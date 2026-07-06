'use strict';

/*
 * Tag routes — four endpoints for managing two separate JSON stores in SCREENSHOT_DIR:
 *   tag_rules.json  — a map of rule definitions used to auto-assign categories
 *   url_tags.json   — a map of { netlifyUrl: category } for per-URL manual overrides
 * Both stores are read and written as flat JSON files; no database is involved.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {
  const TAG_RULES_PATH = path.join(SCREENSHOT_DIR, 'tag_rules.json');
  const URL_TAGS_PATH  = path.join(SCREENSHOT_DIR, 'url_tags.json');

  /* Returns the full tag rules object, or {} if no rules have been saved yet. */
  router.get('/api/tag-rules', (req, res) => {
    try {
      const rules = fs.existsSync(TAG_RULES_PATH) ? JSON.parse(fs.readFileSync(TAG_RULES_PATH, 'utf8')) : {};
      res.json(rules);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Replaces the entire tag rules object. Expects a plain JSON object in the request body. */
  router.post('/api/tag-rules', express.json(), (req, res) => {
    try {
      const rules = req.body;
      if (typeof rules !== 'object' || Array.isArray(rules)) return res.status(400).json({ error: 'Expected object' });
      fs.writeFileSync(TAG_RULES_PATH, JSON.stringify(rules, null, 2));
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Returns the full URL-to-category map, or {} if no tags have been saved yet. */
  router.get('/api/url-tags', (req, res) => {
    try {
      const tags = fs.existsSync(URL_TAGS_PATH) ? JSON.parse(fs.readFileSync(URL_TAGS_PATH, 'utf8')) : {};
      res.json(tags);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Sets or removes the category tag for a single URL.
   * Expects { url, category } in the request body. Omitting category (or sending null/empty)
   * removes the entry rather than writing a blank value. */
  router.post('/api/url-tags', express.json(), (req, res) => {
    try {
      const { url, category } = req.body;
      if (!url) return res.status(400).json({ error: 'url required' });
      const tags = fs.existsSync(URL_TAGS_PATH) ? JSON.parse(fs.readFileSync(URL_TAGS_PATH, 'utf8')) : {};
      if (category) tags[url] = category;
      else delete tags[url];
      fs.writeFileSync(URL_TAGS_PATH, JSON.stringify(tags, null, 2));
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
