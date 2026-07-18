'use strict';

/**
 * GAM ReportService helpers — submit async report jobs, poll for completion,
 * download the gzip-compressed CSV, and parse the results.
 *
 * Unlike LICA, GAM reports can break down metrics by dimensions not exposed in
 * the SOAP entity APIs (e.g. LINE_ITEM_ID + CREATIVE_ID together). The trade-off
 * is that every report requires a round-trip: submit → poll → download URL → fetch CSV.
 * GAM returns the CSV gzip-compressed regardless of the export format requested.
 */

const axios = require('axios');
const xml2js = require('xml2js');
const zlib = require('zlib');
const { GAM_SOAP_NS, GAM_SOAP_ENDPOINT, GAM_REPORT_SOAP_ENDPOINT } = require('../config');
const { extractNetlifyUrl, splitCsvLine } = require('./utils');

/**
 * Generic report runner: submits a report job described by reportQueryXml, polls until
 * COMPLETED (up to 30 attempts × 3 s = ~90 s), then downloads and decompresses the CSV.
 * Returns the raw CSV string. Throws on SOAP fault, job failure, or timeout.
 * reportQueryXml should contain only the inner XML elements of <reportQuery> — the
 * surrounding SOAP wrapper is added here.
 */
async function runReportAndDownload(reportQueryXml, networkCode, token) {
  const runSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body><runReportJob xmlns="${GAM_SOAP_NS}"><reportJob><reportQuery>${reportQueryXml}</reportQuery></reportJob></runReportJob></soapenv:Body>
</soapenv:Envelope>`;

  let runRes;
  try {
    runRes = await axios.post(GAM_REPORT_SOAP_ENDPOINT, runSoap, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 30000 });
  } catch(axErr) {
    const fault = axErr.response?.data || '';
    const m = String(fault).match(/<faultstring>([^<]+)<\/faultstring>/);
    throw new Error('GAM report SOAP fault: ' + (m ? m[1] : String(fault).substring(0, 400)));
  }
  const runParsed = await xml2js.parseStringPromise(runRes.data);
  const runBody = runParsed['soap:Envelope']?.['soap:Body']?.[0];
  const jobId = runBody?.['runReportJobResponse']?.[0]?.rval?.[0]?.id?.[0];
  if (!jobId) throw new Error('No report job ID: ' + (runBody?.['soap:Fault']?.[0]?.faultstring?.[0] || ''));

  // Poll for completion — up to 60 × 3 s = 3 minutes
  let reportDone = false;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const stParsed = await xml2js.parseStringPromise((await axios.post(GAM_REPORT_SOAP_ENDPOINT, `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header><soapenv:Body><getReportJobStatus xmlns="${GAM_SOAP_NS}"><reportJobId>${jobId}</reportJobId></getReportJobStatus></soapenv:Body></soapenv:Envelope>`, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 })).data);
    const status = stParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getReportJobStatusResponse']?.[0]?.rval?.[0];
    console.log(`Report job ${jobId} status [${i + 1}/60]: ${status}`);
    if (status === 'COMPLETED') { reportDone = true; break; }
    if (status === 'FAILED') throw new Error('Report job failed');
  }
  if (!reportDone) throw new Error('Report job timed out after 3 minutes');

  const urlParsed = await xml2js.parseStringPromise((await axios.post(GAM_REPORT_SOAP_ENDPOINT, `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header><soapenv:Body><getReportDownloadURL xmlns="${GAM_SOAP_NS}"><reportJobId>${jobId}</reportJobId><exportFormat>CSV_DUMP</exportFormat></getReportDownloadURL></soapenv:Body></soapenv:Envelope>`, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 })).data);
  const downloadUrl = urlParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getReportDownloadURLResponse']?.[0]?.rval?.[0];

  // GAM always gzips the CSV download regardless of requested format
  const csvRes = await axios.get(downloadUrl, { headers: { Authorization: `Bearer ${token}` }, timeout: 60000, responseType: 'arraybuffer' });
  return zlib.gunzipSync(Buffer.from(csvRes.data)).toString('utf8');
}

/**
 * Runs a network-wide impressions report by CREATIVE_ID covering the last ~3 years (1094 days).
 * Returns { byId: { creativeId → impressions }, byName: { creativeName → impressions } }.
 * Both indexes are built because the AV fingerprinting logic needs to match by name
 * when creative IDs differ between LICA and the AV report.
 */
async function fetchImpressions(networkCode, token) {
  const now = new Date();
  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startD = new Date(now); startD.setDate(startD.getDate() - 1094);
  const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };

  const runSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <RequestHeader xmlns="${GAM_SOAP_NS}">
      <networkCode>${networkCode}</networkCode>
      <applicationName>Infinity-Dashboard</applicationName>
    </RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <runReportJob xmlns="${GAM_SOAP_NS}">
      <reportJob>
        <reportQuery>
          <dimensions>CREATIVE_ID</dimensions>
          <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
          <dimensionAttributes>CREATIVE_NAME</dimensionAttributes>
          <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
          <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
          <dateRangeType>CUSTOM_DATE</dateRangeType>
        </reportQuery>
      </reportJob>
    </runReportJob>
  </soapenv:Body>
</soapenv:Envelope>`;

  const runRes = await axios.post(GAM_REPORT_SOAP_ENDPOINT, runSoap, {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
    timeout: 30000,
  });

  const runParsed = await xml2js.parseStringPromise(runRes.data);
  const runBody = runParsed['soap:Envelope']?.['soap:Body']?.[0];
  const jobId = runBody?.['runReportJobResponse']?.[0]?.rval?.[0]?.id?.[0];
  if (!jobId) {
    const fault = runBody?.['soap:Fault']?.[0]?.faultstring?.[0];
    throw new Error('No report job ID returned' + (fault ? ': ' + fault : ''));
  }
  console.log('Report job ID:', jobId);

  // Poll for completion
  let completed = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <RequestHeader xmlns="${GAM_SOAP_NS}">
      <networkCode>${networkCode}</networkCode>
      <applicationName>Infinity-Dashboard</applicationName>
    </RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <getReportJobStatus xmlns="${GAM_SOAP_NS}">
      <reportJobId>${jobId}</reportJobId>
    </getReportJobStatus>
  </soapenv:Body>
</soapenv:Envelope>`;
    const statusRes = await axios.post(GAM_REPORT_SOAP_ENDPOINT, statusSoap, {
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
      timeout: 15000,
    });
    const statusParsed = await xml2js.parseStringPromise(statusRes.data);
    const statusBody = statusParsed['soap:Envelope']?.['soap:Body']?.[0];
    const status = statusBody?.['getReportJobStatusResponse']?.[0]?.rval?.[0];
    console.log('Report status:', status);
    if (status === 'COMPLETED') { completed = true; break; }
    if (status === 'FAILED') throw new Error('Report job failed');
  }
  if (!completed) throw new Error('Report job timed out');

  // Get download URL
  const urlSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <RequestHeader xmlns="${GAM_SOAP_NS}">
      <networkCode>${networkCode}</networkCode>
      <applicationName>Infinity-Dashboard</applicationName>
    </RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <getReportDownloadURL xmlns="${GAM_SOAP_NS}">
      <reportJobId>${jobId}</reportJobId>
      <exportFormat>CSV_DUMP</exportFormat>
    </getReportDownloadURL>
  </soapenv:Body>
</soapenv:Envelope>`;

  const urlRes = await axios.post(GAM_REPORT_SOAP_ENDPOINT, urlSoap, {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
    timeout: 15000,
  });
  const urlParsed = await xml2js.parseStringPromise(urlRes.data);
  const urlBody = urlParsed['soap:Envelope']?.['soap:Body']?.[0];
  const downloadUrl = urlBody?.['getReportDownloadURLResponse']?.[0]?.rval?.[0];
  if (!downloadUrl) throw new Error('No download URL returned');

  // Download and decompress CSV
  const csvRes = await axios.get(downloadUrl, { headers: { Authorization: `Bearer ${token}` }, timeout: 60000, responseType: 'arraybuffer' });
  const decompressed = zlib.gunzipSync(Buffer.from(csvRes.data));
  const csvText = decompressed.toString('utf8');
  const lines = csvText.split('\n').filter(Boolean);
  console.log('Report CSV rows:', lines.length - 1);
  console.log('Report header:', lines[0]);
  console.log('Sample report IDs:', lines.slice(1, 6).map(l => l.split(',')[0]));

  // Build map keyed by creative name (col 1) and creative id (col 0)
  // Header: "Dimension.CREATIVE_ID","Dimension.CREATIVE_NAME","Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS"
  const byName = {};
  const byId = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const id = cols[0]?.trim().replace(/"/g, '');
    const name = cols[1]?.trim().replace(/"/g, '');
    const impressions = parseInt(cols[cols.length - 1]?.trim().replace(/"/g, '') || '0');
    if (!isNaN(impressions)) {
      if (id) byId[id] = (byId[id] || 0) + impressions;
      if (name) byName[name] = (byName[name] || 0) + impressions;
    }
  }
  return { byId, byName };
}

/**
 * Given a list of report creative IDs (which differ from template creative IDs),
 * fetches each creative from GAM and extracts its Netlify URL if present.
 * Returns a map of creativeId → netlifyUrl.
 * This is used during Active View fingerprint matching: the report creative must be
 * resolved to a Netlify URL so it can be correlated with the template creative.
 */
async function lookupNetlifyUrlsByCreativeId(creativeIds, networkCode, token) {
  // Look up the report creative IDs via SOAP to find which have netlify URLs
  const urlMap = {}; // creativeId -> netlifyUrl
  const batchSize = 100;
  for (let i = 0; i < creativeIds.length; i += batchSize) {
    const batch = creativeIds.slice(i, i + batchSize);
    const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body><getCreativesByStatement xmlns="${GAM_SOAP_NS}"><filterStatement>
    <query>WHERE id IN (${batch.join(', ')}) LIMIT ${batchSize} OFFSET 0</query>
  </filterStatement></getCreativesByStatement></soapenv:Body>
</soapenv:Envelope>`;
    const res = await axios.post(GAM_SOAP_ENDPOINT, soap, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 30000 });
    const parsed = await xml2js.parseStringPromise(res.data);
    const results = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativesByStatementResponse']?.[0]?.rval?.[0]?.results || [];
    for (const c of results) {
      const url = extractNetlifyUrl(c);
      if (url) urlMap[c.id?.[0]] = url;
    }
  }
  return urlMap;
}

/**
 * Runs a LINE_ITEM_ID + CREATIVE_ID report for the given line items and returns
 * a map of creativeId → { impressions, clicks } aggregated across all line items.
 * Used to get delivery metrics for video-hosting line items where the creative IDs
 * are different from the template creative IDs tracked by LICA.
 */
async function fetchMetricsByCreative(lineItemIds, networkCode, token) {
  const now = new Date();
  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startD = new Date(now); startD.setDate(startD.getDate() - 1094);
  const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };
  const idList = lineItemIds.join(', ');

  // Report with LINE_ITEM_ID + CREATIVE_ID so we get per-creative impressions within each line item
  const queryXml = `
    <dimensions>LINE_ITEM_ID</dimensions>
    <dimensions>CREATIVE_ID</dimensions>
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_CLICKS</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
    <statement><query>WHERE LINE_ITEM_ID IN (${idList})</query></statement>`;

  const csvText = await runReportAndDownload(queryXml, networkCode, token);
  const lines = csvText.split('\n').filter(Boolean);

  // CSV: Dimension.LINE_ITEM_ID, Dimension.CREATIVE_ID, Column.IMPRESSIONS, Column.CLICKS
  // Build map: creativeId -> { impressions, clicks }
  const byCreativeId = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const creativeId = cols[1];
    const imps   = parseInt(cols[2] || '0');
    const clicks  = parseInt(cols[3] || '0');
    if (creativeId && creativeId !== '0') {
      byCreativeId[creativeId] = {
        impressions: (byCreativeId[creativeId]?.impressions || 0) + (isNaN(imps) ? 0 : imps),
        clicks:      (byCreativeId[creativeId]?.clicks      || 0) + (isNaN(clicks) ? 0 : clicks),
      };
    }
  }
  return byCreativeId;
}

/**
 * Runs a LINE_ITEM_ID + CREATIVE_ID + AD_UNIT_ID report for the given line items.
 * The CREATIVE_ID here is the 9-digit "rendered" report ID, NOT the template
 * creative ID from LICA/CreativeService — there is no join key between the two.
 * The caller bridges the gap via impression fingerprinting: totalImps for a
 * (line item, report creative) pair ≈ LICA impressionsDelivered for the same
 * (line item, template creative) pair, since both count the same impressions.
 * Report window is 1094 days (GAM custom-range max) — campaigns delivering
 * before that won't fingerprint-match.
 * Returns { lineItemId: { reportCreativeId: { totalImps, totalClicks,
 *   adUnits: { adUnitId: { impressions, clicks } } } } }.
 */
async function fetchImpressionsByCreativeAndAdUnit(lineItemIds, networkCode, token) {
  if (!lineItemIds.length) return {};

  const now = new Date();
  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startD = new Date(now); startD.setDate(startD.getDate() - 1094);
  const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };

  const result = {};
  const batchSize = 400;

  for (let i = 0; i < lineItemIds.length; i += batchSize) {
    const batch = lineItemIds.slice(i, i + batchSize);

    const queryXml = `
    <dimensions>LINE_ITEM_ID</dimensions>
    <dimensions>CREATIVE_ID</dimensions>
    <dimensions>AD_UNIT_ID</dimensions>
    <adUnitView>TOP_LEVEL</adUnitView>
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_CLICKS</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
    <statement><query>WHERE LINE_ITEM_ID IN (${batch.join(', ')})</query></statement>`;

    const csvText = await runReportAndDownload(queryXml, networkCode, token);
    const lines = csvText.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    if (i === 0) console.log('Ad-unit report header:', lines[0]);

    const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const iLI  = header.indexOf('Dimension.LINE_ITEM_ID');
    const iCID = header.indexOf('Dimension.CREATIVE_ID');
    let   iAU  = header.indexOf('Dimension.AD_UNIT_ID');
    if (iAU < 0) iAU = header.findIndex(h => h.startsWith('Dimension.AD_UNIT_ID'));
    const iIMP = header.indexOf('Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS');
    const iCLK = header.indexOf('Column.TOTAL_LINE_ITEM_LEVEL_CLICKS');
    if ([iLI, iCID, iAU, iIMP, iCLK].some(x => x < 0)) throw new Error('Unexpected ad-unit report header: ' + lines[0]);

    for (const line of lines.slice(1)) {
      // Quote-aware split: GAM auto-adds AD_UNIT_NAME alongside AD_UNIT_ID, and a top-level
      // ad unit name containing a comma would otherwise shift every later column.
      const cols = splitCsvLine(line);
      const liId = cols[iLI], cid = cols[iCID], auId = cols[iAU];
      const imps   = parseInt(cols[iIMP] || '0');
      const clicks = parseInt(cols[iCLK] || '0');
      if (!liId || !cid || cid === '0' || !auId) continue;
      if (!result[liId]) result[liId] = {};
      if (!result[liId][cid]) result[liId][cid] = { totalImps: 0, totalClicks: 0, adUnits: {} };
      const rec = result[liId][cid];
      rec.totalImps   += isNaN(imps)   ? 0 : imps;
      rec.totalClicks += isNaN(clicks) ? 0 : clicks;
      if (!rec.adUnits[auId]) rec.adUnits[auId] = { impressions: 0, clicks: 0 };
      rec.adUnits[auId].impressions += isNaN(imps)   ? 0 : imps;
      rec.adUnits[auId].clicks      += isNaN(clicks) ? 0 : clicks;
    }
  }

  return result;
}

module.exports = { runReportAndDownload, fetchImpressions, lookupNetlifyUrlsByCreativeId, fetchMetricsByCreative, fetchImpressionsByCreativeAndAdUnit };
