'use strict';

/*
 * Advertiser name routes — GET and PUT endpoints for reading and overriding the
 * human-readable advertiser name shown in the dashboard for a given Netlify URL.
 * Names are stored as plain-text .txt files in SCREENSHOT_DIR, keyed by an MD5
 * hash of the base URL, so they persist across dashboard refreshes.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { slugToName } = require('../lib/utils');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {

  /* Returns the display name for a Netlify URL.
   * Accepts ?url=<netlify-url>. Reads from the cached .txt file if present,
   * otherwise falls back to deriving a name from the URL slug. */
  router.get('/api/advertiser', (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: 'Missing URL' });
    let baseUrl;
    try { const u = new URL(rawUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = rawUrl; }
    const hash = crypto.createHash('md5').update(baseUrl).digest('hex');
    const txtPath = path.join(SCREENSHOT_DIR, `${hash}.txt`);
    // The .txt file is the same hash-based file written by the screenshot route;
    // reusing it here avoids a separate name-cache store.
    const name = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8').trim() : slugToName(baseUrl);
    res.json({ name });
  });

  /* Saves a custom display name for a Netlify URL.
   * Expects a JSON body with { url, name }. Persists to the hash-keyed .txt file. */
  router.put('/api/advertiser', express.json(), (req, res) => {
    const { url, name } = req.body || {};
    if (!url || !name) return res.status(400).json({ error: 'Missing url or name' });
    let baseUrl;
    try { const u = new URL(url.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = url; }
    const hash = crypto.createHash('md5').update(baseUrl).digest('hex');
    fs.writeFileSync(path.join(SCREENSHOT_DIR, `${hash}.txt`), name.trim());
    res.json({ ok: true });
  });

  return router;
};
