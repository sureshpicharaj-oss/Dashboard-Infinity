'use strict';

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) return { statusCode: 503, body: JSON.stringify({ error: 'Blobs not configured', siteID: !!siteID, token: !!token }) };
  const store = getStore({ name: 'user-data', siteID, token });

  if (event.httpMethod === 'GET') {
    const rules = await store.getJSON('tag_rules').catch(() => null);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rules || {}),
    };
  }

  if (event.httpMethod === 'POST') {
    const rules = JSON.parse(event.body || '{}');
    await store.setJSON('tag_rules', rules);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
