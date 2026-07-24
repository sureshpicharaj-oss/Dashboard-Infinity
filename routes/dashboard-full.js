'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getToken } = require('../lib/auth');
const { fetchDashboardData } = require('../lib/dashboard-data');

module.exports = function(SCREENSHOT_DIR) {
  const router = express.Router();

  router.get('/api/dashboard', async (req, res) => {
    try {
      const networkCode = process.env.GAM_NETWORK_CODE;
      if (!networkCode) return res.status(500).json({ error: 'GAM_NETWORK_CODE is not set' });

      const token = await getToken();
      const { results, urlLineItemMap, urlCreativeMap, urlLicaImpsMap, videoIdMap } = await fetchDashboardData(networkCode, token);

      fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_lineitem_cache.json'), JSON.stringify(urlLineItemMap));
      fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_creative_cache.json'), JSON.stringify(urlCreativeMap));
      fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_lica_imps_cache.json'), JSON.stringify(urlLicaImpsMap));
      fs.writeFileSync(path.join(SCREENSHOT_DIR, 'url_videoid_cache.json'), JSON.stringify(videoIdMap));
      try { fs.unlinkSync(path.join(SCREENSHOT_DIR, 'active_view_cache.json')); } catch(e) {}

      let videoStatsByVideoId = {};
      try {
        const vsPath = path.join(SCREENSHOT_DIR, 'video_stats_cache.json');
        if (fs.existsSync(vsPath)) videoStatsByVideoId = JSON.parse(fs.readFileSync(vsPath, 'utf8'));
      } catch(e) {}

      const mergedResults = results.map(r => {
        const vs = r.videoId ? (videoStatsByVideoId[r.videoId + '_' + r.device] ?? videoStatsByVideoId[r.videoId]) : null;
        return { ...r, completionRate: vs?.completionRate ?? null, durationSec: vs?.durationSec ?? null, videoStarts: vs?.videoStarts ?? null };
      });

      res.json({ total: mergedResults.length, lastFetched: new Date().toISOString(), results: mergedResults });
    } catch (err) {
      const message = err.response?.data || err.message;
      console.error('Dashboard error:', message);
      // Classify the failure so the client shows an honest banner: an auth error (expired/
      // revoked token) is genuinely a token problem; a timeout/DNS/connection error is a
      // network issue (e.g. broken IPv6 route) and must NOT be mislabelled as "token expired".
      const gam = err.response?.data;
      const isAuth = !!(gam && (gam.error === 'invalid_grant' || gam.error === 'unauthorized_client'))
                     || /invalid_grant|unauthorized_client/i.test(err.message || '');
      const isNetwork = /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ECONNABORTED|timeout|network/i.test(err.code || err.message || '');
      const reason = isAuth ? 'auth' : isNetwork ? 'network' : 'unknown';
      // Fallback: serve the last committed dashboard_cache.json (written by scripts/refresh.js
      // and refreshed daily by the GitHub Actions workflow) so the dashboard still renders.
      try {
        const cached = JSON.parse(fs.readFileSync(path.join(SCREENSHOT_DIR, 'dashboard_cache.json'), 'utf8'));
        console.warn(`Serving cached dashboard_cache.json as fallback (live GAM fetch failed: ${reason})`);
        return res.json({ ...cached, cached: true, cacheReason: reason, cacheDetail: typeof message === 'string' ? message : JSON.stringify(message) });
      } catch (cacheErr) {
        return res.status(500).json({ error: typeof message === 'string' ? message : JSON.stringify(message) });
      }
    }
  });

  return router;
};
