'use strict';

/*
 * Screenshot refresh script — run by GitHub Actions after the daily GAM data refresh.
 * Writes screenshots directly to Netlify Blobs using explicit credentials, bypassing
 * the Netlify Function upload endpoint entirely (avoids MissingBlobsEnvironmentError).
 * Skips URLs that already have a screenshot stored. Manual uploads (upload_ prefix)
 * always take read priority over auto-captured ones (bare key).
 *
 * Usage: node scripts/screenshot-refresh.js
 * Env vars required: NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN
 */

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const NETLIFY_SITE_ID    = process.env.NETLIFY_SITE_ID;
const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN;

if (!NETLIFY_SITE_ID || !NETLIFY_AUTH_TOKEN) {
  console.log('NETLIFY_SITE_ID or NETLIFY_AUTH_TOKEN not set — skipping screenshot refresh');
  process.exit(0);
}

const cacheFile = path.join(__dirname, '../public/data/dashboard_cache.json');
if (!fs.existsSync(cacheFile)) {
  console.log('No dashboard cache found — skipping screenshot refresh');
  process.exit(0);
}

const { results = [] } = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

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

const { getStore } = require('@netlify/blobs');
const puppeteer    = require('puppeteer');

// Connect directly to Blobs with explicit credentials — works from any environment
const store = getStore({ name: 'screenshots', siteID: NETLIFY_SITE_ID, token: NETLIFY_AUTH_TOKEN });

function blobKey(baseUrl, device) {
  return crypto.createHash('md5').update(`${baseUrl}|${device}`).digest('hex');
}

async function screenshotExists(baseUrl, device) {
  const hash = blobKey(baseUrl, device);
  // Check manual upload first, then auto-capture
  if ((await store.get('upload_' + hash).catch(() => null)) !== null) return true;
  return (await store.get(hash).catch(() => null)) !== null;
}

async function saveScreenshot(baseUrl, device, buffer) {
  await store.set(blobKey(baseUrl, device), buffer);
}

async function takeScreenshot(browser, baseUrl, device) {
  const isMobile = device === 'mobile' || device === 'video-mobile';
  const page = await browser.newPage();
  try {
    if (isMobile) {
      await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
    } else {
      await page.setViewport({ width: 1920, height: 1080 });
    }
    // Block media so banners render in their static state
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

async function processTarget(browser, { baseUrl, device }) {
  try {
    if (await screenshotExists(baseUrl, device)) {
      console.log(`  –  ${baseUrl} (${device}) — already stored, skipping`);
      return true;
    }
    const buffer = await takeScreenshot(browser, baseUrl, device);
    await saveScreenshot(baseUrl, device, buffer);
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
