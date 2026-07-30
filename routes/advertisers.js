'use strict';

/*
 * Advertiser-assignment routes — a Tags-style store mapping a Netlify URL to a manually-assigned
 * advertiser (brand). Mirrors the url-tags half of routes/tags.js: a single flat JSON map in
 * SCREENSHOT_DIR, read/written wholesale, with a POST upsert/delete.
 *
 * NOTE: distinct from routes/advertiser.js (singular), which stores the per-URL display NAME shown
 * in the "Creative" column. This one is the assignable brand behind the creative.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {
  const URL_ADVERTISERS_PATH = path.join(SCREENSHOT_DIR, 'url_advertisers.json');

  /* Returns the full URL-to-advertiser map, or {} if nothing has been assigned yet. */
  router.get('/api/url-advertisers', (req, res) => {
    try {
      const map = fs.existsSync(URL_ADVERTISERS_PATH) ? JSON.parse(fs.readFileSync(URL_ADVERTISERS_PATH, 'utf8')) : {};
      res.json(map);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Sets or removes the advertiser for a single URL.
   * Expects { url, advertiser }. Omitting advertiser (or sending null/empty) removes the entry. */
  router.post('/api/url-advertisers', express.json(), (req, res) => {
    try {
      const { url, advertiser } = req.body;
      if (!url) return res.status(400).json({ error: 'url required' });
      const map = fs.existsSync(URL_ADVERTISERS_PATH) ? JSON.parse(fs.readFileSync(URL_ADVERTISERS_PATH, 'utf8')) : {};
      if (advertiser) map[url] = advertiser;
      else delete map[url];
      fs.writeFileSync(URL_ADVERTISERS_PATH, JSON.stringify(map, null, 2));
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
