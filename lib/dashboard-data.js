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
const { fetchImpressionsByCreativeAndAdUnit } = require('./gam-reports');
const { extractNetlifyUrl, getTemplateVarValue, slugToName } = require('./utils');

const AD_UNIT_NAMES = {
  '225800817': 'BBCGoodFood.com',
  '225800697': 'GardenersWorld.com',
  '225719337': 'madeformums.com',
  '225719097': 'olivemagazine.com',
  '225800337': 'RadioTimes.com',
  '225800577': 'TopGear.com',
  '225723417': 'Historyextra.com',
};

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

  // masterUrlSet tracks every distinct base URL a master creative is linked to via its
  // companions. A master normally has exactly one, giving a clean 1:1 master->URL mapping.
  // If it ever has more than one (the same master creative reused across unrelated
  // campaigns), we can't tell which line items belong to which URL from LICA alone —
  // so that master is treated as ambiguous and excluded below rather than guessed at.
  const masterNetlifyMap = {};
  const masterUrlSet = {};
  for (const [companionId, masterIds] of Object.entries(companionToMaster)) {
    const cData = companionNetlifyMap[companionId];
    if (!cData) continue;
    let baseUrl;
    try { const u = new URL(cData.netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = cData.netlifyUrl.trim(); }
    for (const masterId of masterIds) {
      if (!masterNetlifyMap[masterId]) masterNetlifyMap[masterId] = cData;
      if (!masterUrlSet[masterId]) masterUrlSet[masterId] = new Set();
      masterUrlSet[masterId].add(baseUrl);
    }
  }
  const allMasterIdsInSets = new Set(Object.values(companionToMaster).flatMap(s => [...s]));
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

  // pushedCreativeIds tracks every creative ID actually added to netlifyCreatives, so a
  // true duplicate (the same creative object surfacing from both the desktop and mobile
  // scans) is only ever counted once. Desktop and mobile-master creatives come from
  // disjoint SOAP queries (970-wide template IDs vs 320/300-wide master IDs), so this is
  // a defensive guard rather than something expected to trigger in normal operation —
  // it deliberately does NOT suppress a real mobile row just because a desktop creative
  // happens to share the same Netlify host (both can legitimately deliver independently).
  const netlifyCreatives = [];
  const pushedCreativeIds = new Set();
  for (const c of desktopCreatives) {
    const id = c.id?.[0];
    if (excludedCreativeIds.has(id)) continue;
    const netlifyUrl = extractNetlifyUrl(c);
    if (!netlifyUrl) continue;
    netlifyCreatives.push({ creative: c, netlifyUrl, videoId: getTemplateVarValue(c, 'VIDEO_ID'), isMobile: false });
    if (id) pushedCreativeIds.add(id);
  }

  let mobileMatched = 0, mobileAmbiguousSkipped = 0;
  for (const c of mobileMasters) {
    const id = c.id?.[0];
    if (excludedCreativeIds.has(id)) continue;
    if (id && pushedCreativeIds.has(id)) continue;
    if (masterUrlSet[id]?.size > 1) {
      console.warn(`Master creative ${id} is linked to ${masterUrlSet[id].size} distinct URLs (${[...masterUrlSet[id]].join(', ')}) — skipping to avoid cross-campaign impression misattribution`);
      mobileAmbiguousSkipped++;
      continue;
    }
    if (masterNetlifyMap[id]) {
      const { netlifyUrl, videoId } = masterNetlifyMap[id];
      netlifyCreatives.push({ creative: c, netlifyUrl, videoId, isMobile: true });
      if (id) pushedCreativeIds.add(id);
      mobileMatched++;
    }
  }
  console.log(`Mobile: ${mobileMatched} masters matched, ${mobileAmbiguousSkipped} skipped as ambiguous. Total netlify rows: ${netlifyCreatives.length}`);

  const netlifyIds = netlifyCreatives.map(({ creative }) => creative.id?.[0]).filter(Boolean);

  // LICA is the source of truth for every row's impressions/clicks — a failed fetch here
  // must not be swallowed into an empty result set that then gets published as a fresh,
  // all-zero dashboard. Let it throw; callers (routes/dashboard-full.js, scripts/refresh.js)
  // already surface a visible error / non-zero exit rather than overwriting a good cache.
  const lica = await fetchCreativeLICAStats(netlifyIds, networkCode, token);
  const statsByCreativeId     = lica.statsByCreativeId;
  const lineItemsByCreativeId = lica.lineItemsByCreativeId;
  const impsByCreativeAndLI   = lica.impsByCreativeAndLI;

  const grouped = {};
  for (const { creative, netlifyUrl, videoId, isMobile } of netlifyCreatives) {
    let baseUrl;
    try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
    const id = creative.id?.[0];
    const s  = statsByCreativeId[id];
    const sizeKey = isMobile ? 'm' : 'd';
    const groupKey = videoId ? `${baseUrl}##${videoId}##${sizeKey}` : `${baseUrl}##${sizeKey}`;
    if (!grouped[groupKey]) grouped[groupKey] = { netlifyUrl: baseUrl, videoId: videoId || null, isMobile, impressions: 0, clicks: 0, lineItemIds: new Set(), adUnitIds: new Set(), creativeIds: new Set(), impsByAdUnit: {}, firstStartDate: Infinity };
    grouped[groupKey].impressions += s?.impressions > 0 ? s.impressions : 0;
    grouped[groupKey].clicks      += s?.clicks      > 0 ? s.clicks      : 0;
    if (id) grouped[groupKey].creativeIds.add(id);
    if (id && lineItemsByCreativeId[id]) {
      for (const lid of lineItemsByCreativeId[id]) grouped[groupKey].lineItemIds.add(lid);
    }
  }
  console.log(`Dedup: ${netlifyCreatives.length} creatives → ${Object.keys(grouped).length} rows (video skins split by VIDEO_ID)`);

  let statusByLI = {};
  try {
    const allLIIds = [...new Set(Object.values(grouped).flatMap(g => [...g.lineItemIds]))];
    const [meta, reportByLIAndCreative] = await Promise.all([
      fetchLineItemMeta(allLIIds, networkCode, token),
      fetchImpressionsByCreativeAndAdUnit(allLIIds, networkCode, token)
        .catch(e => { console.warn('ad-unit report failed:', e.message); return {}; }),
    ]);
    statusByLI = meta.statusByLI;

    for (const g of Object.values(grouped)) {
      g.firstStartDate = Math.min(Infinity, ...[...g.lineItemIds].map(lid => meta.startDateByLI[lid] || Infinity));
      if (!isFinite(g.firstStartDate)) g.firstStartDate = 0;
      for (const lid of g.lineItemIds) {
        for (const auid of (meta.adUnitsByLI[lid] || [])) g.adUnitIds.add(auid);
      }
    }

    // Impression fingerprinting: report creative IDs (9-digit rendered) have no join
    // key to LICA template creative IDs, but within the same line item the report
    // creative whose total impressions match the LICA count within max(50, 1%) is the
    // same creative — the identical bridge used by lib/active-view-data.js.
    //
    // A/B creative variants rotating evenly in one line item land within tolerance of
    // each other, so tolerance alone can't separate them. Resolution is constraint
    // solving, never closest-match: lock unique exact (diff=0) hits first, then
    // repeatedly eliminate locked report creatives from the remaining candidate lists
    // — each locked pair disambiguates its sibling. Pairs still ambiguous at the
    // fixpoint are skipped; wrong data is worse than no data. LICA is all-time; the
    // report window is 1094 days — campaigns delivering before the window won't match.
    const pairs = [];
    for (const g of Object.values(grouped)) {
      for (const cid of g.creativeIds) {
        for (const [liId, licaImps] of Object.entries(impsByCreativeAndLI[cid] || {})) {
          const liCreatives = reportByLIAndCreative[liId] || {};
          const tol = Math.max(50, Math.round(licaImps * 0.01));
          const candidates = Object.entries(liCreatives)
            .filter(([, v]) => Math.abs(v.totalImps - licaImps) <= tol)
            .map(([rcid, v]) => ({ rcid, exact: v.totalImps === licaImps }));
          pairs.push({ g, liId, licaImps, candidates, locked: null, dead: false });
        }
      }
    }

    const lockedBy = {}; // `${liId}:${rcid}` → pair
    let conflicts = 0;

    // Tier 1: lock pairs with a unique exact hit (unless two pairs exact-claim the same creative)
    const exactClaims = {};
    for (const p of pairs) {
      const ex = p.candidates.filter(c => c.exact);
      if (ex.length === 1) {
        const k = `${p.liId}:${ex[0].rcid}`;
        (exactClaims[k] = exactClaims[k] || []).push(p);
      }
    }
    for (const [k, claimants] of Object.entries(exactClaims)) {
      if (claimants.length === 1) {
        claimants[0].locked = k.slice(k.indexOf(':') + 1);
        lockedBy[k] = claimants[0];
      } else {
        for (const p of claimants) p.dead = true;
        conflicts += claimants.length;
      }
    }

    // Tier 2: iterate — a pair whose candidates reduce to one after removing
    // creatives locked by other pairs is itself resolved.
    let changed = true;
    while (changed) {
      changed = false;
      const claims = {};
      for (const p of pairs) {
        if (p.locked || p.dead) continue;
        const remaining = p.candidates.filter(c => !lockedBy[`${p.liId}:${c.rcid}`]);
        if (remaining.length === 1) {
          const k = `${p.liId}:${remaining[0].rcid}`;
          (claims[k] = claims[k] || []).push(p);
        }
      }
      for (const [k, claimants] of Object.entries(claims)) {
        if (claimants.length === 1) {
          claimants[0].locked = k.slice(k.indexOf(':') + 1);
          lockedBy[k] = claimants[0];
          changed = true;
        } else {
          for (const p of claimants) p.dead = true;
          conflicts += claimants.length;
        }
      }
    }

    // Apply locked pairs. The report's numbers lag LICA by a few hours for live
    // campaigns, so anchor each breakdown to the LICA count the row displays:
    // proportions come from the report, the total is the pair's licaImps exactly —
    // filtered sums then reconcile 100% with row totals. There's no per-LI LICA click
    // breakdown to anchor against directly, so clicks get the same proportional scale
    // factor as impressions — keeps clicks consistent with the anchored impressions
    // instead of mixing an anchored total with raw, unadjusted report-window clicks.
    let applied = 0, ambiguous = 0, unmatched = 0;
    for (const p of pairs) {
      if (!p.locked) {
        if (p.dead) continue; // counted in conflicts
        const remaining = p.candidates.filter(c => !lockedBy[`${p.liId}:${c.rcid}`]);
        if (remaining.length === 0) unmatched++;
        else ambiguous++;
        continue;
      }
      const rec = reportByLIAndCreative[p.liId][p.locked];
      const scale = rec.totalImps > 0 ? p.licaImps / rec.totalImps : 0;
      const scaled = Object.entries(rec.adUnits).map(([auId, s]) => ({
        name: AD_UNIT_NAMES[auId] || 'Other',
        imps: Math.round(s.impressions * scale),
        clicks: Math.round(s.clicks * scale),
      }));
      const resid = p.licaImps - scaled.reduce((a, x) => a + x.imps, 0);
      if (resid !== 0 && scaled.length) {
        scaled.reduce((max, x) => (x.imps > max.imps ? x : max), scaled[0]).imps += resid;
      }
      for (const s of scaled) {
        if (!p.g.impsByAdUnit[s.name]) p.g.impsByAdUnit[s.name] = { impressions: 0, clicks: 0 };
        p.g.impsByAdUnit[s.name].impressions += s.imps;
        p.g.impsByAdUnit[s.name].clicks      += s.clicks;
      }
      applied++;
    }
    console.log(`Ad-unit fingerprint: ${applied} matched, ${ambiguous} ambiguous, ${conflicts} conflicting, ${unmatched} unmatched (creative,LI) pairs`);
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

  // Build intermediate maps needed by active-view and video-stats pipelines. Keyed by the
  // same composite group key as dashboard rows (netlifyUrl##videoId##device) rather than
  // just netlifyUrl, so a URL with both a desktop skin and video creatives gets independent
  // active-view stats per row/tab instead of one number blended across all of them.
  const urlLineItemMap = {};
  for (const data of Object.values(grouped)) {
    const device = data.isMobile ? (data.videoId ? 'video-mobile' : 'mobile') : (data.videoId ? 'video' : 'desktop');
    const key = `${data.netlifyUrl}##${data.videoId || ''}##${device}`;
    if (!urlLineItemMap[key]) urlLineItemMap[key] = [];
    for (const lid of data.lineItemIds) {
      if (!urlLineItemMap[key].includes(lid)) urlLineItemMap[key].push(lid);
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
  for (const { creative, netlifyUrl, videoId, isMobile } of netlifyCreatives) {
    let baseUrl;
    try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
    const id = creative.id?.[0];
    if (id && baseUrl && (statsByCreativeId[id]?.impressions || 0) > 0 && impsByCreativeAndLI[id]) {
      const device = isMobile ? (videoId ? 'video-mobile' : 'mobile') : (videoId ? 'video' : 'desktop');
      const key = `${baseUrl}##${videoId || ''}##${device}`;
      if (!urlLicaImpsMap[key]) urlLicaImpsMap[key] = {};
      urlLicaImpsMap[key][id] = impsByCreativeAndLI[id];
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
        adUnitNames:          [...new Set([
                                ...[...r.adUnitIds].map(id => AD_UNIT_NAMES[id]).filter(Boolean),
                                ...Object.keys(r.impsByAdUnit || {}).filter(n => n !== 'Other'),
                              ])],
        impsByAdUnit:         r.impsByAdUnit || {},
        // Fraction of this row's impressions the ad-unit fingerprint actually covers —
        // ambiguous/unmatched (creative, LI) pairs contribute nothing to impsByAdUnit, so
        // this can be well below 1 even for a row with real, complete delivery. Lets the
        // frontend show a partial-coverage marker instead of presenting a partial
        // breakdown as if it were the whole picture.
        adUnitCoverage:       r.impressions > 0
                                ? Math.min(1, Object.values(r.impsByAdUnit || {}).reduce((s, x) => s + (x.impressions || 0), 0) / r.impressions)
                                : null,
        sortKey:              r.firstStartDate || 0,
      };
    });

  return { results, urlLineItemMap, urlCreativeMap, urlLicaImpsMap, videoIdMap };
}

module.exports = { fetchDashboardData };
