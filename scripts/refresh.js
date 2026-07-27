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
// Prefer IPv4 for outbound connections — on networks with broken/flaky IPv6, Node 18's
// IPv6-first default makes the GAM/OAuth calls hang until timeout.
require('dns').setDefaultResultOrder('ipv4first');
const fs = require('fs');
const path = require('path');
const { getToken } = require('../lib/auth');
const { fetchDashboardData } = require('../lib/dashboard-data');
const { fetchVideoStats } = require('../lib/video-data');
const { fetchActiveViewStatsWithSplits } = require('../lib/active-view-data');
const { resolveCustomTargetingValues, resolveCustomTargetingKeyIds } = require('../lib/gam-targeting');
const { fetchSegmentPerformance, CRITERIA_KEYS, AUDIENCE_CRITERIA_KEYS } = require('../lib/gam-segments');

// Ranks a segment aggregate (key -> value -> {impressions,clicks}) by CTR and derives the cross-key
// delivery bounds. Shared by the row-level highlight chip AND the per-creative split dropdowns, so
// the honest-bounds math lives in exactly one place. Returns { best, byKey, delivery }.
function computeSegView(agg, opts = {}) {
  const { floor = 100, rowCtr = 0, delivery: rowDelivery = null, n = 4 } = opts;
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
    const top = ranked.slice(0, n);
    const bottom = ranked.length > n ? ranked.slice(-n).reverse() : [];
    byKey[key] = { top, bottom };
    const cand = top[0];
    if (contextualKeys.includes(key) && cand && cand.clicks > 0 && (!best || cand.ctr > best.ctr)) {
      best = { key, ...cand };
    }
  }
  // Cross-key delivery read — bounds only (unions across keys can't be summed exactly). All
  // fractions are of TSeg, the delivered total from the most-covering single-valued taxonomy key
  // (cat/subcat/primary_cat/category), which never over-counts, so retained fractions stay
  // conservative. See public/index.html deliveryHtml() for how the verdicts render.
  const RELIABLE_TOTAL_KEYS = ['cat', 'subcat', 'primary_cat', 'category'];
  const threshold = (rowCtr || 0) * 0.9;
  let TSeg = 0;
  const perKey = {};
  for (const key of contextualKeys) {
    const vals = agg[key];
    if (!vals) continue;
    let total = 0, aboveImps = 0, aboveClicks = 0, belowImps = 0;
    for (const s of Object.values(vals)) {
      const ctr = s.impressions > 0 ? (s.clicks / s.impressions) * 100 : 0;
      total += s.impressions;
      if (ctr >= threshold) { aboveImps += s.impressions; aboveClicks += s.clicks; }
      else belowImps += s.impressions;
    }
    perKey[key] = { total, aboveImps, aboveClicks, belowImps };
    if (RELIABLE_TOTAL_KEYS.includes(key) && total > TSeg) TSeg = total;
  }
  let delivery = null;
  if (TSeg > 0) {
    let incBestImps = 0, incBestClicks = 0, incBestKey = null, incSumImps = 0;
    let exclSumBelow = 0, exclMaxBelow = 0;
    for (const k of Object.keys(perKey)) {
      const pk = perKey[k];
      incSumImps += pk.aboveImps;                 // all keys → optimistic ceiling (over-counts)
      exclSumBelow += pk.belowImps;               // all keys → pessimistic removal (over-counts)
      // Single-key bounds (inclusion FLOOR, exclusion BEST) from single-valued taxonomy keys only —
      // multi-valued keys (posttag/tag/tags) over-count and would inflate the floor / deflate the best.
      if (RELIABLE_TOTAL_KEYS.includes(k)) {
        if (pk.aboveImps > incBestImps) { incBestImps = pk.aboveImps; incBestClicks = pk.aboveClicks; incBestKey = k; }
        if (pk.belowImps > exclMaxBelow) exclMaxBelow = pk.belowImps;
      }
    }
    const d = rowDelivery || {};
    const rrf = (d.requiredRetainFrac != null && isFinite(d.requiredRetainFrac)) ? d.requiredRetainFrac : null;
    const incLowerFrac = Math.min(1, incBestImps / TSeg);
    const incUpperFrac = Math.min(1, incSumImps / TSeg);
    const exclWorstFrac = Math.max(0, 1 - Math.min(1, exclSumBelow / TSeg));
    const exclBestFrac  = Math.max(0, 1 - Math.min(1, exclMaxBelow / TSeg));
    const verdict = (lower, upper) => rrf == null ? 'na' : lower >= rrf ? 'safe' : upper >= rrf ? 'maybe' : 'unlikely';
    delivery = {
      hasGoal: !!d.hasGoal, behind: !!d.behind, sponsorship: !!d.sponsorship,
      openEnded: !!d.openEnded, completed: !!d.completed,
      requiredRetainFrac: rrf, goalUnits: d.goalUnits || null, remaining: d.remaining || null,
      endTs: d.endTs || null, paceCushion: d.paceCushion ?? null,
      incBestKey, incBestCtr: incBestImps > 0 ? parseFloat((incBestClicks / incBestImps * 100).toFixed(2)) : 0,
      incLowerFrac, incUpperFrac, exclWorstFrac, exclBestFrac,
      verdictIncl: verdict(incLowerFrac, incUpperFrac),
      verdictExcl: verdict(exclWorstFrac, exclBestFrac),
      rowCtr: rowCtr || 0,
    };
  }
  return { best, byKey, delivery };
}

