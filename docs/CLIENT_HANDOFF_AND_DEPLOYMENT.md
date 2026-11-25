# InstaScraper — Client Handoff, Known Issues & Deployment Guide

**Prepared:** 2026-11-25 · **Branch:** `mysql-port` · **Target host:** Hostinger (Node.js app + managed MySQL/MariaDB) or any always-on Linux/Windows server with PM2

> **Status: NOT YET READY FOR CLIENT HANDOFF.**
> The app builds, typechecks, and its deterministic tests pass. But section 3.1 lists
> **7 blocking issues in the Instagram send path**, and live sending has not been
> verified since the MySQL port. Fix the blockers, then complete every step in
> section 6. Do not enable outbound sending for a client before that.

### Fix log (2026-11-25, second pass)

| Item | Status | Change |
|---|---|---|
| B1 no-sender bypass | **Fixed** | `messaging-service.ts`: with no sender account, the send is blocked (`SENDING_DISABLED` / `NO_SENDER`) before reaching the provider |
| B2 wrong-sender fallback | **Fixed** | `unipile-provider.ts`: the fallback to the first account is used only when no sender was named |
| B3 gate blocks → FAILED | **Fixed** | `bulk-messaging-service.ts`: every gate "not now" keeps the item QUEUED and waits until `retryAt` (30 s – 60 min) |
| B4 cooldown re-roll | **Fixed** | `send-gate.ts`: the jitter gap is stable per (sender, lastSentAt); the worker re-checks the gate after waiting |
| B5 stalled jobs / H1 follow-ups | **Fixed** | New `scheduler/outreach-scheduler.ts` + `src/instrumentation.ts`: every 2 min it re-kicks RUNNING jobs and sends due follow-ups. On in production; `OUTREACH_SCHEDULER=false` disables it |
| B6 ACTIVE/WARMING senders | **Fixed** | Bulk and draft send accept `CONNECTED/ACTIVE/WARMING` |
| B7 halt flags | **Fixed** | `PAUSE_ALL_MESSAGING` / `EMERGENCY_STOP` now block every outbound send through the send gate |
| H2 ledger blocks pause senders | **Fixed** | `ALREADY_CONTACTED` / `UNKNOWN_PENDING` / `LEDGER_CONFLICT` / `DNC_SUPPRESSED` no longer count as sender errors |
| H3 execution skips outside hours | Open | Use bulk jobs for overnight campaigns until fixed |
| AI auto-enrichment | **Off** | `AI_AUTO_ENRICHMENT=false`: discovery uses free rule-based **location + content** scoring (`rule-based-relevance.ts`) instead of Gemini. AI analysis and drafts remain manual on the campaign page |

New tests: `test_rule_based_relevance.ts` (6), `test_website_business_profile.ts` (48). These suites pass:
kill switch 12/12, send-path guard 10/10, discovery gates 47/47, relevance 33/33.
The DB-backed send suites still need to be run once MySQL is up.

---

## Contents

