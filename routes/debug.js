'use strict';

/*
 * Debug routes — a collection of one-off investigation endpoints used during development
 * to inspect GAM data structures, verify SOAP responses, and diagnose matching issues.
 * None of these endpoints are used by the dashboard UI in production.
 * Unlike other route files, this module does not receive SCREENSHOT_DIR (no cache needed).
 */

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const zlib = require('zlib');
const { getToken } = require('../lib/auth');
const { fetchCreativesViaSoap, fetchPage } = require('../lib/gam-creatives');
const { fetchCreativeLICAStats } = require('../lib/gam-lica');
const { fetchMetricsByCreative, lookupNetlifyUrlsByCreativeId, runReportAndDownload } = require('../lib/gam-reports');
const { extractNetlifyUrl, getTemplateVarValue } = require('../lib/utils');
const { findCustomTargetingValueIds } = require('../lib/gam-targeting');
const {
  GAM_SOAP_NS, GAM_SOAP_ENDPOINT, GAM_REPORT_SOAP_ENDPOINT,
  GAM_CREATIVESET_SOAP_ENDPOINT, GAM_LICA_SOAP_ENDPOINT,
  GAM_LINEITEM_SOAP_ENDPOINT, GAM_CUSTOM_TARGETING_ENDPOINT,
} = require('../config');

const router = express.Router();

