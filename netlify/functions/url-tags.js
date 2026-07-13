'use strict';

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const store = getStore({ name: 'user-data', siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });

  if (event.httpMethod === 'GET') {
    const tags = await store.getJSON('url_tags').catch(() => null);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tags || {}),
    };
  }

  if (event.httpMethod === 'POST') {
    const { url, category } = JSON.parse(event.body || '{}');
    if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'url required' }) };
    const tags = (await store.getJSON('url_tags').catch(() => null)) || {};
    if (category) tags[url] = category;
    else delete tags[url];
    await store.setJSON('url_tags', tags);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
