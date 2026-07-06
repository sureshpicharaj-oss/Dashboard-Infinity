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
const { fetchVideoLineItemsByVideoIds, fetchVideoCompletionByLineItem } = require('../lib/gam-video');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {

  /* Returns a map of { videoId: { completionRate, durationSec } } for all known VIDEO_IDs.
   * Requires url_videoid_cache.json to exist (written by /api/dashboard on each refresh).
   * Serves a cached response if the cache file is under 6 hours old, avoiding repeated
   * report jobs. VIDEO_IDs are matched to dedicated video-hosting line items via the
   * VIDEO_ID custom targeting key, not by creative name or order. */
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

      // Find dedicated video-hosting line items by VIDEO_ID (global custom targeting search)
      const videoIdToData = await fetchVideoLineItemsByVideoIds(allVideoIds, networkCode, token);
      const allVideoLineItemIds = [...new Set(Object.values(videoIdToData).flatMap(d => d.lineItemIds || []))];

      let completionByLineItem = {};
      if (allVideoLineItemIds.length) {
        completionByLineItem = await fetchVideoCompletionByLineItem(allVideoLineItemIds, networkCode, token);
      }

      // Map VIDEO_ID → { completionRate, durationSec }
      // Average completion rate across all line items for this VIDEO_ID (there may be more than one)
      const videoStatsByVideoId = {};
      for (const vid of allVideoIds) {
        const data = videoIdToData[vid];
        const entry = {};
        if (data) {
          const rates = (data.lineItemIds || []).map(liId => completionByLineItem[liId]).filter(r => r != null);
          if (rates.length) entry.completionRate = parseFloat((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1));
          if (data.durationMs > 0) entry.durationSec = Math.round(data.durationMs / 1000);
        }
        if (Object.keys(entry).length) videoStatsByVideoId[vid] = entry;
      }

      console.log(`Video stats mapped: ${Object.keys(videoStatsByVideoId).length}/${allVideoIds.length} video IDs have completion data`);

      const toCache = { ...videoStatsByVideoId, _ts: Date.now() };
      fs.writeFileSync(vsCachePath, JSON.stringify(toCache));
      res.json(videoStatsByVideoId);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
