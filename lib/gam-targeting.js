'use strict';

/**
 * Helpers for working with GAM's CustomTargetingService.
 * Used to resolve VIDEO_ID targeting key IDs at runtime (rather than hard-coding them)
 * and to look up custom targeting value IDs so video-hosting line items can be found
 * by their VIDEO_ID value (e.g. "AliceSteve", "OrdWebbSkin").
 */

const axios = require('axios');
const xml2js = require('xml2js');
const { GAM_SOAP_NS, GAM_CUSTOM_TARGETING_ENDPOINT, VIDEO_TARGETING_KEY_NAMES } = require('../config');

// Fallback defaults used if the GAM lookup fails; refreshed on first use
let resolvedVideoKeyIds = ['18074515', '18004753'];

/**
 * Queries GAM for the numeric IDs of the custom targeting keys named in VIDEO_TARGETING_KEY_NAMES.
 * Updates the module-level cache so subsequent calls to findCustomTargetingValueIds can filter
 * by the correct key IDs. Falls back to the hardcoded defaults if the lookup returns nothing.
 */
async function resolveVideoTargetingKeyIds(networkCode, token) {
  const nameList = VIDEO_TARGETING_KEY_NAMES.map(n => `'${n}'`).join(', ');
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getCustomTargetingKeysByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE name IN (${nameList}) LIMIT 20</query></filterStatement>
    </getCustomTargetingKeysByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
  const res = await axios.post(GAM_CUSTOM_TARGETING_ENDPOINT, soap, {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000,
  });
  const parsed = await xml2js.parseStringPromise(res.data);
  const keys = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCustomTargetingKeysByStatementResponse']?.[0]?.rval?.[0]?.results || [];
  const ids = keys.map(k => k.id?.[0]).filter(Boolean);
  if (ids.length) {
    resolvedVideoKeyIds = ids;
    console.log(`Resolved video targeting key IDs: ${keys.map(k => `${k.name?.[0]}=${k.id?.[0]}`).join(', ')}`);
  }
  return resolvedVideoKeyIds;
}

/**
 * Recursively walks any part of a GAM line item object and collects all custom targeting
 * value IDs it finds, regardless of which key they belong to.
 * GAM nests targeting in multiple levels (targeting → customTargeting → children → …),
 * so a deep recursive search is needed rather than a single field access.
 */
function findCustomTargetingValueIds(node) {
  // Returns ALL custom targeting value IDs from a line item, across all keys
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(i => findCustomTargetingValueIds(i));
  if (node.keyId && node.valueIds) return (node.valueIds || []).map(v => String(v));
  return Object.values(node).flatMap(v => typeof v === 'object' ? findCustomTargetingValueIds(v) : []);
}

/**
 * Fetches the custom targeting values for a specific key ID that match the given names,
 * and returns a map of GAM value ID → original VIDEO_ID string (preserving the case
 * used in the creative, since GAM names may differ in capitalisation).
 * keyId is the numeric GAM ID of the targeting key (e.g. the ID for "infinityvideo").
 * valueNames is the list of VIDEO_ID strings to look up (e.g. ["AliceSteve", "OrdWebbSkin"]).
 */
async function getCustomTargetingValueMap(keyId, valueNames, networkCode, token) {
  const nameList = valueNames.map(n => `'${n.replace(/'/g, "''")}'`).join(', ');
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getCustomTargetingValuesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement><query>WHERE customTargetingKeyId = ${keyId} AND name IN (${nameList}) LIMIT 500</query></filterStatement>
    </getCustomTargetingValuesByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;
  const res = await axios.post(GAM_CUSTOM_TARGETING_ENDPOINT, soap, {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000,
  });
  const parsed = await xml2js.parseStringPromise(res.data);
  const values = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCustomTargetingValuesByStatementResponse']?.[0]?.rval?.[0]?.results || [];
  // Build map: valueId → originalVideoId (case-insensitive match back to our input names)
  const lowerToOriginal = {};
  for (const n of valueNames) lowerToOriginal[n.toLowerCase()] = n;
  const map = {};
  for (const v of values) {
    const gamName = v.name?.[0];
    // Map to the original case used in the creative (so cross-reference works)
    const original = lowerToOriginal[gamName?.toLowerCase()] || gamName;
    map[v.id?.[0]] = original;
  }
  return map;
}

module.exports = { resolveVideoTargetingKeyIds, findCustomTargetingValueIds, getCustomTargetingValueMap };
