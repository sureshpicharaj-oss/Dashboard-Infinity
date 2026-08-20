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
  const statsByCreativeId      = lica.statsByCreativeId;
  const lineItemsByCreativeId  = lica.lineItemsByCreativeId;
  const impsByCreativeAndLI    = lica.impsByCreativeAndLI;
  const clicksByCreativeAndLI  = lica.clicksByCreativeAndLI || {};

  const grouped = {};
  for (const { creative, netlifyUrl, videoId, isMobile } of netlifyCreatives) {
    let baseUrl;
    try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
    const id = creative.id?.[0];
    const s  = statsByCreativeId[id];
    const sizeKey = isMobile ? 'm' : 'd';
    const groupKey = videoId ? `${baseUrl}##${videoId}##${sizeKey}` : `${baseUrl}##${sizeKey}`;
    if (!grouped[groupKey]) grouped[groupKey] = { netlifyUrl: baseUrl, videoId: videoId || null, isMobile, impressions: 0, clicks: 0, lineItemIds: new Set(), adUnitIds: new Set(), creativeIds: new Set(), reportCidsByLI: {}, impsByAdUnit: {}, firstStartDate: Infinity };
    grouped[groupKey].impressions += s?.impressions > 0 ? s.impressions : 0;
    grouped[groupKey].clicks      += s?.clicks      > 0 ? s.clicks      : 0;
    if (id) grouped[groupKey].creativeIds.add(id);
    if (id && lineItemsByCreativeId[id]) {
      for (const lid of lineItemsByCreativeId[id]) grouped[groupKey].lineItemIds.add(lid);
    }
  }
  console.log(`Dedup: ${netlifyCreatives.length} creatives → ${Object.keys(grouped).length} rows (video skins split by VIDEO_ID)`);

  let statusByLI = {};
  let keyValueIdsByLI = {};
  let goalByLI = {};
  let startDateByLI = {};
  // template creative ID -> { liId: rendered report creative ID }, and per (line item, rendered
  // creative) report totals — both from the impression fingerprint below. Hoisted so the row/split
  // reconciliation after the fingerprint can read them.
  const renderedByTemplate = {};
  let reportByLIAndCreative = {};
  // template creative ID -> { adUnitName: {impressions, clicks} } — the SAME per-(creative, line
  // item) ad-unit breakdown already computed below for the row total, but kept per-creative too so
  // a split entry can show exactly where an individual creative delivers (e.g. a line item blending
  // a broad "Skin" creative with a site-specific "Skin-Top Gear" variant — the row total blends both,
  // masking that the latter runs almost entirely on one site).
  const creativeAdUnitMap = {};
  // template creative ID -> line item ID -> { adUnitName: {impressions, clicks} } — the SAME
  // breakdown again, kept one level finer, so a creative reused across several line items (a
  // generic "Manual Line" filler booked onto more than one flight) can be split into one split-view
  // row per line item instead of blending all of its bookings into one figure.
  const creativeLiAdUnitMap = {};
  try {
    const allLIIds = [...new Set(Object.values(grouped).flatMap(g => [...g.lineItemIds]))];
    const [meta, reportRes] = await Promise.all([
      fetchLineItemMeta(allLIIds, networkCode, token),
      fetchImpressionsByCreativeAndAdUnit(allLIIds, networkCode, token)
        .catch(e => { console.warn('ad-unit report failed:', e.message); return {}; }),
    ]);
    reportByLIAndCreative = reportRes || {};
    statusByLI = meta.statusByLI;
    keyValueIdsByLI = meta.keyValueIdsByLI || {};
    goalByLI = meta.goalByLI || {};
    startDateByLI = meta.startDateByLI || {};

    for (const g of Object.values(grouped)) {
      g.firstStartDate = Math.min(Infinity, ...[...g.lineItemIds].map(lid => meta.startDateByLI[lid] || Infinity));
      if (!isFinite(g.firstStartDate)) g.firstStartDate = 0;
      // Farthest-out end date across the row's line items — Infinity/null when any of them is
      // open-ended (no defined end can't be "the latest end", it just never ends).
      const endTimes = [...g.lineItemIds].map(lid => {
        const gb = goalByLI[lid];
        return (gb && !gb.unlimitedEnd && gb.endTs != null) ? gb.endTs : Infinity;
      });
      const lastEnd = endTimes.length ? Math.max(...endTimes) : null;
      g.lastEndDate = (lastEnd != null && isFinite(lastEnd)) ? lastEnd : null;
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
          pairs.push({ g, templateCid: cid, liId, licaImps, candidates, locked: null, dead: false });
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
      // Record the rendered creative this (row, line item) pair resolved to, so the reconciliation
      // below can pull THIS row's own creatives' authoritative report totals (true clicks, de-duped).
      (p.g.reportCidsByLI[p.liId] || (p.g.reportCidsByLI[p.liId] = new Set())).add(p.locked);
      (renderedByTemplate[p.templateCid] || (renderedByTemplate[p.templateCid] = {}))[p.liId] = p.locked;
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
      // Same breakdown, mirrored per-creative (not just summed into the row) — see creativeAdUnitMap above.
      if (!creativeAdUnitMap[p.templateCid]) creativeAdUnitMap[p.templateCid] = {};
      for (const s of scaled) {
        if (!creativeAdUnitMap[p.templateCid][s.name]) creativeAdUnitMap[p.templateCid][s.name] = { impressions: 0, clicks: 0 };
        creativeAdUnitMap[p.templateCid][s.name].impressions += s.imps;
        creativeAdUnitMap[p.templateCid][s.name].clicks      += s.clicks;
      }
      // Same breakdown again, one level finer — see creativeLiAdUnitMap above.
      if (!creativeLiAdUnitMap[p.templateCid]) creativeLiAdUnitMap[p.templateCid] = {};
      if (!creativeLiAdUnitMap[p.templateCid][p.liId]) creativeLiAdUnitMap[p.templateCid][p.liId] = {};
      for (const s of scaled) {
        const bucket = creativeLiAdUnitMap[p.templateCid][p.liId];
        if (!bucket[s.name]) bucket[s.name] = { impressions: 0, clicks: 0 };
        bucket[s.name].impressions += s.imps;
        bucket[s.name].clicks      += s.clicks;
      }
      applied++;
    }
    console.log(`Ad-unit fingerprint: ${applied} matched, ${ambiguous} ambiguous, ${conflicts} conflicting, ${unmatched} unmatched (creative,LI) pairs`);
  } catch(e) {
    console.warn('fetchLineItemMeta failed:', e.message);
  }

  // ---- Reconcile each row's impressions/clicks to the report, PER CREATIVE ----
  // Summing per-creative LICA stats mis-states a row when GAM mis-registers delivery: a resized
  // creative under-records CLICKS (row loses clicks), or a master+companion double-registration
  // sums the same serves twice (row doubles impressions). The delivery report, broken out per
  // (line item, rendered creative), keeps the true clicks and counts each serve once. We correct
  // ONLY this row's own creatives (never a whole line item — a line item can also serve other
  // creatives, so its total would over-count), and only in the SAFE direction:
  //   - a creative the fingerprint locked to a rendered creative → recover with max(LICA, report),
  //     which fixes under-recorded clicks/impressions but never reduces (avoids under-counting a
  //     creative that rendered as several ids where only one locked);
  //   - a creative that NEVER locked yet every line item it ran on had OTHER creatives lock → it is
  //     a double-registration (phantom master/companion); drop it;
  //   - otherwise → keep LICA. Rows with no report data are untouched (LICA), as before.
  const creativeContribution = (cid, g) => {
    const st = statsByCreativeId[cid] || { impressions: 0, clicks: 0 };
    const rbl = renderedByTemplate[cid] || {};
    const lockedLIs = Object.keys(rbl);
    if (!lockedLIs.length) {
      const liIds = [...(lineItemsByCreativeId[cid] || [])];
      const phantom = liIds.length > 0 && liIds.every(li => g.reportCidsByLI[li] && g.reportCidsByLI[li].size);
      return phantom ? { impressions: 0, clicks: 0, source: 'phantom' }
                     : { impressions: st.impressions || 0, clicks: st.clicks || 0, source: 'lica' };
    }
    let ri = 0, rc = 0;
    for (const li of lockedLIs) { const r = reportByLIAndCreative[li]?.[rbl[li]]; if (r) { ri += r.totalImps || 0; rc += r.totalClicks || 0; } }
    const imps = Math.max(st.impressions || 0, ri), clicks = Math.max(st.clicks || 0, rc);
    return { impressions: imps, clicks, source: (ri > (st.impressions || 0) || rc > (st.clicks || 0)) ? 'report' : 'lica' };
  };

  let reconciled = 0;
  if (Object.keys(reportByLIAndCreative).length) {
    for (const g of Object.values(grouped)) {
      let repImps = 0, repClicks = 0, corrected = false;
      for (const cid of g.creativeIds) {
        const c = creativeContribution(cid, g);
        repImps += c.impressions; repClicks += c.clicks;
        if (c.source !== 'lica') corrected = true;
      }
      if (corrected && (repImps !== g.impressions || repClicks !== g.clicks)) {
        g.licaImpressions = g.impressions; g.licaClicks = g.clicks; // keep originals for reference
        g.impressions = repImps; g.clicks = repClicks;
        g.statsSource = 'report';
        reconciled++;
        console.log(`[reconcile] ${g.netlifyUrl}${g.videoId ? ' vid=' + g.videoId : ''} ${g.isMobile ? 'mob' : 'dsk'}: LICA ${g.licaImpressions}/${g.licaClicks} → ${repImps}/${repClicks}`);
      }
    }
  }
  console.log(`Reconciled ${reconciled} row(s) per-creative to report totals`);

  // Single-line-item version of the row-level rollup just below — used to give each split-view
  // row (one line item) its own live/complete status, instead of inheriting whatever the busiest
  // sibling creative on the same row happens to be doing.
  const liStatusFor = lid => {
    const raw = statusByLI[lid];
    return raw === 'DELIVERING' ? 'delivering'
         : raw === 'READY'      ? 'ready'
         : raw === 'PAUSED'     ? 'paused'
         : raw === 'INACTIVE'   ? 'inactive'
         : null;
  };

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

  // Per-creative split detail for the drill-down modal — keyed by the same composite group
  // key. One entry per contributing creative: its name + EXACT per-creative impressions,
  // clicks and CTR (from LICA), plus the line items it ran on. viewability, completionRate
  // and keyValues are left null/empty here and filled in later by scripts/refresh.js from
  // the active-view, video-stats and custom-targeting pipelines (best-effort).
  const urlSplitsMap = {};
  const nowTs = Date.now();
  for (const { creative, netlifyUrl, videoId, isMobile } of netlifyCreatives) {
    let baseUrl;
    try { const u = new URL(netlifyUrl.trim()); baseUrl = `${u.protocol}//${u.host}/`; } catch(e) { baseUrl = netlifyUrl.trim(); }
    const id = creative.id?.[0];
    if (!id || !baseUrl) continue;
    const s = statsByCreativeId[id];
    let imps = s?.impressions > 0 ? s.impressions : 0;
    let clk  = s?.clicks      > 0 ? s.clicks      : 0;
    if (imps <= 0 && clk <= 0) continue; // only creatives that actually delivered (per LICA)
    const device = isMobile ? (videoId ? 'video-mobile' : 'mobile') : (videoId ? 'video' : 'desktop');
    const key = `${baseUrl}##${videoId || ''}##${device}`;
    if (!urlSplitsMap[key]) urlSplitsMap[key] = [];
    if (urlSplitsMap[key].some(e => e.creativeId === id)) continue; // guard duplicate creative
    const liIds = [...(lineItemsByCreativeId[id] || [])];
    // Reconcile this creative the SAME way as the row total (max-recover locked, drop phantom double).
    const grpKey = videoId ? `${baseUrl}##${videoId}##${isMobile ? 'm' : 'd'}` : `${baseUrl}##${isMobile ? 'm' : 'd'}`;
    const grp = grouped[grpKey];
    const contrib = grp ? creativeContribution(id, grp) : { impressions: imps, clicks: clk, source: 'lica' };
    if (contrib.source === 'phantom') continue; // double-registration — counted via the real creatives
    imps = contrib.impressions; clk = contrib.clicks;
    const name = creative.name?.[0] || null;

    const pushSplit = (rowLiIds, rowImps, rowClicks, cAdUnit) => {
      const kvIds = [...new Set(rowLiIds.flatMap(lid => keyValueIdsByLI[lid] || []))];
      // Same shape/semantics as the row-level impsByAdUnit + adUnitCoverage, just scoped to this
      // one row — lets the split view show exactly where THIS booking delivers, not the row's blend.
      const cAdUnitCoverage = rowImps > 0
        ? Math.min(1, Object.values(cAdUnit).reduce((s, x) => s + (x.impressions || 0), 0) / rowImps)
        : null;
      // A split row is at most one line item (the split-by-line-item logic above guarantees this),
      // so its own start/end/pacing read is exact — not a blend of several bookings' dates.
      const li0 = rowLiIds[0] || null;
      const g0 = li0 ? goalByLI[li0] : null;
      const startDate = li0 ? (startDateByLI[li0] || null) : null;
      const endDate = (g0 && !g0.unlimitedEnd && g0.endTs != null) ? g0.endTs : null;
      urlSplitsMap[key].push({
        creativeId:     id,
        name,
        impressions:    rowImps,
        clicks:         rowClicks,
        ctr:            rowImps && rowClicks ? parseFloat(((rowClicks / rowImps) * 100).toFixed(2)) : null,
        statsSource:    contrib.source,
        viewability:    null,
        viewable:       null,
        measurable:     null,
        completionRate: null,
        lineItemIds:    rowLiIds,
        keyValueIds:    kvIds,   // resolved to { key, value } labels by scripts/refresh.js
        keyValues:      [],
        impsByAdUnit:   cAdUnit,
        adUnitCoverage: cAdUnitCoverage,
        // Only meaningful for a single-line-item row — a blended multi-LI row (the impsPool===0
        // fallback below never reaches this) has no single status to report.
        liveStatus:     rowLiIds.length === 1 ? liStatusFor(rowLiIds[0]) : null,
        startDate,
        endDate,
        delivery:       buildRowDelivery(rowLiIds, goalByLI, statusByLI, startDate || 0, nowTs),
      });
    };

    if (liIds.length <= 1) {
      // Common case (one creative, one booking) — behaviour unchanged from before line-item
      // splitting was added below.
      pushSplit(liIds, imps, clk, creativeAdUnitMap[id] || {});
      continue;
    }

    // This creative is reused across several line items (e.g. a generic "Manual Line" filler
    // booked onto more than one flight) — split its reconciled total across those line items using
    // each one's own LICA/report share, anchored to the trusted creative-level total exactly
    // (scale + residual-to-largest-bucket, the same reconciliation contract the ad-unit fingerprint
    // above uses), so each booking gets its own row, its own line-item link, and its own
    // live/complete status instead of being blended into one figure that can never be flagged stale.
    const rbl = renderedByTemplate[id] || {};
    const shares = liIds.map(li => {
      const rcid = rbl[li];
      const rep = rcid ? reportByLIAndCreative[li]?.[rcid] : null;
      const licaImps   = (impsByCreativeAndLI[id]   || {})[li] || 0;
      const licaClicks = (clicksByCreativeAndLI[id] || {})[li] || 0;
      return {
        li,
        imps:   rep ? Math.max(licaImps, rep.totalImps || 0)     : licaImps,
        clicks: rep ? Math.max(licaClicks, rep.totalClicks || 0) : licaClicks,
        adUnit: (creativeLiAdUnitMap[id] || {})[li] || {},
      };
    });
    const impsPool = shares.reduce((a, x) => a + x.imps, 0);
    const clicksPool = shares.reduce((a, x) => a + x.clicks, 0);
    const perLi = shares.map(x => ({
      li: x.li,
      imps:   impsPool   > 0 ? Math.round(x.imps   * (imps / impsPool))   : 0,
      clicks: clicksPool > 0 ? Math.round(x.clicks * (clk  / clicksPool)) : 0,
      adUnit: x.adUnit,
    }));
    if (impsPool > 0) {
      const resid = imps - perLi.reduce((a, x) => a + x.imps, 0);
      if (resid !== 0) perLi.reduce((mx, x) => (x.imps > mx.imps ? x : mx), perLi[0]).imps += resid;
    } else {
      perLi[0].imps = imps; // no per-LI delivery signal at all — credit it to the first line item
    }
    if (clicksPool > 0) {
      const resid = clk - perLi.reduce((a, x) => a + x.clicks, 0);
      if (resid !== 0) perLi.reduce((mx, x) => (x.clicks > mx.clicks ? x : mx), perLi[0]).clicks += resid;
    } else {
      perLi[0].clicks = clk;
    }
    for (const row of perLi) pushSplit([row.li], row.imps, row.clicks, row.adUnit);
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
  const now = Date.now();
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
        // Earliest start / farthest end across the row's line items — the outer view's own dates
        // (the split view shows each line item's own, exact dates instead — see urlSplitsMap above).
        startDate:            r.firstStartDate || null,
        endDate:              r.lastEndDate ?? null,
        // Booked-goal / pacing read (GAM's own actual-vs-expected delivery %, worst LI wins).
        delivery:             buildRowDelivery([...r.lineItemIds], goalByLI, statusByLI, r.firstStartDate || 0, now),
        sortKey:              r.firstStartDate || 0,
      };
    });

  return { results, urlLineItemMap, urlCreativeMap, urlLicaImpsMap, videoIdMap, urlSplitsMap };
}

