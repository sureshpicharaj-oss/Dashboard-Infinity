'use strict';

/*
 * Full dashboard route — handles both desktop AND mobile skin creatives.
 *
 * This is the full-server equivalent of routes/dashboard.js (which is desktop-only).
 * Performance-optimised flow:
 *   Phase 1 (parallel): desktop creatives + 300×250/251 companions (filtered to 9 template IDs,
 *     ~419 creatives) + ALL creative sets (no filter) + excluded creative IDs.
 *   Phase 1b: cross-reference companion IDs that have Netlify URLs against the creative-set map
 *     to derive the exact master IDs we need (~200–400 correlated 320×50/51 masters).
 *   Phase 2: fetch only those specific masters by ID — avoids scanning all 17,133 320×50/51s.
 * Mobile URLs that already appear in the desktop set are skipped to avoid duplicate rows.
 *
 * Side-effects: writes url_lineitem_cache.json, url_creative_cache.json,
 * url_lica_imps_cache.json, url_videoid_cache.json, and invalidates
 * active_view_cache.json so the next /api/active-view call re-runs the report.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getToken } = require('../lib/auth');
const { fetchCreativesViaSoap, fetchCreativesByIds } = require('../lib/gam-creatives');
const { fetchCompanionToMasterMap } = require('../lib/gam-companion');
const { fetchCreativeLICAStats, fetchExcludedCreativeIds } = require('../lib/gam-lica');
const { fetchLineItemMeta } = require('../lib/gam-lineitems');
const { extractNetlifyUrl, getTemplateVarValue, slugToName } = require('../lib/utils');

module.exports = function(SCREENSHOT_DIR) {
  const router = express.Router();

  /* Main dashboard data endpoint. Returns all active Netlify skin creatives with
   * aggregated impressions, clicks, CTR, active view rate, and video completion rate.
   * No query params accepted — always fetches fresh data from GAM on each call.
   * Each row includes a 'device' field: 'desktop', 'mobile', 'video', or 'video-mobile'. */
  router.get('/api/dashboard', async (req, res) => {
    try {
      const networkCode = process.env.GAM_NETWORK_CODE;
      if (!networkCode) return res.status(500).json({ error: 'GAM_NETWORK_CODE is not set' });

      const token = await getToken();
      const t0 = Date.now();

      // Phase 1 (parallel): companions carry Netlify URL; creative sets map companions→masters;
      // desktop and excluded run alongside. We skip the bulk 320×50 master scan entirely —
      // instead we derive the exact master IDs we need from creative sets × companion IDs.
      const [desktopCreatives, mobileCompanions, companionToMaster, excludedCreativeIds] = await Promise.all([
        fetchCreativesViaSoap(networkCode, token, 'desktop'),
        fetchCreativesViaSoap(networkCode, token, 'mobile-companion'), // 300×250/251 — carry Netlify URL
        fetchCompanionToMasterMap(networkCode, token, null),           // ALL creative sets, no filter
        fetchExcludedCreativeIds(networkCode, token),
      ]);
      console.log(`Phase 1 (${Date.now() - t0}ms): ${desktopCreatives.length} desktop, ${mobileCompanions.length} companions, ${Object.keys(companionToMaster).length} creative-set pairs`);

      // Build companion → { netlifyUrl, videoId } from the 300×250/251 creatives
      const companionNetlifyMap = {};
      for (const c of mobileCompanions) {
        if (excludedCreativeIds.has(c.id?.[0])) continue;
        const netlifyUrl = extractNetlifyUrl(c);
        if (!netlifyUrl) continue;
        const id = c.id?.[0];
        if (id) companionNetlifyMap[id] = { netlifyUrl, videoId: getTemplateVarValue(c, 'VIDEO_ID') };
      }

      // Derive the correlated master IDs — only masters whose companion has a Netlify URL
      const masterNetlifyMap = {}; // masterId → { netlifyUrl, videoId }
      for (const [companionId, masterId] of Object.entries(companionToMaster)) {
        if (companionNetlifyMap[companionId] && !masterNetlifyMap[masterId]) {
          masterNetlifyMap[masterId] = companionNetlifyMap[companionId];
        }
      }
      // Pattern B: some 300×251 creatives are the MASTER in a creative set (the 320×51 is the
      // companion). Their ID appears as a VALUE in companionToMaster, not a key. They carry the
      // Netlify URL and LICA stats themselves — no separate master fetch needed.
      const allMasterIdsInSets = new Set(Object.values(companionToMaster));
      let patternBCount = 0;
      for (const [companionId, data] of Object.entries(companionNetlifyMap)) {
        if (allMasterIdsInSets.has(companionId) && !masterNetlifyMap[companionId]) {
          masterNetlifyMap[companionId] = data;
          patternBCount++;
        }
      }

      const correlatedMasterIds = Object.keys(masterNetlifyMap);
      console.log(`Phase 1b: ${Object.keys(companionNetlifyMap).length} companions with Netlify URLs → ${correlatedMasterIds.length} correlated master IDs (${patternBCount} Pattern B 300×251 masters)`);

      // Phase 2: fetch only the correlated mobile masters by their specific IDs
      const t1 = Date.now();
      const mobileMasters = await fetchCreativesByIds(networkCode, token, correlatedMasterIds);
      console.log(`Phase 2 (${Date.now() - t1}ms): ${mobileMasters.length} mobile masters fetched by ID`);

      // Desktop: Netlify URL lives on the 970px template creative itself
      const netlifyCreatives = [];
      const desktopBaseUrls = new Set();
      for (const c of desktopCreatives) {
        if (excludedCreativeIds.has(c.id?.[0])) continue;
        const netlifyUrl = extractNetlifyUrl(c);
        if (!netlifyUrl) continue;
        let baseUrl;
        try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
        desktopBaseUrls.add(baseUrl);
        netlifyCreatives.push({ creative: c, netlifyUrl, videoId: getTemplateVarValue(c, 'VIDEO_ID'), isMobile: false });
      }

      // Mobile: stats come from the 320×50/51 master; URL is from masterNetlifyMap (companion→master lookup).
      // Skip any companion URL that already appears in the desktop set (e.g. a desktop skin's companion).
      let mobileMatched = 0;
      for (const c of mobileMasters) {
        if (excludedCreativeIds.has(c.id?.[0])) continue;
        const id = c.id?.[0];
        if (masterNetlifyMap[id]) {
          const { netlifyUrl, videoId } = masterNetlifyMap[id];
          netlifyCreatives.push({ creative: c, netlifyUrl, videoId, isMobile: true });
          mobileMatched++;
        }
      }

      console.log(`Mobile: ${mobileMatched} masters matched. Total netlify rows: ${netlifyCreatives.length}`);

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

      // Build grouped map. Video skins split per VIDEO_ID; desktop/mobile kept separate via sizeKey.
      // Build the set of desktop base URLs that have real LICA data — used to suppress mobile
      // rows only when a genuinely live desktop creative shares the same URL. A phantom desktop
      // creative (0 impressions, no line items) must NOT block a real mobile creative.
      const activeDesktopBaseUrls = new Set();
      for (const { creative, netlifyUrl, isMobile } of netlifyCreatives) {
        if (isMobile) continue;
        const id = creative.id?.[0];
        const hasData = (statsByCreativeId[id]?.impressions || 0) > 0 || (lineItemsByCreativeId[id]?.size || 0) > 0;
        if (hasData) {
          let baseUrl;
          try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
          activeDesktopBaseUrls.add(baseUrl);
        }
      }

      const grouped = {};
      for (const { creative, netlifyUrl, videoId, isMobile } of netlifyCreatives) {
        let baseUrl;
        try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
        // Skip mobile rows only if an active desktop creative covers the same URL
        if (isMobile && activeDesktopBaseUrls.has(baseUrl)) continue;
        const id = creative.id?.[0];
        const s  = statsByCreativeId[id];
        const sizeKey = isMobile ? 'm' : 'd';
        const groupKey = videoId ? `${baseUrl}##${videoId}##${sizeKey}` : `${baseUrl}##${sizeKey}`;
        if (!grouped[groupKey]) grouped[groupKey] = { netlifyUrl: baseUrl, videoId: videoId || null, isMobile, impressions: 0, clicks: 0, lineItemIds: new Set(), firstStartDate: Infinity };
        grouped[groupKey].impressions += s?.impressions > 0 ? s.impressions : 0;
        grouped[groupKey].clicks      += s?.clicks      > 0 ? s.clicks      : 0;
        if (id && lineItemsByCreativeId[id]) {
          for (const lid of lineItemsByCreativeId[id]) grouped[groupKey].lineItemIds.add(lid);
        }
      }

      console.log(`Dedup: ${netlifyCreatives.length} creatives → ${Object.keys(grouped).length} rows (video skins split by VIDEO_ID)`);

      let statusByLI = {};
      try {
        const allLIIds = [...new Set(Object.values(grouped).flatMap(g => [...g.lineItemIds]))];
        const meta = await fetchLineItemMeta(allLIIds, networkCode, token);
        statusByLI = meta.statusByLI;
        for (const g of Object.values(grouped)) {
          g.firstStartDate = Math.min(Infinity, ...[...g.lineItemIds].map(lid => meta.startDateByLI[lid] || Infinity));
          if (!isFinite(g.firstStartDate)) g.firstStartDate = 0;
        }
      } catch(e) {
        console.warn('fetchLineItemMeta failed:', e.message);
      }

      // Derive liveStatus per group before sorting so the sort can use it
      for (const g of Object.values(grouped)) {
        const liStatuses = [...g.lineItemIds].map(lid => statusByLI[lid]).filter(Boolean);
        g.liveStatus = liStatuses.includes('DELIVERING') ? 'delivering'
                     : liStatuses.includes('READY')      ? 'ready'
                     : liStatuses.includes('PAUSED')     ? 'paused'
                     : liStatuses.includes('INACTIVE')   ? 'inactive'
                     : null;
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

      // Sort: READY → DELIVERING → PAUSED → INACTIVE → COMPLETED, newest first within each group
      const STATUS_ORDER = { ready: 0, delivering: 1, paused: 2, inactive: 3 };
      const results = Object.values(grouped)
        .filter(r => r.impressions > 0 || r.lineItemIds.size > 0)
        .sort((a, b) => {
          const aOrder = STATUS_ORDER[a.liveStatus] ?? 4;
          const bOrder = STATUS_ORDER[b.liveStatus] ?? 4;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return b.firstStartDate - a.firstStartDate;
        })
        .map(r => {
          const device = r.isMobile
            ? (r.videoId ? 'video-mobile' : 'mobile')
            : (r.videoId ? 'video' : 'desktop');
          return {
            netlifyUrl:           r.netlifyUrl,
            videoId:              r.videoId || null,
            advertiser:           slugToName(r.netlifyUrl),
            device,
            liveStatus:           r.liveStatus,
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
