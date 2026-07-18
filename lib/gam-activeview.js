'use strict';

/**
 * Fetches Active View (AV) viewability data from GAM via report jobs.
 *
 * Two granularities are available:
 *   - Per line item: used to compute a weighted average viewability across all line items
 *     that serve a given creative URL (Σ viewable / Σ measurable).
 *   - Per line item + creative: used for impression fingerprinting — matching a template
 *     creative's LICA impression count to the "rendered creative" ID in the AV report.
 *     GAM uses different creative IDs for template creatives in LICA vs. AV reports, with
 *     no join key, so we match by comparing LICA impressions against the AV report's own
 *     TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS for the same line item (same quantity on both sides,
 *     tolerance max(50, 1%) — see lib/active-view-data.js). Viewable/measurable are read off
 *     whichever rendered creative that match identifies.
 *
 * Both functions cover the last 700 days.
 */

const { runReportAndDownload } = require('./gam-reports');

/**
 * Returns a map of lineItemId → { viewable, measurable } raw impression counts.
 * The caller is responsible for computing the final viewability percentage as
 * Σ(viewable) / Σ(measurable) across whichever line items belong to a URL group.
 * Rows with zero measurable impressions are skipped to avoid polluting the averages.
 */
async function fetchActiveViewByLineItem(lineItemIds, networkCode, token) {
  if (!lineItemIds.length) return {};
  const now = new Date();
  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startD = new Date(now); startD.setDate(startD.getDate() - 700);
  const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };
  const idList = [...new Set(lineItemIds)].join(', ');

  const queryXml = `
    <dimensions>LINE_ITEM_ID</dimensions>
    <columns>TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS</columns>
    <columns>TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
    <statement><query>WHERE LINE_ITEM_ID IN (${idList})</query></statement>`;

  const csvText = await runReportAndDownload(queryXml, networkCode, token);
  const lines = csvText.split('\n').filter(Boolean);
  console.log('Active View CSV header:', lines[0]);
  const activeViewByLineItem = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const lineItemId = cols[0];
    const viewable   = parseFloat(cols[1] || '0');
    const measurable = parseFloat(cols[2] || '0');
    if (lineItemId && measurable > 0) {
      if (!activeViewByLineItem[lineItemId]) activeViewByLineItem[lineItemId] = { viewable: 0, measurable: 0 };
      activeViewByLineItem[lineItemId].viewable   += viewable;
      activeViewByLineItem[lineItemId].measurable += measurable;
    }
  }
  return activeViewByLineItem;
}

/**
 * Returns a nested map of { lineItemId: { creativeId: { viewable, measurable, impressions } } }.
 * The creativeId here is the "rendered" creative ID that GAM uses in AV reports —
 * it is NOT the same as the template creative ID returned by LICA or CreativeService.
 * `impressions` (TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS) is the fingerprinting key: it's the
 * same quantity LICA's impressionsDelivered counts, unlike `measurable` which is only a
 * subset of served impressions and drifts once measurable rate is below ~100%.
 */
async function fetchActiveViewByCreative(lineItemIds, networkCode, token) {
  if (!lineItemIds.length) return {};
  const now = new Date();
  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startD = new Date(now); startD.setDate(startD.getDate() - 700);
  const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };
  const idList = [...new Set(lineItemIds)].join(', ');

  const queryXml = `
    <dimensions>LINE_ITEM_ID</dimensions>
    <dimensions>CREATIVE_ID</dimensions>
    <columns>TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS</columns>
    <columns>TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
    <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>
    <statement><query>WHERE LINE_ITEM_ID IN (${idList})</query></statement>`;

  const csvText = await runReportAndDownload(queryXml, networkCode, token);
  const lines = csvText.split('\n').filter(Boolean);
  // CSV: LINE_ITEM_ID, CREATIVE_ID, VIEWABLE, MEASURABLE, IMPRESSIONS
  const avByLIAndCreative = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const lineItemId = cols[0];
    const creativeId = cols[1];
    const viewable    = parseFloat(cols[2] || '0');
    const measurable  = parseFloat(cols[3] || '0');
    const impressions = parseFloat(cols[4] || '0');
    if (lineItemId && creativeId && creativeId !== '0' && (measurable > 0 || impressions > 0)) {
      if (!avByLIAndCreative[lineItemId]) avByLIAndCreative[lineItemId] = {};
      if (!avByLIAndCreative[lineItemId][creativeId]) avByLIAndCreative[lineItemId][creativeId] = { viewable: 0, measurable: 0, impressions: 0 };
      avByLIAndCreative[lineItemId][creativeId].viewable    += viewable;
      avByLIAndCreative[lineItemId][creativeId].measurable  += measurable;
      avByLIAndCreative[lineItemId][creativeId].impressions += impressions;
    }
  }
  return avByLIAndCreative;
}

module.exports = { fetchActiveViewByLineItem, fetchActiveViewByCreative };
