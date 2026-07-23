'use strict';

/**
 * Fetches dashboard template creatives from GAM via the SOAP CreativeService.
 *
 * Supports three size types:
 *   - 'desktop' (default): 970×249/250/251px skin template creatives — the eight
 *     known desktop skin template IDs. The Netlify URL lives on the creative itself.
 *   - 'mobile-companion': 300×250/251px — carry the Netlify URL for mobile skins.
 *     Filtered to template IDs: 12350359, 12381157, 12439909, 12517322, 12522680, 12528680
 *     (verified by scanning all 300×250 creatives in the network for Netlify URLs).
 *   - 'mobile-master': 320×50/51px — pixel creatives that carry the LICA stats.
 *     Their Netlify URL is obtained via the companion→master mapping in gam-companion.js.
 *
 * Results are paged in batches of 500 with up to 10 concurrent requests per batch.
 */

const axios = require('axios');
const xml2js = require('xml2js');
const { GAM_SOAP_ENDPOINT, GAM_SOAP_NS } = require('../config');
const { withRetry } = require('./utils');

/**
 * Builds the SOAP envelope for a single paged CreativeService query.
 *
 * sizeType controls which creatives are requested:
 *   'mobile-companion' — 300×250/251 (companion ad units carrying the Netlify URL)
 *   'mobile-master'    — 320×50/51   (master pixel units carrying LICA impressions)
 *   'desktop'          — 970×249/250/251 filtered to the eight known template IDs
 */
function buildSoapEnvelope(networkCode, offset, pageSize, sizeType = 'desktop') {
  let query;
  if (sizeType === 'mobile-companion') {
    // Template IDs verified by querying all 300x250/251 creatives with Netlify URLs.
    // Scoping to these avoids scanning all 36k+ 300x250 creatives in the network.
    query = `WHERE creativeTemplateId IN (12338205, 12350359, 12381157, 12415237, 12439909, 12517322, 12522680, 12522683, 12528680) AND ((width = 300 AND height = 250) OR (width = 300 AND height = 251)) LIMIT ${pageSize} OFFSET ${offset}`;
  } else if (sizeType === 'mobile-master') {
    query = `WHERE ((width = 320 AND height = 50) OR (width = 320 AND height = 51)) LIMIT ${pageSize} OFFSET ${offset}`;
  } else {
    query = `WHERE creativeTemplateId IN (12338205, 12391253, 12430810, 12479439, 12514886, 12517019, 12522683, 12523354) AND ((width = 970 AND height = 249) OR (width = 970 AND height = 250) OR (width = 970 AND height = 251)) LIMIT ${pageSize} OFFSET ${offset}`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
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
        <query>${query}</query>
      </filterStatement>
    </getCreativesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
}

// Executes one page request and returns the raw rval object from the parsed SOAP response.
async function fetchPage(networkCode, token, offset, pageSize, sizeType = 'desktop') {
  const response = await withRetry(() => axios.post(GAM_SOAP_ENDPOINT, buildSoapEnvelope(networkCode, offset, pageSize, sizeType), {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
    timeout: 30000,
  }), { label: `fetchPage(${sizeType} offset ${offset})` });
  const parsed = await xml2js.parseStringPromise(response.data);
  const body = parsed['soap:Envelope']?.['soap:Body']?.[0];
  const rval = body?.['getCreativesByStatementResponse']?.[0]?.rval?.[0];
  return rval;
}

/**
 * Fetches all matching template creatives across however many pages GAM requires.
 * The first page is always fetched synchronously to learn the total result count.
 * Subsequent pages are fetched in parallel batches of 10 to balance speed against
 * GAM's undocumented rate limits.
 *
 * @param {string} networkCode  GAM network code
 * @param {string} token        OAuth2 bearer token
 * @param {string} [sizeType]   'desktop' | 'mobile-companion' | 'mobile-master'
 */
async function fetchCreativesViaSoap(networkCode, token, sizeType = 'desktop') {
  const pageSize = 500;

  const firstPage = await fetchPage(networkCode, token, 0, pageSize, sizeType);
  if (!firstPage) return [];

  const totalResults = parseInt(firstPage.totalResultSetSize?.[0] || '0');
  const firstResults = firstPage.results || [];

  if (totalResults <= pageSize) return firstResults;

  const offsets = [];
  for (let offset = pageSize; offset < totalResults; offset += pageSize) {
    offsets.push(offset);
  }

  const BATCH = 10;
  let remaining = [...firstResults];
  for (let i = 0; i < offsets.length; i += BATCH) {
    const batch = offsets.slice(i, i + BATCH);
    const pages = await Promise.all(batch.map(offset => fetchPage(networkCode, token, offset, pageSize, sizeType)));
    for (const page of pages) {
      if (page?.results) remaining.push(...page.results);
    }
  }

  return remaining;
}

/**
 * Fetches a specific set of creatives by their IDs.
 * Used to fetch only the mobile master creatives that are linked to our
 * known Infinity companion creatives (via creative sets), instead of
 * scanning all 17,133 320×50/51 creatives in the network.
 *
 * @param {string}   networkCode  GAM network code
 * @param {string}   token        OAuth2 bearer token
 * @param {string[]} ids          Creative IDs to fetch
 * @returns {Promise<Array>}      Creative SOAP result objects
 */
async function fetchCreativesByIds(networkCode, token, ids) {
  if (!ids || ids.length === 0) return [];
  const pageSize = 500;
  const results = [];
  // Split into batches of 500 to stay within GAM's IN() clause limits
  for (let i = 0; i < ids.length; i += pageSize) {
    const batch = ids.slice(i, i + pageSize);
    const inClause = batch.join(', ');
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
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
        <query>WHERE id IN (${inClause}) LIMIT ${pageSize} OFFSET 0</query>
      </filterStatement>
    </getCreativesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
    const response = await withRetry(() => axios.post(GAM_SOAP_ENDPOINT, envelope, {
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
      timeout: 30000,
    }), { label: 'getCreativesByStatement(byId)' });
    const parsed = await xml2js.parseStringPromise(response.data);
    const rval = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativesByStatementResponse']?.[0]?.rval?.[0];
    if (rval?.results) results.push(...rval.results);
  }
  return results;
}

module.exports = { buildSoapEnvelope, fetchPage, fetchCreativesViaSoap, fetchCreativesByIds };
