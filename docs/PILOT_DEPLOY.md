# Pilot Deployment Checklist

This document details the operational deployment checklist for launching the pilot environment safely.

---

## 1. Environment & Runtime Configuration

- [ ] **Set `NODE_ENV=production`**  
  Ensure `NODE_ENV` is set to `production` in the production runtime environment (systemd, Docker, PM2, or cloud provider). This activates all production guards, disables mock providers, enforces strict authentication rate limiting, and disallows test fixtures.
- [ ] **Run on a 24/7 Server / Background Daemon**  
  The application execution engine, send gate, and follow-up message scheduler require continuous execution. Run on an always-on server (e.g. Linux VM with PM2 or Docker container) rather than an ephemeral or sleeping dev instance.

---

## 2. Database Preparation & Backup

- [ ] **Take Full Database Backup Before First Run**  
  Create a pg_dump backup of the production database before executing any live pilot actions:
  ```bash
  pg_dump -Fc -v -d <DATABASE_NAME> -f pre_pilot_backup.dump
  ```
- [ ] **Run Prisma Migrations**  
  Apply all pending schema migrations deterministically using `prisma migrate deploy` (never `prisma migrate dev` or `db push` in production):
  ```bash
  npx prisma migrate deploy
  # Or via npm shortcut:
  npm run db:migrate:deploy
  ```
- [ ] **Verify Migration Status**  
  Confirm zero schema drift and that all 35 migrations are marked applied:
  ```bash
  npm run db:migrate:status
  ```

---

## 3. Required Environment Variables (Names Only)

Ensure the following variables are configured in the production environment (do NOT print or log their values):

### Core Application & Database
- `NODE_ENV` (`production`)
- `DATABASE_URL` (production PostgreSQL connection string)
- `AUTH_SECRET` (minimum 32-character high-entropy secret)
- `APP_URL` or `NEXT_PUBLIC_APP_URL` (public canonical URL)

### Messaging & Unipile Integration
- `UNIPILE_API_KEY`
- `UNIPILE_DSN`
- `UNIPILE_WEBHOOK_SECRET` (optional, recommended for webhook authentication)
- `UNIPILE_READ_TIMEOUT_MS` (optional, default 15000)
- `UNIPILE_SEND_TIMEOUT_MS` (optional, default 45000)

### Discovery & Scrapers
- `DISCOVERY_PROVIDER` (`instagram_all_in_one` default, or `google_maps` / `instagram_places` / `instagram_search` / `hybrid`)
- `ENRICHMENT_PROVIDER` (`instagram_scraper` default, or `instagram_profile_scraper`)
- `SCRAPER_PROVIDER` (`apify` or `sparior`)
- If using Apify: `APIFY_API_TOKEN`
- If using Sparior: `SPARIOR_API_KEY`, `SPARIOR_API_HOST`, `SPARIOR_BASE_URL`
- Instagram all-in-one (optional overrides): `APIFY_IG_SCRAPER_ACTOR_ID`,
  `IG_SEARCH_LIMIT`, `IG_MAX_QUERIES_PER_JOB`, `IG_MAX_RESULTS_PER_JOB`,
  `IG_SCRAPER_COST_PER_RESULT_USD`, `IG_NEIGHBOURHOODS`,
  `IG_SEARCH_INCLUDE_PLACES`, `IG_MIN_FOLLOWERS`, `IG_MAX_FOLLOWERS`,
  `IG_MIN_POSTS`, `IG_MAX_DAYS_SINCE_LAST_POST`, `LEAD_TIER_A_MIN`,
  `LEAD_TIER_B_MIN`, `LEAD_TIER_C_MIN`

With the defaults, discovery and details use ONLY `apify/instagram-scraper`. The
`compass/crawler-google-places` and `apify/instagram-profile-scraper` actors are
never called; both remain selectable by switching the two env vars.

### Instagram All-In-One Mode (default)
Tradeoffs vs Google Maps:
- No Maps phone, rating, review count, claimed status, or closed flags. Scores
  flag `UNKNOWN_MAPS_DATA` and re-normalize around Instagram/contact signals.
  Tier scores are therefore NOT directly comparable with Maps-based leads.
- Location certainty is weaker: the actor has no location input, so the city is
  embedded in query text and each result is verified from bio/address/place data/
  TLD. Explicit other-city results are rejected; unknown-location results proceed
  to details only when the Gemini pre-gate marks them relevant.
- Cheaper and handle-first: every discovered candidate already has a handle.

Costs & caps:
- `IG_SCRAPER_COST_PER_RESULT_USD` (default `0.0027` conservative)
- `IG_SEARCH_LIMIT` (default `10` per query)
- `IG_MAX_QUERIES_PER_JOB` (default `6`)
- `IG_MAX_RESULTS_PER_JOB` (default `60`)
- `DISCOVERY_MAX_JOB_USD` (hard stop; partial results kept, `stop_reason=budget_exhausted`)

