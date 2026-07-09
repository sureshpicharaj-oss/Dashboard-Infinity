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
const { GAM_SOAP_NS, GAM_SOAP_ENDPOINT, GAM_LICA_SOAP_ENDPOINT, GAM_LINEITEM_SOAP_ENDPOINT, GAM_CUSTOM_TARGETING_ENDPOINT, GAM_INVENTORY_SOAP_ENDPOINT, EXCLUDED_ORDER_IDS } = require('../config');
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
  if (!videoIds.length) return { videoIdToData: {}, valueIdToVideoId: {} };
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

  // Look up the flix ad unit ID so the line item scan can be filtered to that inventory.
  // All Flix video tracking line items live under tracking.immediate.co.uk/flix — querying
  // only those reduces the scan from hundreds of network-wide line items to a handful.
  let flixAdUnitId = null;
  try {
    // First find the parent ad unit (tracking.immediate.co.uk), then find its flix child.
    // This disambiguates when multiple ad units share the name 'flix' across different parents.
    const parentSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getAdUnitsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE name = 'tracking.immediate.co.uk' LIMIT 5</query></filterStatement>
    </getAdUnitsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
    const parentRes = await axios.post(GAM_INVENTORY_SOAP_ENDPOINT, parentSoap, {
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000,
    });
    const parentParsed = await xml2js.parseStringPromise(parentRes.data);
    const parentUnits = parentParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getAdUnitsByStatementResponse']?.[0]?.rval?.[0]?.results || [];
    const parentId = parentUnits[0]?.id?.[0];

    if (parentId) {
      const invSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getAdUnitsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE name = 'flix' AND parentId = '${parentId}' LIMIT 5</query></filterStatement>
    </getAdUnitsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const invRes = await axios.post(GAM_INVENTORY_SOAP_ENDPOINT, invSoap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000,
      });
      const invParsed = await xml2js.parseStringPromise(invRes.data);
      const adUnits = invParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getAdUnitsByStatementResponse']?.[0]?.rval?.[0]?.results || [];
      if (adUnits.length >= 1) {
        flixAdUnitId = adUnits[0].id?.[0];
        console.log(`Flix ad unit ID: ${flixAdUnitId}`);
      } else {
        console.warn('No flix ad unit found under tracking.immediate.co.uk — scanning all SPONSORSHIP/HOUSE line items');
      }
    } else {
      console.warn('Parent ad unit tracking.immediate.co.uk not found — scanning all SPONSORSHIP/HOUSE line items');
    }
  } catch(e) {
    console.warn('Flix ad unit lookup failed:', e.message);
  }

  // Step 2: Fetch SPONSORSHIP and HOUSE line items only — all known video tracking line items
  // use these types. STANDARD and PRICE_PRIORITY are excluded to avoid scanning thousands of
  // irrelevant line items. Within each page, only 1×1v (VIDEO creative size) line items are
  // checked, since all Flix video tracking line items carry a 1×1 VIDEO placeholder.
  const excludeClause = EXCLUDED_ORDER_IDS.map(id => `AND orderId != ${id}`).join(' ');
  const lineItemTypes = ['SPONSORSHIP', 'HOUSE'];
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

        // Skip line items not targeting the flix ad unit (when we have its ID).
        // Inventory targeting may include the ad unit directly or via a parent with includeDescendants.
        if (flixAdUnitId) {
          const targetedAdUnits = li.targeting?.[0]?.inventoryTargeting?.[0]?.targetedAdUnits || [];
          const targetsFllix = targetedAdUnits.some(u => u.adUnitId?.[0] === flixAdUnitId);
          if (!targetsFllix) continue;
        }

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
            // Find the creativeTargetings slot that contains this VIDEO_ID's value ID.
            // The slot name is stored so the LICA loop can resolve targetingName → VIDEO_ID
            // via key values rather than creative naming conventions.
            if (!videoIdToLineItemIds[videoName].creativeTargetingName) {
              for (const slot of (li.creativeTargetings || [])) {
                const slotName = slot.name?.[0];
                if (!slotName) continue;
                if (findCustomTargetingValueIds(slot.targeting?.[0]).includes(valId)) {
                  videoIdToLineItemIds[videoName].creativeTargetingName = slotName;
                  break;
                }
              }
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

      // Fetch LICAs for matched line items — paginated, no status filter so inactive/completed
      // campaigns are included for historical completion rate data.
      const licaPageSize = 500;
      let licaOffset = 0;
      const allLicas = [];
      while (true) {
        const licaSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemCreativeAssociationsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE lineItemId IN (${liIdList}) LIMIT ${licaPageSize} OFFSET ${licaOffset}</query></filterStatement>
    </getLineItemCreativeAssociationsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
        const licaRes = await axios.post(GAM_LICA_SOAP_ENDPOINT, licaSoap, {
          headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 30000,
        });
        const licaParsed = await xml2js.parseStringPromise(licaRes.data);
        const licaRval = licaParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemCreativeAssociationsByStatementResponse']?.[0]?.rval?.[0];
        const page = licaRval?.results || [];
        const licaTotal = parseInt(licaRval?.totalResultSetSize?.[0] || '0');
        allLicas.push(...page);
        licaOffset += licaPageSize;
        if (licaOffset >= licaTotal) break;
      }
      console.log(`LICAs fetched: ${allLicas.length}`);

      // lineItemId → [creativeId, ...]
      const liToCreativeIds = {};
      for (const lica of allLicas) {
        const liId = lica.lineItemId?.[0]; const cId = lica.creativeId?.[0];
        if (liId && cId) { if (!liToCreativeIds[liId]) liToCreativeIds[liId] = []; liToCreativeIds[liId].push(cId); }

        // Primary: match via LICA targetingName looked up against the key-value-derived slot map.
        // creativeTargetingName is set in Step 2 by scanning creativeTargetings value IDs, so
        // the mapping is based on actual GAM key values, not creative naming conventions.
        const tName = lica.targetingName?.[0];
        if (tName && cId) {
          for (const [videoName, data] of Object.entries(videoIdToLineItemIds)) {
            if (data.creativeTargetingName === tName && data.lineItemIds.includes(liId)) {
              if (!data.trackingCreativeId) {
                data.trackingCreativeId = cId;
                // Read video delivery stats directly from the LICA object. GAM populates these
                // at the association level — this is the same source the UI uses for per-creative
                // completion rates, without needing a separate report job.
                const licaStats = lica.stats?.[0];
                const licaStarts   = parseInt(licaStats?.videoStartsDelivered?.[0]   || '0');
                const licaCompletes = parseInt(licaStats?.videoCompletionsDelivered?.[0] || '0');
                if (licaStarts > 0) {
                  data.licaStarts   = (data.licaStarts   || 0) + licaStarts;
                  data.licaCompletes = (data.licaCompletes || 0) + licaCompletes;
                }
                console.log(`LICA targetingName match: "${videoName}" -> creative ${cId} (slot "${tName}") starts=${licaStarts} completes=${licaCompletes}`);
              }
              break;
            }
          }
        }
        // Fallback: search LICA targeting object for matching value IDs (older setup without named slots)
        const licaValueIds = findCustomTargetingValueIds(lica.targeting?.[0]);
        for (const valId of licaValueIds) {
          const videoName = valueIdToVideoId[valId];
          if (videoName && cId && videoIdToLineItemIds[videoName] && !videoIdToLineItemIds[videoName].trackingCreativeId) {
            videoIdToLineItemIds[videoName].trackingCreativeId = cId;
            const licaStats = lica.stats?.[0];
            const licaStarts    = parseInt(licaStats?.videoStartsDelivered?.[0]    || '0');
            const licaCompletes = parseInt(licaStats?.videoCompletionsDelivered?.[0] || '0');
            if (licaStarts > 0) {
              videoIdToLineItemIds[videoName].licaStarts    = (videoIdToLineItemIds[videoName].licaStarts    || 0) + licaStarts;
              videoIdToLineItemIds[videoName].licaCompletes = (videoIdToLineItemIds[videoName].licaCompletes || 0) + licaCompletes;
            }
            console.log(`LICA targeting match: "${videoName}" -> creative ${cId} in LI ${liId} starts=${licaStarts} completes=${licaCompletes}`);
          }
        }
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
        // Build name → videoId from the creatives we fetched via LICA.
        // We'll use these names to find any other creatives sharing the same name
        // (e.g. old tracking creatives whose LICAs were deleted but whose names match).
        const creativeIdToName = {};
        for (const c of creatives) {
          const cId = c.id?.[0];
          const dur = parseInt(c.duration?.[0] || '0');
          if (dur > 0) creIdToDurationMs[cId] = dur;
          if (cId && c.name?.[0]) creativeIdToName[cId] = c.name[0];
        }
        console.log(`Creative durations found: ${Object.keys(creIdToDurationMs).length}/${allCreativeIds.length}`);

        // Map each VIDEO_ID's line item to its creative duration, and store the tracking
        // creative's name so the route can build a lineItemId+name → videoId index.
        for (const [vid, data] of Object.entries(videoIdToLineItemIds)) {
          if (data.trackingCreativeId && creativeIdToName[data.trackingCreativeId]) {
            data.trackingCreativeName = creativeIdToName[data.trackingCreativeId];
          }
          for (const liId of data.lineItemIds) {
            const cIds = liToCreativeIds[liId] || [];
            for (const cId of cIds) {
              if (creIdToDurationMs[cId]) { data.durationMs = creIdToDurationMs[cId]; break; }
            }
            if (data.durationMs > 0) break;
          }
        }

        // For each VIDEO_ID that has a trackingCreativeId with a known name, search for all
        // other creatives sharing that exact name. This finds older tracking creatives (e.g.
        // 740... series) that have video completion data but no longer have active LICAs.
        // Only include names that exactly equal a VIDEO_ID — generic creative names
        // like "Apple - 1x1v - 12/3/2026" would match unrelated creatives.
        const videoIdSet = new Set(uniqueIds);
        const nameToVideoId = {};
        for (const [vid, data] of Object.entries(videoIdToLineItemIds)) {
          if (data.trackingCreativeId) {
            const cName = creativeIdToName[data.trackingCreativeId];
            if (cName && videoIdSet.has(cName)) nameToVideoId[cName] = vid;
          }
        }
        const distinctNames = Object.keys(nameToVideoId);
        if (distinctNames.length) {
          // Batch into groups of 15 to stay within GAM PQL limits
          const batchSize = 15;
          const allNameMatches = [];
          for (let i = 0; i < distinctNames.length; i += batchSize) {
            const batch = distinctNames.slice(i, i + batchSize);
            const nameList = batch.map(n => `'${n.replace(/'/g, "''")}'`).join(', ');
            const nameSearchSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getCreativesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE name IN (${nameList}) LIMIT 500</query></filterStatement>
    </getCreativesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
            try {
              const nsRes = await axios.post(GAM_SOAP_ENDPOINT, nameSearchSoap, {
                headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 20000,
              });
              const nsParsed = await xml2js.parseStringPromise(nsRes.data);
              const batchResults = nsParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativesByStatementResponse']?.[0]?.rval?.[0]?.results || [];
              allNameMatches.push(...batchResults);
            } catch(e) {
              console.warn(`Name-based creative search batch ${i}–${i+batchSize} failed:`, e.message);
            }
          }
          console.log(`Name-based creative search: ${allNameMatches.length} creatives found for ${distinctNames.length} names`);
          for (const c of allNameMatches) {
            const cId = c.id?.[0];
            const cName = c.name?.[0];
            const vid = nameToVideoId[cName];
            if (vid && cId && cId !== videoIdToLineItemIds[vid]?.trackingCreativeId) {
              if (!videoIdToLineItemIds[vid].additionalCreativeIds) videoIdToLineItemIds[vid].additionalCreativeIds = [];
              videoIdToLineItemIds[vid].additionalCreativeIds.push(cId);
            }
          }
        }
      }
    } catch(e) {
      console.warn('Creative duration lookup failed:', e.message);
    }
  }

  return { videoIdToData: videoIdToLineItemIds, valueIdToVideoId };
}

