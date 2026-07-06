/**
 * server.js — Infinity Dashboard (full / original monolith entry point)
 *
 * Handles both desktop and mobile creatives in a single file.
 * Runs on port 3000 (or the PORT env var).
 *
 * Start: node server.js
 *
 * This is the original pre-refactor server. The modular desktop version
 * (server-desktop.js, port 3001) extracts the same logic into routes/.
 * All API routes and helper functions live inline here.
 *
 * SCREENSHOT_DIR (public/screenshots/) is used for:
 *   - Screenshot PNGs cached by /api/screenshot
 *   - JSON caches written by /api/dashboard (url_lineitem_cache, etc.)
 *     and read by /api/active-view and /api/video-stats
 */

require('dotenv').config();
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');
const xml2js = require('xml2js');
const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const GAM_REST_BASE = 'https://admanager.googleapis.com/v1';
const GAM_SOAP_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/CreativeService';
const GAM_REPORT_SOAP_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/ReportService';
const GAM_CREATIVESET_SOAP_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/CreativeSetService';
const GAM_LICA_SOAP_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/LineItemCreativeAssociationService';
const GAM_SOAP_NS = 'https://www.google.com/apis/ads/publisher/v202602';
const SCOPES = ['https://www.googleapis.com/auth/admanager'];

let authClient = null;

function getOAuth2Client() {
  return new OAuth2Client(
    process.env.GAM_CLIENT_ID,
    process.env.GAM_CLIENT_SECRET,
    'http://localhost:3000'
  );
}

async function getAuthClient() {
  if (!authClient) {
    const client = getOAuth2Client();
    if (!process.env.GAM_REFRESH_TOKEN) {
      throw new Error('GAM_REFRESH_TOKEN is not set — visit http://localhost:3000/auth to authorise');
    }
    client.setCredentials({ refresh_token: process.env.GAM_REFRESH_TOKEN });
    authClient = client;
  }
  return authClient;
}

async function getToken() {
  const client = await getAuthClient();
  const { token } = await client.getAccessToken();
  return token;
}

const GENERIC_TITLES = new Set(['netlify app', 'untitled', 'index', 'home', '']);

async function fetchAdvertiserName(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InfinityDashboard/1.0)' },
      maxRedirects: 5,
    });
    const html = res.data || '';

    // og:site_name — most explicit brand signal
    const siteNameMatch = html.match(/property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
    if (siteNameMatch) {
      const n = siteNameMatch[1].trim();
      if (n && !GENERIC_TITLES.has(n.toLowerCase())) return n;
    }

    // <title> — split on - | : and take first segment
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      const t = titleMatch[1].split(/\s*[-–|:]\s*/)[0].trim();
      if (t && !GENERIC_TITLES.has(t.toLowerCase()) && t.length > 1) return t;
    }

    // og:title fallback
    const ogTitleMatch = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (ogTitleMatch) {
      const t = ogTitleMatch[1].split(/\s*[-–|:]\s*/)[0].trim();
      if (t && !GENERIC_TITLES.has(t.toLowerCase()) && t.length > 1) return t;
    }
  } catch(e) {}
  return null;
}

function slugToName(netlifyUrl) {
  try {
    const host = new URL(netlifyUrl).hostname;
    let slug = host.split('.')[0];
    slug = slug.replace(/-\d{6,8}$/, '');
    slug = slug.replace(/-(v\d+|core|out-now|watchnow|today|tomorrow|seasonal)$/i, '');
    slug = slug.replace(/-(desktop|mobile)$/i, '');
    return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  } catch(e) { return ''; }
}

function getTemplateVarValue(creative, varName) {
  const vars = creative.creativeTemplateVariableValues || [];
  const match = vars.find(v => v.uniqueName?.[0] === varName);
  if (match?.value?.[0]?.trim()) return match.value[0].trim();
  if (varName === 'VIDEO_ID') {
    const fallback = vars.find(v => v.uniqueName?.[0] === 'CAMPAIGN_ID');
    return fallback?.value?.[0]?.trim() || null;
  }
  return null;
}

