'use strict';

/*
 * Pure data-fetching logic extracted from routes/dashboard-full.js.
 * Returns the full dashboard result set plus the intermediate maps needed
 * by the active-view and video-stats pipelines — no fs, no Express.
 */

const { fetchCreativesViaSoap, fetchCreativesByIds } = require('./gam-creatives');
const { fetchCompanionToMasterMap } = require('./gam-companion');
const { fetchCreativeLICAStats, fetchExcludedCreativeIds } = require('./gam-lica');
const { fetchLineItemMeta } = require('./gam-lineitems');
const { extractNetlifyUrl, getTemplateVarValue, slugToName } = require('./utils');

async function fetchDashboardData(networkCode, token) {
  const t0 = Date.now();

  const [desktopCreatives, mobileCompanions, companionToMaster, excludedCreativeIds] = await Promise.all([
    fetchCreativesViaSoap(networkCode, token, 'desktop'),
    fetchCreativesViaSoap(networkCode, token, 'mobile-companion'),
    fetchCompanionToMasterMap(networkCode, token, null),
    fetchExcludedCreativeIds(networkCode, token),
  ]);
  console.log(`Phase 1 (${Date.now() - t0}ms): ${desktopCreatives.length} desktop, ${mobileCompanions.length} companions, ${Object.keys(companionToMaster).length} creative-set pairs`);

  const companionNetlifyMap = {};
  for (const c of mobileCompanions) {
    if (excludedCreativeIds.has(c.id?.[0])) continue;
    const netlifyUrl = extractNetlifyUrl(c);
    if (!netlifyUrl) continue;
    const id = c.id?.[0];
    if (id) companionNetlifyMap[id] = { netlifyUrl, videoId: getTemplateVarValue(c, 'VIDEO_ID') };
  }

  const masterNetlifyMap = {};
  for (const [companionId, masterId] of Object.entries(companionToMaster)) {
    if (companionNetlifyMap[companionId] && !masterNetlifyMap[masterId]) {
      masterNetlifyMap[masterId] = companionNetlifyMap[companionId];
    }
  }
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

  const t1 = Date.now();
  const mobileMasters = await fetchCreativesByIds(networkCode, token, correlatedMasterIds);
  console.log(`Phase 2 (${Date.now() - t1}ms): ${mobileMasters.length} mobile masters fetched by ID`);

  const netlifyCreatives = [];
  for (const c of desktopCreatives) {
    if (excludedCreativeIds.has(c.id?.[0])) continue;
    const netlifyUrl = extractNetlifyUrl(c);
    if (!netlifyUrl) continue;
    netlifyCreatives.push({ creative: c, netlifyUrl, videoId: getTemplateVarValue(c, 'VIDEO_ID'), isMobile: false });
  }

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

  for (const g of Object.values(grouped)) {
    const liStatuses = [...g.lineItemIds].map(lid => statusByLI[lid]).filter(Boolean);
    g.liveStatus = liStatuses.includes('DELIVERING') ? 'delivering'
                 : liStatuses.includes('READY')      ? 'ready'
                 : liStatuses.includes('PAUSED')     ? 'paused'
                 : liStatuses.includes('INACTIVE')   ? 'inactive'
                 : null;
  }

  // Build intermediate maps needed by active-view and video-stats pipelines
  const urlLineItemMap = {};
  for (const data of Object.values(grouped)) {
    const url = data.netlifyUrl;
    if (!urlLineItemMap[url]) urlLineItemMap[url] = [];
    for (const lid of data.lineItemIds) {
      if (!urlLineItemMap[url].includes(lid)) urlLineItemMap[url].push(lid);
    }
  }

  const urlCreativeMap = {};
  for (const { creative, netlifyUrl } of netlifyCreatives) {
    let baseUrl;
    try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
    const id = creative.id?.[0];
    if (id && (statsByCreativeId[id]?.impressions || 0) > 0 && baseUrl) {
      if (!urlCreativeMap[baseUrl]) urlCreativeMap[baseUrl] = [];
      if (!urlCreativeMap[baseUrl].includes(id)) urlCreativeMap[baseUrl].push(id);
    }
  }

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

  const videoIdMap = {};
  for (const g of Object.values(grouped)) {
    if (g.videoId && !/[<>"&]/.test(g.videoId)) {
      const device = g.isMobile ? 'video-mobile' : 'video';
      if (!videoIdMap[g.videoId]) videoIdMap[g.videoId] = [];
      if (!videoIdMap[g.videoId].some(e => e.device === device)) {
        videoIdMap[g.videoId].push({ netlifyUrl: g.netlifyUrl, device });
      }
    }
  }

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
        activeView:           null,
        activeViewViewable:   null,
        activeViewMeasurable: null,
        completionRate:       null,
        durationSec:          null,
        lineItemIds:          [...r.lineItemIds],
        sortKey:              r.firstStartDate || 0,
      };
    });

  return { results, urlLineItemMap, urlCreativeMap, urlLicaImpsMap, videoIdMap };
}

module.exports = { fetchDashboardData };
