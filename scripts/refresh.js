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
const { resolveCustomTargetingValues, resolveCustomTargetingKeyIds } = require('../lib/gam-targeting');
const { fetchSegmentPerformance, CRITERIA_KEYS, AUDIENCE_CRITERIA_KEYS } = require('../lib/gam-segments');

// Aggregates per-line-item segment delivery (from fetchSegmentPerformance) up to each dashboard
// row, then ranks each key's values by CTR. Returns, per group key, the single best contextual
// (key,value) for the row's highlight chip plus per-key top/bottom lists for the modal.
// A volume floor keeps statistically-meaningless segments out of the ranking.
function buildPerfBySegment(results, segByLI, opts = {}) {
  const N = opts.n || 4;           // top/bottom values kept per key
  const out = {};
  for (const r of results) {
    const gk = `${r.netlifyUrl}##${r.videoId || ''}##${r.device}`;
    // Volume floor is relative to the row's total delivery: a segment must account for at
    // least 1% of the creative's impressions to be ranked (10,000 imp → 100), with a 100-imp
    // absolute minimum so tiny rows don't rank statistical noise.
    const rowImps = r.impressions || 0;
    const floor = Math.max(100, Math.round(rowImps * 0.01));
    const agg = {}; // key -> value -> { impressions, clicks }
    for (const li of (r.lineItemIds || [])) {
      const byKeyLI = segByLI[li];
      if (!byKeyLI) continue;
      for (const [key, vals] of Object.entries(byKeyLI)) {
        if (!agg[key]) agg[key] = {};
        for (const [val, s] of Object.entries(vals)) {
          const cur = agg[key][val] || (agg[key][val] = { impressions: 0, clicks: 0 });
          cur.impressions += s.impressions; cur.clicks += s.clicks;
        }
      }
    }
    // Rank every contextual key that actually has delivery. Data presence IS the site scoping:
    // a Top Gear-only creative has make/range data but no diet/meal-type; a Good Food creative
    // the reverse; a cross-site creative shows both. This is more robust than filtering by the
    // (sometimes partial) ad-unit fingerprint. permutive (audience) is shown in the modal too
    // but never wins the contextual headline chip.
    const contextualKeys = CRITERIA_KEYS;
    const rankKeys = [...CRITERIA_KEYS, ...AUDIENCE_CRITERIA_KEYS, 'permutive'];
    const byKey = {};
    let best = null;
    for (const key of rankKeys) {
      const vals = agg[key];
      if (!vals) continue;
      const ranked = Object.entries(vals)
        .map(([value, s]) => ({
          value,
          impressions: s.impressions,
          clicks: s.clicks,
          ctr: s.impressions > 0 ? parseFloat(((s.clicks / s.impressions) * 100).toFixed(2)) : 0,
        }))
        .filter(v => v.impressions >= floor)
        .sort((a, b) => b.ctr - a.ctr);
      if (!ranked.length) continue;
      const top = ranked.slice(0, N);
      const bottom = ranked.length > N ? ranked.slice(-N).reverse() : [];
      byKey[key] = { top, bottom };
      const cand = top[0];
      if (contextualKeys.includes(key) && cand && cand.clicks > 0 && (!best || cand.ctr > best.ctr)) {
        best = { key, ...cand };
      }
    }
    if (Object.keys(byKey).length) out[gk] = { best, byKey };
  }
  return out;
}

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
          const dedup = `${lbl.key} ${lbl.value}`;
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
          completionRate: rowCompletion,
          lineItemIds:    s.lineItemIds,
          keyValues,
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

  // Segment performance — which custom-targeting key values a row performed best/worst on
  // (by CTR). Two GAM reports (CUSTOM_CRITERIA for cat/ap_gen/ap_stda/posttag, plus a
  // CUSTOM_DIMENSION report for permutive), aggregated per row. Non-fatal, like the others.
  let perfFailed = false;
  let perfOut = null;
  try {
    console.log('Running segment performance fetch…');
    const allLIs = [...new Set(results.flatMap(r => r.lineItemIds || []))];
    const keyIds = await resolveCustomTargetingKeyIds(['permutive'], networkCode, token);
    const segByLI = await fetchSegmentPerformance(allLIs, keyIds['permutive'], networkCode, token, { days: 1094 });
    perfOut = buildPerfBySegment(results, segByLI);
    console.log(`Segment performance: ${Object.keys(perfOut).length} rows with segment data`);
  } catch (err) {
    perfFailed = true;
    perfOut = readCache('perf_by_segment_cache.json', {});
    console.warn(`⚠ Segment performance fetch failed: ${err.message || err} — reusing cached; dashboard refresh continues`);
  }

  if (!perfFailed) {
    fs.writeFileSync(path.join(dataDir, 'perf_by_segment_cache.json'), JSON.stringify(perfOut));
  } else {
    console.warn('Skipped rewriting perf_by_segment_cache.json (fetch failed; prior cache kept)');
  }

  console.log('Refresh complete. Files written to public/data/');
}

main().catch(err => {
  console.error('Refresh failed:', err.message || err);
  process.exit(1);
});
