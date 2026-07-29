'use strict';

/*
 * Alert-acknowledgement route — one endpoint backing a single JSON store in SCREENSHOT_DIR:
 *   alert_acks.json — a map of { groupKey: { ackAt, ctr, activeView, completionRate } }
 * where groupKey is the row's composite `netlifyUrl##videoId##device`. Records that a user has
 * "looked into" an under-performing line item (clearing its whole-row red alert). The stored metric
 * values are the row's values at acknowledgement time, so the frontend can re-fire the alert if the
 * line item later performs WORSE than when it was reviewed. Mirrors routes/tags.js; no database.
 * Kept separate from the dashboard data caches, so the daily refresh never overwrites it.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {
  const ALERT_ACKS_PATH = path.join(SCREENSHOT_DIR, 'alert_acks.json');

  /* Returns the full acknowledgement map, or {} if nothing has been acknowledged yet. */
  router.get('/api/alert-acks', (req, res) => {
    try {
      const acks = fs.existsSync(ALERT_ACKS_PATH) ? JSON.parse(fs.readFileSync(ALERT_ACKS_PATH, 'utf8')) : {};
      res.json(acks);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Sets or clears the acknowledgement for one row.
   * Expects { key, ack } — `ack` is the metric snapshot object to store; a falsy/missing `ack`
   * removes the entry (un-review) rather than storing a blank value. */
  router.post('/api/alert-acks', express.json(), (req, res) => {
    try {
      const { key, ack } = req.body;
      if (!key) return res.status(400).json({ error: 'key required' });
      const acks = fs.existsSync(ALERT_ACKS_PATH) ? JSON.parse(fs.readFileSync(ALERT_ACKS_PATH, 'utf8')) : {};
      if (ack) acks[key] = ack;
      else delete acks[key];
      fs.writeFileSync(ALERT_ACKS_PATH, JSON.stringify(acks, null, 2));
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
