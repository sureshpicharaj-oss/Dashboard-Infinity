'use strict';

/*
 * Screenshot refresh script — run locally or via GitHub Actions.
 * Saves screenshots as static PNG files to public/screenshots/ which are
 * committed to git and served directly by Netlify CDN (no Blobs needed).
 * Skips URLs that already have a file on disk.
 *
 * Filename format: <netlify-subdomain>-<device>.png
 * e.g. ecvoters-welsh-mobile-200226-mobile.png
 *
 * Usage: node scripts/screenshot-refresh.js
 * No env vars required beyond what dotenv provides.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const cacheFile     = path.join(__dirname, '../public/data/dashboard_cache.json');
const screenshotDir = path.join(__dirname, '../public/screenshots');

if (!fs.existsSync(cacheFile)) {
  console.log('No dashboard cache found — skipping screenshot refresh');
  process.exit(0);
}

fs.mkdirSync(screenshotDir, { recursive: true });

const { results = [] } = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

function toSubdomain(netlifyUrl) {
  return netlifyUrl.match(/https?:\/\/([^.]+)\.netlify\.app/)?.[1] || null;
}

function screenshotPath(subdomain, device) {
  return path.join(screenshotDir, `${subdomain}-${device}.png`);
}

// Deduplicate by subdomain + device
const seen    = new Set();
const targets = [];
for (const row of results) {
  if (!row.netlifyUrl) continue;
  const subdomain = toSubdomain(row.netlifyUrl);
  if (!subdomain) continue;
  const device = row.device || 'desktop';
  const key    = `${subdomain}|${device}`;
  if (seen.has(key)) continue;
  seen.add(key);
  targets.push({ subdomain, device, netlifyUrl: row.netlifyUrl });
}

const pending = targets.filter(t => !fs.existsSync(screenshotPath(t.subdomain, t.device)));
console.log(`Found ${targets.length} unique URLs — ${targets.length - pending.length} already captured, ${pending.length} to capture`);
if (!pending.length) process.exit(0);

const puppeteer = require('puppeteer');

async function takeScreenshot(browser, netlifyUrl, device) {
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
    await page.goto(netlifyUrl, { waitUntil: 'load', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2500));
    const clipWidth  = isMobile ? 390 : 1920;
    const clipY      = isMobile ? 720 : 0;
    const clipHeight = isMobile ? 124 : 800;
    return await page.screenshot({ clip: { x: 0, y: clipY, width: clipWidth, height: clipHeight } });
  } finally {
    await page.close();
  }
}

async function processTarget(browser, { subdomain, device, netlifyUrl }) {
  const outPath = screenshotPath(subdomain, device);
  try {
    const buffer = await takeScreenshot(browser, netlifyUrl, device);
    fs.writeFileSync(outPath, buffer);
    console.log(`  ✓  ${subdomain} (${device})`);
    return true;
  } catch (err) {
    console.error(`  ✗  ${subdomain} (${device}) — ${err.message}`);
    return false;
  }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 60000,
  });

  let ok = 0, fail = 0;
  try {
    const CONCURRENCY = 3;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const batch   = pending.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(t => processTarget(browser, t)));
      ok   += results.filter(Boolean).length;
      fail += results.filter(v => !v).length;
    }
  } finally {
    await browser.close();
  }

  console.log(`\nScreenshot refresh complete: ${ok} captured, ${fail} failed`);
  if (fail > 0 && ok === 0) process.exit(1);
}

main().catch(err => {
  console.error('Screenshot refresh failed:', err);
  process.exit(1);
});
