'use strict';

/**
 * Finds the video-hosting line items associated with each creative's VIDEO_ID,
 * and fetches video completion rates for those line items via a GAM report.
 *
 * A skin creative carries a VIDEO_ID (e.g. "AliceSteve") as a template variable.
 * The actual video lives on a separate line item that has that same VIDEO_ID set
 * as a custom targeting value. There is no direct foreign key — the link is made
 * by matching custom targeting values across line items.
 *
 * The lookup searches SPONSORSHIP, HOUSE, PRICE_PRIORITY, and STANDARD line item
 * types, with a name-based fallback for line items whose targeting is not parseable.
 */

const axios = require('axios');
const xml2js = require('xml2js');
const { GAM_SOAP_NS, GAM_SOAP_ENDPOINT, GAM_LICA_SOAP_ENDPOINT, GAM_LINEITEM_SOAP_ENDPOINT, GAM_CUSTOM_TARGETING_ENDPOINT, EXCLUDED_ORDER_IDS } = require('../config');
const { findCustomTargetingValueIds } = require('./gam-targeting');
const { runReportAndDownload } = require('./gam-reports');

/**
 * Given a list of VIDEO_ID strings, finds all matching video-hosting line items in GAM.
 * Returns a map of videoId → { lineItemIds: string[], durationMs: number }.
 *
 * The lookup is a three-step process:
 *   1. Resolve VIDEO_ID strings to GAM custom targeting value IDs (global search, any key).
 *   2. Scan line items of relevant types and match those whose targeting contains any of
 *      the resolved value IDs. Falls back to line item name matching if targeting is empty.
 *   3. Fetch the video creative duration via LICA → CreativeService for matched line items,
 *      overriding the videoMaxDuration field which is sometimes inaccurate.
 *
 * videoIds is the deduplicated list of VIDEO_ID values extracted from template creatives.
 */
