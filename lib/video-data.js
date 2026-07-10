'use strict';

const { fetchVideoLineItemsByVideoIds, fetchVideoCompletionByCreativeId, fetchVideoCompletionByLineItem } = require('./gam-video');

const GAM_DEVICE = { 'video': 'Desktop', 'video-mobile': 'Smartphone' };

async function fetchVideoStats(videoIdMap, networkCode, token) {
  const allVideoIds = Object.keys(videoIdMap);
  if (!allVideoIds.length) return {};

  const { videoIdToData } = await fetchVideoLineItemsByVideoIds(allVideoIds, networkCode, token);
  const allVideoLineItemIds = [...new Set(Object.values(videoIdToData).flatMap(d => d.lineItemIds || []))];

  if (!allVideoLineItemIds.length) return {};

  const allCreativeIdsToQuery = [...new Set(
    Object.values(videoIdToData).flatMap(d => [
      d.trackingCreativeId,
      ...(d.additionalCreativeIds || [])
    ]).filter(Boolean)
  )];
  let completionByCreativeId = {};
  if (allCreativeIdsToQuery.length) {
    completionByCreativeId = await fetchVideoCompletionByCreativeId(allCreativeIdsToQuery, networkCode, token);
  }

  const completionByLineItem = await fetchVideoCompletionByLineItem(allVideoLineItemIds, networkCode, token);

  const liVideoIdCount = {};
  for (const data of Object.values(videoIdToData)) {
    for (const liId of (data.lineItemIds || [])) {
      liVideoIdCount[liId] = (liVideoIdCount[liId] || 0) + 1;
    }
  }

  const videoStatsByVideoId = {};

  for (const vid of allVideoIds) {
    const data = videoIdToData[vid];
    if (!data) continue;

    const rowDevices = (videoIdMap[vid] || []).map(r => r.device).filter(Boolean);
    const isMultiDevice = rowDevices.length > 1;
    const deviceList = isMultiDevice ? rowDevices : [null];

    for (const device of deviceList) {
      // For single-device videoIds device is null; use the one known device for creative lookups only
      const actualDevice = device || (rowDevices.length === 1 ? rowDevices[0] : null);
      const gamDevice   = actualDevice ? (GAM_DEVICE[actualDevice] || null) : null;
      const liGamDevice = isMultiDevice ? gamDevice : null;
      const outputKey = isMultiDevice ? vid + '_' + device : vid;

      const entry = {};
      let completionRate = null;
      let videoStarts = null;

      // Step 1: LICA starts/completes
      if (data.licaStarts > 0) {
        completionRate = parseFloat(((data.licaCompletes / data.licaStarts) * 100).toFixed(1));
        videoStarts = data.licaStarts;
      }

      // Step 2: trackingCreativeId (aggregate rate across all line items)
      if (completionRate == null && data.trackingCreativeId && completionByCreativeId[data.trackingCreativeId] != null) {
        const c = completionByCreativeId[data.trackingCreativeId];
        completionRate = c.rate;
        videoStarts = c.starts;
      }

      // Step 2b: device-specific rate from line item — sum starts/completes for all creatives
      // sharing trackingCreativeName in this line item.
      // Note: the video viewership report uses different creative IDs than the LICA/SOAP API
      // (e.g. 740... vs 138... series), so name matching is the only reliable link.
      // Runs independently of step 2 (completionByCreativeId often returns 0 rows for
      // tracking-pixel creatives like Apple 1x1v).
      if (gamDevice && data.trackingCreativeName) {
        for (const liId of (data.lineItemIds || [])) {
          const liData = completionByLineItem[liId];
          if (!liData) continue;
          let totStarts = 0, totCompletes = 0;
          for (const cData of Object.values(liData.byCreative || {})) {
            if (cData.name !== data.trackingCreativeName) continue;
            const dv = cData.byDevice?.[gamDevice];
            if (dv) { totStarts += dv.starts; totCompletes += dv.completes; }
          }
          if (totStarts > 0) {
            completionRate = parseFloat(((totCompletes / totStarts) * 100).toFixed(1));
            videoStarts = totStarts;
            break;
          }
        }
      }

      // Step 3: additionalCreativeIds
      if (completionRate == null) {
        for (const cId of (data.additionalCreativeIds || [])) {
          if (completionByCreativeId[cId] != null) {
            const c = completionByCreativeId[cId];
            completionRate = c.rate;
            videoStarts = c.starts;
            break;
          }
        }
      }

      // Step 4: name-bridge
      if (completionRate == null && data.trackingCreativeName) {
        for (const liId of (data.lineItemIds || [])) {
          const liData = completionByLineItem[liId];
          if (!liData) continue;
          for (const [, cData] of Object.entries(liData.byCreative)) {
            if (cData.name === data.trackingCreativeName) {
              const dv = gamDevice && cData.byDevice?.[gamDevice];
              if (dv && dv.starts > 0) {
                completionRate = parseFloat(((dv.completes / dv.starts) * 100).toFixed(1));
                videoStarts = dv.starts;
              } else {
                completionRate = cData.rate;
                videoStarts = cData.starts;
              }
              break;
            }
          }
          if (completionRate != null) break;
        }
      }

      // Step 5: line item aggregate
      if (completionRate == null) {
        for (const liId of (data.lineItemIds || [])) {
          const liData = completionByLineItem[liId];
          if (!liData) continue;
          // For multi-device: use device-specific aggregate
          const dv = liGamDevice && liData.byDevice?.[liGamDevice];
          if (dv && dv.totStarts > 0) {
            completionRate = parseFloat(((dv.totCompletes / dv.totStarts) * 100).toFixed(1));
            videoStarts = dv.totStarts;
            break;
          } else if (liVideoIdCount[liId] === 1 && liData.aggregate != null) {
            completionRate = liData.aggregate;
            videoStarts = liData.totStarts;
            break;
          }
        }
      }

      if (completionRate != null) entry.completionRate = completionRate;
      if (videoStarts != null) entry.videoStarts = videoStarts;
      if (data.durationMs > 0) entry.durationSec = Math.round(data.durationMs / 1000);

      if (Object.keys(entry).length) videoStatsByVideoId[outputKey] = entry;
    }
  }

  console.log(`Video stats mapped: ${Object.keys(videoStatsByVideoId).length} keys for ${allVideoIds.length} video IDs`);
  return videoStatsByVideoId;
}

module.exports = { fetchVideoStats };