Switching back to Google Maps:
1. Set `DISCOVERY_PROVIDER="google_maps"`.
2. Optionally set `ENRICHMENT_PROVIDER="instagram_profile_scraper"`.
3. Restart the app and check `/api/health/ready` (`discovery_provider`,
   `enrichment_provider`, `disabled_actors` are informational).

### Google Maps Cost Controls
- `GMAPS_MAX_SEARCHES_PER_JOB` (default `2`): paid keyword × area searches per job.
- `DISCOVERY_AREA_COOLDOWN_DAYS` (default `30`): skip a keyword/area pair that
  already ran inside this window. The coverage ledger lives in `DiscoveryCoverage`.
- `DISCOVERY_CACHE_DAYS` (default `90`): reuse place outcomes
  (`accepted`/`rejected`/`no_contact`) from `DiscoveryPlaceOutcome`; known places
  are not re-enriched or re-gated.
- `GMAPS_MIN_IG_YIELD_PERCENT` (default `10`): stop the batch and recommend
  another keyword/area when IG-ready yield is below this.
- `GMAPS_MERGE_KEYWORDS` (default `false`): one keyword per area; opt in to
  merge up to 2. Keywords with >70% placeId overlap are auto-dropped.
- `GMAPS_SCRAPE_CONTACTS` (default `false`): the only switch that re-enables the
  paid contacts/social add-ons.
- `GMAPS_CATEGORY_FILTER` (default empty): optional; the actor bills per returned
  place, so it is not sent unless set.
- `GMAPS_AREA_OVERRIDES` (default empty): JSON map of city → sub-areas for area
  rotation. Built-in lists cover major Canadian and US cities.

The pre-run estimate uses the rolling actual cost/place from the last 5 paid
Maps runs (fallback constants) and the job passes `maxTotalChargeUsd` to the actor.

### AI & Enrichment
- `GEMINI_API_KEY`

### Cron & Background Tasks
- `CRON_SECRET`

---

## 4. Mock & Safety Flag Audit

- [ ] **Ensure All Mock/Dry-Run Flags Are Unset or Disabled**  
  Verify that the following variables are **NOT** present or set in production:
  - `MOCK_UNIPILE` (must NOT be set; setting in production triggers a loud error and causes `/api/health/ready` to fail with HTTP 503)
  - `APIFY_DRY_RUN` (must NOT be set; dry-run mode is forbidden in production)
  - `MOCK_GEMINI` (must NOT be set)
  - `DISABLE_AUTH_RATE_LIMIT` (must NOT be set)
  - `SKIP_SEND_DELAYS` (must NOT be set)

---

## 5. Security & Key Rotation

- [ ] **Rotate Provider API Keys**  
  Rotate all provider API keys (Unipile, Apify, Sparior, Gemini) before starting the pilot, ensuring test-session keys are revoked.
- [ ] **Rotate Authentication Secret**  
  Ensure `AUTH_SECRET` is freshly generated and distinct from local development.

---

## 6. Readiness Probe Verification

- [ ] **Check `/api/health/ready`**  
  Query the readiness endpoint on the production deployment:
  ```bash
  curl -i https://<YOUR_APP_DOMAIN>/api/health/ready
  ```
  **Verification Criteria:**
  - Status code is **`HTTP 200 OK`**.
  - Response body confirms:
    - `"status": "ready"`
    - `"database": { "status": "connected" }`
    - `"migrations": { "status": "up_to_date" }`
    - `"mock_modes": { "unipile_mock": false, "apify_dry_run": false }`
    - `"checks": { "outbound_sending": "disabled" }` (or "enabled")

---

## 7. Stage 2 Small Discovery Configuration & Preflight

Before starting the real lead-fetching discovery run:

### Environment Settings
```bash
# Global Kill Switch (keeps sending completely OFF)
OUTBOUND_SENDING_ENABLED="false"

# Small Pilot Hard Caps
DISCOVERY_STAGE="pilot_small"
DISCOVERY_MAX_JOB_USD="0.60"

# Provider Settings (defaults: Instagram-only via apify/instagram-scraper)
DISCOVERY_PROVIDER="instagram_all_in_one"
ENRICHMENT_PROVIDER="instagram_scraper"
IG_SEARCH_LIMIT="10"
IG_MAX_QUERIES_PER_JOB="6"
IG_MAX_RESULTS_PER_JOB="60"
IG_SCRAPER_COST_PER_RESULT_USD="0.0027"
SCRAPER_PROVIDER="apify"
APIFY_DRY_RUN="false"

# Google Maps-only caps (used only when DISCOVERY_PROVIDER="google_maps")
GMAPS_MAX_TOTAL_PLACES="15"
GMAPS_MAX_CITIES="1"

# Monthly Budget & Spend Reset
# Set monthly cap in USD (leave blank or omit to remove monthly cap)
APIFY_MONTHLY_BUDGET_USD="10.00"
# Set to an ISO timestamp (e.g. "2026-11-01T00:00:00Z") to reset spend window calculation.
# If unset or older than the start of the current month, only current month's spend is counted.
APIFY_BUDGET_RESET_DATE=""
```

