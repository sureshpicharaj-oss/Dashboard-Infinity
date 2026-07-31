'use strict';

/*
 * Advertiser display-NAME store (the name shown in the "Creative" column), overridable per Netlify URL.
 * Stored as a single JSON map { url: name } under the "url_names" key so the client can bulk-load every
 * override on start-up and re-apply them after each refresh (the daily GAM pipeline only knows the
 * auto-derived slug name, so without this the override reverts on reload).
 *
 * GET (no query)      -> the whole { url: name } map
 * GET ?url=<netlify>  -> { name } for one URL (back-compat for the per-row lookup)
 * PUT { url, name }   -> upsert (empty/absent name deletes the override)
 */

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const store = getStore({ name: 'user-data', siteID: process.env.NETLIFY_SITE_ID || process.env.SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
  const readMap = async () => { const raw = await store.get('url_names', { type: 'text' }).catch(() => null); return raw ? JSON.parse(raw) : {}; };

  if (event.httpMethod === 'GET') {
    const map = await readMap();
    const url = event.queryStringParameters?.url;
    const body = url ? { name: map[url] || null } : map;
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  if (event.httpMethod === 'PUT') {
    const { url, name } = JSON.parse(event.body || '{}');
    if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'url required' }) };
    const map = await readMap();
    if (name && String(name).trim()) map[url] = String(name).trim(); else delete map[url];
    await store.set('url_names', JSON.stringify(map));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
