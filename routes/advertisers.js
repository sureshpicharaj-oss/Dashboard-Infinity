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

  /* Three ops on the url-advertisers store:
   *  - { url, advertiser }        assign (or remove, if advertiser is null/empty) an advertiser to a URL
   *  - { addName: "Honda" }       register an advertiser NAME (master list, reserved "__names" key)
   *  - { removeName: "Honda" }    drop a name from the master list
   * The name list lets an advertiser exist (assignable from a creative's Edit) before it's assigned anywhere. */
  router.post('/api/url-advertisers', express.json(), (req, res) => {
    try {
      const { url, advertiser, addName, removeName } = req.body || {};
      const map = fs.existsSync(URL_ADVERTISERS_PATH) ? JSON.parse(fs.readFileSync(URL_ADVERTISERS_PATH, 'utf8')) : {};
      if (addName) { const s = new Set(map.__names || []); s.add(addName); map.__names = [...s]; }
      else if (removeName) { map.__names = (map.__names || []).filter(n => n !== removeName); }
      else if (url) { if (advertiser) map[url] = advertiser; else delete map[url]; }
      else return res.status(400).json({ error: 'url or name required' });
      fs.writeFileSync(URL_ADVERTISERS_PATH, JSON.stringify(map, null, 2));
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