/**
 * Runs a GAM report dimensioned by LINE_ITEM_ID + CUSTOM_TARGETING_VALUE_ID, querying
 * VIDEO_VIEWERSHIP_START and VIDEO_VIEWERSHIP_COMPLETE. Because the flix tracking line
 * items use creative-targeting slots keyed on each VIDEO_ID's custom targeting value,
 * GAM attributes video events to the active slot's value at delivery time — giving true
 * per-VIDEO_ID rates without relying on creative IDs or creative names.
 *
 * Returns a map of videoId → completionRate (percentage, 1 decimal place).
 */
async function fetchVideoCompletionByValueId(lineItemIds, valueIdToVideoId, networkCode, token) {
  if (!lineItemIds.length) return {};
  const now = new Date();
  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startD = new Date(now); startD.setDate(startD.getDate() - 700);
  const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };
  const idList = [...new Set(lineItemIds)].join(', ');

  const queryXml = `
    <dimensions>LINE_ITEM_ID</dimensions>
    <dimensions>CUSTOM_TARGETING_VALUE_ID</dimensions>
    <columns>VIDEO_VIEWERSHIP_START</columns>
    <columns>VIDEO_VIEWERSHIP_COMPLETE</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
    <statement><query>WHERE LINE_ITEM_ID IN (${idList})</query></statement>`;

  const csvText = await runReportAndDownload(queryXml, networkCode, token);
  const lines = csvText.split('\n').filter(Boolean);
  console.log('Video completion by value CSV header:', lines[0]);

  // Each row: LINE_ITEM_ID, CUSTOM_TARGETING_VALUE_ID, VIDEO_VIEWERSHIP_START, VIDEO_VIEWERSHIP_COMPLETE
  // Accumulate starts/completes per VALUE_ID (in case a VIDEO_ID spans multiple line items)
  const rawByValueId = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const valueId  = cols[1];
    const starts   = parseFloat(cols[2]) || 0;
    const completes = parseFloat(cols[3]) || 0;
    if (!valueId || starts === 0) continue;
    const videoId = valueIdToVideoId[valueId];
    if (!videoId) continue;
    if (!rawByValueId[videoId]) rawByValueId[videoId] = { starts: 0, completes: 0 };
    rawByValueId[videoId].starts    += starts;
    rawByValueId[videoId].completes += completes;
  }

  const byVideoId = {};
  for (const [vid, raw] of Object.entries(rawByValueId)) {
    if (raw.starts > 0) byVideoId[vid] = parseFloat(((raw.completes / raw.starts) * 100).toFixed(1));
  }
  console.log(`Video completion by value ID: ${Object.keys(byVideoId).length}/${Object.keys(valueIdToVideoId).length} video IDs have data`);
  return byVideoId;
}

