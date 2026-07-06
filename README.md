# Infinity Dashboard

A real-time monitoring dashboard for Infinity skin and video skin ad creatives running across Immediate Media properties via Google Ad Manager.

---

## The Problem This Solves

Ad ops teams flying blind. Creatives live on Netlify, stats live in GAM, and there's no single view that shows what's running, whether it's working, and what it looks like. This dashboard closes that gap — it pulls the data directly from the source of truth (GAM SOAP APIs) and presents it without a 24-hour delay, without a spreadsheet, and without anyone having to manually run a report.

---

## Architecture Philosophy

**Pull from the authoritative source, cache aggressively, never duplicate data.**

GAM is the source of truth. We don't maintain a database — there's nothing to keep in sync, nothing to go stale in a shadow store. Every Refresh hits GAM directly. The only things we cache locally are:

- Puppeteer screenshots (expensive to retake, slow to change)
- Active View and video completion rates (6-hour TTL — these come from report jobs that take 30–90 seconds to run; caching is not optional)
- Line item and creative mappings (written fresh on every dashboard Refresh, used by downstream async calls)

Everything else is computed on the fly from what GAM returns.

---

## Data Flow

```
GAM CreativeService (SOAP)
  └── 970×249/250/251 template creatives
        └── extract Netlify URL + VIDEO_ID from template variables
              └── group by base URL  ──────────────────────────────────────────┐
                                                                                │
GAM LineItemCreativeAssociationService (SOAP)                                  │
  └── impressionsDelivered + clicksDelivered per creative ID                   │
        └── aggregate across all creatives for the same URL  ──────────────────┤
                                                                                │
GAM ReportService (SOAP, async job)                                            │
  └── Active View (viewable + measurable impressions, by line item + creative) │
        └── matched to URL via impression-count fingerprinting  ────────────────┤
                                                                                │
GAM CustomTargetingService + LineItemService (SOAP)                            │
  └── VIDEO_ID → dedicated video line item → completion rate report  ──────────┤
                                                                                ▼
                                                                     /api/dashboard JSON
                                                                     → index-desktop.html
```

---

## Key Architectural Decisions

### 1. LICA for impressions, not a report

Most GAM integrations reach for the Report API first. That's wrong for this use case.

The `LineItemCreativeAssociationService` returns `impressionsDelivered` and `clicksDelivered` per creative, all-time, synchronously. No job to submit, no polling loop, no 30–90 second wait. The data is the same number you'd get from a report — it's just available instantly because LICA tracks it natively.

Reports are reserved here for metrics that LICA genuinely can't provide: Active View (viewability) and video quartile completion. Those require the Report API because they're computed metrics, not stored counters.

### 2. Group by base URL, not by creative

A single campaign runs multiple creative variants — 249px, 250px, 251px height — all pointing to the same `https://site.netlify.app/` URL. Treating each creative as a distinct row would show the same campaign three times with inflated-looking impression splits.

Grouping by `${protocol}//${host}/` collapses the variants into one row and sums the impressions correctly. Video creatives get an additional split by `VIDEO_ID` so that a single URL running multiple video assets shows each asset's completion rate separately.

### 3. Active View matching via impression fingerprinting

GAM's Active View report returns its own internal creative IDs — these are 9-digit rendered creative IDs, not the template creative IDs that LICA uses. There is no join key between the two systems.

The solution: LICA tells us how many impressions a given template creative served within a given line item. The Active View report tells us how many impressions were measurable for a given (line item, rendered creative) pair. If those two numbers match within ±20, they refer to the same creative. This is impression-count fingerprinting — not a hack, just using what both systems happen to agree on.

We save the LICA impression breakdown in `url_lica_imps_cache.json` at Refresh time, then use it during Active View lookups to find the right rendered creative without needing the Creative Set API.

### 4. VIDEO_ID → completion rate: the right lookup path

Video creatives carry a `VIDEO_ID` template variable (e.g. `AliceSteve`, `OrdWebbSkin`). The instinct is to search line items by name. That's fragile — naming conventions drift.

