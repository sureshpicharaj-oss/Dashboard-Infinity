'use strict';

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

function urlKey(url) {
  return 'adv_' + crypto.createHash('md5').update(url).digest('hex');
}

exports.handler = async (event) => {
  const store = getStore({ name: 'user-data', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });

  if (event.httpMethod === 'GET') {
    const url = event.queryStringParameters?.url;
    if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'url param required' }) };
    const name = await store.get(urlKey(url), { type: 'text' }).catch(() => null);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || null }),
    };
  }

  if (event.httpMethod === 'PUT') {
    const { url, name } = JSON.parse(event.body || '{}');
    if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'url required' }) };
    await store.set(urlKey(url), name || '');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