/**
 * Runs a GAM report for VIDEO_VIEWERSHIP_START and VIDEO_VIEWERSHIP_COMPLETE, segmented
 * by LINE_ITEM_ID and CREATIVE_ID. Returns:
 *   { lineItemId → { byCreative: { creativeId → rate }, aggregate: rate } }
 *
 * Used as a fallback when the value-ID approach returns no data for a VIDEO_ID.
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
    <dimensions>CREATIVE_ID</dimensions>
    <dimensions>CREATIVE_NAME</dimensions>
    <dimensions>DEVICE_CATEGORY_NAME</dimensions>
    <columns>VIDEO_VIEWERSHIP_START</columns>
    <columns>VIDEO_VIEWERSHIP_COMPLETE</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
    <statement><query>WHERE LINE_ITEM_ID IN (${idList})</query></statement>`;

  const csvText = await runReportAndDownload(queryXml, networkCode, token);
  const lines = csvText.split('\n').filter(Boolean);
  console.log('Video completion CSV header:', lines[0]);

  // Each row: LINE_ITEM_ID, CREATIVE_ID, CREATIVE_NAME, DEVICE_CATEGORY_NAME, VIDEO_VIEWERSHIP_START, VIDEO_VIEWERSHIP_COMPLETE
  const rawByLineItem = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const liId        = cols[0];
    const creativeId  = cols[1] || null;
    const creativeName = cols[2] || '';
    const device      = cols[3] || '';
    const starts      = parseFloat(cols[4]) || 0;
    const completes   = parseFloat(cols[5]) || 0;
    if (!liId) continue;
    if (!rawByLineItem[liId]) rawByLineItem[liId] = { byCreative: {}, byDevice: {}, totStarts: 0, totCompletes: 0 };
    rawByLineItem[liId].totStarts    += starts;
    rawByLineItem[liId].totCompletes += completes;
    if (device) {
      if (!rawByLineItem[liId].byDevice[device]) rawByLineItem[liId].byDevice[device] = { totStarts: 0, totCompletes: 0 };
      rawByLineItem[liId].byDevice[device].totStarts    += starts;
      rawByLineItem[liId].byDevice[device].totCompletes += completes;
    }
    if (creativeId && creativeId !== '0' && starts > 0) {
      if (!rawByLineItem[liId].byCreative[creativeId]) rawByLineItem[liId].byCreative[creativeId] = { starts: 0, completes: 0, name: creativeName, byDevice: {} };
      rawByLineItem[liId].byCreative[creativeId].starts    += starts;
      rawByLineItem[liId].byCreative[creativeId].completes += completes;
      if (device) {
        if (!rawByLineItem[liId].byCreative[creativeId].byDevice[device]) rawByLineItem[liId].byCreative[creativeId].byDevice[device] = { starts: 0, completes: 0 };
        rawByLineItem[liId].byCreative[creativeId].byDevice[device].starts    += starts;
        rawByLineItem[liId].byCreative[creativeId].byDevice[device].completes += completes;
      }
    }
  }

  const byLineItem = {};
  for (const [liId, raw] of Object.entries(rawByLineItem)) {
    const byCreative = {};
    for (const [cId, c] of Object.entries(raw.byCreative)) {
      byCreative[cId] = { rate: parseFloat(((c.completes / c.starts) * 100).toFixed(1)), name: c.name || '', starts: c.starts, byDevice: c.byDevice };
    }
    const byDevice = {};
    for (const [dev, d] of Object.entries(raw.byDevice)) {
      if (d.totStarts > 0) byDevice[dev] = { totStarts: d.totStarts, totCompletes: d.totCompletes };
    }
    const aggregate = raw.totStarts > 0 ? parseFloat(((raw.totCompletes / raw.totStarts) * 100).toFixed(1)) : null;
    byLineItem[liId] = { byCreative, byDevice, aggregate, totStarts: raw.totStarts };
  }

  console.log(`Video completion data: ${Object.keys(byLineItem).length} line items`);
  return byLineItem;
}

/**
 * Runs a GAM report dimensioned by CREATIVE_ID only, querying VIDEO_VIEWERSHIP_START and
 * VIDEO_VIEWERSHIP_COMPLETE for a specific list of creative IDs. This avoids the LINE_ITEM_ID
 * dependency entirely — given the trackingCreativeId for each VIDEO_ID (resolved via LICA
 * targetingName → key-value slot), we can query completion rates per creative directly.
 *
 * Returns a map of creativeId → completionRate (percentage, 1 decimal place).
 */
