'use strict';

// ---- Joy score (attention score) ----
// A 0–100 "did this creative earn eyeballs" score: viewability + dwell (time in view) + CTR, plus
// completion for video. Scored vs EXPECTATION, not an absolute ceiling: each signal's expected/"par"
// level scores PAR_SCORE (60 — solid, not perfect), so only BEATING expectation climbs toward 100 and
// there's always headroom to grow. Every signal is bounded and reaches 100 at its own ceiling — CTR's
// ceiling is 2× its par, same as the others reach 100 at a real max, not an asymptote. Every knob
// lives in ATT so it's easy to tune. Null score when a display row has no Active View — scoring off CTR
// alone would mislead. Shown as a green/amber/red pill, labelled "Joy score" in the UI.
//
// Single server-side source of truth: required by scripts/refresh.js (bakes it into the caches) and by
// scripts/rebake-attention.js. public/index.html carries a client-side MIRROR (computeAttentionClient)
// for the live /api path — the two MUST stay in sync (same knobs, same formulas).
const ATT = {
  dwellCeilSec: 60,                          // dwell capped here; 60s in view = full dwell marks
  // Expected ("par") level per signal → PAR_SCORE. Calibrated to the estate's own norms (what's
  // "usually expected" for these premium skins): viewability median ≈84% / p25 ≈80%, dwell median
  // ≈45s, so a placement only goes green by BEATING its expected level, not just meeting it.
  par: { viewability: 78, dwellSec: 45, completion: 50 },
  // CTR's par: caller-supplied per-publication expected CTR (computeAttention's `ctrBench`) when
  // available, falling back to this flat device split only when no ad-unit benchmark exists yet
  // (e.g. before the next refresh populates impsByAdUnit).
  ctrBar: { desktop: 2.0, mobile: 0.8 },
  ctrCeilMult: 2,                            // CTR's ceiling (100 points) = par × this
  PAR_SCORE: 60,                             // score earned by exactly meeting expectation
  weights: {
    display: { viewability: 0.40, dwell: 0.40, ctr: 0.20 },
    video:   { viewability: 0.20, dwell: 0.30, completion: 0.30, ctr: 0.20 },
  },
  green: 65, red: 35, lowVolume: 1000,
};
// Bounded metric (has a real ceiling): par → PAR_SCORE, ceiling `max` → 100, linear on each side.
function attnParLinear(v, par, max) {
  if (v == null || !isFinite(v) || v <= 0) return 0;
  if (v >= max) return 100;
  return v <= par ? (v / par) * ATT.PAR_SCORE
                  : ATT.PAR_SCORE + ((v - par) / (max - par)) * (100 - ATT.PAR_SCORE);
}
function attnTier(score) { return score == null ? 'na' : score >= ATT.green ? 'ok' : score < ATT.red ? 'low' : 'mid'; }
function computeAttention(o) {
  // o: { device, viewability, avgViewableSec, ctr, completionRate, impressions, ctrBench }
  // ctrBench: this row/creative's own expected CTR (per-publication leave-one-out benchmark,
  // same one the pills elsewhere use) — preferred over the flat device bar when available.
  const isVideo = /video/.test(o.device || '');
  const isMobile = o.device === 'mobile' || o.device === 'video-mobile';
  const w = isVideo ? ATT.weights.video : ATT.weights.display;
  const bar = (o.ctrBench != null && isFinite(o.ctrBench) && o.ctrBench > 0)
    ? o.ctrBench
    : (isMobile ? ATT.ctrBar.mobile : ATT.ctrBar.desktop);
  const raw = [];
  if (w.viewability) raw.push({ label: 'Viewability', w: w.viewability, avail: o.viewability != null,
    score: o.viewability != null ? attnParLinear(o.viewability, ATT.par.viewability, 100) : null, disp: o.viewability != null ? Math.round(o.viewability) + '%' : null });
  if (w.dwell) raw.push({ label: 'Dwell', w: w.dwell, avail: o.avgViewableSec != null,
    score: o.avgViewableSec != null ? attnParLinear(Math.min(o.avgViewableSec, ATT.dwellCeilSec), ATT.par.dwellSec, ATT.dwellCeilSec) : null, disp: o.avgViewableSec != null ? o.avgViewableSec.toFixed(1) + 's' : null });
  if (w.completion) raw.push({ label: 'Completion', w: w.completion, avail: o.completionRate != null,
    score: o.completionRate != null ? attnParLinear(o.completionRate, ATT.par.completion, 100) : null, disp: o.completionRate != null ? Math.round(o.completionRate) + '%' : null });
  if (w.ctr) raw.push({ label: 'CTR', w: w.ctr, avail: o.ctr != null,
    score: o.ctr != null ? attnParLinear(o.ctr, bar, bar * ATT.ctrCeilMult) : null, disp: o.ctr != null ? o.ctr.toFixed(2) + '%' : null });
  const avail = raw.filter(c => c.avail && c.score != null);
  const wsum = avail.reduce((a, c) => a + c.w, 0);
  // Coverage gate: without Active View (viewability + dwell both gone) a display row has only CTR left.
  let score = null;
  if (wsum >= 0.35) { score = Math.round(avail.reduce((a, c) => a + c.score * (c.w / wsum), 0)); avail.forEach(c => c.rw = c.w / wsum); }
  return {
    score, tier: attnTier(score),
    lowConfidence: (o.impressions || 0) < ATT.lowVolume,
    ctrBar: bar,
    components: raw.map(c => ({ label: c.label, raw: c.disp, score: c.score == null ? null : Math.round(c.score),
      weight: Math.round((c.rw != null ? c.rw : c.w) * 100), avail: c.avail })),
  };
}

module.exports = { ATT, computeAttention, attnParLinear, attnTier };
