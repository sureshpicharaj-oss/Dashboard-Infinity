'use strict';

/*
 * Video stats route — returns completion rate and video duration for every VIDEO_ID
 * seen in the current dashboard data. Requires the dashboard to have been loaded first
 * (which writes url_videoid_cache.json). Results are cached for 6 hours because the
 * underlying GAM report job takes significant time to run.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getToken } = require('../lib/auth');
const { fetchVideoLineItemsByVideoIds, fetchVideoCompletionByCreativeId, fetchVideoCompletionByLineItem } = require('../lib/gam-video');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {

  /* Returns a map of { videoId: { completionRate, durationSec } } for all known VIDEO_IDs.
   * Requires url_videoid_cache.json to exist (written by /api/dashboard on each refresh).
   * Serves a cached response if the cache file is under 6 hours old, avoiding repeated
   * report jobs.
   *
   * Per-VIDEO_ID rate resolution (in order):
   *  1. trackingCreativeId (mapped via LICA targetingName → key-value slot) found in the
   *     LINE_ITEM_ID+CREATIVE_ID report → use that creative's rate directly.
   *  2. Historic LICA lookup: old tracking creative IDs from the report are matched back to
   *     VIDEO_IDs via their LICA targetingName → slot name → key-value match.
   *  3. If neither yields a match → no completionRate for that VIDEO_ID (never aggregate). */
  router.get('/api/video-stats', async (req, res) => {
    const videoIdCachePath = path.join(SCREENSHOT_DIR, 'url_videoid_cache.json');
    if (!fs.existsSync(videoIdCachePath)) {
      return res.status(503).json({ error: 'Load dashboard first to generate video ID data' });
    }

    const vsCachePath = path.join(SCREENSHOT_DIR, 'video_stats_cache.json');
    if (fs.existsSync(vsCachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(vsCachePath, 'utf8'));
        // 6-hour TTL: GAM report jobs are slow, so caching avoids redundant runs
        if (cached._ts && Date.now() - cached._ts < 6 * 60 * 60 * 1000) {
          const { _ts, ...data } = cached;
          return res.json(data);
        }
      } catch(e) {}
    }

    try {
      const raw = JSON.parse(fs.readFileSync(videoIdCachePath, 'utf8'));
      // Support both old flat-array format and new { videoId: netlifyUrl } map
      const allVideoIds = Array.isArray(raw) ? [...new Set(raw)] : [...new Set(Object.keys(raw))];

      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;

      // Step 1: Find flix tracking line items by VIDEO_ID custom targeting value.
      // Returns videoIdToData (lineItemIds, durationMs, trackingCreativeId, creativeTargetingName)
      // and valueIdToVideoId (GAM custom targeting value ID → VIDEO_ID string).
      const { videoIdToData, valueIdToVideoId } = await fetchVideoLineItemsByVideoIds(allVideoIds, networkCode, token);
      const allVideoLineItemIds = [...new Set(Object.values(videoIdToData).flatMap(d => d.lineItemIds || []))];

      if (!allVideoLineItemIds.length) {
        return res.json({});
      }

      // Step 2: Query by CREATIVE_ID for all VIDEO_IDs.
      // Includes both trackingCreativeId (current, from LICA targetingName match) and
      // additionalCreativeIds (older creatives found by searching GAM for the same creative name —
      // the name is the bridge: LICA → current creative name → search → old creative IDs with data).
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

      // Step 3: LINE_ITEM+CREATIVE_NAME report — the reporting data store preserves creative names
      // even for deleted creatives, so we can match old tracking creatives back to VIDEO_IDs.
      const completionByLineItem = await fetchVideoCompletionByLineItem(allVideoLineItemIds, networkCode, token);

      // Build liId+creativeName → videoId using the trackingCreativeName we stored per VIDEO_ID.
      // e.g. line item 7247789189, name "30 sec_Skin" → "HBO_Skin_30"
      // This covers both cases: name matches VIDEO_ID (Sky) and name doesn't (HBO slots).
      const liNameToVideoId = {};
      for (const [vid, data] of Object.entries(videoIdToData)) {
        if (data.trackingCreativeName) {
          for (const liId of (data.lineItemIds || [])) {
            liNameToVideoId[`${liId}::${data.trackingCreativeName}`] = vid;
          }
        }
      }

      // Build a line item → VIDEO_ID count index for aggregate fallback decisions.
      const liVideoIdCount = {};
      for (const data of Object.values(videoIdToData)) {
        for (const liId of (data.lineItemIds || [])) {
          liVideoIdCount[liId] = (liVideoIdCount[liId] || 0) + 1;
        }
      }

      // Step 4: Build per-VIDEO_ID completion rates.
      // Resolution order:
      //  1. LICA stats (videoStartsDelivered / videoCompletionsDelivered on the LICA object)
      //  2. trackingCreativeId in the CREATIVE_ID report
      //  3. additionalCreativeIds in the CREATIVE_ID report (older tracking creatives, same name)
      //  4. LINE_ITEM+CREATIVE_NAME report — match by lineItemId + creative name
      //  5. LINE_ITEM aggregate — only when the line item serves exactly one VIDEO_ID
      const videoStatsByVideoId = {};
      for (const vid of allVideoIds) {
        const data = videoIdToData[vid];
        if (!data) continue;

        const entry = {};
        let completionRate = null;
        let videoStarts = null;

        // 1. LICA stats
        if (data.licaStarts > 0) {
          completionRate = parseFloat(((data.licaCompletes / data.licaStarts) * 100).toFixed(1));
          videoStarts = data.licaStarts;
        }

        // 2. Current tracking creative
        if (completionRate == null && data.trackingCreativeId && completionByCreativeId[data.trackingCreativeId] != null) {
          const c = completionByCreativeId[data.trackingCreativeId];
          completionRate = c.rate;
          videoStarts = c.starts;
        }

        // 3. Older creatives found via name-based search in CreativeService
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

        // 4. LINE_ITEM+CREATIVE_NAME report: find a row on any of this VIDEO_ID's line items
        // whose creative name matches the name we know from the LICA-matched tracking creative.
        if (completionRate == null && data.trackingCreativeName) {
          for (const liId of (data.lineItemIds || [])) {
            const liData = completionByLineItem[liId];
            if (!liData) continue;
            for (const [cId, cData] of Object.entries(liData.byCreative)) {
              if (cData.name === data.trackingCreativeName) {
                completionRate = cData.rate;
                videoStarts = cData.starts;
                break;
              }
            }
            if (completionRate != null) break;
          }
        }

        // 5. LINE_ITEM aggregate — only when one VIDEO_ID maps to this line item
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

      const toCache = { ...videoStatsByVideoId, _ts: Date.now() };
      fs.writeFileSync(vsCachePath, JSON.stringify(toCache));
      res.json(videoStatsByVideoId);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
