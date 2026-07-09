'use strict';

/*
 * Standalone refresh script — run by GitHub Actions on a daily cron schedule.
 * Fetches all GAM data and writes three JSON files to data/ which Netlify serves
 * as static assets. No Express, no HTTP server required.
 *
 * Usage: node scripts/refresh.js
 * Env vars required: GAM_NETWORK_CODE, GAM_CLIENT_ID, GAM_CLIENT_SECRET, GAM_REFRESH_TOKEN
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getToken } = require('../lib/auth');
const { fetchDashboardData } = require('../lib/dashboard-data');
const { fetchVideoStats } = require('../lib/video-data');
const { fetchActiveViewStats } = require('../lib/active-view-data');

async function main() {
  const networkCode = process.env.GAM_NETWORK_CODE;
  if (!networkCode) throw new Error('GAM_NETWORK_CODE is not set');

  console.log('Fetching GAM token…');
  const token = await getToken();

  console.log('Running dashboard fetch…');
  const { results, urlLineItemMap, urlLicaImpsMap, videoIdMap } = await fetchDashboardData(networkCode, token);
  console.log(`Dashboard: ${results.length} rows`);

  console.log('Running video stats fetch…');
  const videoStats = await fetchVideoStats(Object.keys(videoIdMap), networkCode, token);
  console.log(`Video stats: ${Object.keys(videoStats).length} video IDs`);

  console.log('Running active view fetch…');
  const activeView = await fetchActiveViewStats(urlLineItemMap, urlLicaImpsMap, networkCode, token);
  console.log(`Active view: ${Object.keys(activeView).length} URLs`);

  // Merge video stats and active view into results
  const mergedResults = results.map(r => ({
    ...r,
    activeView:           activeView[r.netlifyUrl]?.rate ?? null,
    activeViewViewable:   activeView[r.netlifyUrl]?.viewable ?? null,
    activeViewMeasurable: activeView[r.netlifyUrl]?.measurable ?? null,
    completionRate:       r.videoId ? (videoStats[r.videoId]?.completionRate ?? null) : null,
    durationSec:          r.videoId ? (videoStats[r.videoId]?.durationSec ?? null) : null,
  }));

  const dataDir = path.join(__dirname, '..', 'public', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(
    path.join(dataDir, 'dashboard_cache.json'),
    JSON.stringify({ total: mergedResults.length, lastFetched: new Date().toISOString(), results: mergedResults })
  );
  fs.writeFileSync(
    path.join(dataDir, 'video_stats_cache.json'),
    JSON.stringify(videoStats)
  );
  fs.writeFileSync(
    path.join(dataDir, 'active_view_cache.json'),
    JSON.stringify(activeView)
  );

  console.log('Refresh complete. Files written to public/data/');
}

main().catch(err => {
  console.error('Refresh failed:', err.message || err);
  process.exit(1);
});
