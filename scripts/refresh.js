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

  const dataDir = path.join(__dirname, '..', 'public', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // Reads a previously-written cache file, or returns the fallback if it's missing/corrupt.
  const readCache = (name, fallback) => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')); }
    catch { return fallback; }
  };

  console.log('Fetching GAM token…');
  const token = await getToken();

  // Dashboard fetch is the primary product — if it fails there is nothing worth committing,
  // so let it throw and abort the run (exit 1 gates the workflow's commit step).
  console.log('Running dashboard fetch…');
  const { results, urlLineItemMap, urlLicaImpsMap, videoIdMap } = await fetchDashboardData(networkCode, token);
  console.log(`Dashboard: ${results.length} rows`);

  // Video stats and active view are supplementary enrichments merged onto dashboard rows.
  // A transient GAM failure in either must NOT discard the whole day's dashboard refresh:
  // fall back to the previously-cached values (so rows keep yesterday's numbers rather than
  // going null) and skip overwriting that cache file with degraded data.
  let videoStats, videoStatsFailed = false;
  try {
    console.log('Running video stats fetch…');
    videoStats = await fetchVideoStats(videoIdMap, networkCode, token);
    console.log(`Video stats: ${Object.keys(videoStats).length} keys`);
  } catch (err) {
    videoStatsFailed = true;
    videoStats = readCache('video_stats_cache.json', {});
    console.warn(`⚠ Video stats fetch failed: ${err.message || err} — reusing ${Object.keys(videoStats).length} cached keys; dashboard refresh continues`);
  }

  let activeView, activeViewFailed = false;
  try {
    console.log('Running active view fetch…');
    activeView = await fetchActiveViewStats(urlLineItemMap, urlLicaImpsMap, networkCode, token);
    console.log(`Active view: ${Object.keys(activeView).length} URLs`);
  } catch (err) {
    activeViewFailed = true;
    activeView = readCache('active_view_cache.json', {});
    console.warn(`⚠ Active view fetch failed: ${err.message || err} — reusing ${Object.keys(activeView).length} cached URLs; dashboard refresh continues`);
  }

  // Merge video stats and active view into results. Active view is keyed by the same
  // composite group key as rows (netlifyUrl##videoId##device) so a URL with both a desktop
  // skin and video creatives gets independent viewability per row instead of one blended
  // number stamped onto everything sharing that URL.
  const mergedResults = results.map(r => {
    const avKey = `${r.netlifyUrl}##${r.videoId || ''}##${r.device}`;
    const av = activeView[avKey];
    const vs = r.videoId ? (videoStats[r.videoId + '_' + r.device] ?? videoStats[r.videoId]) : null;
    return {
      ...r,
      activeView:           av?.rate ?? null,
      activeViewViewable:   av?.viewable ?? null,
      activeViewMeasurable: av?.measurable ?? null,
      completionRate:       vs?.completionRate ?? null,
      durationSec:          vs?.durationSec ?? null,
      videoStarts:          vs?.videoStarts ?? null,
    };
  });

  fs.writeFileSync(
    path.join(dataDir, 'dashboard_cache.json'),
    JSON.stringify({ total: mergedResults.length, lastFetched: new Date().toISOString(), results: mergedResults })
  );
  // Only rewrite a supplementary cache when its fetch succeeded — otherwise keep the prior
  // file so a transient failure doesn't blank out yesterday's good video/AV data.
  if (!videoStatsFailed) {
    fs.writeFileSync(path.join(dataDir, 'video_stats_cache.json'), JSON.stringify(videoStats));
  } else {
    console.warn('Skipped rewriting video_stats_cache.json (fetch failed; prior cache kept)');
  }
  if (!activeViewFailed) {
    fs.writeFileSync(path.join(dataDir, 'active_view_cache.json'), JSON.stringify(activeView));
  } else {
    console.warn('Skipped rewriting active_view_cache.json (fetch failed; prior cache kept)');
  }

  console.log('Refresh complete. Files written to public/data/');
}

main().catch(err => {
  console.error('Refresh failed:', err.message || err);
  process.exit(1);
});