const DAY_MS = 86400000;

/**
 * Aggregates a set of line items into one delivery/pacing read. `paceCushion` is GAM's own
 * actual-vs-expected delivery ratio (deliveryIndicator's actualPct ÷ expectedPct, no date math of
 * ours) — 1.0 is exactly on plan, below 1.0 is behind, above is ahead; the worst (lowest) line item
 * wins so one lagging booking can't be hidden by others pacing fine. `requiredRetainFrac`/`reqRate`/
 * `supplyRate` are a second, date-aware read (the fraction of current delivery you'd need to KEEP to
 * still hit the booked goal by flight end) used elsewhere for the underdelivery guardrail — kept
 * here too so both reads stay available from the one call. Null fields mean "not computable" (no
 * goal, open-ended, unknown start), not "zero".
 */
function buildRowDelivery(lineItemIds, goalByLI, statusByLI, firstStartDate, now) {
  let goalUnits = 0, delivered = 0, remaining = 0, reqRate = 0;
  let hasGoal = false, openEnded = false, behind = false, sponsorship = false;
  let liCount = 0, liveCount = 0, completedCount = 0;
  let paceCushion = null, endTs = null;
  for (const li of lineItemIds) {
    const g = goalByLI[li];
    if (!g) continue;
    liCount++;
    const status = statusByLI[li];
    if (status === 'COMPLETED') completedCount++;
    // SPONSORSHIP goals are a % of inventory (units=100 = 100%), not an impression count — they
    // don't carry an impression underdelivery risk, so they're never a live obligation here.
    if (g.lineItemType === 'SPONSORSHIP') { sponsorship = true; continue; }
    const hasImpGoal = g.unitType === 'IMPRESSIONS' && g.units > 0 && g.goalType && g.goalType !== 'NONE';
    if (!hasImpGoal) continue;
    // GAM's own pace signal (no date math): actual vs expected delivery %.
    if (isFinite(g.expectedPct) && g.expectedPct > 0 && isFinite(g.actualPct)) {
      const c = g.actualPct / g.expectedPct;
      paceCushion = paceCushion == null ? c : Math.min(paceCushion, c);
      if (c < 0.95) behind = true;
    }
    // A LIVE obligation = currently delivering with a still-open flight. Ended/paused/ready or
    // past-end line items carry no forward pacing question (a past flight can't be "made" to
    // deliver), so they never inflate reqRate — that would produce a bogus "behind" verdict.
    const futureEnd = g.unlimitedEnd || g.endTs == null || g.endTs > now;
    if (status !== 'DELIVERING' || !futureEnd) continue;
    liveCount++;
    hasGoal = true;
    goalUnits += g.units;
    delivered += g.impressionsDelivered;
    const rem = Math.max(0, g.units - g.impressionsDelivered);
    remaining += rem;
    if (g.unlimitedEnd || g.endTs == null) {
      openEnded = true;
    } else {
      const days = Math.max(1, Math.ceil((g.endTs - now) / DAY_MS));
      reqRate += rem / days;
      if (endTs == null || g.endTs < endTs) endTs = g.endTs;
    }
  }
  const elapsedDays = firstStartDate > 0 ? Math.max(1, Math.min(1094, (now - firstStartDate) / DAY_MS)) : null;
  // Historical delivery rate at full targeting — a proxy for available supply, not a forecast.
  const supplyRate = (hasGoal && delivered > 0 && elapsedDays) ? delivered / elapsedDays : null;
  const requiredRetainFrac = (supplyRate && reqRate > 0) ? reqRate / supplyRate : null;
  return {
    hasGoal, goalUnits, delivered, remaining,
    reqRate: reqRate || null, supplyRate, requiredRetainFrac, elapsedDays,
    endTs, openEnded, behind, sponsorship, paceCushion,
    liCount, liveCount, completed: liCount > 0 && liveCount === 0 && completedCount > 0,
  };
}

module.exports = { fetchDashboardData };
