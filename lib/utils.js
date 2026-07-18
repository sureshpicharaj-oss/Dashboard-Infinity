'use strict';

/**
 * Shared utility functions for extracting advertiser identity from Netlify-hosted creatives.
 * GAM stores no advertiser name on template creatives, so these helpers derive a human-readable
 * name by fetching the creative's landing page and parsing its HTML metadata.
 */

const axios = require('axios');

// Page titles that are too generic to use as an advertiser name.
const GENERIC_TITLES = new Set(['netlify app', 'untitled', 'index', 'home', '']);

/**
 * Fetches a URL and extracts the most useful brand name from its HTML.
 * Tries og:site_name first (most reliable), then <title> (split on separators
 * to discard site-name suffixes), then og:title as a last resort.
 * Returns null on network error or if no usable name is found.
 */
async function fetchAdvertiserName(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InfinityDashboard/1.0)' },
      maxRedirects: 5,
    });
    const html = res.data || '';

    // og:site_name — most explicit brand signal
    const siteNameMatch = html.match(/property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
    if (siteNameMatch) {
      const n = siteNameMatch[1].trim();
      if (n && !GENERIC_TITLES.has(n.toLowerCase())) return n;
    }

    // <title> — split on - | : and take first segment
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      const t = titleMatch[1].split(/\s*[-–|:]\s*/)[0].trim();
      if (t && !GENERIC_TITLES.has(t.toLowerCase()) && t.length > 1) return t;
    }

    // og:title fallback
    const ogTitleMatch = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (ogTitleMatch) {
      const t = ogTitleMatch[1].split(/\s*[-–|:]\s*/)[0].trim();
      if (t && !GENERIC_TITLES.has(t.toLowerCase()) && t.length > 1) return t;
    }
  } catch(e) {}
  return null;
}

/**
 * Derives a readable advertiser name from a Netlify subdomain when the live page
 * is unavailable or returns no useful metadata.
 * Strips common Netlify deploy suffixes (8-digit hashes, version tags like -v2,
 * campaign suffixes like -out-now, and -desktop/-mobile variants) before title-casing.
 */
function slugToName(netlifyUrl) {
  try {
    const host = new URL(netlifyUrl).hostname;
    let slug = host.split('.')[0];
    slug = slug.replace(/-\d{6,8}$/, '');
    slug = slug.replace(/-(v\d+|core|out-now|watchnow|today|tomorrow|seasonal)$/i, '');
    slug = slug.replace(/-(desktop|mobile)$/i, '');
    return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  } catch(e) { return ''; }
}

/**
 * Reads a named variable from a GAM template creative's creativeTemplateVariableValues array.
 * For VIDEO_ID specifically, falls back to CAMPAIGN_ID if VIDEO_ID is absent —
 * some older creatives use CAMPAIGN_ID as the video identifier.
 */
function getTemplateVarValue(creative, varName) {
  const vars = creative.creativeTemplateVariableValues || [];
  const match = vars.find(v => v.uniqueName?.[0] === varName);
  if (match?.value?.[0]?.trim()) return match.value[0].trim();
  if (varName === 'VIDEO_ID') {
    const fallback = vars.find(v => v.uniqueName?.[0] === 'CAMPAIGN_ID');
    return fallback?.value?.[0]?.trim() || null;
  }
  return null;
}

/**
 * Recursively searches any value (string, array, or object) for a Netlify URL.
 * Used because Netlify URLs appear in different fields across creative types
 * (e.g. asset URL, snippet content, template variable value).
 * Depth limit of 5 prevents runaway recursion on deeply nested SOAP objects.
 */
function extractNetlifyUrl(obj, depth = 0) {
  if (depth > 5) return null;
  if (typeof obj === 'string') {
    const match = obj.match(/(?:https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9-]*\.netlify\.app(?:\/[^\s"'<>]*)?/);
    if (!match) return null;
    return match[0].startsWith('http') ? match[0] : `https://${match[0]}`;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = extractNetlifyUrl(item, depth + 1);
      if (found) return found;
    }
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      const found = extractNetlifyUrl(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Splits one line of a GAM CSV_DUMP report into fields, respecting quoted fields that
 * contain commas (GAM quotes any string dimension — e.g. CREATIVE_NAME, AD_UNIT_NAME —
 * that itself contains a comma). A naive line.split(',') would shift every column after
 * such a field. Doubled quotes ("") inside a quoted field are unescaped to a single quote.
 */
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

module.exports = { fetchAdvertiserName, slugToName, getTemplateVarValue, extractNetlifyUrl, splitCsvLine };
