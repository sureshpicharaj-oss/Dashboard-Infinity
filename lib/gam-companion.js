'use strict';

/**
 * Maps mobile companion creative IDs to their master creative IDs via GAM's
 * CreativeSetService.
 *
 * In GAM mobile skins, the 300×250/251 companion creative carries the Netlify URL
 * (it is the visible ad unit), while the 320×50/51 master creative carries the
 * LICA impressions. The two are linked through a CreativeSet. This module queries
 * CreativeSetService — optionally scoped to a list of master creative IDs — and
 * returns a map of { companionCreativeId -> Set<masterCreativeId> } so the dashboard
 * route can join the two sets. A companion can appear in more than one creative set
 * (e.g. re-traffic reusing the same 300x250 with a new 320x50 master), so every
 * master is kept rather than only the last one seen.
 */

const axios = require('axios');
const xml2js = require('xml2js');
const { GAM_CREATIVESET_SOAP_ENDPOINT, GAM_SOAP_NS } = require('../config');
const { withRetry } = require('./utils');

// Fetches one page of creative sets and returns the raw rval.
async function fetchCreativeSetPage(networkCode, token, whereClause, offset, pageSize) {
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <RequestHeader xmlns="${GAM_SOAP_NS}">
      <networkCode>${networkCode}</networkCode>
      <applicationName>Infinity-Dashboard</applicationName>
    </RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <getCreativeSetsByStatement xmlns="${GAM_SOAP_NS}">
      <statement>
        <query>${whereClause}LIMIT ${pageSize} OFFSET ${offset}</query>
      </statement>
    </getCreativeSetsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
  const res = await withRetry(() => axios.post(GAM_CREATIVESET_SOAP_ENDPOINT, soap, {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
    timeout: 30000,
  }), { label: 'getCreativeSetsByStatement' });
  const parsed = await xml2js.parseStringPromise(res.data);
  return parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativeSetsByStatementResponse']?.[0]?.rval?.[0];
}

function extractPairs(results, companionToMaster) {
  for (const set of (results || [])) {
    const masterId = set.masterCreativeId?.[0];
    const companionIds = Array.isArray(set.companionCreativeIds) ? set.companionCreativeIds : [];
    for (const cid of companionIds) {
      const companionId = typeof cid === 'string' ? cid.trim() : String(cid);
      if (masterId && companionId) {
        if (!companionToMaster[companionId]) companionToMaster[companionId] = new Set();
        companionToMaster[companionId].add(String(masterId).trim());
      }
    }
  }
}

/**
 * Fetches all CreativeSets (optionally filtered to the given master IDs) and returns
 * a map of companionCreativeId → masterCreativeId.
 *
 * When masterIds is null, fetches ALL creative sets using parallel page requests
 * (same pattern as fetchCreativesViaSoap) to avoid sequential sequential page-by-page waits.
 *
 * @param {string}   networkCode    GAM network code
 * @param {string}   token          OAuth2 bearer token
 * @param {string[]} [masterIds]    Scope to these master IDs. Pass null to fetch all sets.
 * @returns {Promise<Object>}  { [companionId]: Set<masterCreativeId> }
 */
async function fetchCompanionToMasterMap(networkCode, token, masterIds = null) {
  const pageSize = 500;
  const BATCH = 10;
  const companionToMaster = {};

  if (masterIds === null) {
    // Fetch all creative sets in parallel: first page gives the total, remaining pages fan out.
    const firstPage = await fetchCreativeSetPage(networkCode, token, '', 0, pageSize);
    if (!firstPage) return companionToMaster;
    const total = parseInt(firstPage.totalResultSetSize?.[0] || '0');
    extractPairs(firstPage.results, companionToMaster);

    if (total > pageSize) {
      const offsets = [];
      for (let offset = pageSize; offset < total; offset += pageSize) offsets.push(offset);
      for (let i = 0; i < offsets.length; i += BATCH) {
        const batch = offsets.slice(i, i + BATCH);
        const pages = await Promise.all(batch.map(off => fetchCreativeSetPage(networkCode, token, '', off, pageSize)));
        for (const page of pages) { if (page) extractPairs(page.results, companionToMaster); }
      }
    }
    return companionToMaster;
  }

  // Scoped fetch: split master IDs into batches of 500, each fetched sequentially (usually 1 page each).
  const masterIdList = [...masterIds];
  const idBatches = Array.from({ length: Math.ceil(masterIdList.length / 500) }, (_, i) => masterIdList.slice(i * 500, (i + 1) * 500));

  for (const idBatch of idBatches) {
    const whereClause = `WHERE masterCreativeId IN (${idBatch.join(', ')}) `;
    let offset = 0;
    let total = null;
    while (total === null || offset < total) {
      const rval = await fetchCreativeSetPage(networkCode, token, whereClause, offset, pageSize);
      if (!rval) break;
      total = parseInt(rval.totalResultSetSize?.[0] || '0');
      extractPairs(rval.results, companionToMaster);
      offset += pageSize;
      if (!rval.results || rval.results.length === 0) break;
    }
  }

  return companionToMaster;
}

module.exports = { fetchCompanionToMasterMap };
