'use strict';

/*
 * Pure video-stats logic extracted from routes/video-stats.js.
 * No fs, no Express — accepts allVideoIds and returns the stats map directly.
 */

const { fetchVideoLineItemsByVideoIds, fetchVideoCompletionByCreativeId, fetchVideoCompletionByLineItem } = require('./gam-video');

async function fetchVideoStats(allVideoIds, networkCode, token) {
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

    const entry = {};
    let completionRate = null;
    let videoStarts = null;

    if (data.licaStarts > 0) {
      completionRate = parseFloat(((data.licaCompletes / data.licaStarts) * 100).toFixed(1));
      videoStarts = data.licaStarts;
    }

    if (completionRate == null && data.trackingCreativeId && completionByCreativeId[data.trackingCreativeId] != null) {
      const c = completionByCreativeId[data.trackingCreativeId];
      completionRate = c.rate;
      videoStarts = c.starts;
    }

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

    if (completionRate == null && data.trackingCreativeName) {
      for (const liId of (data.lineItemIds || [])) {
        const liData = completionByLineItem[liId];
        if (!liData) continue;
        for (const [, cData] of Object.entries(liData.byCreative)) {
          if (cData.name === data.trackingCreativeName) {
            completionRate = cData.rate;
            videoStarts = cData.starts;
            break;
          }
        }
        if (completionRate != null) break;
      }
    }

    if (completionRate == null) {
      for (const liId of (data.lineItemIds || [])) {
        const liData = completionByLineItem[liId];
        if (liData && liVideoIdCount[liId] === 1 && liData.aggregate != null) {
          completionRate = liData.aggregate;
          videoStarts = liData.totStarts;
          break;
        }
      }
    }

    if (completionRate != null) entry.completionRate = completionRate;
    if (videoStarts != null) entry.videoStarts = videoStarts;
    if (data.durationMs > 0) entry.durationSec = Math.round(data.durationMs / 1000);

    if (Object.keys(entry).length) videoStatsByVideoId[vid] = entry;
  }

  console.log(`Video stats mapped: ${Object.keys(videoStatsByVideoId).length}/${allVideoIds.length} video IDs have data`);
  return videoStatsByVideoId;
}

module.exports = { fetchVideoStats };
