'use strict';

// ---- Transparent+ (attention score) ----
// A 0–100 "did this creative earn eyeballs" score: viewability + dwell (time in view) + CTR, plus
// completion for video. Scored vs EXPECTATION, not an absolute ceiling: each signal's expected/"par"
// level scores PAR_SCORE (60 — solid, not perfect), so only BEATING expectation climbs toward 100 and
// there's always headroom to grow. Bounded signals (viewability, dwell, completion) reach 100 at their
// ceiling; unbounded CTR asymptotes toward 100 (you can always beat it by a little more). Every knob
// lives in ATT so it's easy to tune. Null score when a display row has no Active View — scoring off CTR
// alone would mislead. Shown as a green/amber/red pill.
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
  ctrBar: { desktop: 2.0, mobile: 0.8 },     // expected ("par") CTR %, by device family
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
// Unbounded metric (CTR): par → PAR_SCORE, asymptotes toward 100 — always room to beat it.
function attnParOpen(v, par) {
  if (v == null || !isFinite(v) || v <= 0) return 0;
  const k = par * (1 - ATT.PAR_SCORE / 100) / (ATT.PAR_SCORE / 100); // value=par ⇒ PAR_SCORE
  return 100 * v / (v + k);
}
function attnTier(score) { return score == null ? 'na' : score >= ATT.green ? 'ok' : score < ATT.red ? 'low' : 'mid'; }
function computeAttention(o) {
  // o: { device, viewability, avgViewableSec, ctr, completionRate, impressions }
  const isVideo = /video/.test(o.device || '');
  const isMobile = o.device === 'mobile' || o.device === 'video-mobile';
  const w = isVideo ? ATT.weights.video : ATT.weights.display;
  const bar = isMobile ? ATT.ctrBar.mobile : ATT.ctrBar.desktop;
  const raw = [];
  if (w.viewability) raw.push({ label: 'Viewability', w: w.viewability, avail: o.viewability != null,
    score: o.viewability != null ? attnParLinear(o.viewability, ATT.par.viewability, 100) : null, disp: o.viewability != null ? Math.round(o.viewability) + '%' : null });
  if (w.dwell) raw.push({ label: 'Dwell', w: w.dwell, avail: o.avgViewableSec != null,
    score: o.avgViewableSec != null ? attnParLinear(Math.min(o.avgViewableSec, ATT.dwellCeilSec), ATT.par.dwellSec, ATT.dwellCeilSec) : null, disp: o.avgViewableSec != null ? o.avgViewableSec.toFixed(1) + 's' : null });
  if (w.completion) raw.push({ label: 'Completion', w: w.completion, avail: o.completionRate != null,
    score: o.completionRate != null ? attnParLinear(o.completionRate, ATT.par.completion, 100) : null, disp: o.completionRate != null ? Math.round(o.completionRate) + '%' : null });
  if (w.ctr) raw.push({ label: 'CTR', w: w.ctr, avail: o.ctr != null,
    score: o.ctr != null ? attnParOpen(o.ctr, bar) : null, disp: o.ctr != null ? o.ctr.toFixed(2) + '%' : null });
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

module.exports = { ATT, computeAttention, attnParLinear, attnParOpen, attnTier };
