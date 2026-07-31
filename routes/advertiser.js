'use strict';

/*
 * Advertiser display-NAME routes — the human-readable name shown in the "Creative" column, overridable
 * per Netlify URL. Stored as a single JSON map { url: name } in SCREENSHOT_DIR/url_names.json so the
 * client can bulk-load every override on start-up and re-apply them after each refresh. (The GAM pipeline
 * only produces the auto-derived slug name, so without applying these overrides on load the edit reverts.)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { slugToName } = require('../lib/utils');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {
  const NAMES_PATH = path.join(SCREENSHOT_DIR, 'url_names.json');
  const readMap = () => { try { return fs.existsSync(NAMES_PATH) ? JSON.parse(fs.readFileSync(NAMES_PATH, 'utf8')) : {}; } catch(e) { return {}; } };

  /* GET (no ?url) returns the whole { url: name } map; GET ?url=<netlify-url> returns { name } for one URL
   * (falling back to the derived slug name), for the per-row lookup. */
  router.get('/api/advertiser', (req, res) => {
    const map = readMap();
    const rawUrl = req.query.url;
    if (!rawUrl) return res.json(map);
    let baseUrl; try { const u = new URL(rawUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = rawUrl; }
    res.json({ name: map[rawUrl] || map[baseUrl] || slugToName(baseUrl) });
  });

  /* PUT { url, name } upserts the override (empty/absent name deletes it). */
  router.put('/api/advertiser', express.json(), (req, res) => {
    const { url, name } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const map = readMap();
    if (name && String(name).trim()) map[url] = String(name).trim(); else delete map[url];
    fs.writeFileSync(NAMES_PATH, JSON.stringify(map, null, 2));
    res.json({ ok: true });
  });

  return router;
};
