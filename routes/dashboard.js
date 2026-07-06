'use strict';

/*
 * Dashboard route — the primary data endpoint for the Infinity Dashboard UI.
 * Fetches all desktop skin template creatives from GAM via SOAP, filters to those
 * with a Netlify URL, enriches them with LICA impression/click stats, groups
 * duplicates by base URL (video skins further split by VIDEO_ID), attaches line item
 * start dates for sort order, and writes several JSON cache files used by the
 * active-view and video-stats routes. Order 3559958634 is excluded from results.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getToken } = require('../lib/auth');
const { fetchCreativesViaSoap } = require('../lib/gam-creatives');
const { fetchCreativeLICAStats, fetchExcludedCreativeIds } = require('../lib/gam-lica');
const { fetchLineItemStartDates } = require('../lib/gam-lineitems');
const { extractNetlifyUrl, getTemplateVarValue, slugToName } = require('../lib/utils');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {

  /* Main dashboard data endpoint. Returns all active Netlify skin creatives with
   * aggregated impressions, clicks, CTR, active view rate, and video completion rate.
   * No query params accepted — always fetches fresh data from GAM on each call.
   * Side-effects: writes url_lineitem_cache.json, url_creative_cache.json,
   * url_lica_imps_cache.json, url_videoid_cache.json, and invalidates
   * active_view_cache.json so the next active-view call re-runs the report. */
  router.get('/api/dashboard', async (req, res) => {
    try {
      const networkCode = process.env.GAM_NETWORK_CODE;
      if (!networkCode) return res.status(500).json({ error: 'GAM_NETWORK_CODE is not set' });

      const token = await getToken();

      const [desktopCreatives, excludedCreativeIds] = await Promise.all([
        fetchCreativesViaSoap(networkCode, token),
        fetchExcludedCreativeIds(networkCode, token),
      ]);

      console.log(`Fetched: ${desktopCreatives.length} desktop creatives`);

      const netlifyCreatives = [];
      for (const c of desktopCreatives) {
        if (excludedCreativeIds.has(c.id?.[0])) continue;
        const netlifyUrl = extractNetlifyUrl(c);
        if (!netlifyUrl) continue;
        netlifyCreatives.push({ creative: c, netlifyUrl, videoId: getTemplateVarValue(c, 'VIDEO_ID') });
      }

      const netlifyIds = netlifyCreatives.map(({ creative }) => creative.id?.[0]).filter(Boolean);

      let statsByCreativeId = {};
      let lineItemsByCreativeId = {};
      let impsByCreativeAndLI = {};
      try {
        const lica = await fetchCreativeLICAStats(netlifyIds, networkCode, token);
        statsByCreativeId     = lica.statsByCreativeId;
        lineItemsByCreativeId = lica.lineItemsByCreativeId;
        impsByCreativeAndLI   = lica.impsByCreativeAndLI;
      } catch (e) {
        console.warn('LICA stats fetch failed:', e.message, e.response?.data?.substring?.(0, 500) || '');
      }

      // Build grouped map — video skins split per VIDEO_ID so each video asset
      // gets its own row, while non-video skins are deduplicated by base URL only
      const grouped = {};
      for (const { creative, netlifyUrl, videoId } of netlifyCreatives) {
        let baseUrl;
        try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
        const id = creative.id?.[0];
        const s  = statsByCreativeId[id];
        const groupKey = videoId ? `${baseUrl}##${videoId}` : baseUrl;
        if (!grouped[groupKey]) grouped[groupKey] = { netlifyUrl: baseUrl, videoId: videoId || null, impressions: 0, clicks: 0, lineItemIds: new Set(), firstStartDate: Infinity };
        grouped[groupKey].impressions += s?.impressions > 0 ? s.impressions : 0;
        grouped[groupKey].clicks      += s?.clicks      > 0 ? s.clicks      : 0;
        if (id && lineItemsByCreativeId[id]) {
          for (const lid of lineItemsByCreativeId[id]) grouped[groupKey].lineItemIds.add(lid);
        }
      }

      console.log(`Dedup: ${netlifyCreatives.length} creatives → ${Object.keys(grouped).length} rows (video skins split by VIDEO_ID)`);

      try {
        const allLIIds = [...new Set(Object.values(grouped).flatMap(g => [...g.lineItemIds]))];
        const startDateByLI = await fetchLineItemStartDates(allLIIds, networkCode, token);
        for (const g of Object.values(grouped)) {
          // Use the earliest line item start date across all line items for this URL as the sort key
          g.firstStartDate = Math.min(Infinity, ...[...g.lineItemIds].map(lid => startDateByLI[lid] || Infinity));
          if (!isFinite(g.firstStartDate)) g.firstStartDate = 0;
        }
      } catch(e) {
        console.warn('fetchLineItemStartDates failed:', e.message);
      }

      // url_lineitem_cache.json — used by /api/active-view to know which line items to query
      const urlLineItemMap = {};
      for (const data of Object.values(grouped)) {
        const url = data.netlifyUrl;
        if (!urlLineItemMap[url]) urlLineItemMap[url] = [];
        for (const lid of data.lineItemIds) {
          if (!urlLineItemMap[url].includes(lid)) urlLineItemMap[url].push(lid);
        }
      }
      fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_lineitem_cache.json'), JSON.stringify(urlLineItemMap));

      // url_creative_cache.json — maps base URL → template creative IDs that have impressions,
      // used by the debug active-view endpoints
      const urlCreativeMap = {};
      for (const { creative, netlifyUrl } of netlifyCreatives) {
        let baseUrl;
        try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
        const id = creative.id?.[0];
        const hasImpressions = id && (statsByCreativeId[id]?.impressions || 0) > 0;
        if (hasImpressions && baseUrl) {
          if (!urlCreativeMap[baseUrl]) urlCreativeMap[baseUrl] = [];
          if (!urlCreativeMap[baseUrl].includes(id)) urlCreativeMap[baseUrl].push(id);
        }
      }
      fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_creative_cache.json'), JSON.stringify(urlCreativeMap));

      // url_lica_imps_cache.json — per-creative, per-line-item LICA impression counts,
      // used by /api/active-view to fingerprint template creatives against AV report rows
      const urlLicaImpsMap = {};
      for (const { creative, netlifyUrl } of netlifyCreatives) {
        let baseUrl;
        try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
        const id = creative.id?.[0];
        if (id && baseUrl && (statsByCreativeId[id]?.impressions || 0) > 0 && impsByCreativeAndLI[id]) {
          if (!urlLicaImpsMap[baseUrl]) urlLicaImpsMap[baseUrl] = {};
          urlLicaImpsMap[baseUrl][id] = impsByCreativeAndLI[id];
        }
      }
      fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_lica_imps_cache.json'), JSON.stringify(urlLicaImpsMap));

      // Invalidate the active view cache so the next /api/active-view call re-runs the report
      // with fresh LICA impression counts from this refresh
      try { fs.unlinkSync(path.join(SCREENSHOT_DIR, 'active_view_cache.json')); } catch(e) {}

      // url_videoid_cache.json — used by /api/video-stats to find video hosting line items
      const videoIdUrlMap = {};
      for (const g of Object.values(grouped)) {
        if (g.videoId && !videoIdUrlMap[g.videoId]) {
          videoIdUrlMap[g.videoId] = g.netlifyUrl;
        }
      }
      fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_videoid_cache.json'), JSON.stringify(videoIdUrlMap));

      let activeViewByUrl = {};
      try {
        const avPath = path.join(SCREENSHOT_DIR, 'active_view_cache.json');
        if (fs.existsSync(avPath)) activeViewByUrl = JSON.parse(fs.readFileSync(avPath, 'utf8'));
      } catch(e) {}

      let videoStatsByVideoId = {};
      try {
        const vsPath = path.join(SCREENSHOT_DIR, 'video_stats_cache.json');
        if (fs.existsSync(vsPath)) videoStatsByVideoId = JSON.parse(fs.readFileSync(vsPath, 'utf8'));
      } catch(e) {}

      // Sort by most recent line item start date so the newest creatives appear first
      const results = Object.values(grouped)
        .sort((a, b) => b.firstStartDate - a.firstStartDate)
        .map(r => {
          const device = r.videoId ? 'video' : 'desktop';
          return {
            netlifyUrl:           r.netlifyUrl,
            videoId:              r.videoId || null,
            advertiser:           slugToName(r.netlifyUrl),
            device,
            impressions:          r.impressions || null,
            clicks:               r.clicks      || null,
            ctr:                  r.impressions && r.clicks ? parseFloat(((r.clicks / r.impressions) * 100).toFixed(2)) : null,
            activeView:           activeViewByUrl[r.netlifyUrl]?.rate ?? null,
            activeViewViewable:   activeViewByUrl[r.netlifyUrl]?.viewable ?? null,
            activeViewMeasurable: activeViewByUrl[r.netlifyUrl]?.measurable ?? null,
            completionRate:       r.videoId ? (videoStatsByVideoId[r.videoId]?.completionRate ?? null) : null,
            durationSec:          r.videoId ? (videoStatsByVideoId[r.videoId]?.durationSec ?? null) : null,
            lineItemIds:          [...r.lineItemIds],
            sortKey:              r.firstStartDate || 0,
          };
        });

      res.json({
        total: results.length,
        lastFetched: new Date().toISOString(),
        results,
      });
    } catch (err) {
      const message = err.response?.data || err.message;
      console.error('Dashboard error:', message);
      res.status(500).json({ error: typeof message === 'string' ? message : JSON.stringify(message) });
    }
  });

  return router;
};
