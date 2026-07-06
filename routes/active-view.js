'use strict';

/*
 * Active View routes — returns viewability metrics (rate, viewable impressions,
 * measurable impressions) per Netlify URL, plus several debug endpoints for
 * diagnosing the impression-fingerprinting logic.
 *
 * GAM Active View data comes from a report job (not LICA), so results are cached
 * for 6 hours. The primary matching strategy uses per-creative, per-line-item LICA
 * impression counts (written by /api/dashboard) to identify which 9-digit report
 * creative ID corresponds to each template creative, without needing the CreativeSet API.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getToken } = require('../lib/auth');
const { fetchActiveViewByLineItem, fetchActiveViewByCreative } = require('../lib/gam-activeview');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {

  /* Returns Active View viewability stats keyed by Netlify base URL.
   * No query params. Requires url_lineitem_cache.json to exist (written by /api/dashboard).
   * Serves cached data for 6 hours; cache is invalidated on each dashboard refresh.
   *
   * When url_lica_imps_cache.json is available (primary path): matches each template
   * creative to its AV report row by comparing LICA impressions to report measurable
   * impressions within a ±20 tolerance, then aggregates viewable/measurable across matches.
   * Falls back to line-item-level aggregation if the imps cache is absent (less accurate
   * because it includes all creatives on a line item, not just those for this URL). */
  router.get('/api/active-view', async (req, res) => {
    const urlLineItemPath = path.join(SCREENSHOT_DIR, 'url_lineitem_cache.json');
    if (!fs.existsSync(urlLineItemPath)) {
      return res.status(503).json({ error: 'Load dashboard first to generate line item data' });
    }

    const avCachePath = path.join(SCREENSHOT_DIR, 'active_view_cache.json');
    if (fs.existsSync(avCachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(avCachePath, 'utf8'));
        // 6-hour TTL matches the video-stats cache; AV report jobs take 30–90 s to run
        if (cached._ts && Date.now() - cached._ts < 6 * 60 * 60 * 1000) {
          const { _ts, ...data } = cached;
          return res.json(data);
        }
      } catch(e) {}
    }

    try {
      const urlLineItemMap = JSON.parse(fs.readFileSync(urlLineItemPath, 'utf8'));
      const urlCreativePath = path.join(SCREENSHOT_DIR, 'url_creative_cache.json');
      let urlCreativeMap = null;
      if (fs.existsSync(urlCreativePath)) {
        try { urlCreativeMap = JSON.parse(fs.readFileSync(urlCreativePath, 'utf8')); } catch(e) {}
      }

      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;

      // Load per-creative, per-line-item LICA impressions saved during Refresh.
      // Structure: { url: { templateCreativeId: { lineItemId: impressions } } }
      const urlLicaImpsPath = path.join(SCREENSHOT_DIR, 'url_lica_imps_cache.json');
      let urlLicaImpsMap = null;
      if (fs.existsSync(urlLicaImpsPath)) {
        try { urlLicaImpsMap = JSON.parse(fs.readFileSync(urlLicaImpsPath, 'utf8')); } catch(e) {}
      }

      const allLineItemIds = [...new Set(Object.values(urlLineItemMap).flat())];
      const activeViewByUrl = {};

      if (urlLicaImpsMap) {
        // Impression-count matching: for each URL's template creative in a given line item,
        // LICA impressions == report measurable. This directly identifies the correct 9-digit
        // report creative without needing the creative set API.
        const avByLIAndCreative = await fetchActiveViewByCreative(allLineItemIds, networkCode, token);

        for (const [url] of Object.entries(urlLineItemMap)) {
          const licaImps = urlLicaImpsMap[url];
          if (!licaImps) continue;
          let totalViewable = 0, totalMeasurable = 0;
          for (const [, perLI] of Object.entries(licaImps)) {
            for (const [liId, imps] of Object.entries(perLI)) {
              const liCreatives = avByLIAndCreative[liId];
              if (!liCreatives) continue;
              // The report creative whose measurable matches the LICA impressions is the one for this URL
              const match = Object.values(liCreatives).find(av => Math.abs(Math.round(av.measurable) - imps) <= 20);
              if (match) {
                totalViewable   += match.viewable;
                totalMeasurable += match.measurable;
              }
            }
          }
          if (totalMeasurable > 0) activeViewByUrl[url] = { rate: parseFloat(((totalViewable / totalMeasurable) * 100).toFixed(1)), viewable: totalViewable, measurable: totalMeasurable };
        }
      } else {
        // Fallback only if Refresh has never run (no imps cache). Use line-item level but note
        // this includes all creatives in the line item, not just those for this URL.
        const activeViewByLineItem = await fetchActiveViewByLineItem(allLineItemIds, networkCode, token);
        for (const [url, lineItemIds] of Object.entries(urlLineItemMap)) {
          let totalViewable = 0, totalMeasurable = 0;
          for (const lid of lineItemIds) {
            const av = activeViewByLineItem[lid];
            if (av) { totalViewable += av.viewable; totalMeasurable += av.measurable; }
          }
          if (totalMeasurable > 0) activeViewByUrl[url] = { rate: parseFloat(((totalViewable / totalMeasurable) * 100).toFixed(1)), viewable: totalViewable, measurable: totalMeasurable };
        }
      }

      activeViewByUrl._ts = Date.now();
      fs.writeFileSync(avCachePath, JSON.stringify(activeViewByUrl));
      const { _ts, ...data } = activeViewByUrl;
      res.json(data);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* Debug: shows the line item IDs, creative IDs, cached AV result, and a live per-creative
   * AV breakdown for a single URL. Accepts ?url=<partial-or-full-netlify-url>.
   * Partial URL matching allows passing just the subdomain without the trailing slash. */
  router.get('/api/debug-active-view-for-url', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Missing url param' });
    const urlLineItemPath  = path.join(SCREENSHOT_DIR, 'url_lineitem_cache.json');
    const urlCreativePath  = path.join(SCREENSHOT_DIR, 'url_creative_cache.json');
    const avCachePath      = path.join(SCREENSHOT_DIR, 'active_view_cache.json');
    if (!fs.existsSync(urlLineItemPath)) return res.status(503).json({ error: 'No url_lineitem_cache' });
    const urlLineItemMap  = JSON.parse(fs.readFileSync(urlLineItemPath, 'utf8'));
    const urlCreativeMap  = fs.existsSync(urlCreativePath) ? JSON.parse(fs.readFileSync(urlCreativePath, 'utf8')) : null;
    const matchedUrl = Object.keys(urlLineItemMap).find(k => k.includes(targetUrl) || targetUrl.includes(k.replace(/\/$/, '')));
    const lineItemIds  = matchedUrl ? urlLineItemMap[matchedUrl] : null;
    const creativeIds  = matchedUrl && urlCreativeMap ? (urlCreativeMap[matchedUrl] || null) : null;
    let avData = null;
    if (fs.existsSync(avCachePath)) {
      try { avData = JSON.parse(fs.readFileSync(avCachePath, 'utf8')); } catch(e) {}
    }
    const avByUrl = avData ? (avData[matchedUrl] || avData[targetUrl] || null) : null;
    // Now run a live active view query for just the line items of this URL and show per-creative data
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const avByCreative = lineItemIds ? await fetchActiveViewByLineItem(lineItemIds, networkCode, token) : {};
      const creativeBreakdown = (creativeIds || []).map(cid => ({ cid, av: avByCreative[cid] || null }));
      res.json({ matchedUrl, lineItemIds, creativeIds, activeViewCached: avByUrl, creativeBreakdown });
    } catch(e) {
      res.json({ matchedUrl, lineItemIds, creativeIds, activeViewCached: avByUrl, error: e.message });
    }
  });

  /* Debug: runs the full impression-fingerprinting algorithm for a single URL and returns
   * a detailed breakdown showing which template creative × line item matched which report
   * creative, the LICA impression count used for matching, and the resulting viewable/measurable
   * figures. Accepts ?url=<partial-or-full-netlify-url>. */
  router.get('/api/debug-av-master-ids-for-url', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'url param required' });
    try {
      const urlLineItemPath  = path.join(SCREENSHOT_DIR, 'url_lineitem_cache.json');
      const urlLicaImpsPath  = path.join(SCREENSHOT_DIR, 'url_lica_imps_cache.json');
      if (!fs.existsSync(urlLineItemPath))  return res.status(503).json({ error: 'no url_lineitem_cache — Refresh dashboard first' });
      if (!fs.existsSync(urlLicaImpsPath))  return res.status(503).json({ error: 'no url_lica_imps_cache — Refresh dashboard first' });

      const urlLineItemMap = JSON.parse(fs.readFileSync(urlLineItemPath, 'utf8'));
      const urlLicaImpsMap = JSON.parse(fs.readFileSync(urlLicaImpsPath, 'utf8'));

      const matchedUrl = Object.keys(urlLineItemMap).find(k => k.includes(targetUrl) || targetUrl.includes(k.replace(/\/$/, '')));
      if (!matchedUrl) return res.json({ error: 'URL not found in line item cache', targetUrl });

      const lineItemIds = urlLineItemMap[matchedUrl] || [];
      const licaImps    = urlLicaImpsMap[matchedUrl] || {};

      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const avByLIAndCreative = await fetchActiveViewByCreative(lineItemIds, networkCode, token);

      // For each template creative × line item, find the matching report creative by impression count
      const matchRows = [];
      let totalViewable = 0, totalMeasurable = 0;
      for (const [templateId, perLI] of Object.entries(licaImps)) {
        for (const [liId, imps] of Object.entries(perLI)) {
          const liCreatives = avByLIAndCreative[liId] || {};
          const matchEntry  = Object.entries(liCreatives).find(([, av]) => Math.abs(Math.round(av.measurable) - imps) <= 20);
          const reportCreativeId = matchEntry ? matchEntry[0] : null;
          const av = matchEntry ? matchEntry[1] : null;
          if (av) { totalViewable += av.viewable; totalMeasurable += av.measurable; }
          matchRows.push({
            templateId, lineItemId: liId, licaImpressions: imps,
            reportCreativeId, viewable: av?.viewable ?? null, measurable: av?.measurable ?? null,
            rate: av ? parseFloat(((av.viewable / av.measurable) * 100).toFixed(1)) : null,
          });
        }
      }
      const combinedRate = totalMeasurable > 0 ? parseFloat(((totalViewable / totalMeasurable) * 100).toFixed(1)) : null;

      res.json({ matchedUrl, lineItemIds, combinedRate, totalViewable, totalMeasurable, matchRows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  /* Debug: returns raw AV report rows (LINE_ITEM_ID × CREATIVE_ID dimensions) for a
   * specific line item, covering all data since the line item was booked (up to 700 days).
   * Accepts ?id=<lineItemId>. Useful for verifying which creative IDs appear in reports
   * and cross-checking impression counts against LICA. */
  router.get('/api/debug-av-report-for-li', async (req, res) => {
    // Returns raw active view report rows (with CREATIVE_ID dim) for a specific line item
    const liId = req.query.id;
    if (!liId) return res.status(400).json({ error: 'id param required' });
    try {
      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;
      const now = new Date();
      const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
      const startD = new Date(now); startD.setDate(startD.getDate() - 700);
      const start = { year: startD.getFullYear(), month: startD.getMonth() + 1, day: startD.getDate() };
      const { runReportAndDownload } = require('../lib/gam-reports');
      const queryXml = `
      <dimensions>LINE_ITEM_ID</dimensions>
      <dimensions>CREATIVE_ID</dimensions>
      <columns>TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS</columns>
      <columns>TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS</columns>
      <startDate><year>${start.year}</year><month>${start.month}</month><day>${start.day}</day></startDate>
      <endDate><year>${end.year}</year><month>${end.month}</month><day>${end.day}</day></endDate>
      <dateRangeType>CUSTOM_DATE</dateRangeType>
      <statement><query>WHERE LINE_ITEM_ID IN (${liId})</query></statement>`;
      const csvText = await runReportAndDownload(queryXml, networkCode, token);
      const lines = csvText.split('\n').filter(Boolean);
      const rows = lines.slice(1).map(l => {
        const cols = l.split(',').map(c => c.trim().replace(/"/g, ''));
        return { lineItemId: cols[0], creativeId: cols[1], viewable: parseFloat(cols[2]||'0'), measurable: parseFloat(cols[3]||'0') };
      });
      res.json({ header: lines[0], rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
