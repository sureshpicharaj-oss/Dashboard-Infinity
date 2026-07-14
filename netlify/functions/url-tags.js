'use strict';

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) return { statusCode: 503, body: JSON.stringify({ error: 'Blobs not configured', siteID: !!siteID, token: !!token }) };
  const store = getStore({ name: 'user-data', siteID, token });

  if (event.httpMethod === 'GET') {
    const raw = await store.get('url_tags', { type: 'text' }).catch(() => null);
    const tags = raw ? JSON.parse(raw) : {};
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tags),
    };
  }

  if (event.httpMethod === 'POST') {
    const { url, category } = JSON.parse(event.body || '{}');
    if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'url required' }) };
    const raw = await store.get('url_tags', { type: 'text' }).catch(() => null);
    const tags = raw ? JSON.parse(raw) : {};
    if (category) tags[url] = category;
    else delete tags[url];
    await store.set('url_tags', JSON.stringify(tags));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
