'use strict';

/*
 * Screenshot route — captures a PNG of a Netlify creative URL using Puppeteer
 * and caches it to disk. Serves the cached file on subsequent requests for the same URL,
 * so Puppeteer is only launched once per creative.
 *
 * Supports desktop and mobile viewports via the ?device= query parameter:
 *   desktop (default) — 1920×1080 viewport, clip 1920×800, no scroll
 *   mobile / video-mobile — 390×844 viewport (deviceScaleFactor 2), detects #im-is-base-container via
 *     outer page → iframe frames → iframe-bottom fallback, clips 390×600 centred on creative
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

  // User-uploaded screenshots live here — never wiped when clearing Puppeteer cache
  const UPLOAD_DIR = path.join(SCREENSHOT_DIR, 'uploads');
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

    // User uploads take priority — serve without running Puppeteer
    const uploadPath = path.join(UPLOAD_DIR, `${hash}.png`);
    if (fs.existsSync(uploadPath)) return res.sendFile(uploadPath);

    // Serve the Puppeteer-generated cache if it exists
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
      // Block video/audio so media never loads — faster networkidle2 and banner shows
      // its static state rather than a mid-play video frame.
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (req.resourceType() === 'media') req.abort();
        else req.continue();
      });

      await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2500));

      const clipWidth  = isMobile ? 390 : 1920;
      const clipY      = isMobile ? 720 : 0;
      const clipHeight = isMobile ? 124 : 800;

      await page.screenshot({ path: imgPath, clip: { x: 0, y: clipY, width: clipWidth, height: clipHeight } });

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

  // Accepts a raw image body (PNG or JPEG) and saves it into the uploads/ subdirectory.
  // Uploads are served in preference to Puppeteer-generated screenshots and are never
  // deleted when the Puppeteer cache is cleared.
  router.post('/api/screenshot/upload', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
    const rawUrl = req.query.url ? decodeURIComponent(req.query.url) : '';
    if (!rawUrl || !rawUrl.includes('netlify.app')) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    const baseUrl = rawUrl.match(/https?:\/\/[^\s]+?\.netlify\.app\//)?.[0] || rawUrl;
    const device  = req.query.device || 'desktop';
    const hash    = crypto.createHash('md5').update(baseUrl + '|' + device).digest('hex');
    const imgPath = path.join(UPLOAD_DIR, `${hash}.png`);
    try {
      fs.writeFileSync(imgPath, req.body);
      const txtPath = path.join(SCREENSHOT_DIR, `${hash}.txt`);
      if (!fs.existsSync(txtPath)) fs.writeFileSync(txtPath, slugToName(baseUrl));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
