'use strict';

/*
 * Recompute ONLY the Transparent+ `attention` field on the existing caches, in place, using the
 * shared scorer in lib/attention.js. Every input the score needs (viewability=activeView, dwell=
 * avgViewableSec, ctr, completionRate, impressions, device) is already baked into the caches by a
 * prior full refresh, so this needs no GAM/network access — it just re-scores. Use it to apply a
 * scoring-formula change without waiting on a full `node scripts/refresh.js`.
 *
 * Touches: dashboard_cache.json + video_stats_cache.json (per-row `attention`), splits_cache.json
 * (per-creative `attention`; device is read from the composite key `url##videoId##device`).
 *
 * Usage: node scripts/rebake-attention.js
 */

const fs = require('fs');
const path = require('path');
const { computeAttention } = require('../lib/attention');

const dataDir = path.join(__dirname, '..', 'public', 'data');
const read = f => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
const write = (f, o) => fs.writeFileSync(path.join(dataDir, f), JSON.stringify(o));

function tally(scores) {
  const t = { ok: 0, mid: 0, low: 0, na: 0 };
  let min = Infinity, max = -Infinity;
  for (const a of scores) {
    t[a.tier] = (t[a.tier] || 0) + 1;
    if (a.score != null) { min = Math.min(min, a.score); max = Math.max(max, a.score); }
  }
  return { n: scores.length, tiers: t, min: isFinite(min) ? min : null, max: isFinite(max) ? max : null };
}

function scoreRow(r) {
  return computeAttention({
    device: r.device,
    viewability: r.activeView ?? null,
    avgViewableSec: r.avgViewableSec ?? null,
    ctr: r.ctr ?? null,
    completionRate: r.completionRate ?? null,
    impressions: r.impressions,
  });
}

// ---- rows (dashboard + video) ----
for (const file of ['dashboard_cache.json', 'video_stats_cache.json']) {
  let cache;
  try { cache = read(file); } catch { console.warn(`skip ${file} (not present)`); continue; }
  const rows = Array.isArray(cache) ? cache : (cache.results || []);
  const before = rows.map(r => r.attention).filter(Boolean);
  rows.forEach(r => { if ('attention' in r || r.device) r.attention = scoreRow(r); });
  const after = rows.map(r => r.attention).filter(Boolean);
  write(file, cache);
  const b = tally(before), a = tally(after);
  console.log(`${file}: ${a.n} rows | tiers ${a.tiers.ok}g/${a.tiers.mid}a/${a.tiers.low}r/${a.tiers.na}— | scores ${a.min}–${a.max}  (was ${b.tiers.ok}g/${b.tiers.mid}a/${b.tiers.low}r, ${b.min}–${b.max})`);
}

// ---- splits (per-creative) ----
try {
  const splits = read('splits_cache.json');
  const allAfter = [];
  let entries = 0;
  for (const [key, arr] of Object.entries(splits)) {
    if (!Array.isArray(arr)) continue;
    const device = key.split('##').pop(); // `url##videoId##device`
    for (const s of arr) {
      s.attention = computeAttention({
        device,
        viewability: s.viewability ?? null,
        avgViewableSec: s.avgViewableSec ?? null,
        ctr: s.ctr ?? null,
        completionRate: s.completionRate ?? null,
        impressions: s.impressions,
      });
      allAfter.push(s.attention);
      entries++;
    }
  }
  write('splits_cache.json', splits);
  const a = tally(allAfter);
  console.log(`splits_cache.json: ${entries} creatives | tiers ${a.tiers.ok}g/${a.tiers.mid}a/${a.tiers.low}r/${a.tiers.na}— | scores ${a.min}–${a.max}`);
} catch (e) { console.warn(`skip splits_cache.json (${e.message})`); }

console.log('Rebake complete.');