module.exports = function() {

  /* Returns a sample of up to 3 Netlify creatives with their raw SOAP fields flattened,
   * to help inspect what properties are available on template creative objects. */
  router.get('/api/debug-netlify', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const allCreatives = await fetchCreativesViaSoap(networkCode, token);
      const netlify = allCreatives
        .map(c => ({ creative: c, netlifyUrl: extractNetlifyUrl(c) }))
        .filter(({ netlifyUrl }) => netlifyUrl !== null)
        .slice(0, 3);

      const samples = netlify.map(({ creative, netlifyUrl }) => {
        const keys = Object.keys(creative).filter(k => k !== '$');
        const preview = {};
        for (const k of keys) {
          const v = creative[k];
          // Unwrap single-element arrays (xml2js wraps every value) for readability
          preview[k] = Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' ? v[0] : v;
        }
        preview._xsiType = creative.$?.['xsi:type'];
        preview._netlifyUrl = netlifyUrl;
        return preview;
      });
      res.json(samples);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Attempts to correlate report creative IDs back to Netlify URLs via LICA.
   * NOTE: This route is broken — fetchCreativeLineItems is not defined and will throw.
   * Left in place as a development artefact. */
  router.get('/api/debug-metrics', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;

      // Get first 5 netlify creatives and their line items
      const allCreatives = await fetchCreativesViaSoap(networkCode, token);
      const netlify = allCreatives.filter(c => extractNetlifyUrl(c)).slice(0, 5);
      const netlifyIds = netlify.map(c => c.id?.[0]);
      // NOTE: fetchCreativeLineItems is not defined — this route would fail at runtime in the original code too
      const licaMap = await (async () => { throw new Error('fetchCreativeLineItems is not defined'); })();
      const lineItemIds = [...new Set(Object.values(licaMap).flat())].slice(0, 10);

      if (!lineItemIds.length) return res.json({ error: 'No line items found for sample creatives' });

      // Run report with LINE_ITEM_ID + CREATIVE_ID for those line items
      const metricsByCreativeId = await fetchMetricsByCreative(lineItemIds, networkCode, token);
      const reportCreativeIds = Object.keys(metricsByCreativeId);

      // Look up those creative IDs via SOAP
      const netlifyUrlMap = await lookupNetlifyUrlsByCreativeId(reportCreativeIds, networkCode, token);

      res.json({
        lineItemIds,
        reportCreativeIds,
        sampleMetrics: Object.entries(metricsByCreativeId).slice(0, 10).map(([id, m]) => ({
          id, impressions: m.impressions, clicks: m.clicks, netlifyUrl: netlifyUrlMap[id] || null
        })),
        netlifyMatchCount: Object.keys(netlifyUrlMap).length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message, detail: err.response?.data?.substring?.(0, 500) });
    }
  });

  /* Returns raw LICA records for the first Netlify creative found, showing the
   * SOAP response shape before any parsing. Useful for verifying LICA field names. */
  router.get('/api/debug-lica', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const allCreatives = await fetchCreativesViaSoap(networkCode, token);
      const firstId = allCreatives.find(c => extractNetlifyUrl(c))?.id?.[0];
      if (!firstId) return res.json({ error: 'No netlify creative found' });

      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemCreativeAssociationsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement>
        <query>WHERE creativeId = ${firstId} LIMIT 5 OFFSET 0</query>
      </filterStatement>
    </getLineItemCreativeAssociationsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const res2 = await axios.post(GAM_LICA_SOAP_ENDPOINT, soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 30000
      });
      const parsed = await xml2js.parseStringPromise(res2.data);
      const rval = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemCreativeAssociationsByStatementResponse']?.[0]?.rval?.[0];
      const results = rval?.results || [];
      res.json({ creativeId: firstId, total: rval?.totalResultSetSize?.[0], rawLica: results.slice(0, 2) });
    } catch (err) {
      res.status(500).json({ error: err.message, detail: err.response?.data?.substring?.(0, 500) });
    }
  });

  /* Returns LICA records (impressions, clicks, line item IDs) for a specific creative.
   * Accepts ?id=<creativeId>. */
  router.get('/api/debug-licas-for-creative', async (req, res) => {
    const creativeId = req.query.id;
    if (!creativeId) return res.status(400).json({ error: 'id param required' });
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemCreativeAssociationsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE creativeId = ${creativeId} LIMIT 50 OFFSET 0</query></filterStatement>
    </getLineItemCreativeAssociationsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const r = await axios.post(GAM_LICA_SOAP_ENDPOINT, soap, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 });
      const parsed = await xml2js.parseStringPromise(r.data);
      const results = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemCreativeAssociationsByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      res.json(results.map(l => ({ lineItemId: l.lineItemId?.[0], impressions: l.stats?.[0]?.stats?.[0]?.impressionsDelivered?.[0], clicks: l.stats?.[0]?.stats?.[0]?.clicksDelivered?.[0] })));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Returns total Netlify creative count and a 20-creative sample with name, ID, and URL.
   * Useful for verifying the template+size filter is capturing the right creatives. */
  router.get('/api/debug-master-ids', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const allCreatives = await fetchCreativesViaSoap(networkCode, token);
      const netlifyCreatives = allCreatives
        .map(c => ({ creative: c, netlifyUrl: extractNetlifyUrl(c) }))
        .filter(({ netlifyUrl }) => netlifyUrl !== null);
      const mapped = netlifyCreatives.slice(0, 20).map(({ creative, netlifyUrl }) => ({
        name: creative.name?.[0], id: creative.id?.[0], netlifyUrl,
      }));
      res.json({ totalNetlify: netlifyCreatives.length, sample: mapped });
    } catch (err) {
      res.status(500).json({ error: err.message, detail: err.response?.data?.substring?.(0, 1000) || null });
    }
  });

  /* Checks whether any of the template creative IDs (from SOAP) appear in a 90-day
   * GAM impressions report (by CREATIVE_ID dimension). Reports use 9-digit "master"
   * creative IDs that differ from the 8-digit template creative IDs, so a zero match
   * count is expected — this confirms the mismatch and validates the fingerprinting approach. */
  router.get('/api/debug-netlify-in-report', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;

      // Fetch netlify creative IDs
      const allCreatives = await fetchCreativesViaSoap(networkCode, token);
      const netlifyIds = new Set(
        allCreatives.filter(c => extractNetlifyUrl(c)).map(c => c.id?.[0]).filter(Boolean)
      );

      // Run a 90-day report to get CREATIVE_ID rows
      const now = new Date();
      const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
      const startD = new Date(now); startD.setDate(startD.getDate() - 90);
      const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };

      const runSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body><runReportJob xmlns="${GAM_SOAP_NS}"><reportJob><reportQuery>
    <dimensions>CREATIVE_ID</dimensions>
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
  </reportQuery></reportJob></runReportJob></soapenv:Body>