1. [What the app does](#1-what-the-app-does)
2. [Architecture](#2-architecture)
3. [Known issues](#3-known-issues)
4. [Improvements already made (this release)](#4-improvements-already-made-this-release)
5. [Recommended improvements (roadmap)](#5-recommended-improvements-roadmap)
6. [Deployment — step by step](#6-deployment--step-by-step)
7. [Go-live: turning sending on safely](#7-go-live-turning-sending-on-safely)
8. [Operations, monitoring & backups](#8-operations-monitoring--backups)
9. [Rollback plan](#9-rollback-plan)
10. [Client handoff checklist](#10-client-handoff-checklist)
11. [What to tell the client (known limitations)](#11-what-to-tell-the-client-known-limitations)

---

## 1. What the app does

InstaScraper is a lead-generation and outreach platform for local businesses.

| Stage | What happens | Provider |
|---|---|---|
| **Discover** | Finds businesses by keyword and city from Instagram search or Google Maps | Apify (or Sparior via RapidAPI) |
| **Enrich** | Pulls Instagram profile data. Scrapes each lead's **website** for emails, phones, socials, services, hours, address and description | Apify, plus a free built-in website scraper |
| **Qualify** | AI scores each lead and filters out bad fits, chains and duplicates | Google Gemini |
| **Draft** | AI writes personalised DMs and emails; a quality gate blocks spammy or unsafe copy | Gemini + built-in quality checks |
| **Approve & send** | Human review queue, then Instagram DMs from connected accounts with caps, warm-up, working hours and cooldowns. Email over SMTP | Unipile (Instagram), SMTP |
| **Replies** | Inbound DMs arrive by webhook; AI classifies intent and drafts a reply | Unipile webhook + Gemini |
| **Compliance** | Do-Not-Contact list, opt-out detection, cross-campaign contact ledger, email unsubscribe links | Built-in |
| **Analytics** | Funnel, outcomes, A/B results, recommendations | Built-in |

---

## 2. Architecture

- **Framework:** Next.js 16.3 (App Router, webpack build), React 19, Tailwind CSS v4
- **Database:** MySQL 8 / MariaDB via Prisma 7 (`@prisma/adapter-mariadb`). Migrations are in `prisma/migrations/`. `prisma/migrations-postgres/` is legacy and not used at runtime.
- **Auth:** email/password, JWT session cookie signed with `AUTH_SECRET`, auth rate limiter
- **Background work runs in-process.** Discovery jobs, bulk message jobs, follow-ups and AI jobs run inside the Next.js server process. **The app must run as one long-lived instance on an always-on server.** It cannot run on serverless, sleeping or auto-scaled hosting.
- **Startup:** `npm start` runs `prisma migrate deploy`, resumes unfinished discovery jobs (no new paid runs), then starts `next start` on `PORT`.
- **Health probe:** `GET /api/health/ready` reports config and dependency status (DB, migrations, providers, sending switch) without exposing secrets.

---

## 3. Known issues

Severity: **Blocker** = must fix before the client uses sending · **High** = fix before handoff · **Medium** = fix soon after · **Low** = backlog.

### 3.1 Blockers — Instagram send path

These came from a code review of the send path. None has been reproduced against live
data yet, because the database was offline during review. After the DB is up, run the
read-only message-status counts to confirm which have already fired.

| # | Issue | Where | Impact | Fix |
|---|---|---|---|---|
| B1 | **Kill switch and caps bypassed when no sender account exists.** The send-slot reservation only runs when a sender is resolved. With no sender rows, the message goes straight to the provider. | `src/lib/services/messaging/messaging-service.ts:485`, `execution/campaign-execution-service.ts:1853`, `senders/instagram-sender-service.ts:1113` | Messages can go out with `OUTBOUND_SENDING_ENABLED=false` and ignore daily/hourly caps → account bans | Fail closed: if no sender resolves, block with `NO_SENDER` and never call the provider |
| B2 | **Wrong-sender fallback.** If the sender's Unipile ID can't be resolved, it silently sends from the first active Unipile account. | `messaging/unipile-provider.ts:160` | DMs from the wrong Instagram account; caps and ledger are charged to a different account | Remove the fallback; fail with `SENDER_NOT_LINKED` |
| B3 | **Cap and gate blocks marked FAILED.** The bulk loop only defers on 4 reasons (disabled, dry-run, outside hours, cooldown). `DAILY_CAP`, `HOURLY_CAP`, `STAGGER_OFFSET`, `SENDER_PAUSED` and others fall through and become `FAILED / WORKER_ERROR`. | `messaging/bulk-messaging-service.ts:1539` | Leads silently dropped from campaigns once a cap is hit | Treat every gate "not now" reason as a deferral with `retryAt` |
| B4 | **Cooldown wait re-rolls the random gap.** The worker sleeps until `retryAt`, then the reservation picks a new random gap and can refuse again. | `messaging/send-gate.ts:981` | About half of waiting items fail as `WORKER_ERROR` | Persist the chosen gap per sender, or re-check without re-rolling |
| B5 | **Jobs stall in RUNNING.** On "outside working hours" or "sending disabled" the worker exits its loop. Nothing restarts it: `start` only accepts QUEUED jobs, `resume` only PAUSED ones. A server restart also kills in-flight workers. | `bulk-messaging-service.ts` (worker loop), `api/message-jobs/[jobId]/start\|resume` | Overnight campaigns never continue the next morning | Add a scheduler tick (see R1) that re-kicks RUNNING jobs whose `retryAt` has passed; recover on startup like discovery does |
| B6 | **Only `CONNECTED` counts as an eligible sender in two places.** Resuming a paused sender sets it to `WARMING` or `ACTIVE`. | `bulk-messaging-service.ts:1179`, `drafts/draft-send-service.ts:42` | After a pause/resume, bulk jobs pause with "No connected Instagram sender accounts" and draft sends are rejected | Use the same eligible-status set as `send-gate.ts` (`CONNECTED/ACTIVE/WARMING`) |
| B7 | **Global halt flags only stop replies.** `PAUSE_ALL_MESSAGING` and `EMERGENCY_STOP` are checked only in the reply path. | `messaging/reply-send-service.ts:145` | The "emergency stop" does not stop first messages or follow-ups, despite what `.env.example` says | Check both flags inside `reserveSendSlot` / `canSendNow` |

### 3.2 High

| # | Issue | Where | Fix |
|---|---|---|---|
| H1 | **Follow-ups are only sent while a bulk job for that campaign is running.** `dispatchDueFollowUps` is called only from inside the bulk worker loop. | `messaging/bulk-messaging-service.ts:1216` | Call it from the scheduler tick (R1) for every campaign with due follow-ups |
| H2 | **"Already contacted" ledger blocks count as sender errors.** They increment `consecutiveErrors`; after 3 the sender auto-pauses for 1–24 h. | `messaging/messaging-service.ts:552` | Release ledger/DNC blocks as `SKIPPED`, not `FAILED` |
| H3 | **Campaign execution drops leads outside working hours.** They are marked `SKIPPED` permanently, although the UI message says "resumes at…". | `execution/campaign-execution-service.ts` (~1862) | Defer instead of skip |
| H4 | **Secrets are stored in plain text in the local `.env`** (Unipile, Apify, Gemini, DB). The file is git-ignored, but these keys have been used in development. | `.env` | **Rotate every provider key before handoff**, then set the new ones only on the server (section 6.3) |
| H5 | **Older docs are out of date.** `docs/PRODUCTION_CHECKLIST.md` still describes PostgreSQL, ntfy and a hard-coded IP. | `docs/` | Treat this file as the source of truth; archive or update the old checklist |
| H6 | **Live sending not re-verified since the MySQL port.** The last live verification was on PostgreSQL in October. | — | Do the controlled live test in section 7 |

### 3.3 Medium

| # | Issue | Where | Fix |
|---|---|---|---|
| M1 | `middleware.ts` is deprecated in Next.js 16 and renamed to `proxy.ts` (export `proxy`). It still works, but will break in a future major version. | `src/middleware.ts` | Rename the file and its export |
| M2 | No app-level rate limiting except on auth endpoints. | API routes | Rate-limit at the proxy/CDN (Cloudflare or Hostinger) |
| M3 | No Content-Security-Policy or HSTS headers; other security headers are set. | `next.config.ts` | Add HSTS once HTTPS is guaranteed; add CSP after testing against real assets |
| M4 | The working-hours stagger check compares the lead's local time with the sender's start hour; the daily-cap retry time uses the server's local midnight. | `messaging/send-gate.ts:959`, `:875` | Use one timezone consistently (the sender's) |
| M5 | `bypassWorkingHours` and `skipWeekends` are passed to `canSendNow` but never read. | `messaging/send-gate.ts` | Wire them in, or remove them |
| M6 | Website scraper uses plain `fetch` with no JS rendering, so JavaScript-only sites (some Wix/React builds) return little data. | `enrichment/website-lead-enricher.ts` | Optional Playwright fallback when the homepage HTML is nearly empty |
| M7 | The per-host scrape rate limiter is in memory only; there is no `429 / Retry-After` handling and no robots.txt check. | `enrichment/website-lead-enricher.ts` | Honour 429 with backoff; optionally respect robots.txt |
| M8 | Campaign deletion cascades campaign data, including message-attempt audit rows. | Prisma schema | Soft-delete campaigns, or export the audit trail before deleting |

### 3.4 Low

- Unipile `POST /chats` is sent as JSON; Unipile's docs show multipart. Only matters if live sends fail with a 4xx. Verify during the section 7 test.
- `npm audit` shows dev-only advisories in the Prisma CLI chain; the breaking upgrade was declined.
- `src/components/ui/theme-toggle.tsx` is no longer used (the app is black-theme only). It can be deleted.
- `navbar.tsx` uses `window.location.href` for logout redirects (lint warning); switch to `router.push`.

---

## 4. Improvements already made (this release)

### 4.1 UI / UX redesign — black 50% · orange 30% · white 20%
- **Palette:** a new design system in `src/app/globals.css`. Tailwind's grey palettes are remapped to true black, and indigo/violet/purple to the orange brand, so every screen changed consistently. Text is white.
- **Single dark theme:** `dark:` variants now follow the `.dark` class rather than the OS setting. The light/dark toggle is removed.
- **Restyled pieces:** orange gradient primary buttons with glow; a glass-black navbar with an orange accent line; orange active tabs; a sticky tab bar on the campaign page; accented stat cards and campaign cards.
- **Motion:** sections and cards fade up in sequence; cards lift on hover; modals fade and scale in; the lead drawer slides in; loading placeholders shimmer. Everything turns off under `prefers-reduced-motion`.
- **Polish:** orange focus rings and selection colour, styled scrollbars, input focus glow.

### 4.2 Website scraping of leads
- **New business-profile extractor** (`src/lib/services/enrichment/website-business-profile.ts`). From each lead's site it pulls:
  - what the business is: type, name, description, summary, founded year, price range, site rating
  - where and when: address, city, postal code, geo coordinates, opening hours, areas served
  - what it sells: services/offerings, meta keywords
  - extras: booking link, site platform (WordPress, Wix, Shopify…), logo/image, language
- **Smarter page discovery:**
  - Real "Contact" links are scanned first.
  - Non-English slugs are recognised (kontakt, contacto, impressum, mentions-légales…).
  - Guessed URLs no longer crowd out real links.
  - Contact pages are fetched when a phone or address is missing.
- **Parsing fixes:**
  - `tel:%2B…` phone links are decoded.
  - Junk emails from `<script>` bundles are ignored.
  - JSON-LD is parsed even when wrapped in comments or `@graph`.
  - Titles are entity-decoded.
  - Phones are normalised for the lead's own country (previously always Canada).
- **Fetching:** the real HTTP status is recorded, pages are capped at 2 MB, and only HTML responses are accepted.
- **No data loss:**
  - "Find Contacts" now adds to stored contacts; before, it overwrote them.
  - A failed re-scan keeps the previous business profile.
  - Instagram-pipeline leads keep every email and phone found, not just the first.
- **New "Website Intel" panel** in the lead drawer. It shows the business profile, every contact with the page it came from, per-page scan results, and a Re-scan button.
- **Tests:** `scripts/test_website_business_profile.ts`, 48 checks, registered in `npm test`.

---

## 5. Recommended improvements (roadmap)

| # | Improvement | Why |
|---|---|---|
| R1 | **Scheduler tick:** a protected endpoint (e.g. `POST /api/cron/tick` with `CRON_SECRET`) called every minute by Hostinger cron or `pm2` cron. It resumes due RUNNING jobs, dispatches follow-ups and recovers stale executions. | Fixes B5 and H1; makes campaigns survive restarts and run overnight |
| R2 | Move workers to a separate process (`npm run worker`) | Lets the web server restart or scale without killing sends |
| R3 | Sender health dashboard: daily sent vs cap, last error, warm-up stage, next allowed send time | The client can see why messages aren't going out |
| R4 | Alerting on send failures and auto-pauses (email or Slack; ntfy was removed) | Problems get noticed within minutes, not days |
| R5 | Playwright fallback for JS-only websites (M6) | Fills contact data on modern site builders |
| R6 | Use the website business profile in AI drafts (services, hours, booking link) | More specific, more personal first messages |
| R7 | Show website-derived services, hours and address as columns or filters in the leads grid | Faster triage |
| R8 | End-to-end browser tests (Playwright) for login, campaign, approve and send (dry-run) | Catches UI regressions before releases |
| R9 | Staging environment that mirrors production, with sending off | Safe place to test every release |

---

## 6. Deployment — step by step

> Work through this in order. Each step has an **expected result**. If a step doesn't
> match its expected result, stop and fix it before continuing.

### 6.1 Server requirements

- [ ] Always-on server or Hostinger Node.js hosting (no sleeping, no serverless, **one instance only**)
- [ ] Node.js **≥ 20.9** (22 LTS recommended) → `node -v`
- [ ] MySQL 8.0+ or MariaDB 10.6+, with a dedicated database and user
- [ ] HTTPS domain, e.g. `https://app.clientdomain.com`. HTTPS is required: production refuses insecure cookies.
- [ ] Outbound internet access to Apify, Gemini, Unipile, SMTP and lead websites
- [ ] At least 2 GB RAM for the build (`next build` is capped at 2 CPUs in `next.config.ts`)

### 6.2 Code freeze and local checks (on your machine)

```bash
git checkout mysql-port
git pull
npm ci
npm run prisma:validate        # expect: schema is valid
npm run typecheck              # expect: no output (0 errors)
npm run lint                   # expect: 0 errors (warnings OK)
npm test                       # expect: all deterministic suites PASS; DB suites need DATABASE_URL_TEST
npm run scan:secrets           # expect: no secrets found in tracked files
```

- [ ] Commit all changes and merge `mysql-port` → `main` (or deploy from a tag such as `v1.0.0`).
- [ ] **Deploy code and the database from the same commit.** Migrations must match the code.

### 6.3 Production environment variables

Set these in the host's environment panel or a server-only `.env`. **Never commit them, and never reuse the development keys: rotate first (H4).**

**Required**

| Variable | Value / rule |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | Port the host expects (Hostinger usually injects it) |
| `DATABASE_URL` | MySQL URL in the form `mysql://` + user + `:` + password + `@` + host + `:3306/` + db + `?connection_limit=5` (keep the limit small on shared hosting) |
| `AUTH_SECRET` | Random, **≥ 32 chars**: `openssl rand -base64 48` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Client admin login. The password must not be a default; the build rejects weak defaults |
| `APP_PUBLIC_URL` | `https://app.clientdomain.com` (used for unsubscribe links and webhooks) |
| `COOKIE_SECURE` | Leave unset or set `true`. **`false` makes the production build fail on purpose** |
| `GEMINI_API_KEY` | AI analysis and drafting |
| `APIFY_API_TOKEN` | Discovery and enrichment (if `SCRAPER_PROVIDER=apify`) |
| `UNIPILE_DSN`, `UNIPILE_API_KEY`, `UNIPILE_BASE_URL` | Instagram messaging |
| `UNIPILE_WEBHOOK_PATH_SECRET` | Long random string; part of the webhook URL |
| `EMAIL_CREDENTIALS_KEY` | Encryption key for stored SMTP passwords. **Keep it stable**: changing it makes saved SMTP passwords unreadable |
| `AI_AUTO_ENRICHMENT` | `false` for now: rule-based location + content filtering, AI run manually |
| `OUTREACH_SCHEDULER` | Leave unset (on in production) |

**Safety switches for the first deploy**

| Variable | First deploy | After the section 7 go-live |
|---|---|---|
| `OUTBOUND_SENDING_ENABLED` | **`false`** | `true` |
| `MESSAGING_PROVIDER` | `unipile` | `unipile` |
| `PAUSE_ALL_MESSAGING` / `EMERGENCY_STOP` | unset | unset (emergency use only; see B7) |
| `DISCOVERY_MAX_JOB_USD`, `APIFY_MAX_CHARGE_PER_JOB_USD`, `APIFY_MONTHLY_BUDGET_USD` | Set conservative caps | Tune with the client |
| `SENDER_DAILY_DEFAULT`, `SENDER_HOURLY_CAP`, `SENDER_COOLDOWN_SECONDS`, `WORKING_HOURS_START/END` | Conservative (e.g. 20/day, 4/h, 600 s) | Raise slowly as accounts warm up |

**Must NOT be set in production.** If any of these is set, the build fails or `/api/health/ready` returns 503:
`MOCK_UNIPILE`, `MOCK_GEMINI`, `APIFY_DRY_RUN`, `DISABLE_AUTH_RATE_LIMIT`, `SKIP_SEND_DELAYS`.

See `.env.example` for every optional tuning variable (discovery caps, Sparior, Google Maps cost controls, email caps).

### 6.4 Database

```bash
# 1. Back up first (if the DB already has data)
mysqldump --single-transaction --routines -h HOST -u USER -p DBNAME > pre_deploy_$(date +%F).sql

# 2. Apply migrations (never use "migrate dev" or "db push" in production)
npm run db:migrate:deploy
npm run db:migrate:status      # expect: "Database schema is up to date!"

# 3. Create the admin account (first deploy only)
npm run db:seed:admin
```

- [ ] Hostinger without remote MySQL access: run the migration SQL in phpMyAdmin, in order (see `docs/CUTOVER_RUNBOOK.md` §4–5). **Never edit an already-applied migration.**
- [ ] Moving existing PostgreSQL data: follow `docs/CUTOVER_RUNBOOK.md` exactly (ETL → verify → checksums → assign owner).

### 6.5 Build and start

```bash
npm ci
npm run build        # runs prisma generate + migrate deploy, then next build
npm start            # migrate deploy → resume unfinished discovery jobs → next start on $PORT
```

**Keep it running with PM2** (VPS):

```bash
npm i -g pm2
pm2 start npm --name instascraper -- run start
pm2 save
pm2 startup          # follow the printed command so it restarts on reboot
pm2 logs instascraper
```

**Hostinger Node.js app:** set the start command to `npm start` and the build command to `npm run build`. Set Node ≥ 20.9, enter the env vars from 6.3, and allow **1 instance**.

**Reverse proxy (VPS):** put Nginx or Caddy in front with HTTPS (Let's Encrypt), proxy to `localhost:$PORT`, and pass `X-Forwarded-For` / `X-Forwarded-Proto`. Add edge rate limiting (M2).

### 6.6 Post-deploy smoke test (sending still OFF)

```bash
curl -fsS https://app.clientdomain.com/api/health/ready
```

- [ ] Expect `status: "ready"`, `database_migrations: "up_to_date"`, `auth_secret: "configured"`, `cookie_secure: "secure"`, `rate_limiting: "enforced"`, providers `configured`, `outbound_sending: "disabled"`
- [ ] Log in as the admin → dashboard loads with the black/orange theme and no console errors
- [ ] Create a test campaign → run a **tiny** discovery (5–15 leads) → leads appear and costs stay inside the caps
- [ ] Open a lead with a website → **Find Contacts** → the Website Intel panel shows the business profile and contacts
- [ ] Upload a small CSV of leads → the import succeeds
- [ ] Add a handle to Do-Not-Contact → that lead shows as suppressed
- [ ] Generate AI drafts → they pass the quality gate and appear in the Review Queue
- [ ] The red "sending disabled" banner is visible (expected while `OUTBOUND_SENDING_ENABLED=false`)

### 6.7 Unipile webhook and senders

- [ ] In the Unipile dashboard, register: `https://app.clientdomain.com/api/webhooks/unipile/new-message/<UNIPILE_WEBHOOK_PATH_SECRET>` and `.../account-status/<UNIPILE_WEBHOOK_PATH_SECRET>`
- [ ] Settings → Instagram Senders → connect the client's accounts → status shows Connected
- [ ] Send a DM *to* a connected account from a personal account → it appears in the app as an inbound reply

### 6.8 Email (optional channel)

- [ ] Email page → add an SMTP account → send a test email to yourself
- [ ] SPF, DKIM and DMARC are set for the sending domain (the app shows DNS checks)
- [ ] The unsubscribe link in the test email works

---

## 7. Go-live: turning sending on safely

Do this only after the blockers B1–B7 are fixed and redeployed.

1. **Back up the DB** (6.4 step 1).
2. Set `OUTBOUND_SENDING_ENABLED=true` and restart: `pm2 restart instascraper`.
3. **Controlled live test:** one campaign, **3 leads you own** (internal test Instagram accounts), one sender.
   - [ ] Approve 3 drafts → send → all 3 arrive in Instagram from the **correct** sender (checks B2)
   - [ ] The message status in the app is `SENT`, with a provider message ID
   - [ ] Reply from one test account → the reply appears, is classified, and an AI reply draft is created
   - [ ] Re-send to the same lead → blocked as already contacted, and the sender is **not** paused (checks H2)
   - [ ] Lower `SENDER_HOURLY_CAP` to 1 and queue 3 → items are deferred, not failed (checks B3)
   - [ ] Set `EMERGENCY_STOP=true` → nothing sends (checks B7) → unset it
4. **Ramp up:** day 1–3 at 10–15 DMs per account per day; increase gradually over 2–3 weeks.
5. **Watch daily:** failed messages, auto-paused senders, Unipile account status.

---

## 8. Operations, monitoring & backups

| What | How | How often |
|---|---|---|
| App health | `GET /api/health/ready` via an uptime monitor (UptimeRobot or similar) | Every 5 min |
| Logs | `pm2 logs instascraper`, or Hostinger logs. Watch for `[STARTUP-RECOVERY]`, `[BULK]`, `[website-enrichment]`, MySQL errors 1213/1205 (deadlock/lock wait), "too many connections" | Daily |
| Provider spend | Apify console + the in-app budget page; Gemini usage | Weekly |
| Sender accounts | Settings → Senders: status, errors, auto-pauses | Daily during the first month |
| DB backups | hPanel automatic backups **plus** an off-host encrypted `mysqldump`. **Test a restore once.** | Daily |
| Key rotation | Unipile, Apify, Gemini, `AUTH_SECRET` (rotating logs users out) | On staff change, or every 6 months |
| Updates | Deploy a tagged commit → `npm ci && npm run build` → `pm2 restart` → re-run the 6.6 checks | Per release |

**Emergency stop:** set `OUTBOUND_SENDING_ENABLED=false` and restart. This is the reliable kill switch today; `EMERGENCY_STOP` only stops replies until B7 is fixed.

---

## 9. Rollback plan

1. Set `OUTBOUND_SENDING_ENABLED=false` and restart, to stop sends immediately.
2. Redeploy the previous tag: `git checkout <previous-tag> && npm ci && npm run build && pm2 restart instascraper`.
3. If a migration caused the problem, restore the pre-deploy `mysqldump`. Migrations are forward-only; do not hand-edit tables.
4. Re-run the 6.6 smoke test.

---

## 10. Client handoff checklist

- [ ] Blockers B1–B7 fixed, redeployed and verified by the section 7 live test
- [ ] H1–H3 fixed (follow-ups, ledger pauses, working-hours skips), or explained to the client as known limitations
- [ ] All provider keys rotated; production keys exist only on the server
- [ ] `npm test`, typecheck, lint and build pass on the deployed commit; the commit is tagged
- [ ] `/api/health/ready` returns `ready` on the production domain
- [ ] Uptime monitor and daily backups configured; one restore tested
- [ ] Client admin account created with a strong password; the client changes it at first login
- [ ] Client's Instagram senders connected; warm-up plan agreed
- [ ] Spend caps (Apify/Gemini) agreed with the client and set
- [ ] Client walkthrough done: create campaign → discover → review leads (Website Intel) → approve drafts → monitor sends → handle replies → DNC
- [ ] The client has a copy of section 11

---

## 11. What to tell the client (known limitations)

- **Instagram limits are real.** New accounts must warm up; sending too fast gets accounts restricted. The app enforces caps, but Instagram has the final say.
- **The server must stay on.** Campaigns run inside the app. If the server restarts, discovery resumes automatically. Message jobs and follow-ups currently need the scheduler fix (R1) to resume on their own.
- **Website data depends on the website.** Sites built only with JavaScript, or that block bots, may return little. Contact details are only as accurate as the business's own site.
- **AI drafts need human review.** The quality gate catches most problems, but approve before sending.
- **Costs scale with usage.** Apify, Gemini and Unipile bill per use or per account; the budget caps prevent surprises.
- **Compliance is the client's responsibility.** Respect opt-outs (handled automatically), local anti-spam laws (CASL in Canada, CAN-SPAM in the US, GDPR in the EU) and Instagram's terms.
