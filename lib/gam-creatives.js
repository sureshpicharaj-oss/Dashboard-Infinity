'use strict';

/**
 * Fetches the dashboard's target template creatives from GAM via the SOAP CreativeService.
 * Only retrieves creatives that use one of the eight known desktop skin template IDs
 * and are sized 970×249/250/251px — the three height variants used for the skin format.
 * Results are paged in batches of 500 with up to 10 concurrent requests per batch.
 */

const axios = require('axios');
const xml2js = require('xml2js');
const { GAM_SOAP_ENDPOINT, GAM_SOAP_NS } = require('../config');

/**
 * Builds the SOAP envelope for a single paged CreativeService query.
 * The hardcoded template IDs and size constraints are intentional — the dashboard
 * only tracks desktop skin creatives and no other formats.
 */
function buildSoapEnvelope(networkCode, offset, pageSize) {
  const query = `WHERE creativeTemplateId IN (12338205, 12391253, 12430810, 12479439, 12514886, 12517019, 12522683, 12523354) AND ((width = 970 AND height = 249) OR (width = 970 AND height = 250) OR (width = 970 AND height = 251)) LIMIT ${pageSize} OFFSET ${offset}`;
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
async function fetchPage(networkCode, token, offset, pageSize) {
  const response = await axios.post(GAM_SOAP_ENDPOINT, buildSoapEnvelope(networkCode, offset, pageSize), {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
    timeout: 30000,
  });
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
 */
async function fetchCreativesViaSoap(networkCode, token) {
  const pageSize = 500;

  const firstPage = await fetchPage(networkCode, token, 0, pageSize);
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
    const pages = await Promise.all(batch.map(offset => fetchPage(networkCode, token, offset, pageSize)));
    for (const page of pages) {
      if (page?.results) remaining.push(...page.results);
    }
  }

  return remaining;
}

module.exports = { buildSoapEnvelope, fetchPage, fetchCreativesViaSoap };