function extractNetlifyUrl(obj, depth = 0) {
  if (depth > 5) return null;
  if (typeof obj === 'string') {
    const match = obj.match(/(?:https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9-]*\.netlify\.app(?:\/[^\s"'<>]*)?/);
    if (!match) return null;
    return match[0].startsWith('http') ? match[0] : `https://${match[0]}`;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = extractNetlifyUrl(item, depth + 1);
      if (found) return found;
    }
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      const found = extractNetlifyUrl(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function buildSoapEnvelope(networkCode, offset, pageSize, sizeType = 'desktop') {
  let query;
  if (sizeType === 'mobile-companion') {
    query = `WHERE ((width = 300 AND height = 250) OR (width = 300 AND height = 251)) LIMIT ${pageSize} OFFSET ${offset}`;
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

async function fetchPage(networkCode, token, offset, pageSize, sizeType = 'desktop') {
  const response = await axios.post(GAM_SOAP_ENDPOINT, buildSoapEnvelope(networkCode, offset, pageSize, sizeType), {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
    timeout: 30000,
  });
  const parsed = await xml2js.parseStringPromise(response.data);
  const body = parsed['soap:Envelope']?.['soap:Body']?.[0];
  const rval = body?.['getCreativesByStatementResponse']?.[0]?.rval?.[0];
  return rval;
}

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

async function fetchCompanionToMasterMap(networkCode, token, masterIds = null) {
  const pageSize = 500;
  const companionToMaster = {};

  const masterIdList = masterIds ? [...masterIds] : null;
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

async function fetchLineItemStartDates(lineItemIds, networkCode, token) {
  // Returns { lineItemId → startDate as UTC ms timestamp }
  if (!lineItemIds.length) return {};
  const startDateByLI = {};
  const batchSize = 400;

  for (let i = 0; i < lineItemIds.length; i += batchSize) {
    const batch = lineItemIds.slice(i, i + batchSize);
    let offset = 0, total = null;

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
    <getLineItemsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement>
        <query>WHERE id IN (${batch.join(', ')}) LIMIT 500 OFFSET ${offset}</query>
      </filterStatement>
    </getLineItemsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;

      const res = await axios.post(GAM_LINEITEM_SOAP_ENDPOINT, soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
        timeout: 30000,
      });
      const parsed = await xml2js.parseStringPromise(res.data);
      const rval = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemsByStatementResponse']?.[0]?.rval?.[0];
      if (!rval) break;
      total = parseInt(rval.totalResultSetSize?.[0] || '0');
      const results = rval.results || [];

      for (const li of results) {
        const id = li.id?.[0];
        const dt = li.startDateTime?.[0];
        if (id && dt) {
          const d = dt.date?.[0];
          if (d) {
            const ts = Date.UTC(
              parseInt(d.year?.[0]    || '0'),
              parseInt(d.month?.[0]   || '1') - 1,
              parseInt(d.day?.[0]     || '1'),
              parseInt(dt.hour?.[0]   || '0'),
              parseInt(dt.minute?.[0] || '0'),
              parseInt(dt.second?.[0] || '0'),
            );
            startDateByLI[id] = ts;
          }
        }
      }

      offset += 500;
      if (results.length === 0) break;
    }
  }

  return startDateByLI;
}

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

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const stParsed = await xml2js.parseStringPromise((await axios.post(GAM_REPORT_SOAP_ENDPOINT, `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header><soapenv:Body><getReportJobStatus xmlns="${GAM_SOAP_NS}"><reportJobId>${jobId}</reportJobId></getReportJobStatus></soapenv:Body></soapenv:Envelope>`, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 })).data);
    const status = stParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getReportJobStatusResponse']?.[0]?.rval?.[0];
    if (status === 'COMPLETED') break;
    if (status === 'FAILED') throw new Error('Report job failed');
  }

  const urlParsed = await xml2js.parseStringPromise((await axios.post(GAM_REPORT_SOAP_ENDPOINT, `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header><soapenv:Body><getReportDownloadURL xmlns="${GAM_SOAP_NS}"><reportJobId>${jobId}</reportJobId><exportFormat>CSV_DUMP</exportFormat></getReportDownloadURL></soapenv:Body></soapenv:Envelope>`, { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 })).data);
  const downloadUrl = urlParsed['soap:Envelope']?.['soap:Body']?.[0]?.['getReportDownloadURLResponse']?.[0]?.rval?.[0];

  const csvRes = await axios.get(downloadUrl, { headers: { Authorization: `Bearer ${token}` }, timeout: 60000, responseType: 'arraybuffer' });
  return zlib.gunzipSync(Buffer.from(csvRes.data)).toString('utf8');
}

const GAM_LINEITEM_SOAP_ENDPOINT = `https://ads.google.com/apis/ads/publisher/v202602/LineItemService`;

// Orders whose creatives are completely excluded from the dashboard
const EXCLUDED_ORDER_IDS = [3559958634];

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

// Custom targeting keys that hold VIDEO_IDs on video line items.
// Key names to resolve at runtime: infinityvideo, Video_Tracking, advertiser
const VIDEO_TARGETING_KEY_NAMES = ['infinityvideo', 'Video_Tracking', 'advertiser'];
let resolvedVideoKeyIds = ['18074515', '18004753']; // fallback defaults; refreshed on first use
const GAM_CUSTOM_TARGETING_ENDPOINT = `https://ads.google.com/apis/ads/publisher/v202602/CustomTargetingService`;

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

function findCustomTargetingValueIds(node) {
  // Returns ALL custom targeting value IDs from a line item, across all keys
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(i => findCustomTargetingValueIds(i));
  if (node.keyId && node.valueIds) return (node.valueIds || []).map(v => String(v));
  return Object.values(node).flatMap(v => typeof v === 'object' ? findCustomTargetingValueIds(v) : []);
}

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
        // Name-based fallback
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

async function fetchActiveViewByLineItem(lineItemIds, networkCode, token) {
  // Returns lineItemId → { viewable, measurable } raw impression counts
  // Caller does weighted average: Σ(viewable) / Σ(measurable) per URL group
  if (!lineItemIds.length) return {};
  const now = new Date();
  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startD = new Date(now); startD.setDate(startD.getDate() - 700);
  const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };
  const idList = [...new Set(lineItemIds)].join(', ');

  const queryXml = `
    <dimensions>LINE_ITEM_ID</dimensions>
    <columns>TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS</columns>
    <columns>TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
    <statement><query>WHERE LINE_ITEM_ID IN (${idList})</query></statement>`;

  const csvText = await runReportAndDownload(queryXml, networkCode, token);
  const lines = csvText.split('\n').filter(Boolean);
  console.log('Active View CSV header:', lines[0]);
  const activeViewByLineItem = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const lineItemId = cols[0];
    const viewable   = parseFloat(cols[1] || '0');
    const measurable = parseFloat(cols[2] || '0');
    if (lineItemId && measurable > 0) {
      if (!activeViewByLineItem[lineItemId]) activeViewByLineItem[lineItemId] = { viewable: 0, measurable: 0 };
      activeViewByLineItem[lineItemId].viewable   += viewable;
      activeViewByLineItem[lineItemId].measurable += measurable;
    }
  }
  return activeViewByLineItem;
}

async function fetchActiveViewByCreative(lineItemIds, networkCode, token) {
  // Returns { lineItemId: { creativeId: { viewable, measurable } } }
  // Used with impsByCreativeAndLI for impression-count matching: LICA imps == report measurable
  if (!lineItemIds.length) return {};
  const now = new Date();
  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startD = new Date(now); startD.setDate(startD.getDate() - 700);
  const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };
  const idList = [...new Set(lineItemIds)].join(', ');

  const queryXml = `
    <dimensions>LINE_ITEM_ID</dimensions>
    <dimensions>CREATIVE_ID</dimensions>
    <columns>TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS</columns>
    <columns>TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
    <statement><query>WHERE LINE_ITEM_ID IN (${idList})</query></statement>`;

  const csvText = await runReportAndDownload(queryXml, networkCode, token);
  const lines = csvText.split('\n').filter(Boolean);
  // CSV: LINE_ITEM_ID, CREATIVE_ID, VIEWABLE, MEASURABLE
  const avByLIAndCreative = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const lineItemId = cols[0];
    const creativeId = cols[1];
    const viewable   = parseFloat(cols[2] || '0');
    const measurable = parseFloat(cols[3] || '0');
    if (lineItemId && creativeId && creativeId !== '0' && measurable > 0) {
      if (!avByLIAndCreative[lineItemId]) avByLIAndCreative[lineItemId] = {};
      if (!avByLIAndCreative[lineItemId][creativeId]) avByLIAndCreative[lineItemId][creativeId] = { viewable: 0, measurable: 0 };
      avByLIAndCreative[lineItemId][creativeId].viewable   += viewable;
      avByLIAndCreative[lineItemId][creativeId].measurable += measurable;
    }
  }
  return avByLIAndCreative;
}

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