</soapenv:Envelope>`;
      const runRes = await axios.post(GAM_REPORT_SOAP_ENDPOINT, runSoap, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 30000 });
      const jobId = (await xml2js.parseStringPromise(runRes.data))['soap:Envelope']?.['soap:Body']?.[0]?.['runReportJobResponse']?.[0]?.rval?.[0]?.id?.[0];
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const stParsed = await xml2js.parseStringPromise((await axios.post(GAM_REPORT_SOAP_ENDPOINT, `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header><soapenv:Body><getReportJobStatus xmlns="${GAM_SOAP_NS}"><reportJobId>${jobId}</reportJobId></getReportJobStatus></soapenv:Body></soapenv:Envelope>`, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 })).data);
        const status = stParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getReportJobStatusResponse']?.[0]?.rval?.[0];
        if (status === 'COMPLETED') break;
        if (status === 'FAILED') throw new Error('Report failed');
      }
      const downloadUrl = (await xml2js.parseStringPromise((await axios.post(GAM_REPORT_SOAP_ENDPOINT, `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header><soapenv:Body><getReportDownloadURL xmlns="${GAM_SOAP_NS}"><reportJobId>${jobId}</reportJobId><exportFormat>CSV_DUMP</exportFormat></getReportDownloadURL></soapenv:Body></soapenv:Envelope>`, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 })).data))['soap:Envelope']?.['soap:Body']?.[0]?.['getReportDownloadURLResponse']?.[0]?.rval?.[0];
      const csvText = zlib.gunzipSync(Buffer.from((await axios.get(downloadUrl, { headers: { Authorization: `Bearer ${token}` }, timeout: 60000, responseType: 'arraybuffer' })).data)).toString('utf8');
      const lines = csvText.split('\n').filter(Boolean);
      const reportIds = new Set(lines.slice(1).map(l => l.split(',')[0].replace(/"/g, '')));

      const matches = [...netlifyIds].filter(id => reportIds.has(id));
      const sampleReportIds = lines.slice(1, 6).map(l => l.split(',')[0].replace(/"/g, ''));

      res.json({
        netlifyCreativeCount: netlifyIds.size,
        reportRowCount: reportIds.size,
        netlifyIdsInReport: matches.length,
        matchedIds: matches.slice(0, 10),
        sampleReportIds,
        sampleNetlifyIds: [...netlifyIds].slice(0, 5),
      });
    } catch (err) {
      res.status(500).json({ error: err.message, detail: err.response?.data?.substring?.(0, 500) });
    }
  });

  /* Returns a sample of up to 3 creative sets from GAM, to inspect the raw
   * CreativeSet SOAP response shape. */
  router.get('/api/debug-creative-sets', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getCreativeSetsByStatement xmlns="${GAM_SOAP_NS}">
      <statement><query>LIMIT 3 OFFSET 0</query></statement>
    </getCreativeSetsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const res2 = await axios.post(GAM_CREATIVESET_SOAP_ENDPOINT, soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 30000
      });
      const parsed = await xml2js.parseStringPromise(res2.data);
      const rval = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativeSetsByStatementResponse']?.[0]?.rval?.[0];
      res.json({ total: rval?.totalResultSetSize?.[0], rawSample: rval?.results?.slice(0, 3) || [] });
    } catch (err) {
      res.status(500).json({ error: err.message, detail: err.response?.data?.substring?.(0, 1000) });
    }
  });

  /* Runs a 30-day GAM impressions report, takes the first 10 creative IDs from the CSV,
   * then looks them up via SOAP to show their type and whether they have a Netlify URL.
   * Used to verify that report creative IDs are the 9-digit "master" IDs, not template IDs. */
  router.get('/api/debug-report-ids', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;

      // Run a quick report and grab first 10 creative IDs
      const now = new Date();
      const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
      const startD = new Date(now); startD.setDate(startD.getDate() - 30);
      const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };

      const runSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body><runReportJob xmlns="${GAM_SOAP_NS}"><reportJob><reportQuery>
    <dimensions>CREATIVE_ID</dimensions>
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
  </reportQuery></reportJob></runReportJob></soapenv:Body>
</soapenv:Envelope>`;

      const runRes = await axios.post(GAM_REPORT_SOAP_ENDPOINT, runSoap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 30000
      });
      const runParsed = await xml2js.parseStringPromise(runRes.data);
      const jobId = runParsed['soap:Envelope']?.['soap:Body']?.[0]?.['runReportJobResponse']?.[0]?.rval?.[0]?.id?.[0];

      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const st = await axios.post(GAM_REPORT_SOAP_ENDPOINT, `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header><soapenv:Body><getReportJobStatus xmlns="${GAM_SOAP_NS}"><reportJobId>${jobId}</reportJobId></getReportJobStatus></soapenv:Body></soapenv:Envelope>`, {
          headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000
        });
        const stParsed = await xml2js.parseStringPromise(st.data);
        const status = stParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getReportJobStatusResponse']?.[0]?.rval?.[0];
        if (status === 'COMPLETED') break;
        if (status === 'FAILED') throw new Error('Report failed');
      }

      const urlSoap = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header><soapenv:Body><getReportDownloadURL xmlns="${GAM_SOAP_NS}"><reportJobId>${jobId}</reportJobId><exportFormat>CSV_DUMP</exportFormat></getReportDownloadURL></soapenv:Body></soapenv:Envelope>`;
      const urlRes = await axios.post(GAM_REPORT_SOAP_ENDPOINT, urlSoap, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 });
      const urlParsed = await xml2js.parseStringPromise(urlRes.data);
      const downloadUrl = urlParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getReportDownloadURLResponse']?.[0]?.rval?.[0];
      const csvRes = await axios.get(downloadUrl, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000, responseType: 'arraybuffer' });
      const csvText = zlib.gunzipSync(Buffer.from(csvRes.data)).toString('utf8');
      const lines = csvText.split('\n').filter(Boolean);
      const sampleIds = lines.slice(1, 11).map(l => l.split(',')[0].replace(/"/g, ''));

      // Now look up those IDs via SOAP
      const idFilter = sampleIds.join(', ');
      const soapEnv = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body><getCreativesByStatement xmlns="${GAM_SOAP_NS}"><filterStatement>
    <query>WHERE id IN (${idFilter}) LIMIT 10 OFFSET 0</query>
  </filterStatement></getCreativesByStatement></soapenv:Body>
</soapenv:Envelope>`;
      const soapRes = await axios.post(GAM_SOAP_ENDPOINT, soapEnv, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 30000 });
      const soapParsed = await xml2js.parseStringPromise(soapRes.data);
      const soapBody = soapParsed['soap:Envelope']?.['soap:Body']?.[0];
      const results = soapBody?.['getCreativesByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      const mapped = results.map(c => ({
        id: c.id?.[0],
        name: c.name?.[0],
        type: c.$?.['xsi:type'],
        hasNetlify: !!extractNetlifyUrl(c)
      }));

      res.json({ reportSampleIds: sampleIds, soapLookup: mapped });
    } catch (err) {
      res.status(500).json({ error: err.message, detail: err.response?.data?.substring?.(0, 500) });
    }
  });

  /* Returns a count of creative xsi:types across the first 500 creatives in GAM,
   * plus one sample ThirdPartyCreative. Used to understand the creative type mix. */
  router.get('/api/debug-types', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const rval = await fetchPage(networkCode, token, 0, 500);
      const results = rval?.results || [];
      const typeCounts = {};
      for (const c of results) {
        const type = c.$?.['xsi:type'] || 'unknown';
        typeCounts[type] = (typeCounts[type] || 0) + 1;
      }
      const sample = results.find(c => c.$?.['xsi:type'] === 'ThirdPartyCreative');
      res.json({ total: rval?.totalResultSetSize?.[0], typeCounts, sampleThirdParty: sample || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Returns the variable definitions (name, label, type, required) for all 8 skin
   * creative templates. Useful for verifying which variable holds the Netlify URL
   * and which holds the VIDEO_ID. */
  router.get('/api/debug-template-vars', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <RequestHeader xmlns="${GAM_SOAP_NS}">
      <networkCode>${networkCode}</networkCode>
      <applicationName>Infinity-Dashboard</applicationName>
    </RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <getCreativeTemplatesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement>
        <query>WHERE id IN (12338205, 12391253, 12430810, 12479439, 12514886, 12517019, 12522683, 12523354) LIMIT 50</query>
      </filterStatement>
    </getCreativeTemplatesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const tplRes = await axios.post(
        'https://ads.google.com/apis/ads/publisher/v202602/CreativeTemplateService',
        soap,
        { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 }
      );
      const parsed = await xml2js.parseStringPromise(tplRes.data);
      const templates = parsed['soap:Envelope']?.['soap:Body']?.[0]
        ?.['getCreativeTemplatesByStatementResponse']?.[0]?.rval?.[0]?.results || [];

      const result = templates.map(t => ({
        id: t.id?.[0],
        name: t.name?.[0],
        variables: (t.variables || []).map(v => ({
          name: v.uniqueName?.[0],
          label: v.label?.[0],
          type: v['$']?.['xsi:type'],
          required: v.isRequired?.[0],
        })),
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Searches GAM line items by name, ID, or order ID.
   * Accepts ?q=<name-substring> (default "AliceSteve"), ?id=<lineItemId>, or ?order=<orderId>.
   * When ?id is provided, also returns full targeting data and custom targeting value IDs. */
  router.get('/api/debug-search-lineitem', async (req, res) => {
    const term = req.query.q || 'AliceSteve';
    const id = req.query.id;
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const order = req.query.order;
      const query = id
        ? `WHERE id = ${id} LIMIT 1`
        : order
          ? `WHERE orderId = ${order} LIMIT 20`
          : `WHERE name LIKE '%${term.replace(/'/g,"''")}%' LIMIT 20`;
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>${query}</query></filterStatement>
    </getLineItemsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const liRes = await axios.post(GAM_LINEITEM_SOAP_ENDPOINT, soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000,
      });
      const parsed = await xml2js.parseStringPromise(liRes.data);
      const items = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemsByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      if (id && items.length) {
        // Return raw targeting for inspection
        const li = items[0];
        const ctValueIds = findCustomTargetingValueIds(li, ['18074515','18004753']);
        return res.json({
          id: li.id?.[0], name: li.name?.[0], type: li.lineItemType?.[0], status: li.status?.[0],
          isArchived: li.isArchived?.[0],
          customTargetingValueIdsFound: ctValueIds,
          targeting: li.targeting,
        });
      }
      res.json(items.map(li => ({
        id: li.id?.[0], name: li.name?.[0],
        type: li.lineItemType?.[0], status: li.status?.[0],
        isArchived: li.isArchived?.[0], orderId: li.orderId?.[0],
      })));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Returns all creatives associated with a line item, with a passesFilter flag showing
   * whether each creative would be included by the template+size filter used in /api/dashboard.
   * Accepts ?id=<lineItemId>. Uses two SOAP calls: LICA to get creative IDs, then
   * CreativeService to get creative details. */
  router.get('/api/debug-creative-for-lineitem', async (req, res) => {
    const liId = req.query.id;
    if (!liId) return res.status(400).json({ error: 'id param required' });
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const licaSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemCreativeAssociationsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE lineItemId = ${liId} LIMIT 20</query></filterStatement>
    </getLineItemCreativeAssociationsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const licaRes = await axios.post(GAM_LICA_SOAP_ENDPOINT, licaSoap, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 });
      const licaParsed = await xml2js.parseStringPromise(licaRes.data);
      const licas = licaParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemCreativeAssociationsByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      const creativeIds = licas.map(l => l.creativeId?.[0]).filter(Boolean);
      if (!creativeIds.length) return res.json({ lineItemId: liId, creativeIds: [], creatives: [] });
      const crSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getCreativesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE id IN (${creativeIds.join(', ')}) LIMIT 20</query></filterStatement>
    </getCreativesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const crRes = await axios.post(GAM_SOAP_ENDPOINT, crSoap, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 });
      const crParsed = await xml2js.parseStringPromise(crRes.data);
      const creatives = crParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativesByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      res.json({
        lineItemId: liId,
        creatives: creatives.map(c => ({
          id: c.id?.[0],
          name: c.name?.[0],
          templateId: c.creativeTemplateId?.[0] || null,
          width: c.width?.[0],
          height: c.height?.[0],
          netlifyUrl: extractNetlifyUrl(c),
          // passesFilter mirrors the exact criteria in fetchCreativesViaSoap: known template ID + 970×249/250/251
          passesFilter: !!(c.creativeTemplateId?.[0] && ['12338205','12391253','12430810','12479439','12514886','12517019','12522683','12523354'].includes(c.creativeTemplateId?.[0]) && ['249','250','251'].includes((c.size?.[0]?.height?.[0] || c.height?.[0])) && (c.size?.[0]?.width?.[0] || c.width?.[0]) === '970'),
          rawKeys: Object.keys(c),
          rawCreative: c,
        })),
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Returns all template variable values for up to 5 creatives matching a name substring.
   * Accepts ?name=<partial-name>. Filters to the 8 known skin template IDs. */
  router.get('/api/debug-creative-vars', async (req, res) => {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: 'name param required' });
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body><getCreativesByStatement xmlns="${GAM_SOAP_NS}">
    <filterStatement><query>WHERE name LIKE '%${name.replace(/'/g,"''")}%' AND creativeTemplateId IN (12338205, 12391253, 12430810, 12479439, 12514886, 12517019, 12522683, 12523354) LIMIT 5</query></filterStatement>
  </getCreativesByStatement></soapenv:Body>
</soapenv:Envelope>`;
      const crRes = await axios.post(GAM_SOAP_ENDPOINT, soap, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 });
      const crParsed = await xml2js.parseStringPromise(crRes.data);
      const creatives = crParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativesByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      res.json(creatives.map(c => ({
        id: c.id?.[0], name: c.name?.[0], templateId: c.creativeTemplateId?.[0],
        netlifyUrl: extractNetlifyUrl(c),
        videoId: getTemplateVarValue(c, 'VIDEO_ID'),
        vars: (c.creativeTemplateVariableValues || []).map(v => ({ name: v.uniqueName?.[0], value: v.value?.[0] })),
      })));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Investigates why specific VIDEO_IDs are missing from video stats results.
   * Hard-coded list of known-missing IDs. Checks: (1) whether the values exist as
   * custom targeting values under the infinityvideo key; (2) whether any line items
   * match by name; (3) whether archived Sponsorship line items carry those targeting values. */
  router.get('/api/debug-missing-video-ids', async (req, res) => {
    const MISSING = ['GF_Trust_July','Core-Vertical_AliceSteve','aliceandsteve','hbotest','OlIVE_bounce_skin','ORD-00298397_Webb_Skin'];
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const results = {};

      // 1. Check if these values exist in the infinityvideo key at all
      const nameList = MISSING.map(n => `'${n.replace(/'/g,"''")}'`).join(', ');
      const ctSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getCustomTargetingValuesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE customTargetingKeyId = 18074515 AND name IN (${nameList}) LIMIT 50</query></filterStatement>
    </getCustomTargetingValuesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const ctRes = await axios.post(GAM_CUSTOM_TARGETING_ENDPOINT, ctSoap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000,
      });
      const ctParsed = await xml2js.parseStringPromise(ctRes.data);
      const ctValues = ctParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCustomTargetingValuesByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      results.foundAsCtValues = ctValues.map(v => ({ id: v.id?.[0], name: v.name?.[0] }));
      const foundValueIds = ctValues.map(v => v.id?.[0]);

      // 2. Try name-based search for any line item containing these strings (including archived)
      const nameMatches = {};
      await Promise.all(MISSING.map(async vid => {
        const liSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE name LIKE '%${vid.replace(/'/g,"''")}%' LIMIT 10</query></filterStatement>
    </getLineItemsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
        const liRes = await axios.post(GAM_LINEITEM_SOAP_ENDPOINT, liSoap, {
          headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000,
        });
        const liParsed = await xml2js.parseStringPromise(liRes.data);
        const lis = liParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemsByStatementResponse']?.[0]?.rval?.[0]?.results || [];
        nameMatches[vid] = lis.map(li => ({ id: li.id?.[0], name: li.name?.[0], status: li.status?.[0], isArchived: li.isArchived?.[0], type: li.lineItemType?.[0] }));
      }));
      results.nameMatches = nameMatches;

      // 3. Check which value IDs appear in Sponsorship line items (including archived)
      if (foundValueIds.length) {
        const liSoap2 = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE lineItemType = 'SPONSORSHIP' AND isArchived = true LIMIT 500</query></filterStatement>
    </getLineItemsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
        const liRes2 = await axios.post(GAM_LINEITEM_SOAP_ENDPOINT, liSoap2, {
          headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 30000,
        });
        const liParsed2 = await xml2js.parseStringPromise(liRes2.data);
        const archivedLis = liParsed2['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemsByStatementResponse']?.[0]?.rval?.[0]?.results || [];
        const archivedMatches = [];
        for (const li of archivedLis) {
          const valIds = findCustomTargetingValueIds(li.targeting, ['18074515']);
          const matched = valIds.filter(v => foundValueIds.includes(v));
          if (matched.length) archivedMatches.push({ liId: li.id?.[0], liName: li.name?.[0], matchedValueIds: matched });
        }
        results.archivedLineItemMatches = archivedMatches;
        results.totalArchivedSponsorship = archivedLis.length;
      }

      res.json(results);
    } catch(err) { res.status(500).json({ error: err.message, detail: err.response?.data?.substring?.(0,500) }); }
  });

  /* Returns all custom targeting keys whose name contains "video", "skin", "infinity",
   * "flix", "advertis", or whose ID is 300297. Used to discover the key IDs needed
   * for VIDEO_ID targeting queries. */
  router.get('/api/debug-custom-targeting-keys', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getCustomTargetingKeysByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE name LIKE '%video%' OR name LIKE '%skin%' OR name LIKE '%infinity%' OR name LIKE '%flix%' OR name LIKE '%advertis%' OR id = 300297 LIMIT 50</query></filterStatement>
    </getCustomTargetingKeysByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const res2 = await axios.post(
        'https://ads.google.com/apis/ads/publisher/v202602/CustomTargetingService',
        soap,
        { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 }
      );
      const parsed = await xml2js.parseStringPromise(res2.data);
      const keys = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCustomTargetingKeysByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      res.json(keys.map(k => ({ id: k.id?.[0], name: k.name?.[0], displayName: k.displayName?.[0], type: k.type?.[0] })));
    } catch(err) { res.status(500).json({ error: err.message }); }
  });

  /* Looks up a single custom targeting value by key ID and value ID.
   * Accepts ?keyId=<id>&valueId=<id>. Useful for verifying what a specific targeting
   * value ID resolves to. */
  router.get('/api/debug-ct-value', async (req, res) => {
    const keyId = req.query.keyId;
    const valueId = req.query.valueId;
    if (!keyId || !valueId) return res.status(400).json({ error: 'keyId and valueId required' });
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body><getCustomTargetingValuesByStatement xmlns="${GAM_SOAP_NS}">
    <filterStatement><query>WHERE customTargetingKeyId = ${keyId} AND id = ${valueId} LIMIT 1</query></filterStatement>
  </getCustomTargetingValuesByStatement></soapenv:Body>
</soapenv:Envelope>`;
      const r = await axios.post(GAM_CUSTOM_TARGETING_ENDPOINT, soap, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 });
      const parsed = await xml2js.parseStringPromise(r.data);
      const values = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCustomTargetingValuesByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      res.json(values.map(v => ({ id: v.id?.[0], name: v.name?.[0], displayName: v.displayName?.[0] })));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Returns a sample of up to 10 video skin creatives (those with a VIDEO_ID template var)
   * alongside a sample of Sponsorship line items whose name contains "flix".
   * Used to manually verify that VIDEO_ID values on creatives match line item names. */
  router.get('/api/debug-video-match', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;

      // Get a sample of video skin creatives and their VIDEO_ID values
      const allCreatives = await fetchCreativesViaSoap(networkCode, token);
      const videoSamples = allCreatives
        .map(c => ({ videoId: getTemplateVarValue(c, 'VIDEO_ID'), name: c.name?.[0], id: c.id?.[0] }))
        .filter(c => c.videoId)
        .slice(0, 10);

      // Get a sample of flix sponsorship line item names
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE lineItemType = 'SPONSORSHIP' AND name LIKE '%flix%' LIMIT 10 OFFSET 0</query></filterStatement>
    </getLineItemsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const res2 = await axios.post(GAM_LINEITEM_SOAP_ENDPOINT, soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000
      });
      const parsed = await xml2js.parseStringPromise(res2.data);
      const liResults = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemsByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      const liSamples = liResults.map(li => ({ id: li.id?.[0], name: li.name?.[0], orderId: li.orderId?.[0] }));

      res.json({ videoIdSamples: videoSamples, lineItemSamples: liSamples });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Returns all skin template creatives whose Netlify URL contains "avios".
   * One-off endpoint to diagnose a specific advertiser's missing data. */
  router.get('/api/debug-avios', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <RequestHeader xmlns="${GAM_SOAP_NS}">
      <networkCode>${networkCode}</networkCode>
      <applicationName>Infinity-Dashboard</applicationName>
    </RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <getCreativesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement>
        <query>WHERE creativeTemplateId IN (12338205, 12391253, 12430810, 12479439, 12514886, 12517019, 12522683, 12523354) LIMIT 500 OFFSET 0</query>
      </filterStatement>
    </getCreativesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const response = await axios.post(GAM_SOAP_ENDPOINT, soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
        timeout: 30000,
      });
      const parsed = await xml2js.parseStringPromise(response.data);
      const results = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativesByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      const avios = results
        .filter(c => {
          const netlifyUrl = extractNetlifyUrl(c);
          return netlifyUrl && netlifyUrl.toLowerCase().includes('avios');
        })
        .map(c => ({
          id: c.id?.[0],
          name: c.name?.[0],
          width: c.width?.[0],
          height: c.height?.[0],
          templateId: c.creativeTemplateId?.[0],
          netlifyUrl: extractNetlifyUrl(c),
        }));
      res.json(avios);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Find all creatives for a given netlify URL (within our template+size filter) + their LICA impression stats */
  /* Returns all skin template creatives matching a partial Netlify URL, with their LICA stats.
   * Accepts ?url=<partial-url> (e.g. ?url=marcom-desktop-090326.netlify.app).
   * Useful for checking whether a specific creative is being picked up and what impressions it has. */
  router.get('/api/debug-url', async (req, res) => {
    const urlParam = (req.query.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    if (!urlParam) return res.status(400).json({ error: 'url param required (e.g. ?url=marcom-desktop-090326.netlify.app)' });
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;

      const allCreatives = await fetchCreativesViaSoap(networkCode, token);
      const matched = allCreatives.filter(c => {
        const url = extractNetlifyUrl(c);
        return url && url.toLowerCase().includes(urlParam.toLowerCase());
      });

      if (!matched.length) return res.json({ url: urlParam, found: 0, creatives: [] });

      const ids = matched.map(c => c.id?.[0]).filter(Boolean);
      const { statsByCreativeId } = await fetchCreativeLICAStats(ids, networkCode, token);

      const creatives = matched.map(c => {
        const id = c.id?.[0];
        const stats = statsByCreativeId[id] || { impressions: 0, clicks: 0 };
        return {
          id,
          name:        c.name?.[0],
          templateId:  c.creativeTemplateId?.[0] || null,
          netlifyUrl:  extractNetlifyUrl(c),
          impressions: stats.impressions,
          clicks:      stats.clicks,
        };
      });

      const total = creatives.reduce((s, c) => s + c.impressions, 0);
      res.json({ url: urlParam, found: creatives.length, totalImpressions: total, creatives });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Returns the distinct creative template IDs found across all Netlify creatives,
   * with their names and creative counts, sorted by count. Used to verify which
   * template IDs to include in the filter. */
  router.get('/api/template-ids', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const allCreatives = await fetchCreativesViaSoap(networkCode, token);
      const templateIds = {};
      for (const c of allCreatives) {
        const netlifyUrl = extractNetlifyUrl(c);
        if (!netlifyUrl) continue;
        const tplId = c.creativeTemplateId?.[0];
        if (tplId) templateIds[tplId] = (templateIds[tplId] || 0) + 1;
      }

      // Look up template names from CreativeTemplateService
      const ids = Object.keys(templateIds);
      const tplSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <RequestHeader xmlns="${GAM_SOAP_NS}">
      <networkCode>${networkCode}</networkCode>
      <applicationName>Infinity-Dashboard</applicationName>
    </RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <getCreativeTemplatesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement>
        <query>WHERE id IN (${ids.join(', ')}) LIMIT 50</query>
      </filterStatement>
    </getCreativeTemplatesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const tplRes = await axios.post(
        'https://ads.google.com/apis/ads/publisher/v202602/CreativeTemplateService',
        tplSoap,
        { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 }
      );
      const tplParsed = await xml2js.parseStringPromise(tplRes.data);
      const tplResults = tplParsed['soap:Envelope']?.['soap:Body']?.[0]
        ?.['getCreativeTemplatesByStatementResponse']?.[0]?.rval?.[0]?.results || [];

      const named = ids.map(id => ({
        id,
        name: tplResults.find(t => t.id?.[0] === id)?.name?.[0] || '(unknown)',
        creativeCount: templateIds[id],
      })).sort((a, b) => b.creativeCount - a.creativeCount);

      res.json({ templates: named, total: Object.values(templateIds).reduce((a,b)=>a+b,0) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Fires a minimal SOAP request to fetch 5 creatives by size (970×250) and returns
   * the HTTP status and a truncated response body. Used to verify SOAP connectivity
   * and OAuth token validity. */
  router.get('/api/soap-test', async (req, res) => {
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <RequestHeader xmlns="${GAM_SOAP_NS}">
      <networkCode>${networkCode}</networkCode>
      <applicationName>Infinity-Dashboard</applicationName>
    </RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <getCreativesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement>
        <query>WHERE width = 970 AND height = 250 LIMIT 5 OFFSET 0</query>
      </filterStatement>
    </getCreativesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      console.log('Sending SOAP request...');
      const response = await axios.post(GAM_SOAP_ENDPOINT, soapEnvelope, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'Authorization': `Bearer ${token}`, 'SOAPAction': '' },
        timeout: 15000,
      });
      console.log('SOAP response status:', response.status);
      res.json({ status: response.status, data: response.data?.substring?.(0, 1000) });
    } catch (err) {
      console.error('SOAP test error:', err.message, err.code);
      res.status(500).json({ error: err.message, code: err.code, status: err.response?.status, data: err.response?.data?.substring?.(0, 500) });
    }
  });

  /* Returns the GAM network object for the configured network code via the REST API.
   * Useful for verifying the OAuth token has access to the correct network. */
  router.get('/api/network', async (req, res) => {
    try {
      const token = await getToken();
      const { GAM_REST_BASE } = require('../config');
      const response = await axios.get(
        `${GAM_REST_BASE}/networks/${process.env.GAM_NETWORK_CODE}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      res.json(response.data);
    } catch (err) {
      res.status(500).json({ error: err.message, detail: err.response?.data || null });
    }
  });

  return router;
};