// Aggregates ONE creative's segment rows out of the CREATIVE_ID-broken-out report, using the
// fingerprint's rendered-creative-id-per-line-item map. Falls back to line-item level (all creatives
// on a line item) where the creative couldn't be separated. Returns { agg, segBasis }.
function aggregateCreativeSeg(renderedByLI, lineItemIds, segByLICreative) {
  const agg = {};
  const merge = (byKey) => {
    for (const [key, vals] of Object.entries(byKey)) {
      if (!agg[key]) agg[key] = {};
      for (const [val, s] of Object.entries(vals)) {
        const cur = agg[key][val] || (agg[key][val] = { impressions: 0, clicks: 0 });
        cur.impressions += s.impressions; cur.clicks += s.clicks;
      }
    }
  };
  const rbl = renderedByLI || {};
  let liWithData = 0, liFallback = 0;
  for (const li of (lineItemIds || [])) {
    const byCid = segByLICreative[li];
    if (!byCid) continue;
    liWithData++;
    const rcid = rbl[li];
    if (rcid && byCid[rcid]) merge(byCid[rcid]);
    else { for (const cid of Object.keys(byCid)) merge(byCid[cid]); liFallback++; }
  }
  const segBasis = liWithData === 0 ? 'none' : liFallback === 0 ? 'creative' : liFallback === liWithData ? 'line-item' : 'partial';
  return { agg, segBasis };
}

