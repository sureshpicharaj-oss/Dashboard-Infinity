'use strict';

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { url, device } = event.queryStringParameters || {};
  if (!url) return { statusCode: 400, body: 'url param required' };

  const store = getStore('screenshots');
  const key = 'upload_' + crypto.createHash('md5').update(`${url}|${device || ''}`).digest('hex');

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
