'use strict';

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

exports.handler = async (event) => {
  const { url, device } = event.queryStringParameters || {};
  if (!url) return { statusCode: 400, body: 'url param required' };

  const store = getStore('screenshots');
  const key = crypto.createHash('md5').update(`${url}|${device || ''}`).digest('hex');

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
