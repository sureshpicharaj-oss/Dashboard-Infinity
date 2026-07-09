'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getToken } = require('../lib/auth');
const { fetchVideoStats } = require('../lib/video-data');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {

  router.get('/api/video-stats', async (req, res) => {
    const videoIdCachePath = path.join(SCREENSHOT_DIR, 'url_videoid_cache.json');
    if (!fs.existsSync(videoIdCachePath)) {
      return res.status(503).json({ error: 'Load dashboard first to generate video ID data' });
    }

    const vsCachePath = path.join(SCREENSHOT_DIR, 'video_stats_cache.json');
    if (fs.existsSync(vsCachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(vsCachePath, 'utf8'));
        if (cached._ts && Date.now() - cached._ts < 6 * 60 * 60 * 1000) {
          const { _ts, ...data } = cached;
          return res.json(data);
        }
      } catch(e) {}
    }

    try {
      const raw = JSON.parse(fs.readFileSync(videoIdCachePath, 'utf8'));
      // Normalise to new format: { [videoId]: [{ device, netlifyUrl }] }
      let videoIdMap;
      if (Array.isArray(raw)) {
        videoIdMap = {};
        for (const vid of [...new Set(raw)]) videoIdMap[vid] = [{ device: 'video' }];
      } else if (Object.keys(raw).length && !Array.isArray(Object.values(raw)[0])) {
        videoIdMap = {};
        for (const [vid, d] of Object.entries(raw)) {
          videoIdMap[vid] = [{ device: d.isMobile ? 'video-mobile' : 'video', netlifyUrl: d.netlifyUrl }];
        }
      } else {
        videoIdMap = raw;
      }

      const token = await getToken();
      const networkCode = process.env.GAM_NETWORK_CODE;

      const videoStatsByVideoId = await fetchVideoStats(videoIdMap, networkCode, token);

      const toCache = { ...videoStatsByVideoId, _ts: Date.now() };
      fs.writeFileSync(vsCachePath, JSON.stringify(toCache));
      res.json(videoStatsByVideoId);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
