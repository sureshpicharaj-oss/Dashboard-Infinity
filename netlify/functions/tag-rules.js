'use strict';

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const store = getStore({ name: 'user-data', siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });

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