The correct path: search GAM's CustomTargetingService globally for custom targeting values matching the VIDEO_ID string, get back the value IDs, then scan line items for those value IDs in their targeting tree. A line item that targets `VIDEO_ID = AliceSteve` is definitionally the video-hosting line item for that creative. Once found, run `VIDEO_VIEWERSHIP_START` / `VIDEO_VIEWERSHIP_COMPLETE` columns in a report filtered to those line item IDs.

Name-based matching is kept as a fallback only.

### 5. No shadow database

Adding a database would mean: a schema to maintain, a sync job to break, data that diverges from GAM over time, and a deployment dependency. None of that buys anything here. The volume is small (hundreds of creatives, not millions of events), GAM is already the authoritative store, and the SOAP APIs are fast enough for on-demand queries.

The JSON files in `public/screenshots/` are not a database — they are cache materializations of query results, with well-defined invalidation rules. They can be deleted at any time and the system regenerates them on the next Refresh.

---

## File Structure

```
server-desktop.js            Entry point — port 3001
config.js                    All GAM endpoint URLs and shared constants
lib/
  auth.js                    Google OAuth2 — token acquisition and refresh
  utils.js                   URL extraction, slug→name, template variable helpers
  gam-creatives.js           Paginated SOAP fetch of 970px template creatives
  gam-lica.js                LICA impression/click aggregation + excluded creative IDs
  gam-lineitems.js           Line item start dates (drives default sort order)
  gam-reports.js             Report job submission, polling, CSV download, gunzip
  gam-targeting.js           Custom targeting key/value resolution
  gam-video.js               VIDEO_ID → line item matching + completion rate
  gam-activeview.js          Active View report (line item level + creative level)
routes/
  auth.js                    /auth OAuth entry + callback
  dashboard.js               /api/dashboard — orchestrates all data fetching
  screenshot.js              /api/screenshot — Puppeteer, 1920×1080, no scroll
  advertiser.js              /api/advertiser — per-URL name overrides
  active-view.js             /api/active-view — viewability + debug endpoints
  video-stats.js             /api/video-stats — completion rates + cache
  tags.js                    /api/tag-rules, /api/url-tags — category assignment
  debug.js                   /api/debug-* — diagnostic and inspection endpoints
public/
  index-desktop.html         Desktop + Video Skin UI
  screenshots/               Screenshot cache + JSON materializations
```

---

## Cache Reference

| File | What it holds | Invalidated |
|---|---|---|
| `url_lineitem_cache.json` | `netlifyUrl → [lineItemIds]` | Every Refresh |
| `url_creative_cache.json` | `netlifyUrl → [creativeIds]` (served only) | Every Refresh |
| `url_lica_imps_cache.json` | `url → creativeId → lineItemId → impressions` | Every Refresh |
| `url_videoid_cache.json` | `videoId → netlifyUrl` | Every Refresh |
| `active_view_cache.json` | `netlifyUrl → { rate, viewable, measurable }` | 6 hours |
| `video_stats_cache.json` | `videoId → { completionRate, durationSec }` | 6 hours |
| `tag_rules.json` | `category → [keywords]` | Manual edits |
| `url_tags.json` | `netlifyUrl → category` | Manual edits |

The first four are written atomically at Refresh time and consumed by the async Active View and Video Stats endpoints that run after the dashboard returns. The 6-hour TTL caches exist because their underlying report jobs are too slow to run synchronously on every page load.

---

## Running

```bash
node server-desktop.js   # Desktop + Video Skin — port 3001
node server.js           # Full build (desktop + mobile) — port 3000
```

`.env` required:
```
GAM_CLIENT_ID=
GAM_CLIENT_SECRET=
GAM_REFRESH_TOKEN=
GAM_NETWORK_CODE=
```

First run: visit `http://localhost:3001/auth` to complete the OAuth flow and get your refresh token.

---

## Creative Template IDs (Desktop Skin)

Creatives must match one of these template IDs **and** be sized 970×249/250/251 to appear in the dashboard:

```
12338205  12391253  12430810  12479439
12514886  12517019  12522683  12523354
```

Order `3559958634` is excluded from all results at the LICA query stage.