async function fetchVideoCompletionByCreativeId(creativeIds, networkCode, token) {
  if (!creativeIds.length) return {};
  const now = new Date();
  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startD = new Date(now); startD.setDate(startD.getDate() - 700);
  const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };
  const idList = [...new Set(creativeIds)].join(', ');

  const queryXml = `
    <dimensions>CREATIVE_ID</dimensions>
    <columns>VIDEO_VIEWERSHIP_START</columns>
    <columns>VIDEO_VIEWERSHIP_COMPLETE</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
    <statement><query>WHERE CREATIVE_ID IN (${idList})</query></statement>`;

  const csvText = await runReportAndDownload(queryXml, networkCode, token);
  const lines = csvText.split('\n').filter(Boolean);
  console.log('Video completion by creative CSV header:', lines[0]);
  console.log(`Video completion by creative: ${lines.length - 1} data rows for ${creativeIds.length} creatives`);

  // Each row: CREATIVE_ID, VIDEO_VIEWERSHIP_START, VIDEO_VIEWERSHIP_COMPLETE
  const byCreativeId = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const creativeId = cols[0];
    const starts     = parseFloat(cols[1]) || 0;
    const completes  = parseFloat(cols[2]) || 0;
    if (!creativeId || starts === 0) continue;
    if (!byCreativeId[creativeId]) byCreativeId[creativeId] = { starts: 0, completes: 0 };
    byCreativeId[creativeId].starts    += starts;
    byCreativeId[creativeId].completes += completes;
  }

  const result = {};
  for (const [cId, raw] of Object.entries(byCreativeId)) {
    if (raw.starts > 0) result[cId] = { rate: parseFloat(((raw.completes / raw.starts) * 100).toFixed(1)), starts: raw.starts };
  }
  console.log(`Video completion by creative ID: ${Object.keys(result).length}/${creativeIds.length} have data`);
  return result;
}

module.exports = { fetchVideoLineItemsByVideoIds, fetchVideoCompletionByCreativeId, fetchVideoCompletionByLineItem };
