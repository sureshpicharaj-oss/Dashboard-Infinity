'use strict';

/**
 * Segment-performance reporting — breaks each line item's delivery down by custom-targeting
 * key value, so the dashboard can show which segments a creative performed best / worst on
 * (by CTR). GAM exposes this two different ways depending on the key's reportableType:
 *
 *   - reportableType = ON (cat, ap_gen, ap_stda, posttag): the CUSTOM_CRITERIA dimension.
 *     One report returns "key=value" criteria for ALL such keys mixed together, so we keep
 *     only the target keys by their "key=" prefix and discard the rest (title, pos, pageid…).
 *   - reportableType = CUSTOM_DIMENSION (permutive): the customDimensionKeyIds report, which
 *     gives a clean per-value breakdown. Impressions matching several values at once land in
 *     GAM's "(multiple values)" bucket, which we drop (unattributable).
 *
 * Returns { [lineItemId]: { [keyName]: { [value]: { impressions, clicks } } } }.
 * All reporting is best-effort; a failed batch is logged and skipped, never thrown, so the
 * daily refresh is never blocked by segment reporting.
 */

const { runReportAndDownload } = require('./gam-reports');
const { splitCsvLine } = require('./utils');
const { resolveCustomTargetingValues } = require('./gam-targeting');

// The CONTEXTUAL custom-targeting keys Immediate uses across its sites (authoritative list
// from ad ops). The CUSTOM_CRITERIA report returns every key's criteria mixed together; we
// keep only these by their "key=" prefix and discard the rest (pageid, deviceType, pos, …).
// Which of these applies to a given row is decided per-publication in scripts/refresh.js.
// pageid/deviceType are intentionally excluded — they're per-page / device, not content
// segments. Union across all sites (shared base + per-site extras + Top Gear's automotive set).
const CRITERIA_KEYS = [
  // shared base (Good Food, Olive, Gardeners' World, History Extra, Radio Times, Made For Mums)
  'cat', 'subcat', 'primary_cat', 'posttag', 'diet', 'meal-type', 'occasion', 'tags', 'channel',
  // per-site extras
  'cuisine',                                                   // Olive
  'garden',                                                    // Gardeners' World
  'content-classification', 'location', 'topic', 'mission', 'person', // History Extra
  'titles',                                                    // Radio Times
  // Top Gear (automotive)
  'tag', 'content_type', 'title', 'author', 'make', 'range', 'category', 'cars_body_style', 'price_brackets', 'categories',
];

// AUDIENCE keys that also come via CUSTOM_CRITERIA but whose values are numeric codes needing
// name resolution (like permutive): ap_gen = gender (0→Male, 1→Female), ap_stda = age band
// (0→<25 … 5→65+). Kept separate from CONTEXTUAL keys so they never win the contextual chip —
// they show as an audience lens in the modal alongside permutive.
const AUDIENCE_CRITERIA_KEYS = ['ap_gen', 'ap_stda'];

function dateRangeXml(days) {
  const now = new Date();
  const s = new Date(now); s.setDate(s.getDate() - days);
  return `<startDate><year>${s.getFullYear()}</year><month>${s.getMonth() + 1}</month><day>${s.getDate()}</day></startDate>`
       + `<endDate><year>${now.getFullYear()}</year><month>${now.getMonth() + 1}</month><day>${now.getDate()}</day></endDate>`
       + `<dateRangeType>CUSTOM_DATE</dateRangeType>`;
}