// Aggregates per-line-item segment delivery (from fetchSegmentPerformance) up to each dashboard
// row, then ranks each key's values by CTR. Returns, per group key, the single best contextual
// (key,value) for the row's highlight chip plus per-key top/bottom lists for the modal.
// A volume floor keeps statistically-meaningless segments out of the ranking.
function buildPerfBySegment(results, segByLICreative, opts = {}) {
  const N = opts.n || 4;           // top/bottom values kept per key
  const out = {};
  for (const r of results) {
    const gk = `${r.netlifyUrl}##${r.videoId || ''}##${r.device}`;
    // Volume floor is relative to the row's total delivery: a segment must account for at
    // least 1% of the creative's impressions to be ranked (10,000 imp → 100), with a 100-imp
    // absolute minimum so tiny rows don't rank statistical noise.
    const rowImps = r.impressions || 0;
    const floor = Math.max(100, Math.round(rowImps * 0.01));
    // Aggregate THIS row's own creatives only. The segment report is broken out by CREATIVE_ID,
    // and reportCreativeIdsByLI (from the impression fingerprint) tells us which rendered creatives
    // on each line item are this row's. Where a line item has no resolved creatives (fingerprint
    // ambiguous/failed), fall back to line-item level (all creatives on it) and flag it — a shared
    // line item's siblings then blend in for that line item only. segBasis records the outcome.
    const agg = {}; // key -> value -> { impressions, clicks }
    const mergeCreative = (byKey) => {
      for (const [key, vals] of Object.entries(byKey)) {
        if (!agg[key]) agg[key] = {};
        for (const [val, s] of Object.entries(vals)) {
          const cur = agg[key][val] || (agg[key][val] = { impressions: 0, clicks: 0 });
          cur.impressions += s.impressions; cur.clicks += s.clicks;
        }
      }
    };
    const cidsByLI = r.reportCreativeIdsByLI || {};
    let liWithData = 0, liFallback = 0;
    for (const li of (r.lineItemIds || [])) {
      const byCid = segByLICreative[li];
      if (!byCid) continue;
      liWithData++;
      const rowCids = cidsByLI[li] || [];
      const matched = rowCids.filter(cid => byCid[cid]);
      if (matched.length) {
        for (const cid of matched) mergeCreative(byCid[cid]);   // creative-level (this row's own)
      } else {
        for (const cid of Object.keys(byCid)) mergeCreative(byCid[cid]); // line-item fallback
        liFallback++;
      }
    }
    const segBasis = liWithData === 0 ? 'none'
                   : liFallback === 0 ? 'creative'
                   : liFallback === liWithData ? 'line-item' : 'partial';
    const { best, byKey, delivery } = computeSegView(agg, { floor, rowCtr: r.ctr || 0, delivery: r.delivery, n: N });
    if (Object.keys(byKey).length) out[gk] = { best, byKey, delivery, segBasis };
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

  // Segment performance report (broken out by CREATIVE_ID). Fetched once, then used BOTH to attach
  // each creative's own segment/delivery detail to the splits below AND to build the row-level chip
  // cache. Non-fatal: on failure segByLICreative stays {} and splits/perf just omit segment data.
  let segByLICreative = {};
  try {
    console.log('Running segment performance fetch…');
    const allLIs = [...new Set(results.flatMap(r => r.lineItemIds || []))];
    const permKeyIds = await resolveCustomTargetingKeyIds(['permutive'], networkCode, token);
    segByLICreative = await fetchSegmentPerformance(allLIs, permKeyIds['permutive'], networkCode, token, { days: 1094 });
  } catch (err) {
    console.warn(`⚠ Segment performance fetch failed: ${err.message || err} — splits/perf omit segment data`);
  }

  // Per-creative split detail for the row drill-down modal (public/index.html). Built from
  // urlSplitsMap (exact per-creative impressions/clicks/CTR + name), enriched best-effort
  // with per-creative viewability (AV fingerprint), per-row completion (video stats), resolved
  // custom-targeting key values, AND each creative's own segment performance + delivery read
  // (seg). Keyed by the composite group key. Non-fatal — a failure keeps the prior file.
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
        // This creative's own segment performance + delivery read (its dropdown in the modal).
        const { agg, segBasis } = aggregateCreativeSeg(s.renderedByLI, s.lineItemIds, segByLICreative);
        const segFloor = Math.max(100, Math.round((s.impressions || 0) * 0.01));
        const view = computeSegView(agg, { floor: segFloor, rowCtr: s.ctr || 0, delivery: s.delivery });
        const seg = Object.keys(view.byKey).length ? { ...view, segBasis } : null;
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
          seg,
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

  // Row-level segment chip cache — the "Top Segment" column on the dashboard table uses the row's
  // best (key,value). Built from the same segByLICreative fetched above (attributed to each row's
  // own creatives). Non-fatal, like the others.
  let perfFailed = false;
  let perfOut = null;
  try {
    perfOut = buildPerfBySegment(results, segByLICreative);
    console.log(`Segment performance: ${Object.keys(perfOut).length} rows with segment data`);
  } catch (err) {
    perfFailed = true;
    perfOut = readCache('perf_by_segment_cache.json', {});
    console.warn(`⚠ Segment performance build failed: ${err.message || err} — reusing cached; dashboard refresh continues`);
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
