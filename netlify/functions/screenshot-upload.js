'use strict';

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { url, device, auto } = event.queryStringParameters || {};
  if (!url) return { statusCode: 400, body: 'url param required' };

  // Strip to base origin so hash matches the read function and local server
  const decodedUrl = decodeURIComponent(url);
  const baseUrl = decodedUrl.match(/https?:\/\/[^\s]+?\.netlify\.app\//)?.[0] || decodedUrl;

  const store = getStore({ name: 'screenshots', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
  const hash = crypto.createHash('md5').update(`${baseUrl}|${device || ''}`).digest('hex');
  // auto=true → bare key (auto-generated, replaced daily, never overwrites manual uploads)
  // default   → upload_ prefix (manual upload, takes read priority over auto-generated)
  const key = auto === 'true' ? hash : 'upload_' + hash;

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body || '', 'binary');

  await store.set(key, body);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
};
