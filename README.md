# InstaScraper — Instagram Campaign & Lead Engine SaaS

A full-stack Next.js + TypeScript SaaS platform for Instagram lead generation, profile scraping, message templating, AI personalization preview, and controlled human-in-the-loop campaign execution.

---

## Local Development

### 1. Installation
```bash
npm install
```

### 2. Environment Variables
Copy `.env.example` to `.env` and set your local configuration:
```bash
cp .env.example .env
```
Ensure `DATABASE_URL` and `AUTH_SECRET` (at least 32 characters) are set. Optional providers (`APIFY_API_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) can be added as needed.

### 3. Database Setup & Prisma Migration
Ensure your PostgreSQL database is running, then run Prisma schema generation and migrations:
```bash
npx prisma generate
npx prisma migrate dev
```

For validating database schema and migrations:
```bash
npx prisma format
npx prisma validate
```

### 4. Development Command
Start the Next.js local development server with hot reload:
```bash
npm run dev
```
Open [http://localhost:3001](http://localhost:3001) in your browser.

### 5. Production Build
Compile and verify the optimized production build:
```bash
npm run build
```

### 6. Production Start
Run the compiled production server:
```bash
npm run start
```

### 7. Test Workflow
Run static analysis, type checking, and the end-to-end QA verification suite:
```bash
# Static analysis and type checking
npm run lint
npx tsc --noEmit

# End-to-end full QA verification suite
npx tsx scripts/test_step13_full_qa.ts
```

---

## Demo Flow

Follow these 10 steps to demonstrate the end-to-end functionality:

1. **Login**: Navigate to `/login` and sign in with your credentials (or register a new user at `/register`).
2. **Create Campaign**: Click **"New Campaign"** on the dashboard, provide a title and optional description, and create the campaign.
3. **Scrape Small Test Set**: In the campaign detail view, enter public Instagram usernames or profile URLs in the profile scraper form to ingest profile leads.
4. **Review Leads**: Inspect the populated leads list, test search by username/full name, and filter by verified or business account status.
5. **Create Template**: Open the **Templates** section and create a reusable message template using variables like `{{firstName}}`, `{{username}}`, and `{{campaignName}}`.
6. **Generate AI Preview**: Select a lead and click **"Generate AI Preview"** to inspect the rendered personalized draft. Notice the content remains in draft status and is never sent automatically.
7. **Review Message**: Review the personalized message text in the composer, adjusting copy or tone as needed.
8. **Send One Controlled Test Message**: Click **"Send Controlled Test Message"** to dispatch to a single selected recipient with explicit confirmation.
9. **View Message History**: Inspect the message audit trail under the lead's history, verifying timestamp, delivery status, and message body.
10. **View Analytics**: Open the **Analytics** tab to view live stats computed directly from database records (total leads, verified count, business count, messages sent/failed, execution status).

---

## Health Check & Monitoring
The application includes a zero-credential health check endpoint:

```
GET /api/health
```

**Response (HTTP 200)**:
```json
{
  "status": "ok",
  "timestamp": "2026-09-19T14:40:00.000Z",
  "services": {
    "database": "connected"
  }
}
```

---

## Multi-Attribute Deduplication (Step 4)

The same person found by different searches/campaigns resolves to **one Lead per user**
(`Lead.userId` + normalized identity keys). Ingestion classifies every profile as `NEW`,
`HARD_DUPLICATE` (instagramUserId / usernameNormalized / profileUrl / emailNormalized) or
`SOFT_DUPLICATE` (websiteKey only). Hard duplicates enrich the existing lead fill-only
(never overwrite non-null with null; status / leadScore / aiAnalysis / DNC / lastContactedAt
untouched) and record a `LeadSighting` for the new campaign. Website-only matches create a
flagged lead (`possibleDuplicateOfLeadId`) cleared via
`POST /api/leads/:id/clear-duplicate-flag`.

Send selection excludes `duplicateOfLeadId` leads, excludes possible duplicates whose
canonical lead is CONTACTED+, and never selects anyone already contacted in any campaign.

### Identity backfill + duplicate tooling (run in this order)
1. `npx tsx scripts/backfill-identity.ts --dry-run`
2. `npx tsx scripts/backfill-identity.ts`
3. `npx tsx scripts/report-duplicates.ts` (writes `./tmp/report-duplicates-*.json`)
4. `npx tsx scripts/apply-duplicate-links.ts --dry-run`
5. `npx tsx scripts/apply-duplicate-links.ts --apply`

Nothing is ever deleted or merged destructively; rows are only linked/flagged.

### Partial unique guards (unmodelled by Prisma)
Migration `20260928130500_step4_dedup_unique_guards` adds three **partial** unique indexes
(`UNIQUE (userId, <key>) WHERE <key> IS NOT NULL AND duplicateOfLeadId IS NULL`) that are not
expressible in `schema.prisma`. Verified with
`prisma migrate diff --from-config-datasource --to-schema`: it currently reports **no drift**
(Prisma ignores unmodelled partial indexes). If a future Prisma version reports them as
`DROP INDEX`, **do not accept it** — they are the concurrency guard for duplicate inserts.
See the comment on the `Lead` model.

## Architecture & Security Principles
- **Multi-Tenant Data Isolation**: Every resource (Campaigns, Leads, ScrapeJobs, MessageTemplates, Messages, Executions) is ownership-verified via authenticated JWT sessions. IDOR attacks are rejected with 404 to prevent resource enumeration.
- **Human-in-the-Loop Safety**: Controlled test messaging only; no unattended bulk messaging, no credential harvesting, and no automated bot evasion techniques.
- **Production Headers**: Hardened with `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and restricted `Permissions-Policy`.

---

## Connecting an Instagram Sender Account

Messages are sent from **your own authorized Instagram account** through a dedicated Playwright browser session. Apify is used only for discovery/enrichment — never for sending. The app **never** stores your Instagram password, and never stores raw cookies or access tokens in the database.

How to connect an account:

1. Open **Settings** in the top navigation.
2. Open the **Instagram Sender Account** section.
3. Click **Connect Instagram Account**. The server launches a dedicated Playwright browser profile for this sender account and opens Instagram.
4. Log in to your own authorized Instagram account **manually** in that browser window.
5. Complete any 2FA, login confirmation, CAPTCHA, or security checkpoint **yourself**. The application does not automate or bypass these steps.
6. Return to the app and click **Verify Session**. The server checks that the session is authenticated and records the account as **Connected** with a last-verified time.
7. When composing a single message, or when starting a bulk message job, select this sender account. Only **Connected** accounts can dispatch.

Important notes:

- The Instagram session is stored only as a browser profile reference in `INSTAGRAM_SESSION_DIR` (default `./data/instagram-sessions/<userId>/<senderAccountId>/`); the directory is git-ignored and is never exposed through an API or the `public/` folder.
- The manual-login browser stays open until you verify or disconnect. A long safety timeout (`INSTAGRAM_MANUAL_LOGIN_TIMEOUT_MS`, default 15 minutes) eventually closes an abandoned login browser and moves the account to **Authentication Required**; normal short idle cleanup applies only to connected messaging sessions.
- The account must remain authorized. Instagram may expire the session at any time; when that happens the sender shows **Authentication Required** and you can reconnect and verify again.
- If Instagram presents a CAPTCHA, checkpoint, or rate limit, messaging **pauses** and surfaces the error instead of attempting to bypass it.
- `SESSION_UNAVAILABLE` / `AUTH_REQUIRED` means no message was sent — the app never marks a message SENT unless Instagram confirmed it in the browser.
- `Disconnect` closes the browser session and deletes the local profile directory for that sender account.

---

## Scraper Providers & Usage Tracking (Step 3)

The platform supports multiple Instagram discovery and profile enrichment providers behind unified `DiscoveryProvider` and `ProfileProvider` abstractions.

### Switching Providers
In your `.env`:
```bash
# Default: Apify (actors)
SCRAPER_PROVIDER="apify"
APIFY_API_TOKEN="your-apify-token"

# Or Sparior Pro (RapidAPI)
SCRAPER_PROVIDER="sparior"
SPARIOR_API_KEY="your-rapidapi-key"
SPARIOR_API_HOST="instagram-social.p.rapidapi.com"
```

When `SCRAPER_PROVIDER=sparior`, the application uses Sparior Pro via RapidAPI for search/discovery and profile retrieval, with:
- Exponential backoff retry policies for 5xx and 429 errors.
- Immediate fail-fast without retry for 401/403 authentication failures.
- Rate-limit and monthly quota header parsing (`x-ratelimit-requests-remaining`).
- Configurable per-run caps (`SPARIOR_MAX_REQUESTS_PER_RUN=50`, `SPARIOR_MAX_PAGES_PER_RUN=10`, `SPARIOR_MAX_PROFILES_PER_RUN=100`).
- Sequential pacing (`SPARIOR_REQUEST_DELAY_MS=250`).
- Monthly budget guard (`SPARIOR_MONTHLY_SOFT_LIMIT_PERCENT=90`).

### Usage and Quota Tracking
- Every HTTP request writes a fire-and-forget `UsageLog` record (tracking `provider`, `operation`, `requestCount`, `itemsReturned`, `quotaRemaining`).
- Each `ScrapeJob` stores a detailed discovery funnel in `usage`:
  - `requestsUsed`, `profilesReturned`, `malformedSkipped`, `duplicatesSkipped`, `filteredOutByRelevance`, `dncSkipped`, `newLeadsCreated`, `qualifiedLeads`, `errors`.
- Summary and ROI metrics are available via `GET /api/usage/sparior`, returning:
  - `requests`, `profiles`, `newLeads`, `qualifiedLeads`, `profilesPerRequest`, `newLeadsPerRequest`, `costPerRequest`, and `estimatedCostPerQualifiedLead`.

### Live Smoke Test
An optional live smoke test script tests real RapidAPI connectivity consuming at most 3 requests:
```bash
SPARIOR_LIVE_TEST=1 npx tsx scripts/smoke_sparior_live.ts
```

---

## Unipile Messaging & Webhook Integration (Step 8)

The application supports sending and receiving Instagram direct messages via [Unipile](https://www.unipile.com/) alongside local Playwright browser profiles. Senders are routed per-account based on `InstagramSenderAccount.connectionMethod` (`UNIPILE` vs `PLAYWRIGHT`).

### Environment Variables
Configure in your `.env`:
```bash
# Default fallback messaging provider for newly created senders: "playwright" | "unipile"
MESSAGING_PROVIDER="playwright"

# Unipile credentials & base URL
UNIPILE_DSN="api66.unipile.com"
UNIPILE_API_KEY="your-unipile-api-key"
UNIPILE_BASE_URL="https://api66.unipile.com"

# Webhook path secret for authenticating inbound webhook calls
UNIPILE_WEBHOOK_PATH_SECRET="your-secure-random-path-secret"
```

### Webhook Registration
To receive inbound Instagram direct messages and real-time account status updates, register webhooks with Unipile using either the Unipile Web Dashboard or the Unipile API.

#### Option A: Unipile Dashboard
1. Log in to your Unipile dashboard at [dashboard.unipile.com](https://dashboard.unipile.com).
2. Navigate to **Settings** / **Developers** -> **Webhooks**.
3. Create two webhook subscriptions (pointing to your public domain or ngrok tunnel):
   - **Inbound Messages**:
     - **URL**: `https://<YOUR_DOMAIN>/api/webhooks/unipile/new-message/<UNIPILE_WEBHOOK_PATH_SECRET>`
     - **Events**: `message_received`
   - **Account Status**:
     - **URL**: `https://<YOUR_DOMAIN>/api/webhooks/unipile/account-status/<UNIPILE_WEBHOOK_PATH_SECRET>`
     - **Events**: `account_status`

#### Option B: Unipile API
```bash
# 1. Register inbound message webhook
curl -X POST "https://${UNIPILE_DSN}/api/v1/webhooks" \
  -H "X-API-KEY: ${UNIPILE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "request_url": "https://<YOUR_DOMAIN>/api/webhooks/unipile/new-message/<UNIPILE_WEBHOOK_PATH_SECRET>",
    "events": ["message_received"]
  }'

# 2. Register account status webhook
curl -X POST "https://${UNIPILE_DSN}/api/v1/webhooks" \
  -H "X-API-KEY: ${UNIPILE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "request_url": "https://<YOUR_DOMAIN>/api/webhooks/unipile/account-status/<UNIPILE_WEBHOOK_PATH_SECRET>",
    "events": ["account_status"]
  }'
```

*Note: Any request received without the matching path secret will receive a generic HTTP 404 response to prevent endpoint discovery.*

---

## Push Notifications (ntfy.sh)

The application provides instant mobile and desktop push notifications via [ntfy.sh](https://ntfy.sh). It is completely free, requires no account or subscription, and supports iOS, Android, and web browsers.

### Mobile Setup (iOS / Android)
1. Install the free **ntfy** app from Google Play or Apple App Store.
2. Open the app and tap **+ (Subscribe to topic)**.
3. Enter your topic name (e.g., `Instagram_notification` or any unique topic string).
4. Tap **Subscribe**. That's it!

### In-App Configuration
1. In InstaScraper, navigate to **Settings** -> **Push Notifications (ntfy.sh)**.
2. Enter your topic name (`Instagram_notification`).
3. Leave Server URL as `https://ntfy.sh` (or specify your self-hosted instance).
4. Choose the notification events you wish to receive:
   - `Inbound Lead Replies`: Real-time push alert with a safe ~150 char preview whenever a prospect responds.
   - `High-Value Leads`: Immediate alert when a lead crosses the high score threshold (default: score ≥ 85).
   - `Session Expired`: Urgent notice when an Instagram sender requires re-authentication.
   - `Sender Account Errors`: Alert when a sender encounters a rate limit or dispatch failure.
   - `Provider & System Errors`: Immediate alert when Apify, Sparior, or Gemini run out of quota or fail authentication.
   - `Daily Activity Summary`: Past 24h recap of new leads, sent messages, and replies.
5. Click **"Save Settings"**, then click **"Send Test Push"** to verify delivery to your device.
