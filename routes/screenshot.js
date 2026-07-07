'use strict';

/*
 * Screenshot route — captures a PNG of a Netlify creative URL using Puppeteer
 * and caches it to disk. Serves the cached file on subsequent requests for the same URL,
 * so Puppeteer is only launched once per creative.
 *
 * Supports desktop and mobile viewports via the ?device= query parameter:
 *   desktop (default) — 1920×1080 viewport, clip 1920×800, no scroll
 *   mobile / video-mobile — 390×844 viewport (deviceScaleFactor 2), scroll 300px, clip 390×600
 *
 * Cache key is MD5("<baseUrl>|<device>") so desktop and mobile get separate PNGs.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { slugToName } = require('../lib/utils');

const router = express.Router();

module.exports = function(SCREENSHOT_DIR) {

  /* Takes a screenshot of the given Netlify URL and returns the PNG.
   * Accepts ?url=<netlify-url>&device=<desktop|mobile|video-mobile>.
   * Strips any JS file path from the URL — always screenshots the base origin
   * so the full skin is captured, not a blank asset.
   * The companion .txt file stores the derived advertiser name so the advertiser
   * route can read it without re-deriving. */
  router.get('/api/screenshot', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl || !rawUrl.includes('netlify.app')) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    // Always screenshot the base URL, not a JS file path
    const baseUrl = rawUrl.match(/https?:\/\/[^\s]+?\.netlify\.app\//)?.[0] || rawUrl;
    const device = req.query.device || 'desktop';
    const isMobile = device === 'mobile' || device === 'video-mobile';
    // Include device in hash so mobile and desktop get separate cached screenshots
    const hash = crypto.createHash('md5').update(baseUrl + '|' + device).digest('hex');
    const imgPath = path.join(SCREENSHOT_DIR, `${hash}.png`);

    // Serve the cached PNG immediately if it already exists
    if (fs.existsSync(imgPath)) {
      return res.sendFile(imgPath);
    }

    let browser;
    try {
      const puppeteer = require('puppeteer');
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      if (isMobile) {
        await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
      } else {
        await page.setViewport({ width: 1920, height: 1080 });
      }
      await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      if (isMobile) {
        // Scroll to reveal the mobile skin creative then wait for it to load
        await page.evaluate((px) => window.scrollBy(0, px), 300);
      }
      // Wait 2.5 s after networkidle2 so animated skins have time to settle
      await new Promise(r => setTimeout(r, 2500));
      const clipWidth  = isMobile ? 390 : 1920;
      const clipHeight = isMobile ? 600 : 800;
      await page.screenshot({ path: imgPath, clip: { x: 0, y: 0, width: clipWidth, height: clipHeight } });

      const txtPath = imgPath.replace('.png', '.txt');
      if (!fs.existsSync(txtPath)) {
        fs.writeFileSync(txtPath, slugToName(baseUrl));
      }

      res.sendFile(imgPath);
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  return router;
};
