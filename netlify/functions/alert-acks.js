'use strict';

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) return { statusCode: 503, body: JSON.stringify({ error: 'Blobs not configured', siteID: !!siteID, token: !!token }) };
  const store = getStore({ name: 'user-data', siteID, token });

  if (event.httpMethod === 'GET') {
    const raw = await store.get('alert_acks', { type: 'text' }).catch(() => null);
    const acks = raw ? JSON.parse(raw) : {};
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(acks),
    };
  }

  if (event.httpMethod === 'POST') {
    const { key, ack } = JSON.parse(event.body || '{}');
    if (!key) return { statusCode: 400, body: JSON.stringify({ error: 'key required' }) };
    const raw = await store.get('alert_acks', { type: 'text' }).catch(() => null);
    const acks = raw ? JSON.parse(raw) : {};
    if (ack) acks[key] = ack;
    else delete acks[key];
    await store.set('alert_acks', JSON.stringify(acks));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
