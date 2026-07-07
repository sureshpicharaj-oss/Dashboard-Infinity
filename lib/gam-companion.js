'use strict';

/**
 * Maps mobile companion creative IDs to their master creative IDs via GAM's
 * CreativeSetService.
 *
 * In GAM mobile skins, the 300×250/251 companion creative carries the Netlify URL
 * (it is the visible ad unit), while the 320×50/51 master creative carries the
 * LICA impressions. The two are linked through a CreativeSet. This module queries
 * CreativeSetService — optionally scoped to a list of master creative IDs — and
 * returns a flat map of { companionCreativeId → masterCreativeId } so the dashboard
 * route can join the two sets.
 */

const axios = require('axios');
const xml2js = require('xml2js');
const { GAM_CREATIVESET_SOAP_ENDPOINT, GAM_SOAP_NS } = require('../config');

/**
 * Fetches all CreativeSets (optionally filtered to the given master IDs) and returns
 * a map of companionCreativeId → masterCreativeId.
 *
 * @param {string}   networkCode    GAM network code
 * @param {string}   token          OAuth2 bearer token
 * @param {string[]} [masterIds]    If supplied, only queries sets whose masterCreativeId
 *                                  is in this list. Pass null/undefined to fetch all sets.
 * @returns {Promise<Object>}  { [companionId]: masterCreativeId }
 */
async function fetchCompanionToMasterMap(networkCode, token, masterIds = null) {
  const pageSize = 500;
  const companionToMaster = {};

  const masterIdList = masterIds ? [...masterIds] : null;
  // Split master IDs into batches of 500 to stay within GAM's IN() clause limits.
  // If no master IDs were provided, a single null batch fetches all creative sets.
  const batches = masterIdList
    ? Array.from({ length: Math.ceil(masterIdList.length / 500) }, (_, i) => masterIdList.slice(i * 500, (i + 1) * 500))
    : [null];

  for (const batch of batches) {
    let offset = 0;
    let total = null;
    const whereClause = batch ? `WHERE masterCreativeId IN (${batch.join(', ')}) ` : '';

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
    <getCreativeSetsByStatement xmlns="${GAM_SOAP_NS}">
      <statement>
        <query>${whereClause}LIMIT ${pageSize} OFFSET ${offset}</query>
      </statement>
    </getCreativeSetsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;

      const res = await axios.post(GAM_CREATIVESET_SOAP_ENDPOINT, soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
        timeout: 30000,
      });
      const parsed = await xml2js.parseStringPromise(res.data);
      const rval = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativeSetsByStatementResponse']?.[0]?.rval?.[0];
      if (!rval) break;

      total = parseInt(rval.totalResultSetSize?.[0] || '0');
      const results = rval.results || [];

      for (const set of results) {
        const masterId = set.masterCreativeId?.[0];
        const companionIds = Array.isArray(set.companionCreativeIds) ? set.companionCreativeIds : [];
        for (const cid of companionIds) {
          const companionId = typeof cid === 'string' ? cid.trim() : String(cid);
          if (masterId && companionId) {
            companionToMaster[companionId] = String(masterId).trim();
          }
        }
      }

      offset += pageSize;
      if (results.length === 0) break;
    }
  }

  return companionToMaster;
}

module.exports = { fetchCompanionToMasterMap };
