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

      // Step 2b: device-specific rate from line item — only when trackingCreativeName
      // matches EXACTLY ONE creative in the line item. Two videos sharing a generic
      // tracking-creative name (e.g. "Apple - 1x1v - ...") would otherwise have their
      // events summed together into one blended rate for both. Never overrides an
      // already-correct step-1 LICA rate (completionRate == null guard).
      // Note: the video viewership report uses different creative IDs than the LICA/SOAP API
      // (e.g. 740... vs 138... series), so name matching is the only reliable link.
      // Runs independently of step 2 (completionByCreativeId often returns 0 rows for
      // tracking-pixel creatives like Apple 1x1v).
      if (completionRate == null && gamDevice && data.trackingCreativeName) {
        for (const liId of (data.lineItemIds || [])) {
          const liData = completionByLineItem[liId];
          if (!liData) continue;
          const matches = Object.values(liData.byCreative || {}).filter(cData => cData.name === data.trackingCreativeName);
          if (matches.length !== 1) continue; // no match, or ambiguous — skip rather than blend
          const dv = matches[0].byDevice?.[gamDevice];
          if (dv && dv.starts > 0) {
            completionRate = parseFloat(((dv.completes / dv.starts) * 100).toFixed(1));
            videoStarts = dv.starts;
            break;
          }
        }
      }

      // Step 3: additionalCreativeIds — sum starts/completes across every match with data
      // (older tracking creatives sharing the same name, e.g. desktop+mobile variants),
      // rather than taking only the first one found.
      if (completionRate == null) {
        let totStarts = 0, totCompletes = 0;
        for (const cId of (data.additionalCreativeIds || [])) {
          const c = completionByCreativeId[cId];
          if (c != null) { totStarts += c.starts; totCompletes += c.completes || 0; }
        }
        if (totStarts > 0) {
          completionRate = parseFloat(((totCompletes / totStarts) * 100).toFixed(1));
          videoStarts = totStarts;
        }
      }

      // Step 4: name-bridge. For a device-labeled (multi-device) row, only accept the
      // device-specific slice — falling back to the creative's all-device rate would show
      // e.g. a desktop-dominated rate on a mobile row.
      if (completionRate == null && data.trackingCreativeName) {
        for (const liId of (data.lineItemIds || [])) {
          const liData = completionByLineItem[liId];
          if (!liData) continue;
          for (const [, cData] of Object.entries(liData.byCreative)) {
            if (cData.name === data.trackingCreativeName) {
              if (gamDevice) {
                const dv = cData.byDevice?.[gamDevice];
                if (dv && dv.starts > 0) {
                  completionRate = parseFloat(((dv.completes / dv.starts) * 100).toFixed(1));
                  videoStarts = dv.starts;
                }
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

      // Step 5: line item aggregate. Skip line items hosting more than one VIDEO_ID entirely
      // — there's no way to tell which video the aggregate (or even the device split)
      // actually belongs to, so blending them would silently double-count/misattribute.
      if (completionRate == null) {
        for (const liId of (data.lineItemIds || [])) {
          const liData = completionByLineItem[liId];
          if (!liData) continue;
          if (liVideoIdCount[liId] !== 1) continue;
          // For multi-device: use device-specific aggregate
          const dv = liGamDevice && liData.byDevice?.[liGamDevice];
          if (dv && dv.totStarts > 0) {
            completionRate = parseFloat(((dv.totCompletes / dv.totStarts) * 100).toFixed(1));
            videoStarts = dv.totStarts;
            break;
          } else if (liData.aggregate != null) {
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
