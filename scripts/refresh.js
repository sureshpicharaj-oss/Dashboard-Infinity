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
const { fetchActiveViewStatsWithSplits } = require('../lib/active-view-data');
const { resolveCustomTargetingValues } = require('../lib/gam-targeting');
const { computeAttention } = require('../lib/attention'); // Transparent+ score — single source of truth

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
  const { results, urlLineItemMap, urlLicaImpsMap, videoIdMap, urlSplitsMap } = await fetchDashboardData(networkCode, token);
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

  let activeView, avPerCreative = {}, activeViewFailed = false;
  try {
    console.log('Running active view fetch…');
    const avResult = await fetchActiveViewStatsWithSplits(urlLineItemMap, urlLicaImpsMap, networkCode, token);
    activeView = avResult.byUrl;
    avPerCreative = avResult.perCreative || {};
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
      avgViewableSec:       av?.avgViewableSec ?? null,
      completionRate:       vs?.completionRate ?? null,
      durationSec:          vs?.durationSec ?? null,
      videoStarts:          vs?.videoStarts ?? null,
      attention:            computeAttention({ device: r.device, viewability: av?.rate ?? null, avgViewableSec: av?.avgViewableSec ?? null, ctr: r.ctr, completionRate: vs?.completionRate ?? null, impressions: r.impressions }),
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

  // Per-creative split detail for the row drill-down modal (public/index.html). Built from
  // urlSplitsMap (exact per-creative impressions/clicks/CTR + name), enriched best-effort
  // with per-creative viewability (AV fingerprint) and per-row completion (video stats),
  // plus custom-targeting key values resolved to readable labels. Keyed by the same
  // composite group key as the active-view cache. Non-fatal — a failure keeps the prior file.
  let splitsFailed = false;
  let splitsOut = null;
  try {
    // Resolve every distinct custom-targeting value ID across all splits in one batched pass.
    const allValueIds = [...new Set(
      Object.values(urlSplitsMap || {}).flat().flatMap(s => s.keyValueIds || [])
    )];
    let kvLabels = {};
    if (allValueIds.length) {
      kvLabels = await resolveCustomTargetingValues(allValueIds, networkCode, token);
      console.log(`Resolved ${Object.keys(kvLabels).length}/${allValueIds.length} custom-targeting value labels`);
    }

    splitsOut = {};
    for (const [groupKey, splits] of Object.entries(urlSplitsMap || {})) {
      const [, gVideoId = '', gDevice = ''] = groupKey.split('##');
      const vs = gVideoId ? (videoStats[`${gVideoId}_${gDevice}`] ?? videoStats[gVideoId]) : null;
      const rowCompletion = vs?.completionRate ?? null;
      const avForKey = avPerCreative[groupKey] || {};
      splitsOut[groupKey] = splits.map(s => {
        const av = avForKey[s.creativeId];
        // De-dupe key values by key+value (a creative on several line items can repeat them).
        const seen = new Set();
        const keyValues = [];
        for (const id of (s.keyValueIds || [])) {
          const lbl = kvLabels[id];
          if (!lbl) continue;
          const dedup = `${lbl.key}\0${lbl.value}`;
          if (seen.has(dedup)) continue;
          seen.add(dedup);
          keyValues.push(lbl);
        }
        return {
          creativeId:     s.creativeId,
          name:           s.name,
          impressions:    s.impressions,
          clicks:         s.clicks,
          ctr:            s.ctr,
          viewability:    av?.rate ?? null,
          viewable:       av?.viewable ?? null,
          measurable:     av?.measurable ?? null,
          avgViewableSec: av?.avgViewableSec ?? null,
          completionRate: rowCompletion,
          attention:      computeAttention({ device: gDevice, viewability: av?.rate ?? null, avgViewableSec: av?.avgViewableSec ?? null, ctr: s.ctr, completionRate: rowCompletion, impressions: s.impressions }),
          lineItemIds:    s.lineItemIds,
          keyValues,
          impsByAdUnit:   s.impsByAdUnit || {},
          adUnitCoverage: s.adUnitCoverage ?? null,
          liveStatus:     s.liveStatus ?? null,
        };
      });
    }
    console.log(`Splits: ${Object.keys(splitsOut).length} group keys`);
  } catch (err) {
    splitsFailed = true;
    splitsOut = readCache('splits_cache.json', {});
    console.warn(`⚠ Splits build failed: ${err.message || err} — reusing cached splits; dashboard refresh continues`);
  }

  if (!splitsFailed) {
    fs.writeFileSync(path.join(dataDir, 'splits_cache.json'), JSON.stringify(splitsOut));
  } else {
    console.warn('Skipped rewriting splits_cache.json (build failed; prior cache kept)');
  }

  console.log('Refresh complete. Files written to public/data/');
}

main().catch(err => {
  console.error('Refresh failed:', err.message || err);
  process.exit(1);
});