### Preflight Command
Run the preflight checklist before touching the UI:
```bash
npm run preflight
```
Ensure all required items pass without blockers.

---

## 8. Email Channel (SMTP, one email per lead)

Required env:
```env
OUTBOUND_SENDING_ENABLED="false"     # true only when you are ready to send
APP_PUBLIC_URL="https://your-app.example"  # required; sending is refused without it
EMAIL_CREDENTIALS_KEY=""             # 32 bytes hex/base64, encrypts SMTP passwords
EMAIL_COMPANY_NAME="Your Company"
EMAIL_DAILY_CAP="15"
EMAIL_HOURLY_CAP="4"
EMAIL_DAILY_HARD_MAX="30"
EMAIL_JITTER_MIN_SECONDS="240"
EMAIL_JITTER_MAX_SECONDS="720"
```

DNS records to set on the from-domain:
- SPF: `TXT @ "v=spf1 include:YOUR_SMTP_PROVIDER ~all"`
- DKIM: publish the selector record from your SMTP provider, e.g.
  `TXT mail._domainkey "v=DKIM1; k=rsa; p=..."` and enter `mail` as the selector.
- DMARC: `TXT _dmarc "v=DMARC1; p=quarantine; rua=mailto:dmarc@your-domain"`

The account cannot be enabled while SPF or DKIM fails unless "Allow DNS override" is
checked. Using a free provider domain (gmail.com, outlook.com, yahoo.com) shows a warning.

First-campaign checklist (start at 10 emails/day):
1. Verify the SMTP connection and send one test email to yourself.
2. Run the DNS health check and confirm SPF/DKIM/DMARC pass.
3. Set `EMAIL_DAILY_CAP=10`, keep `OUTBOUND_SENDING_ENABLED=false` until approval.
4. Ensure `APP_PUBLIC_URL` is publicly reachable and test an unsubscribe link.
5. Enable the campaign email templates; preview the final text including the footer.
6. Enable outbound sending and send a small batch (1-2 emails), then check replies.
7. Check the mailbox daily for STOP replies and honor them within 24 hours via
   "Mark as replied" or "Add to DNC".
8. Raise the cap only after SPF/DKIM/DMARC stay green and bounce rate stays below 5%.

## 9. Manual Instagram All-In-One Test (10 results)

Use this for a small, real, paid smoke test. It never sends messages.

1. Set and restart:
   ```env
   DISCOVERY_PROVIDER="instagram_all_in_one"
   ENRICHMENT_PROVIDER="instagram_scraper"
   DISCOVERY_STAGE="pilot_small"      # caps maxLeads at 10
   IG_SEARCH_LIMIT="3"
   IG_MAX_QUERIES_PER_JOB="2"
   IG_MAX_RESULTS_PER_JOB="10"
   DISCOVERY_MAX_JOB_USD="0.05"
   APIFY_DRY_RUN="false"
   ```
2. Open a campaign → Find Instagram Leads → enter a city (not a country) and
   keywords, e.g. `dental clinic` / `Toronto`.
3. Confirm the pre-run plan shows 2 queries, 3 results each, and an estimated
   total ≤ `DISCOVERY_MAX_JOB_USD`, then confirm the paid run.
4. Expected: only `apify/instagram-scraper` runs (search then details). The job
   summary shows results consumed, spend, cost per saved lead, per-query stats,
   and a `stopReason` (`completed` or `budget_exhausted`).
5. Verify no `compass/crawler-google-places` or `apify/instagram-profile-scraper`
   calls appear in Apify run history.
6. Revert `DISCOVERY_STAGE`/limits to pilot values after the smoke test.

## 10. Re-enabling Outbound Sending (Future Stages)

When ready to transition from Discovery-Only (Stage 2) to live sending:
1. Set `OUTBOUND_SENDING_ENABLED="true"` in your environment / `.env`.
2. Ensure at least one Instagram sender account is connected and verified in the UI.
3. Verify `/api/health/ready` reports `"outbound_sending": "enabled"`.
4. The UI banner "Sending is OFF" will disappear and Send/Message actions will become active.


