'use strict';

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

exports.handler = async (event) => {
  const { url, device } = event.queryStringParameters || {};
  if (!url) return { statusCode: 400, body: 'url param required' };

  // Strip to base origin so hash matches uploads and local server
  const decodedUrl = decodeURIComponent(url);
  const baseUrl = decodedUrl.match(/https?:\/\/[^\s]+?\.netlify\.app\//)?.[0] || decodedUrl;

  const { check } = event.queryStringParameters || {};
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;

  // Surface credential issues as a readable error instead of an opaque 502
  if (!siteID || !token) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Blobs not configured', siteID: !!siteID, token: !!token }) };
  }

  let store;
  try {
    store = getStore({ name: 'screenshots', siteID, token });
  } catch (err) {
    return { statusCode: 503, body: JSON.stringify({ error: err.message }) };
  }
  const key = crypto.createHash('md5').update(`${baseUrl}|${device || ''}`).digest('hex');

  // ?check=1 — lightweight existence check used by the screenshot refresh script
  if (check === '1') {
    const exists = (await store.get('upload_' + key).catch(() => null)) !== null
                || (await store.get(key).catch(() => null)) !== null;
    return { statusCode: exists ? 200 : 404, body: '' };
  }

  // Manual uploads take priority over auto-generated screenshots
  let data = await store.get('upload_' + key, { type: 'arrayBuffer' }).catch(() => null);
  if (!data) data = await store.get(key, { type: 'arrayBuffer' }).catch(() => null);

  if (!data) return { statusCode: 404, body: 'Screenshot not found' };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
    body: Buffer.from(data).toString('base64'),
    isBase64Encoded: true,
  };
};
