/**
 * server-desktop.js — Infinity Dashboard (desktop entry point)
 *
 * Serves the desktop-only view of the GAM creative monitoring dashboard.
 * Runs on port 3001.
 *
 * Start: node server-desktop.js
 *
 * Routes are split into modules under routes/. Each route factory receives
 * SCREENSHOT_DIR so it can read/write the JSON cache files (url_lineitem_cache,
 * active_view_cache, etc.) and serve screenshot images — all stored in the
 * same directory under public/screenshots/.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3001;

// Shared directory for screenshot PNGs and JSON caches written by route handlers.
// Created eagerly so routes don't need to guard against its absence.
const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// API routes first — if express.static came before these, a file named
// after a route path could shadow the API endpoint.
app.use(require('./routes/auth'));
app.use(require('./routes/dashboard')(SCREENSHOT_DIR));
app.use(require('./routes/screenshot')(SCREENSHOT_DIR));
app.use(require('./routes/advertiser')(SCREENSHOT_DIR));
app.use(require('./routes/active-view')(SCREENSHOT_DIR));
app.use(require('./routes/video-stats')(SCREENSHOT_DIR));
app.use(require('./routes/tags')(SCREENSHOT_DIR));
app.use(require('./routes/debug')());

// Static files served after routes so API paths take precedence.
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`GAM Dashboard running at http://localhost:${PORT}`);
});
