'use strict';

/*
 * Pure active-view matching logic extracted from routes/active-view.js.
 * Accepts pre-built urlLineItemMap and urlLicaImpsMap (from dashboard-data), keyed by the
 * same composite `netlifyUrl##videoId##device` group key dashboard rows use — not just the
 * base URL — so a URL with both a desktop skin and video creatives gets independent
 * viewability per row/tab instead of one blended number.
 * Returns { [groupKey]: { rate, viewable, measurable } } — no fs, no Express.
 */

const { fetchActiveViewByCreative, fetchActiveViewByLineItem } = require('./gam-activeview');

// Core computation. Returns both the group-level totals (byUrl — the historical return
// shape) and a per-creative breakdown (perCreative — groupKey → creativeId → {viewable,
// measurable, rate}) built from the SAME locked fingerprint pairs, so exposing per-creative
// viewability for the split drill-down costs no extra GAM calls.
async function computeActiveView(urlLineItemMap, urlLicaImpsMap, networkCode, token) {
  const allLineItemIds = [...new Set(Object.values(urlLineItemMap).flat())];
  const activeViewByUrl = {};
  const perCreativeRaw = {}; // groupKey → creativeId → { viewable, measurable }

  if (urlLicaImpsMap) {
    // Impression fingerprinting: LICA impressions vs. the AV report's own
    // TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS for the same (line item, rendered creative) — the
    // same quantity on both sides (unlike `measurable`, which is only a subset of served
    // impressions and drifts once measurable rate dips below ~100%). Tolerance: max(50, 1%).
    //
    // A/B creative variants rotating evenly in one line item land within tolerance of each
    // other, so tolerance alone can't separate them — the same problem the ad-unit
    // fingerprint in lib/dashboard-data.js solves via constraint solving: lock unique exact
    // (diff=0) hits first, then iteratively eliminate locked report creatives from
    // remaining candidates. Pairs still ambiguous at the fixpoint, or where two template
    // creatives claim the same report creative, are skipped — no closest-match fallback,
    // wrong data is worse than no data.
    const avByLIAndCreative = await fetchActiveViewByCreative(allLineItemIds, networkCode, token);

    const pairs = [];
    for (const [url, licaImps] of Object.entries(urlLicaImpsMap)) {
      for (const [creativeId, perLI] of Object.entries(licaImps)) {
        for (const [liId, imps] of Object.entries(perLI)) {
          const liCreatives = avByLIAndCreative[liId] || {};
          const tol = Math.max(50, Math.round(imps * 0.01));
          const candidates = Object.entries(liCreatives)
            .filter(([, v]) => Math.abs(v.impressions - imps) <= tol)
            .map(([rcid]) => ({ rcid, exact: liCreatives[rcid].impressions === imps }));
          pairs.push({ url, creativeId, liId, candidates, locked: null, dead: false });
        }
      }
    }

    const lockedBy = {}; // `${liId}:${rcid}` -> pair
    let conflicts = 0;

    // Tier 1: lock pairs with a unique exact hit (unless two pairs exact-claim the same creative)
    const exactClaims = {};
    for (const p of pairs) {
      const ex = p.candidates.filter(c => c.exact);
      if (ex.length === 1) {
        const k = `${p.liId}:${ex[0].rcid}`;
        (exactClaims[k] = exactClaims[k] || []).push(p);
      }
    }
    for (const [k, claimants] of Object.entries(exactClaims)) {
      if (claimants.length === 1) {
        claimants[0].locked = k.slice(k.indexOf(':') + 1);
        lockedBy[k] = claimants[0];
      } else {
        for (const p of claimants) p.dead = true;
        conflicts += claimants.length;
      }
    }

    // Tier 2: iterate — a pair whose candidates reduce to one after removing creatives
    // locked by other pairs is itself resolved.
    let changed = true;
    while (changed) {
      changed = false;
      const claims = {};
      for (const p of pairs) {
        if (p.locked || p.dead) continue;
        const remaining = p.candidates.filter(c => !lockedBy[`${p.liId}:${c.rcid}`]);
        if (remaining.length === 1) {
          const k = `${p.liId}:${remaining[0].rcid}`;
          (claims[k] = claims[k] || []).push(p);
        }
      }
      for (const [k, claimants] of Object.entries(claims)) {
        if (claimants.length === 1) {
          claimants[0].locked = k.slice(k.indexOf(':') + 1);
          lockedBy[k] = claimants[0];
          changed = true;
        } else {
          for (const p of claimants) p.dead = true;
          conflicts += claimants.length;
        }
      }
    }

    let applied = 0, ambiguous = 0, unmatched = 0;
    const totals = {};
    for (const p of pairs) {
      if (!p.locked) {
        if (!p.dead) {
          const remaining = p.candidates.filter(c => !lockedBy[`${p.liId}:${c.rcid}`]);
          if (remaining.length === 0) unmatched++; else ambiguous++;
        }
        continue;
      }
      const rec = avByLIAndCreative[p.liId][p.locked];
      if (!totals[p.url]) totals[p.url] = { viewable: 0, measurable: 0 };
      totals[p.url].viewable   += rec.viewable;
      totals[p.url].measurable += rec.measurable;
      // Accumulate the same locked pair against its template creative for the split view.
      if (!perCreativeRaw[p.url]) perCreativeRaw[p.url] = {};
      const pc = perCreativeRaw[p.url][p.creativeId] || (perCreativeRaw[p.url][p.creativeId] = { viewable: 0, measurable: 0 });
      pc.viewable   += rec.viewable;
      pc.measurable += rec.measurable;
      applied++;
    }
    console.log(`AV fingerprint: ${applied} matched, ${ambiguous} ambiguous, ${conflicts} conflicting, ${unmatched} unmatched (creative,LI) pairs`);

    for (const [url, t] of Object.entries(totals)) {
      if (t.measurable > 0) {
        activeViewByUrl[url] = {
          rate: parseFloat(((t.viewable / t.measurable) * 100).toFixed(1)),
          viewable: t.viewable,
          measurable: t.measurable,
        };
      }
    }
  } else {
    // Fallback when no LICA imps cache — line-item level, includes all creatives on the LI
    const activeViewByLineItem = await fetchActiveViewByLineItem(allLineItemIds, networkCode, token);
    for (const [url, lineItemIds] of Object.entries(urlLineItemMap)) {
      let totalViewable = 0, totalMeasurable = 0;
      for (const lid of lineItemIds) {
        const av = activeViewByLineItem[lid];
        if (av) { totalViewable += av.viewable; totalMeasurable += av.measurable; }
      }
      if (totalMeasurable > 0) {
        activeViewByUrl[url] = {
          rate: parseFloat(((totalViewable / totalMeasurable) * 100).toFixed(1)),
          viewable: totalViewable,
          measurable: totalMeasurable,
        };
      }
    }
  }

  // Finalise per-creative rates (only where measurable > 0).
  const perCreative = {};
  for (const [url, byCid] of Object.entries(perCreativeRaw)) {
    for (const [cid, t] of Object.entries(byCid)) {
      if (t.measurable > 0) {
        if (!perCreative[url]) perCreative[url] = {};
        perCreative[url][cid] = {
          rate: parseFloat(((t.viewable / t.measurable) * 100).toFixed(1)),
          viewable: t.viewable,
          measurable: t.measurable,
        };
      }
    }
  }

  return { byUrl: activeViewByUrl, perCreative };
}

// Backward-compatible wrapper: existing callers (routes/active-view.js, scripts/refresh.js)
// expect just the flat group-level map.
async function fetchActiveViewStats(urlLineItemMap, urlLicaImpsMap, networkCode, token) {
  return (await computeActiveView(urlLineItemMap, urlLicaImpsMap, networkCode, token)).byUrl;
}

// Splits variant: returns { byUrl, perCreative } in one pass (used by scripts/refresh.js so
// the group totals and the per-creative breakdown come from a single AV fetch).
async function fetchActiveViewStatsWithSplits(urlLineItemMap, urlLicaImpsMap, networkCode, token) {
  return computeActiveView(urlLineItemMap, urlLicaImpsMap, networkCode, token);
}

module.exports = { fetchActiveViewStats, fetchActiveViewStatsWithSplits };
