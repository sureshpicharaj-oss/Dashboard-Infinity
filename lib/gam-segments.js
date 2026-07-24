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
        const eq = criteria.indexOf('=');
        if (eq < 0) continue;
        const key = criteria.slice(0, eq);
        if (!CRITERIA_KEYS.includes(key)) continue; // discard title/pos/pageid/etc.
        const value = criteria.slice(eq + 1);
        const imps = parseInt(cols[cols.length - 2] || '0');
        const clicks = parseInt(cols[cols.length - 1] || '0');
        add(liId, key, value, isNaN(imps) ? 0 : imps, isNaN(clicks) ? 0 : clicks);
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
          const value = cols[1] || '';
          if (!value || value === '(multiple values)') continue; // unattributable
          const imps = parseInt(cols[cols.length - 2] || '0');
          const clicks = parseInt(cols[cols.length - 1] || '0');
          add(liId, 'permutive', value, isNaN(imps) ? 0 : imps, isNaN(clicks) ? 0 : clicks);
        }
      } catch (e) {
        console.warn(`Segment permutive batch @${i} failed: ${e.message}`);
      }
    }
  }

  return out;
}

module.exports = { fetchSegmentPerformance, CRITERIA_KEYS };