app.get('/auth', (req, res) => {
  const client = getOAuth2Client();
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/', async (req, res, next) => {
  if (!req.query.code) return next();
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(req.query.code);
  res.send(`
    <p>Authorised. Add this to your .env file then restart the server:</p>
    <pre>GAM_REFRESH_TOKEN=${tokens.refresh_token}</pre>
  `);
});

// Static files before the API routes here so the OAuth callback (/) and /auth
// work, but all /api/* routes registered below still take precedence because
// there are no matching files in public/ for those paths.
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/debug-netlify', async (req, res) => {
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

app.get('/api/debug-metrics', async (req, res) => {
  try {
    const token = await getToken();
    const networkCode = process.env.GAM_NETWORK_CODE;

    // Get first 5 netlify creatives and their line items
    const allCreatives = await fetchCreativesViaSoap(networkCode, token);
    const netlify = allCreatives.filter(c => extractNetlifyUrl(c)).slice(0, 5);
    const netlifyIds = netlify.map(c => c.id?.[0]);
    const licaMap = await fetchCreativeLineItems(netlifyIds, networkCode, token);
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

app.get('/api/debug-lica', async (req, res) => {
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

app.get('/api/debug-av-master-ids-for-url', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'url param required' });
  try {
    const urlLineItemPath  = path.join(SCREENSHOT_DIR, 'url_lineitem_cache.json');
    const urlLicaImpsPath  = path.join(SCREENSHOT_DIR, 'url_lica_imps_cache.json');
    if (!fs.existsSync(urlLineItemPath))  return res.status(503).json({ error: 'no url_lineitem_cache — Refresh dashboard first' });
    if (!fs.existsSync(urlLicaImpsPath))  return res.status(503).json({ error: 'no url_lica_imps_cache — Refresh dashboard first' });

    const urlLineItemMap = JSON.parse(fs.readFileSync(urlLineItemPath, 'utf8'));
    const urlLicaImpsMap = JSON.parse(fs.readFileSync(urlLicaImpsPath, 'utf8'));

    const matchedUrl = Object.keys(urlLineItemMap).find(k => k.includes(targetUrl) || targetUrl.includes(k.replace(/\/$/, '')));
    if (!matchedUrl) return res.json({ error: 'URL not found in line item cache', targetUrl });

    const lineItemIds = urlLineItemMap[matchedUrl] || [];
    const licaImps    = urlLicaImpsMap[matchedUrl] || {};

    const token = await getToken();
    const networkCode = process.env.GAM_NETWORK_CODE;
    const avByLIAndCreative = await fetchActiveViewByCreative(lineItemIds, networkCode, token);

    // For each template creative × line item, find the matching report creative by impression count
    const matchRows = [];
    let totalViewable = 0, totalMeasurable = 0;
    for (const [templateId, perLI] of Object.entries(licaImps)) {
      for (const [liId, imps] of Object.entries(perLI)) {
        const liCreatives = avByLIAndCreative[liId] || {};
        const matchEntry  = Object.entries(liCreatives).find(([, av]) => Math.abs(Math.round(av.measurable) - imps) <= 20);
        const reportCreativeId = matchEntry ? matchEntry[0] : null;
        const av = matchEntry ? matchEntry[1] : null;
        if (av) { totalViewable += av.viewable; totalMeasurable += av.measurable; }
        matchRows.push({
          templateId, lineItemId: liId, licaImpressions: imps,
          reportCreativeId, viewable: av?.viewable ?? null, measurable: av?.measurable ?? null,
          rate: av ? parseFloat(((av.viewable / av.measurable) * 100).toFixed(1)) : null,
        });
      }
    }
    const combinedRate = totalMeasurable > 0 ? parseFloat(((totalViewable / totalMeasurable) * 100).toFixed(1)) : null;

    res.json({ matchedUrl, lineItemIds, combinedRate, totalViewable, totalMeasurable, matchRows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-av-report-for-li', async (req, res) => {
  // Returns raw active view report rows (with CREATIVE_ID dim) for a specific line item
  const liId = req.query.id;
  if (!liId) return res.status(400).json({ error: 'id param required' });
  try {
    const token = await getToken();
    const networkCode = process.env.GAM_NETWORK_CODE;
    const now = new Date();
    const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
    const startD = new Date(now); startD.setDate(startD.getDate() - 700);
    const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };
    const queryXml = `
      <dimensions>LINE_ITEM_ID</dimensions>
      <dimensions>CREATIVE_ID</dimensions>
      <columns>TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS</columns>
      <columns>TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS</columns>
      <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
      <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
      <dateRangeType>CUSTOM_DATE</dateRangeType>
      <statement><query>WHERE LINE_ITEM_ID IN (${liId})</query></statement>`;
    const csvText = await runReportAndDownload(queryXml, networkCode, token);
    const lines = csvText.split('\n').filter(Boolean);
    const rows = lines.slice(1).map(l => {
      const cols = l.split(',').map(c => c.trim().replace(/"/g, ''));
      return { lineItemId: cols[0], creativeId: cols[1], viewable: parseFloat(cols[2]||'0'), measurable: parseFloat(cols[3]||'0') };
    });
    res.json({ header: lines[0], rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-licas-for-creative', async (req, res) => {
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

app.get('/api/debug-master-ids', async (req, res) => {
  try {
    const token = await getToken();
    const networkCode = process.env.GAM_NETWORK_CODE;
    const [allCreatives, companionToMaster] = await Promise.all([
      fetchCreativesViaSoap(networkCode, token),
      fetchCompanionToMasterMap(networkCode, token),
    ]);
    const netlifyCreatives = allCreatives
      .map(c => ({ creative: c, netlifyUrl: extractNetlifyUrl(c) }))
      .filter(({ netlifyUrl }) => netlifyUrl !== null);

    const mapped = netlifyCreatives.slice(0, 20).map(({ creative, netlifyUrl }) => ({
      name: creative.name?.[0],
      companionId: creative.id?.[0],
      masterId: companionToMaster[creative.id?.[0]] || null,
      netlifyUrl,
    }));
    const totalWithMaster = netlifyCreatives.filter(({ creative }) => !!companionToMaster[creative.id?.[0]]).length;
    res.json({ totalNetlify: netlifyCreatives.length, totalWithMaster, sample: mapped });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data?.substring?.(0, 1000) || null });
  }
});

app.get('/api/debug-netlify-in-report', async (req, res) => {
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

app.get('/api/debug-creative-sets', async (req, res) => {
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

app.get('/api/debug-report-ids', async (req, res) => {
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

app.get('/api/debug-types', async (req, res) => {
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

app.get('/api/debug-template-vars', async (req, res) => {
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
      `https://ads.google.com/apis/ads/publisher/v202602/CreativeTemplateService`,
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

app.get('/api/debug-search-lineitem', async (req, res) => {
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

app.get('/api/debug-creative-for-lineitem', async (req, res) => {
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
        passesFilter: !!(c.creativeTemplateId?.[0] && ['12338205','12391253','12430810','12479439','12514886','12517019','12522683','12523354'].includes(c.creativeTemplateId?.[0]) && ['249','250','251'].includes((c.size?.[0]?.height?.[0] || c.height?.[0])) && (c.size?.[0]?.width?.[0] || c.width?.[0]) === '970'),
        rawKeys: Object.keys(c),
        rawCreative: c,
      })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-creative-vars', async (req, res) => {
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

app.get('/api/debug-missing-video-ids', async (req, res) => {
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

app.get('/api/debug-custom-targeting-keys', async (req, res) => {
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
      `https://ads.google.com/apis/ads/publisher/v202602/CustomTargetingService`,
      soap,
      { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` }, timeout: 15000 }
    );
    const parsed = await xml2js.parseStringPromise(res2.data);
    const keys = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCustomTargetingKeysByStatementResponse']?.[0]?.rval?.[0]?.results || [];
    res.json(keys.map(k => ({ id: k.id?.[0], name: k.name?.[0], displayName: k.displayName?.[0], type: k.type?.[0] })));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/debug-ct-value', async (req, res) => {
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

app.get('/api/debug-video-match', async (req, res) => {
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

app.get('/api/debug-avios', async (req, res) => {
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

// Find all creatives for a given netlify URL (within our template+size filter) + their LICA impression stats
app.get('/api/debug-url', async (req, res) => {
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

app.get('/api/debug-mobile-match', async (req, res) => {
  try {
    const token = await getToken();
    const networkCode = process.env.GAM_NETWORK_CODE;

    const [desktopCreatives, mobileCreatives, companionToMaster] = await Promise.all([
      fetchCreativesViaSoap(networkCode, token, 'desktop'),
      fetchCreativesViaSoap(networkCode, token, 'mobile'),
      fetchCompanionToMasterMap(networkCode, token),
    ]);

    // Build master netlify map
    const masterNetlifyMap = {};
    for (const c of desktopCreatives) {
      const netlifyUrl = extractNetlifyUrl(c);
      if (!netlifyUrl) continue;
      const id = c.id?.[0];
      if (id) masterNetlifyMap[id] = netlifyUrl;
    }

    let inCompanionMap = 0, masterFound = 0, masterMissing = [];
    for (const c of mobileCreatives) {
      const id = c.id?.[0];
      const masterId = companionToMaster[id];
      if (masterId) {
        inCompanionMap++;
        if (masterNetlifyMap[masterId]) {
          masterFound++;
        } else {
          masterMissing.push({ companionId: id, masterId, name: c.name?.[0] });
        }
      }
    }

    res.json({
      desktopCreativesTotal: desktopCreatives.length,
      desktopWithNetlify: Object.keys(masterNetlifyMap).length,
      mobileCreativesTotal: mobileCreatives.length,
      mobileInCompanionMap: inCompanionMap,
      mobileMatchedToNetlifyMaster: masterFound,
      mobileNotInCompanionMap: mobileCreatives.length - inCompanionMap,
      companionMapSize: Object.keys(companionToMaster).length,
      sampleMasterMissing: masterMissing.slice(0, 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug-mobile-templates', async (req, res) => {
  try {
    const token = await getToken();
    const networkCode = process.env.GAM_NETWORK_CODE;
    // Query WITHOUT template ID filter so we can discover which templates mobile uses
    const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><RequestHeader xmlns="${GAM_SOAP_NS}"><networkCode>${networkCode}</networkCode><applicationName>Infinity-Dashboard</applicationName></RequestHeader></soapenv:Header>
  <soapenv:Body>
    <getCreativesByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement>
        <query>WHERE ((width = 300 AND height = 250) OR (width = 300 AND height = 251)) LIMIT 500 OFFSET 0</query>
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
    const total = parseInt(parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getCreativesByStatementResponse']?.[0]?.rval?.[0]?.totalResultSetSize?.[0] || '0');

    // Group by template ID, only show creatives with a netlify URL
    const byTemplate = {};
    const netlifyRows = [];
    for (const c of results) {
      const netlifyUrl = extractNetlifyUrl(c);
      const tplId = c.creativeTemplateId?.[0] || '(no template)';
      byTemplate[tplId] = (byTemplate[tplId] || 0) + 1;
      if (netlifyUrl) {
        netlifyRows.push({ id: c.id?.[0], name: c.name?.[0], templateId: tplId, width: c.width?.[0], height: c.height?.[0], netlifyUrl });
      }
    }
    res.json({ totalInGAM: total, returnedInPage: results.length, netlifyCount: netlifyRows.length, byTemplate, netlifyRows: netlifyRows.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/template-ids', async (req, res) => {
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
      `https://ads.google.com/apis/ads/publisher/v202602/CreativeTemplateService`,
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

app.get('/api/soap-test', async (req, res) => {
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

app.get('/api/network', async (req, res) => {
  try {
    const token = await getToken();
    const response = await axios.get(
      `${GAM_REST_BASE}/networks/${process.env.GAM_NETWORK_CODE}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data || null });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const networkCode = process.env.GAM_NETWORK_CODE;
    if (!networkCode) return res.status(500).json({ error: 'GAM_NETWORK_CODE is not set' });

    const token = await getToken();

    const [desktopCreatives, mobileCompanions, mobileMasters, excludedCreativeIds] = await Promise.all([
      fetchCreativesViaSoap(networkCode, token, 'desktop'),
      fetchCreativesViaSoap(networkCode, token, 'mobile-companion'), // 300x250/251 — carry netlify URL
      fetchCreativesViaSoap(networkCode, token, 'mobile-master'),    // 320x50/51  — pixel, carry LICA stats
      fetchExcludedCreativeIds(networkCode, token),
    ]);

    console.log(`Fetched: ${desktopCreatives.length} desktop, ${mobileCompanions.length} mobile companions, ${mobileMasters.length} mobile masters`);

    // Scope creative-sets query to only our 320x50/51 master IDs
    const mobileMasterIdList = mobileMasters.map(c => c.id?.[0]).filter(Boolean);
    const companionToMaster = await fetchCompanionToMasterMap(networkCode, token, mobileMasterIdList);

    // Build companion → { netlifyUrl, videoId } from the 300x250/251 creatives
    const companionNetlifyMap = {};
    for (const c of mobileCompanions) {
      if (excludedCreativeIds.has(c.id?.[0])) continue;
      const netlifyUrl = extractNetlifyUrl(c);
      if (!netlifyUrl) continue;
      const id = c.id?.[0];
      if (id) companionNetlifyMap[id] = { netlifyUrl, videoId: getTemplateVarValue(c, 'VIDEO_ID') };
    }

    // Reverse companion→master to get master → { netlifyUrl, videoId }
    const mobileMasterNetlifyMap = {};
    for (const [companionId, masterId] of Object.entries(companionToMaster)) {
      if (companionNetlifyMap[companionId] && !mobileMasterNetlifyMap[masterId]) {
        mobileMasterNetlifyMap[masterId] = companionNetlifyMap[companionId];
      }
    }

    // Desktop: netlify URL lives on the 970px template creative itself
    const netlifyCreatives = [];
    const desktopBaseUrls = new Set();
    for (const c of desktopCreatives) {
      if (excludedCreativeIds.has(c.id?.[0])) continue;
      const netlifyUrl = extractNetlifyUrl(c);
      if (!netlifyUrl) continue;
      let baseUrl;
      try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
      desktopBaseUrls.add(baseUrl);
      netlifyCreatives.push({ creative: c, netlifyUrl, videoId: getTemplateVarValue(c, 'VIDEO_ID'), isMobile: false });
    }

    // Mobile: stats come from the 320x50/51 master; URL comes from its 300x250/251 companion
    // Skip any companion URL that already appears in the desktop set (e.g. a desktop skin's 300x250 companion)
    let mobileMatched = 0;
    for (const c of mobileMasters) {
      if (excludedCreativeIds.has(c.id?.[0])) continue;
      const id = c.id?.[0];
      if (mobileMasterNetlifyMap[id]) {
        const { netlifyUrl, videoId } = mobileMasterNetlifyMap[id];
        let baseUrl;
        try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
        if (desktopBaseUrls.has(baseUrl)) continue;
        netlifyCreatives.push({ creative: c, netlifyUrl, videoId, isMobile: true });
        mobileMatched++;
      }
    }
    console.log(`Mobile: ${mobileMatched} masters matched. Total netlify rows: ${netlifyCreatives.length}`);

    const netlifyIds = netlifyCreatives.map(({ creative }) => creative.id?.[0]).filter(Boolean);

    let statsByCreativeId = {};
    let lineItemsByCreativeId = {};
    let impsByCreativeAndLI = {};
    try {
      const lica = await fetchCreativeLICAStats(netlifyIds, networkCode, token);
      statsByCreativeId     = lica.statsByCreativeId;
      lineItemsByCreativeId = lica.lineItemsByCreativeId;
      impsByCreativeAndLI   = lica.impsByCreativeAndLI;
    } catch (e) {
      console.warn('LICA stats fetch failed:', e.message, e.response?.data?.substring?.(0, 500) || '');
    }

    // Build grouped map. Video skins split per VIDEO_ID, desktop/mobile kept separate.
    const grouped = {};
    for (const { creative, netlifyUrl, videoId, isMobile } of netlifyCreatives) {
      let baseUrl;
      try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
      const id = creative.id?.[0];
      const s  = statsByCreativeId[id];
      const sizeKey = isMobile ? 'm' : 'd';
      const groupKey = videoId ? `${baseUrl}##${videoId}##${sizeKey}` : `${baseUrl}##${sizeKey}`;
      if (!grouped[groupKey]) grouped[groupKey] = { netlifyUrl: baseUrl, videoId: videoId || null, isMobile, impressions: 0, clicks: 0, lineItemIds: new Set(), firstStartDate: Infinity };
      grouped[groupKey].impressions += s?.impressions > 0 ? s.impressions : 0;
      grouped[groupKey].clicks      += s?.clicks      > 0 ? s.clicks      : 0;
      if (id && lineItemsByCreativeId[id]) {
        for (const lid of lineItemsByCreativeId[id]) grouped[groupKey].lineItemIds.add(lid);
      }
    }

    console.log(`Dedup: ${netlifyCreatives.length} creatives → ${Object.keys(grouped).length} rows (video skins split by VIDEO_ID)`);

    // Fetch line item start dates and stamp each group with the most recent start date
    try {
      const allLIIds = [...new Set(Object.values(grouped).flatMap(g => [...g.lineItemIds]))];
      const startDateByLI = await fetchLineItemStartDates(allLIIds, networkCode, token);
      for (const g of Object.values(grouped)) {
        g.firstStartDate = Math.min(Infinity, ...[...g.lineItemIds].map(lid => startDateByLI[lid] || Infinity));
        if (!isFinite(g.firstStartDate)) g.firstStartDate = 0;
      }
    } catch(e) {
      console.warn('fetchLineItemStartDates failed:', e.message);
    }

    // Save netlifyUrl → lineItemIds mapping for async Active View endpoint
    const urlLineItemMap = {};
    for (const data of Object.values(grouped)) {
      const url = data.netlifyUrl;
      if (!urlLineItemMap[url]) urlLineItemMap[url] = [];
      for (const lid of data.lineItemIds) {
        if (!urlLineItemMap[url].includes(lid)) urlLineItemMap[url].push(lid);
      }
    }
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_lineitem_cache.json'), JSON.stringify(urlLineItemMap));

    // Save netlifyUrl → creativeIds (only those with impressions > 0) for active view aggregation
    // Filtering to impressions > 0 ensures master creative IDs are only from creatives that
    // actually served this URL, avoiding noise from masters shared with other campaigns
    const urlCreativeMap = {};
    for (const { creative, netlifyUrl } of netlifyCreatives) {
      let baseUrl;
      try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
      const id = creative.id?.[0];
      const hasImpressions = id && (statsByCreativeId[id]?.impressions || 0) > 0;
      if (hasImpressions && baseUrl) {
        if (!urlCreativeMap[baseUrl]) urlCreativeMap[baseUrl] = [];
        if (!urlCreativeMap[baseUrl].includes(id)) urlCreativeMap[baseUrl].push(id);
      }
    }
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_creative_cache.json'), JSON.stringify(urlCreativeMap));

    // Save per-URL, per-creative, per-line-item LICA impressions for active view impression matching.
    // Structure: { url: { templateCreativeId: { lineItemId: impressions } } }
    // At query time: LICA impressions for (templateId, lineItemId) == measurable in the AV report → same creative.
    const urlLicaImpsMap = {};
    for (const { creative, netlifyUrl } of netlifyCreatives) {
      let baseUrl;
      try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
      const id = creative.id?.[0];
      if (id && baseUrl && (statsByCreativeId[id]?.impressions || 0) > 0 && impsByCreativeAndLI[id]) {
        if (!urlLicaImpsMap[baseUrl]) urlLicaImpsMap[baseUrl] = {};
        urlLicaImpsMap[baseUrl][id] = impsByCreativeAndLI[id];
      }
    }
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_lica_imps_cache.json'), JSON.stringify(urlLicaImpsMap));

    // Invalidate active view cache so the next /api/active-view call uses the new imps matching
    try { fs.unlinkSync(path.join(SCREENSHOT_DIR, 'active_view_cache.json')); } catch(e) {}

    // Save videoId → netlifyUrl map for async video stats endpoint
    const videoIdUrlMap = {};
    for (const g of Object.values(grouped)) {
      if (g.videoId && !videoIdUrlMap[g.videoId]) {
        videoIdUrlMap[g.videoId] = g.netlifyUrl;
      }
    }
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_videoid_cache.json'), JSON.stringify(videoIdUrlMap));

    // Read Active View from cache (populated by /api/active-view), keyed by base URL
    let activeViewByUrl = {};
    try {
      const avPath = path.join(SCREENSHOT_DIR, 'active_view_cache.json');
      if (fs.existsSync(avPath)) activeViewByUrl = JSON.parse(fs.readFileSync(avPath, 'utf8'));
    } catch(e) {}

    // Read video completion rate from cache (populated by /api/video-stats), keyed by VIDEO_ID
    let videoStatsByVideoId = {};
    try {
      const vsPath = path.join(SCREENSHOT_DIR, 'video_stats_cache.json');
      if (fs.existsSync(vsPath)) videoStatsByVideoId = JSON.parse(fs.readFileSync(vsPath, 'utf8'));
    } catch(e) {}

    const results = Object.values(grouped)
      .sort((a, b) => b.firstStartDate - a.firstStartDate)
      .map(r => {
        const device = r.isMobile
          ? (r.videoId ? 'video-mobile' : 'mobile')
          : (r.videoId ? 'video' : 'desktop');
        return {
          netlifyUrl:      r.netlifyUrl,
          videoId:         r.videoId || null,
          advertiser:      slugToName(r.netlifyUrl),
          device,
          impressions:     r.impressions || null,
          clicks:          r.clicks      || null,
          ctr:             r.impressions && r.clicks ? parseFloat(((r.clicks / r.impressions) * 100).toFixed(2)) : null,
          activeView:          activeViewByUrl[r.netlifyUrl]?.rate ?? null,
          activeViewViewable:  activeViewByUrl[r.netlifyUrl]?.viewable ?? null,
          activeViewMeasurable:activeViewByUrl[r.netlifyUrl]?.measurable ?? null,
          completionRate:  r.videoId ? (videoStatsByVideoId[r.videoId]?.completionRate ?? null) : null,
          durationSec:     r.videoId ? (videoStatsByVideoId[r.videoId]?.durationSec ?? null) : null,
          lineItemIds:     [...r.lineItemIds],
          sortKey:         r.firstStartDate || 0,
        };
      });

    res.json({
      total: results.length,
      lastFetched: new Date().toISOString(),
      results,
    });
  } catch (err) {
    const message = err.response?.data || err.message;
    console.error('Dashboard error:', message);
    res.status(500).json({ error: typeof message === 'string' ? message : JSON.stringify(message) });
  }
});

// Declared here (after debug routes) because it's only needed by the
// routes below: screenshot, advertiser, active-view, video-stats, and tags.
const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const TAG_RULES_PATH = path.join(SCREENSHOT_DIR, 'tag_rules.json');

app.get('/api/tag-rules', (req, res) => {
  try {
    const rules = fs.existsSync(TAG_RULES_PATH) ? JSON.parse(fs.readFileSync(TAG_RULES_PATH, 'utf8')) : {};
    res.json(rules);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tag-rules', express.json(), (req, res) => {
  try {
    const rules = req.body;
    if (typeof rules !== 'object' || Array.isArray(rules)) return res.status(400).json({ error: 'Expected object' });
    fs.writeFileSync(TAG_RULES_PATH, JSON.stringify(rules, null, 2));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const URL_TAGS_PATH = path.join(SCREENSHOT_DIR, 'url_tags.json');

app.get('/api/url-tags', (req, res) => {
  try {
    const tags = fs.existsSync(URL_TAGS_PATH) ? JSON.parse(fs.readFileSync(URL_TAGS_PATH, 'utf8')) : {};
    res.json(tags);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/url-tags', express.json(), (req, res) => {
  try {
    const { url, category } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const tags = fs.existsSync(URL_TAGS_PATH) ? JSON.parse(fs.readFileSync(URL_TAGS_PATH, 'utf8')) : {};
    if (category) tags[url] = category;
    else delete tags[url];
    fs.writeFileSync(URL_TAGS_PATH, JSON.stringify(tags, null, 2));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/screenshot', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl || !rawUrl.includes('netlify.app')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  const device = req.query.device || 'desktop';
  const isMobile = device === 'mobile' || device === 'video-mobile';
  // Always screenshot the base URL, not a JS file path
  const baseUrl = rawUrl.match(/https?:\/\/[^\s]+?\.netlify\.app\//)?.[0] || rawUrl;
  // Include device in hash so mobile and desktop get separate cached screenshots
  const hash = crypto.createHash('md5').update(baseUrl + '|' + device).digest('hex');
  const imgPath = path.join(SCREENSHOT_DIR, `${hash}.png`);

  if (fs.existsSync(imgPath)) {
    return res.sendFile(imgPath);
  }

  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    if (isMobile) {
      await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
    } else {
      await page.setViewport({ width: 1920, height: 1080 });
    }
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    // Scroll to reveal the skin creative then wait for it to load
    const scrollPx = isMobile ? 300 : 600;
    await page.evaluate((px) => window.scrollBy(0, px), scrollPx);
    await new Promise(r => setTimeout(r, 2500));
    const clipWidth  = isMobile ? 390 : 1920;
    const clipHeight = isMobile ? 600 : 800;
    await page.screenshot({ path: imgPath, clip: { x: 0, y: 0, width: clipWidth, height: clipHeight } });

    const txtPath = imgPath.replace('.png', '.txt');
    if (!fs.existsSync(txtPath)) {
      fs.writeFileSync(txtPath, slugToName(baseUrl));
    }

    res.sendFile(imgPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.get('/api/advertiser', (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'Missing URL' });
  let baseUrl;
  try { const u = new URL(rawUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = rawUrl; }
  const hash = crypto.createHash('md5').update(baseUrl).digest('hex');
  const txtPath = path.join(SCREENSHOT_DIR, `${hash}.txt`);
  const name = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8').trim() : slugToName(baseUrl);
  res.json({ name });
});

app.put('/api/advertiser', express.json(), (req, res) => {
  const { url, name } = req.body || {};
  if (!url || !name) return res.status(400).json({ error: 'Missing url or name' });
  let baseUrl;
  try { const u = new URL(url.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = url; }
  const hash = crypto.createHash('md5').update(baseUrl).digest('hex');
  fs.writeFileSync(path.join(SCREENSHOT_DIR, `${hash}.txt`), name.trim());
  res.json({ ok: true });
});

app.get('/api/active-view', async (req, res) => {
  const urlLineItemPath = path.join(SCREENSHOT_DIR, 'url_lineitem_cache.json');
  if (!fs.existsSync(urlLineItemPath)) {
    return res.status(503).json({ error: 'Load dashboard first to generate line item data' });
  }

  const avCachePath = path.join(SCREENSHOT_DIR, 'active_view_cache.json');
  if (fs.existsSync(avCachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(avCachePath, 'utf8'));
      if (cached._ts && Date.now() - cached._ts < 6 * 60 * 60 * 1000) {
        const { _ts, ...data } = cached;
        return res.json(data);
      }
    } catch(e) {}
  }

  try {
    const urlLineItemMap = JSON.parse(fs.readFileSync(urlLineItemPath, 'utf8'));
    const urlCreativePath = path.join(SCREENSHOT_DIR, 'url_creative_cache.json');
    let urlCreativeMap = null;
    if (fs.existsSync(urlCreativePath)) {
      try { urlCreativeMap = JSON.parse(fs.readFileSync(urlCreativePath, 'utf8')); } catch(e) {}
    }

    const token = await getToken();
    const networkCode = process.env.GAM_NETWORK_CODE;

    // Load per-creative, per-line-item LICA impressions saved during Refresh.
    // Structure: { url: { templateCreativeId: { lineItemId: impressions } } }
    const urlLicaImpsPath = path.join(SCREENSHOT_DIR, 'url_lica_imps_cache.json');
    let urlLicaImpsMap = null;
    if (fs.existsSync(urlLicaImpsPath)) {
      try { urlLicaImpsMap = JSON.parse(fs.readFileSync(urlLicaImpsPath, 'utf8')); } catch(e) {}
    }

    const allLineItemIds = [...new Set(Object.values(urlLineItemMap).flat())];
    const activeViewByUrl = {};

    if (urlLicaImpsMap) {
      // Impression-count matching: for each URL's template creative in a given line item,
      // LICA impressions == report measurable. This directly identifies the correct 9-digit
      // report creative without needing the creative set API.
      const avByLIAndCreative = await fetchActiveViewByCreative(allLineItemIds, networkCode, token);

      for (const [url] of Object.entries(urlLineItemMap)) {
        const licaImps = urlLicaImpsMap[url];
        if (!licaImps) continue;
        let totalViewable = 0, totalMeasurable = 0;
        for (const [, perLI] of Object.entries(licaImps)) {
          for (const [liId, imps] of Object.entries(perLI)) {
            const liCreatives = avByLIAndCreative[liId];
            if (!liCreatives) continue;
            // The report creative whose measurable matches the LICA impressions is the one for this URL
            const match = Object.values(liCreatives).find(av => Math.abs(Math.round(av.measurable) - imps) <= 20);
            if (match) {
              totalViewable   += match.viewable;
              totalMeasurable += match.measurable;
            }
          }
        }
        if (totalMeasurable > 0) activeViewByUrl[url] = { rate: parseFloat(((totalViewable / totalMeasurable) * 100).toFixed(1)), viewable: totalViewable, measurable: totalMeasurable };
      }
    } else {
      // Fallback only if Refresh has never run (no imps cache). Use line-item level but note
      // this includes all creatives in the line item, not just those for this URL.
      const activeViewByLineItem = await fetchActiveViewByLineItem(allLineItemIds, networkCode, token);
      for (const [url, lineItemIds] of Object.entries(urlLineItemMap)) {
        let totalViewable = 0, totalMeasurable = 0;
        for (const lid of lineItemIds) {
          const av = activeViewByLineItem[lid];
          if (av) { totalViewable += av.viewable; totalMeasurable += av.measurable; }
        }
        if (totalMeasurable > 0) activeViewByUrl[url] = { rate: parseFloat(((totalViewable / totalMeasurable) * 100).toFixed(1)), viewable: totalViewable, measurable: totalMeasurable };
      }
    }

    activeViewByUrl._ts = Date.now();
    fs.writeFileSync(avCachePath, JSON.stringify(activeViewByUrl));
    const { _ts, ...data } = activeViewByUrl;
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug-active-view-for-url', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url param' });
  const urlLineItemPath  = path.join(SCREENSHOT_DIR, 'url_lineitem_cache.json');
  const urlCreativePath  = path.join(SCREENSHOT_DIR, 'url_creative_cache.json');
  const avCachePath      = path.join(SCREENSHOT_DIR, 'active_view_cache.json');
  if (!fs.existsSync(urlLineItemPath)) return res.status(503).json({ error: 'No url_lineitem_cache' });
  const urlLineItemMap  = JSON.parse(fs.readFileSync(urlLineItemPath, 'utf8'));
  const urlCreativeMap  = fs.existsSync(urlCreativePath) ? JSON.parse(fs.readFileSync(urlCreativePath, 'utf8')) : null;
  const matchedUrl = Object.keys(urlLineItemMap).find(k => k.includes(targetUrl) || targetUrl.includes(k.replace(/\/$/, '')));
  const lineItemIds  = matchedUrl ? urlLineItemMap[matchedUrl] : null;
  const creativeIds  = matchedUrl && urlCreativeMap ? (urlCreativeMap[matchedUrl] || null) : null;
  let avData = null;
  if (fs.existsSync(avCachePath)) {
    try { avData = JSON.parse(fs.readFileSync(avCachePath, 'utf8')); } catch(e) {}
  }
  const avByUrl = avData ? (avData[matchedUrl] || avData[targetUrl] || null) : null;
  // Now run a live active view query for just the line items of this URL and show per-creative data
  try {
    const token = await getToken();
    const networkCode = process.env.GAM_NETWORK_CODE;
    const avByCreative = lineItemIds ? await fetchActiveViewByLineItem(lineItemIds, networkCode, token) : {};
    const creativeBreakdown = (creativeIds || []).map(cid => ({ cid, av: avByCreative[cid] || null }));
    res.json({ matchedUrl, lineItemIds, creativeIds, activeViewCached: avByUrl, creativeBreakdown });
  } catch(e) {
    res.json({ matchedUrl, lineItemIds, creativeIds, activeViewCached: avByUrl, error: e.message });
  }
});

app.get('/api/video-stats', async (req, res) => {
  const videoIdCachePath = path.join(SCREENSHOT_DIR, 'url_videoid_cache.json');
  if (!fs.existsSync(videoIdCachePath)) {
    return res.status(503).json({ error: 'Load dashboard first to generate video ID data' });
  }

  const vsCachePath = path.join(SCREENSHOT_DIR, 'video_stats_cache.json');
  if (fs.existsSync(vsCachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(vsCachePath, 'utf8'));
      if (cached._ts && Date.now() - cached._ts < 6 * 60 * 60 * 1000) {
        const { _ts, ...data } = cached;
        return res.json(data);
      }
    } catch(e) {}
  }

  try {
    const raw = JSON.parse(fs.readFileSync(videoIdCachePath, 'utf8'));
    // Support both old flat-array format and new { videoId: netlifyUrl } map
    const allVideoIds = Array.isArray(raw) ? [...new Set(raw)] : [...new Set(Object.keys(raw))];

    const token = await getToken();
    const networkCode = process.env.GAM_NETWORK_CODE;

    // Find dedicated video-hosting line items by VIDEO_ID (global custom targeting search)
    const videoIdToData = await fetchVideoLineItemsByVideoIds(allVideoIds, networkCode, token);
    const allVideoLineItemIds = [...new Set(Object.values(videoIdToData).flatMap(d => d.lineItemIds || []))];

    let completionByLineItem = {};
    if (allVideoLineItemIds.length) {
      completionByLineItem = await fetchVideoCompletionByLineItem(allVideoLineItemIds, networkCode, token);
    }

    // Map VIDEO_ID → { completionRate, durationSec }
    const videoStatsByVideoId = {};
    for (const vid of allVideoIds) {
      const data = videoIdToData[vid];
      const entry = {};
      if (data) {
        const rates = (data.lineItemIds || []).map(liId => completionByLineItem[liId]).filter(r => r != null);
        if (rates.length) entry.completionRate = parseFloat((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1));
        if (data.durationMs > 0) entry.durationSec = Math.round(data.durationMs / 1000);
      }
      if (Object.keys(entry).length) videoStatsByVideoId[vid] = entry;
    }

    console.log(`Video stats mapped: ${Object.keys(videoStatsByVideoId).length}/${allVideoIds.length} video IDs have completion data`);

    const toCache = { ...videoStatsByVideoId, _ts: Date.now() };
    fs.writeFileSync(vsCachePath, JSON.stringify(toCache));
    res.json(videoStatsByVideoId);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`GAM Dashboard running at http://localhost:${PORT}`);
});