// days: 1094 is GAM's maximum CUSTOM_DATE window (~3 years) — effectively "the whole period"
// for these campaigns, so the breakdown reflects full-flight performance rather than a recent
// slice. The CUSTOM_CRITERIA report grows with that window (it returns every key's criteria,
// most of which we discard), so we use a SMALL line-item batch to keep each report/download a
// safe size; an oversized or slow batch is caught per-batch and skipped (best-effort).
async function fetchSegmentPerformance(lineItemIds, permutiveKeyId, networkCode, token, opts = {}) {
  const { days = 1094, batchSize = 40 } = opts;
  const out = {}; // liId -> keyName -> value -> { impressions, clicks }
  const audienceCodeById = {}; // audience (permutive/ap_gen/ap_stda) GAM value ID -> short code
  if (!lineItemIds || !lineItemIds.length) return out;

  const add = (liId, key, value, imps, clicks) => {
    if (!liId || !value) return;
    if (!out[liId]) out[liId] = {};
    if (!out[liId][key]) out[liId][key] = {};
    const cur = out[liId][key][value] || (out[liId][key][value] = { impressions: 0, clicks: 0 });
    cur.impressions += imps; cur.clicks += clicks;
  };

  const dateXml = dateRangeXml(days);

  for (let i = 0; i < lineItemIds.length; i += batchSize) {
    const inClause = lineItemIds.slice(i, i + batchSize).join(', ');

    // --- reportableType=ON keys via CUSTOM_CRITERIA (returns all such keys; we filter) ---
    try {
      const q = `<dimensions>LINE_ITEM_ID</dimensions><dimensions>CUSTOM_CRITERIA</dimensions>`
              + `<columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns><columns>TOTAL_LINE_ITEM_LEVEL_CLICKS</columns>`
              + `${dateXml}<statement><query>WHERE LINE_ITEM_ID IN (${inClause})</query></statement>`;
      const csv = await runReportAndDownload(q, networkCode, token);
      const lines = csv.split('\n');
      // Header: Dimension.LINE_ITEM_ID, Dimension.CUSTOM_CRITERIA, Dimension.CUSTOM_TARGETING_VALUE_ID,
      //         Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS, Column.TOTAL_LINE_ITEM_LEVEL_CLICKS
      for (let j = 1; j < lines.length; j++) {
        if (!lines[j]) continue;
        const cols = splitCsvLine(lines[j]);
        const liId = cols[0];
        const criteria = cols[1] || '';        // "key=value"
        const valueId = cols[2] || '';         // CUSTOM_TARGETING_VALUE_ID
        const eq = criteria.indexOf('=');
        if (eq < 0) continue;
        const key = criteria.slice(0, eq);
        const value = criteria.slice(eq + 1);
        const imps = parseInt(cols[cols.length - 2] || '0');
        const clicks = parseInt(cols[cols.length - 1] || '0');
        if (CRITERIA_KEYS.includes(key)) {
          // Contextual: the value is already a readable label (e.g. "supercars", "moussaka").
          add(liId, key, value, isNaN(imps) ? 0 : imps, isNaN(clicks) ? 0 : clicks);
        } else if (AUDIENCE_CRITERIA_KEYS.includes(key)) {
          // Audience: value is a numeric code — key by value ID and resolve to a name later.
          if (!valueId || valueId.length >= 19) continue;
          audienceCodeById[valueId] = value;
          add(liId, key, valueId, isNaN(imps) ? 0 : imps, isNaN(clicks) ? 0 : clicks);
        }
        // else: discard title/pos/pageid/etc.
      }
    } catch (e) {
      console.warn(`Segment CUSTOM_CRITERIA batch @${i} failed: ${e.message}`);
    }

    // --- permutive via CUSTOM_DIMENSION ---
    if (permutiveKeyId) {
      try {
        const q = `<dimensions>LINE_ITEM_ID</dimensions><dimensions>CUSTOM_DIMENSION</dimensions>`
                + `<columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns><columns>TOTAL_LINE_ITEM_LEVEL_CLICKS</columns>`
                + `<customDimensionKeyIds>${permutiveKeyId}</customDimensionKeyIds>`
                + `${dateXml}<statement><query>WHERE LINE_ITEM_ID IN (${inClause})</query></statement>`;
        const csv = await runReportAndDownload(q, networkCode, token);
        const lines = csv.split('\n');
        // Header: Dimension.LINE_ITEM_ID, Dimension.TOP_LEVEL_CUSTOM_TARGETING_KEY[ID]_VALUE,
        //         Dimension...._ID, Column.IMPRESSIONS, Column.CLICKS
        for (let j = 1; j < lines.length; j++) {
          if (!lines[j]) continue;
          const cols = splitCsvLine(lines[j]);
          const liId = cols[0];
          const code = cols[1] || '';    // permutive value code (e.g. "bhgs", "88829")
          const valueId = cols[2] || ''; // GAM custom-targeting value ID (resolves to a name)
          if (!code || code === '(multiple values)' || code === '(not applicable)') continue; // unattributable
          if (!valueId || valueId.length >= 19) continue; // skip GAM's sentinel bucket IDs
          const imps = parseInt(cols[cols.length - 2] || '0');
          const clicks = parseInt(cols[cols.length - 1] || '0');
          // Key by value ID for now; relabelled to the readable segment name after all batches.
          audienceCodeById[valueId] = code;
          add(liId, 'permutive', valueId, isNaN(imps) ? 0 : imps, isNaN(clicks) ? 0 : clicks);
        }
      } catch (e) {
        console.warn(`Segment permutive batch @${i} failed: ${e.message}`);
      }
    }
  }

  // Relabel audience segments (permutive + ap_gen + ap_stda) from their GAM value ID to the
  // readable displayName — e.g. 449090446926 → "Automotive/Auto Shows", ap_gen 0 → "Male",
  // ap_stda 1 → "25-34". Falls back to the short code when a value has no displayName (e.g.
  // "rts"), or if resolution fails entirely.
  const AUDIENCE_KEYS = ['permutive', ...AUDIENCE_CRITERIA_KEYS];
  const audIds = Object.keys(audienceCodeById);
  if (audIds.length) {
    let labels = {};
    try {
      labels = await resolveCustomTargetingValues(audIds, networkCode, token);
    } catch (e) {
      console.warn(`Audience name resolution failed: ${e.message} — using codes`);
    }
    const labelFor = id => (labels[id] && labels[id].value) || audienceCodeById[id] || id;
    for (const liId of Object.keys(out)) {
      for (const ak of AUDIENCE_KEYS) {
        const m = out[liId][ak];
        if (!m) continue;
        const relabeled = {};
        for (const [vid, stats] of Object.entries(m)) {
          const name = labelFor(vid);
          const cur = relabeled[name] || (relabeled[name] = { impressions: 0, clicks: 0 });
          cur.impressions += stats.impressions; cur.clicks += stats.clicks;
        }
        out[liId][ak] = relabeled;
      }
    }
    console.log(`Audience: resolved ${Object.keys(labels).length}/${audIds.length} segment names`);
  }

  return out;
}

module.exports = { fetchSegmentPerformance, CRITERIA_KEYS, AUDIENCE_CRITERIA_KEYS };