async function fetchVideoLineItemsByVideoIds(videoIds, networkCode, token) {
  if (!videoIds.length) return {};
  const uniqueIds = [...new Set(videoIds)];
  const videoIdToLineItemIds = {};

  // Step 1: Search custom targeting values globally (all keys) for our VIDEO_IDs
  const valueIdToVideoId = {};
  try {
    const lowerToOriginal = {};
    for (const n of uniqueIds) lowerToOriginal[n.toLowerCase()] = n;
    const nameList = uniqueIds.map(n => `'${n.replace(/'/g, "''")}'`).join(', ');
    const valSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getCustomTargetingValuesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE name IN (${nameList}) LIMIT 500</query></filterStatement>
    </getCustomTargetingValuesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
    const valRes = await axios.post(GAM_CUSTOM_TARGETING_ENDPOINT, valSoap, {
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000,
    });
    const valParsed = await xml2js.parseStringPromise(valRes.data);
    const values = valParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCustomTargetingValuesByStatementResponse']?.[0]?.rval?.[0]?.results || [];
    for (const v of values) {
      const gamName = v.name?.[0];
      const original = lowerToOriginal[gamName?.toLowerCase()] || gamName;
      if (original) valueIdToVideoId[v.id?.[0]] = original;
    }
    console.log(`Global custom targeting value IDs found: ${Object.keys(valueIdToVideoId).length}/${uniqueIds.length}`);
  } catch(e) {
    console.warn('Global custom targeting value lookup failed:', e.message);
  }

  // Step 2: Fetch all relevant line item types and check their custom targeting + name
  const excludeClause = EXCLUDED_ORDER_IDS.map(id => `AND orderId != ${id}`).join(' ');
  const lineItemTypes = ['SPONSORSHIP', 'HOUSE', 'PRICE_PRIORITY', 'STANDARD'];
  for (const liType of lineItemTypes) {
    let offset = 0;
    const pageSize = 500;
    while (true) {
      const liSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE lineItemType = '${liType}' ${excludeClause} LIMIT ${pageSize} OFFSET ${offset}</query></filterStatement>
    </getLineItemsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const liRes = await axios.post(GAM_LINEITEM_SOAP_ENDPOINT, liSoap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 30000,
      });
      const liParsed = await xml2js.parseStringPromise(liRes.data);
      const rval = liParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemsByStatementResponse']?.[0]?.rval?.[0];
      const lineItems = rval?.results || [];
      const total = parseInt(rval?.totalResultSetSize?.[0] || '0');

      for (const li of lineItems) {
        const liId = li.id?.[0];
        const liName = li.name?.[0] || '';
        const durationMs = parseInt(li.videoMaxDuration?.[0] || '0') || 0;
        // Search entire line item (targeting + creativeTargetings) for our video value IDs (any key)
        const matchedValueIds = findCustomTargetingValueIds(li).filter(v => valueIdToVideoId[v]);
        for (const valId of matchedValueIds) {
          const videoName = valueIdToVideoId[valId];
          if (videoName) {
            if (!videoIdToLineItemIds[videoName]) videoIdToLineItemIds[videoName] = { lineItemIds: [], durationMs: 0 };
            if (!videoIdToLineItemIds[videoName].lineItemIds.includes(liId)) {
              videoIdToLineItemIds[videoName].lineItemIds.push(liId);
              if (durationMs > 0) videoIdToLineItemIds[videoName].durationMs = durationMs;
              console.log(`Custom targeting match [${liType}]: "${videoName}" → "${liName}" (${liId}) dur=${durationMs}ms`);
            }
          }
        }
        // Name-based fallback for line items whose custom targeting does not include the video value
        for (const vid of uniqueIds) {
          if (!videoIdToLineItemIds[vid] && liName.includes(vid)) {
            videoIdToLineItemIds[vid] = { lineItemIds: [liId], durationMs };
            console.log(`Name match fallback [${liType}]: "${vid}" → "${liName}" (${liId}) dur=${durationMs}ms`);
          }
        }
      }

      offset += pageSize;
      if (offset >= total) break;
    }
  }

  const matchCount = Object.keys(videoIdToLineItemIds).length;
  console.log(`Video line items matched: ${matchCount}/${uniqueIds.length} video IDs`);

  // Step 3: Get actual video creative duration via LICAs → CreativeService
  // videoMaxDuration on the line item is unreliable; the creative's duration field is authoritative
  if (matchCount > 0) {
    try {
      const allMatchedLiIds = [...new Set(Object.values(videoIdToLineItemIds).flatMap(d => d.lineItemIds))];
      const liIdList = allMatchedLiIds.join(', ');

      // Fetch LICAs for matched line items
      const licaSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemCreativeAssociationsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE lineItemId IN (${liIdList}) AND status = 'ACTIVE' LIMIT 500</query></filterStatement>
    </getLineItemCreativeAssociationsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const licaRes = await axios.post(GAM_LICA_SOAP_ENDPOINT, licaSoap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 20000,
      });
      const licaParsed = await xml2js.parseStringPromise(licaRes.data);
      const licas = licaParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemCreativeAssociationsByStatementResponse']?.[0]?.rval?.[0]?.results || [];

      // lineItemId → [creativeId, ...]
      const liToCreativeIds = {};
      for (const lica of licas) {
        const liId = lica.lineItemId?.[0]; const cId = lica.creativeId?.[0];
        if (liId && cId) { if (!liToCreativeIds[liId]) liToCreativeIds[liId] = []; liToCreativeIds[liId].push(cId); }
      }

      // Fetch creatives to get their duration (VideoCreative / VastRedirectCreative both have duration field)
      const allCreativeIds = [...new Set(Object.values(liToCreativeIds).flat())];
      if (allCreativeIds.length) {
        const creIdList = allCreativeIds.join(', ');
        const creSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getCreativesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE id IN (${creIdList}) LIMIT 500</query></filterStatement>
    </getCreativesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
        const creRes = await axios.post(GAM_SOAP_ENDPOINT, creSoap, {
          headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 20000,
        });
        const creParsed = await xml2js.parseStringPromise(creRes.data);
        const creatives = creParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativesByStatementResponse']?.[0]?.rval?.[0]?.results || [];

        const creIdToDurationMs = {};
        for (const c of creatives) {
          const dur = parseInt(c.duration?.[0] || '0');
          if (dur > 0) creIdToDurationMs[c.id?.[0]] = dur;
        }
        console.log(`Creative durations found: ${Object.keys(creIdToDurationMs).length}/${allCreativeIds.length}`);

        // Map each VIDEO_ID's line item to its creative duration
        for (const [vid, data] of Object.entries(videoIdToLineItemIds)) {
          for (const liId of data.lineItemIds) {
            const cIds = liToCreativeIds[liId] || [];
            for (const cId of cIds) {
              if (creIdToDurationMs[cId]) { data.durationMs = creIdToDurationMs[cId]; break; }
            }
            if (data.durationMs > 0) break;
          }
        }
      }
    } catch(e) {
      console.warn('Creative duration lookup failed:', e.message);
    }
  }

  return videoIdToLineItemIds;
}

/**
 * Runs a GAM report for VIDEO_VIEWERSHIP_START and VIDEO_VIEWERSHIP_COMPLETE on the
 * given line item IDs, covering the last 700 days.
 * Returns a map of lineItemId → completion rate as a percentage (0–100, one decimal place).
 * Line items with zero starts are omitted to avoid division by zero.
 */
async function fetchVideoCompletionByLineItem(lineItemIds, networkCode, token) {
  if (!lineItemIds.length) return {};
  const now = new Date();
  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startD = new Date(now); startD.setDate(startD.getDate() - 700);
  const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };
  const idList = [...new Set(lineItemIds)].join(', ');

  const queryXml = `
    <dimensions>LINE_ITEM_ID</dimensions>
    <columns>VIDEO_VIEWERSHIP_START</columns>
    <columns>VIDEO_VIEWERSHIP_COMPLETE</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
    <statement><query>WHERE LINE_ITEM_ID IN (${idList})</query></statement>`;

  const csvText = await runReportAndDownload(queryXml, networkCode, token);
  const lines = csvText.split('\n').filter(Boolean);
  console.log('Video completion CSV header:', lines[0]);
  const byLineItem = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const liId = cols[0];
    const starts    = parseFloat(cols[1] || '0');
    const completes = parseFloat(cols[2] || '0');
    if (liId && starts > 0) {
      byLineItem[liId] = parseFloat(((completes / starts) * 100).toFixed(1));
    }
  }
  return byLineItem;
}

module.exports = { fetchVideoLineItemsByVideoIds, fetchVideoCompletionByLineItem };
