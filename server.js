/**
 * server.js — Infinity Dashboard (full entry point)
 *
 * Handles both desktop and mobile creatives.
 * Runs on port 3000 (or the PORT env var).
 *
 * Start: node server.js
 *
 * Routes are split into modules under routes/. Each route factory receives
 * SCREENSHOT_DIR so it can read/write the JSON cache files (url_lineitem_cache,
 * active_view_cache, etc.) and serve screenshot images — all stored in the
 * same directory under public/screenshots/.
 *
 * For the desktop-only view see server-desktop.js (port 3001).
 */

require('dotenv').config();
// Prefer IPv4 for outbound connections. Node 18 tries IPv6 first ('verbatim'), and on
// networks with broken/flaky IPv6 routing the GAM/OAuth calls hang until timeout — which the
// dashboard then mislabels as an expired token. Forcing IPv4-first makes those calls reliable.
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// PNG screenshots directory
const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// JSON data cache directory — shared with scripts/refresh.js
const DATA_DIR = path.join(__dirname, 'public', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// API routes first — if express.static came before these, a file named
// after a route path could shadow the API endpoint.
app.use(require('./routes/auth-full'));
app.use(require('./routes/dashboard-full')(DATA_DIR));
app.use(require('./routes/screenshot')(SCREENSHOT_DIR));
app.use(require('./routes/advertiser')(SCREENSHOT_DIR));
app.use(require('./routes/active-view')(DATA_DIR));
app.use(require('./routes/video-stats')(DATA_DIR));
app.use(require('./routes/tags')(SCREENSHOT_DIR));
app.use(require('./routes/debug')());

// Static files served after routes so API paths take precedence.
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`GAM Dashboard running at http://localhost:${PORT}`);
  // Auto-refresh dashboard data every 4 hours so the cache never goes stale between
  // manual refreshes — catches newly-trafficked campaigns and completed line items.
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const autoRefresh = () => {
    console.log('[auto-refresh] triggering scheduled dashboard refresh...');
    const http = require('http');
    const req = http.get(`http://localhost:${PORT}/api/dashboard`, res => {
      res.resume();
      res.on('end', () => console.log(`[auto-refresh] done (status ${res.statusCode})`));
    });
    req.on('error', err => console.warn('[auto-refresh] error:', err.message));
    req.end();
  };
  setInterval(autoRefresh, FOUR_HOURS);
});
