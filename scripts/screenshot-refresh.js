'use strict';

/*
 * Screenshot refresh script — run by GitHub Actions after the daily GAM data refresh.
 * Reads all Netlify creative URLs from the dashboard cache, takes Puppeteer screenshots
 * (desktop + mobile matching the same viewport/clip as the local server), and uploads
 * each to Netlify Blobs via the /api/screenshot/upload endpoint.
 *
 * Usage: node scripts/screenshot-refresh.js
 * Env vars required: NETLIFY_SITE_URL  (e.g. https://your-site.netlify.app)
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const NETLIFY_SITE_URL = process.env.NETLIFY_SITE_URL;
if (!NETLIFY_SITE_URL) {
  console.log('NETLIFY_SITE_URL not set — skipping screenshot refresh');
  process.exit(0);
}

const cacheFile = path.join(__dirname, '../public/data/dashboard_cache.json');
if (!fs.existsSync(cacheFile)) {
  console.log('No dashboard cache found — skipping screenshot refresh');
  process.exit(0);
}

const { results = [] } = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

// Strip URL to base origin (same logic as routes/screenshot.js)
function toBaseUrl(rawUrl) {
  return rawUrl.match(/https?:\/\/[^\s]+?\.netlify\.app\//)?.[0] || rawUrl;
}

// Deduplicate by stripped base URL + device
const seen    = new Set();
const targets = [];
for (const row of results) {
  if (!row.netlifyUrl) continue;
  const baseUrl = toBaseUrl(row.netlifyUrl);
  const device  = row.device || 'desktop';
  const key     = `${baseUrl}|${device}`;
  if (seen.has(key)) continue;
  seen.add(key);
  targets.push({ baseUrl, device });
}

console.log(`Found ${targets.length} unique URL/device combinations`);
if (!targets.length) process.exit(0);

const puppeteer = require('puppeteer');

async function takeScreenshot(browser, baseUrl, device) {
  const isMobile = device === 'mobile' || device === 'video-mobile';
  const page = await browser.newPage();
  try {
    if (isMobile) {
      await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
    } else {
      await page.setViewport({ width: 1920, height: 1080 });
    }
    // Block media so banners show their static state (faster networkidle2 too)
    await page.setRequestInterception(true);
    page.on('request', r => {
      if (r.resourceType() === 'media') r.abort();
      else r.continue();
    });
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));
    const clipWidth  = isMobile ? 390 : 1920;
    const clipY      = isMobile ? 720 : 0;
    const clipHeight = isMobile ? 124 : 800;
    return await page.screenshot({ clip: { x: 0, y: clipY, width: clipWidth, height: clipHeight } });
  } finally {
    await page.close();
  }
}

async function uploadScreenshot(baseUrl, device, buffer) {
  const url = `${NETLIFY_SITE_URL}/api/screenshot/upload?url=${encodeURIComponent(baseUrl)}&device=${encodeURIComponent(device)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}

async function processTarget(browser, { baseUrl, device }) {
  try {
    const buffer = await takeScreenshot(browser, baseUrl, device);
    await uploadScreenshot(baseUrl, device, buffer);
    console.log(`  ✓  ${baseUrl} (${device})`);
    return true;
  } catch (err) {
    console.error(`  ✗  ${baseUrl} (${device}) — ${err.message}`);
    return false;
  }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let ok = 0, fail = 0;
  try {
    // Run in small batches to avoid overwhelming Puppeteer
    const CONCURRENCY = 3;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch   = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(t => processTarget(browser, t)));
      ok   += results.filter(Boolean).length;
      fail += results.filter(v => !v).length;
    }
  } finally {
    await browser.close();
  }

  console.log(`\nScreenshot refresh complete: ${ok} uploaded, ${fail} failed`);
  if (fail > 0 && ok === 0) process.exit(1);
}

main().catch(err => {
  console.error('Screenshot refresh failed:', err);
  process.exit(1);
});
