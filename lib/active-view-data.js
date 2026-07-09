'use strict';

/*
 * Pure active-view matching logic extracted from routes/active-view.js.
 * Accepts pre-built urlLineItemMap and urlLicaImpsMap (from dashboard-data),
 * returns { [netlifyUrl]: { rate, viewable, measurable } } — no fs, no Express.
 */

const { fetchActiveViewByCreative, fetchActiveViewByLineItem } = require('./gam-activeview');

async function fetchActiveViewStats(urlLineItemMap, urlLicaImpsMap, networkCode, token) {
  const allLineItemIds = [...new Set(Object.values(urlLineItemMap).flat())];
  const activeViewByUrl = {};

  if (urlLicaImpsMap) {
    // Impression-count fingerprinting: LICA impressions ≈ AV report measurable for the same creative.
    // Tolerance: max(50, 1% of imps). No closest-match fallback — wrong data is worse than no data.
    const avByLIAndCreative = await fetchActiveViewByCreative(allLineItemIds, networkCode, token);

    for (const [url] of Object.entries(urlLineItemMap)) {
      const licaImps = urlLicaImpsMap[url];
      if (!licaImps) continue;
      let totalViewable = 0, totalMeasurable = 0;
      for (const [, perLI] of Object.entries(licaImps)) {
        for (const [liId, imps] of Object.entries(perLI)) {
          const liCreatives = avByLIAndCreative[liId];
          if (!liCreatives) continue;
          const tol = Math.max(50, Math.round(imps * 0.01));
          const match = Object.values(liCreatives).find(av => Math.abs(Math.round(av.measurable) - imps) <= tol);
          if (match) {
            totalViewable   += match.viewable;
            totalMeasurable += match.measurable;
          }
        }
      }
      if (totalMeasurable > 0) {
        activeViewByUrl[url] = {
          rate: parseFloat(((totalViewable / totalMeasurable) * 100).toFixed(1)),
          viewable: totalViewable,
          measurable: totalMeasurable,
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

  return activeViewByUrl;
}

module.exports = { fetchActiveViewStats };
