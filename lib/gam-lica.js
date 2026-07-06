'use strict';

/**
 * Fetches impression and click stats from the GAM LineItemCreativeAssociationService (LICA).
 * LICA returns all-time cumulative delivery per creative synchronously — no async report job
 * needed. This makes it the fastest source of impression counts, but it only covers
 * creatives that are directly associated with line items (not rendered creatives in AV reports).
 *
 * Also provides a helper to collect creative IDs that belong to excluded orders, so they can
 * be filtered out of the dashboard before any other processing.
 */

const axios = require('axios');
const xml2js = require('xml2js');
const { GAM_SOAP_NS, GAM_LICA_SOAP_ENDPOINT, GAM_LINEITEM_SOAP_ENDPOINT, EXCLUDED_ORDER_IDS } = require('../config');

/**
 * Queries LICA for all line item associations of the given creative IDs and returns
 * three maps keyed by creativeId:
 *   statsByCreativeId     — { impressions, clicks } totalled across all line items
 *   lineItemsByCreativeId — Set of line item IDs the creative appears in
 *   impsByCreativeAndLI   — { lineItemId: impressionCount } for non-zero rows only
 *
 * netlifyIds is the list of GAM creative IDs to look up (named for their Netlify-hosted content).
 * Queried in batches of 100 IDs with internal LICA pagination (500 rows per page) because
 * GAM's IN clause has a practical limit and LICA can return many rows per creative.
 */
async function fetchCreativeLICAStats(netlifyIds, networkCode, token) {
  // Returns map: creativeId -> { impressions, clicks }
  // Uses LICA impressionsDelivered/clicksDelivered — all-time, per-creative, no report needed
  const statsByCreativeId = {};
  const lineItemsByCreativeId = {};
  const impsByCreativeAndLI = {};
  const batchSize = 100;

  for (let i = 0; i < netlifyIds.length; i += batchSize) {
    const batch = netlifyIds.slice(i, i + batchSize);
    let offset = 0;
    let total = null;

    while (total === null || offset < total) {
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <RequestHeader xmlns="${GAM_SOAP_NS}">
      <networkCode>${networkCode}</networkCode>
      <applicationName>Infinity-Dashboard</applicationName>
    </RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <getLineItemCreativeAssociationsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement>
        <query>WHERE creativeId IN (${batch.join(', ')}) LIMIT 500 OFFSET ${offset}</query>
      </filterStatement>
    </getLineItemCreativeAssociationsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
      const res = await axios.post(GAM_LICA_SOAP_ENDPOINT, soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
        timeout: 30000,
      });
      const parsed = await xml2js.parseStringPromise(res.data);
      const rval = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemCreativeAssociationsByStatementResponse']?.[0]?.rval?.[0];
      if (!rval) break;
      total = parseInt(rval.totalResultSetSize?.[0] || '0');
      const results = rval.results || [];

      for (const lica of results) {
        const creativeId = lica.creativeId?.[0];
        const lineItemId = lica.lineItemId?.[0];
        const imps   = parseInt(lica.stats?.[0]?.stats?.[0]?.impressionsDelivered?.[0] || '0');
        const clicks = parseInt(lica.stats?.[0]?.stats?.[0]?.clicksDelivered?.[0]    || '0');
        if (creativeId) {
          if (!statsByCreativeId[creativeId]) statsByCreativeId[creativeId] = { impressions: 0, clicks: 0 };
          statsByCreativeId[creativeId].impressions += isNaN(imps)   ? 0 : imps;
          statsByCreativeId[creativeId].clicks      += isNaN(clicks) ? 0 : clicks;
          if (lineItemId) {
            if (!lineItemsByCreativeId[creativeId]) lineItemsByCreativeId[creativeId] = new Set();
            lineItemsByCreativeId[creativeId].add(lineItemId);
            if (!isNaN(imps) && imps > 0) {
              if (!impsByCreativeAndLI[creativeId]) impsByCreativeAndLI[creativeId] = {};
              impsByCreativeAndLI[creativeId][lineItemId] = (impsByCreativeAndLI[creativeId][lineItemId] || 0) + imps;
            }
          }
        }
      }

      offset += 500;
      if (results.length === 0) break;
    }
  }

  return { statsByCreativeId, lineItemsByCreativeId, impsByCreativeAndLI };
}

/**
 * Returns a Set of creative IDs that belong to any order in EXCLUDED_ORDER_IDS.
 * Because GAM has no direct order→creative query, this does a two-hop lookup:
 * excluded orders → their line item IDs → creative IDs via LICA.
 * Failures are caught and logged rather than thrown, so the dashboard still loads
 * with an empty exclusion set rather than crashing.
 */
async function fetchExcludedCreativeIds(networkCode, token) {
  if (!EXCLUDED_ORDER_IDS.length) return new Set();
  const excluded = new Set();
  try {
    const orderIdList = EXCLUDED_ORDER_IDS.join(', ');
    // Get line item IDs for excluded orders
    const liSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE orderId IN (${orderIdList}) LIMIT 500</query></filterStatement>
    </getLineItemsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
    const liRes = await axios.post(GAM_LINEITEM_SOAP_ENDPOINT, liSoap, {
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000,
    });
    const liParsed = await xml2js.parseStringPromise(liRes.data);
    const lineItems = liParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemsByStatementResponse']?.[0]?.rval?.[0]?.results || [];
    const liIds = lineItems.map(li => li.id?.[0]).filter(Boolean);
    if (!liIds.length) return excluded;

    // Get all creative IDs associated with those line items
    const liIdList = liIds.join(', ');
    const licaSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getLineItemCreativeAssociationsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE lineItemId IN (${liIdList}) LIMIT 500</query></filterStatement>
    </getLineItemCreativeAssociationsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
    const licaRes = await axios.post(GAM_LICA_SOAP_ENDPOINT, licaSoap, {
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000,
    });
    const licaParsed = await xml2js.parseStringPromise(licaRes.data);
    const licas = licaParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemCreativeAssociationsByStatementResponse']?.[0]?.rval?.[0]?.results || [];
    for (const lica of licas) {
      const cId = lica.creativeId?.[0];
      if (cId) excluded.add(cId);
    }
    console.log(`Excluded ${excluded.size} creative IDs from order(s) ${EXCLUDED_ORDER_IDS.join(', ')}`);
  } catch(e) {
    console.warn('fetchExcludedCreativeIds failed:', e.message);
  }
  return excluded;
}

module.exports = { fetchCreativeLICAStats, fetchExcludedCreativeIds };
