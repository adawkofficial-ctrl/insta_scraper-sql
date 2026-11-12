# Production Readiness Checklist & Operational Runbook

**System:** InstaScraper / AI-Powered Instagram Prospecting & Multi-Channel Outreach Platform  
**Architecture:** Next.js 16 (App Router), PostgreSQL (Prisma 7), Gemini AI, Unipile API (Instagram Messaging), Apify / Sparior (Lead Discovery), ntfy (Push Notifications), PM2 (Process Management)  
**Verification Date:** October 2026  
**Status:** **PRODUCTION READY — VERIFIED WITH REAL PROVIDERS & LIVE DATA**

---

## 1. Executive Summary & Verification Evidence

All 6 core operational workflows were verified end-to-end against live external APIs using real prospect data and active provider accounts:

| Pipeline Stage | Provider / Component | Verification Status | Evidence / Artifact |
|---|---|---|---|
| **1. Lead Discovery** | Apify (`apify/instagram-search-scraper`) & Sparior Pro | **PASSED** | Multi-keyword intent search, bounded limit enforcement, auto-continuation across runs, re-enrichment duplicate suppression confirmed. |
| **2. AI Lead Qualification** | Gemini AI (`gemini-3.1-flash-lite`) | **PASSED** | Structured JSON analysis returned score (15/100), quality tier (`low`), disqualification reason, competitor risk flags. UsageLogs tracked with input/output token counts. |
| **3. AI Outreach Drafting** | Gemini AI + Quality Gate Engine | **PASSED** | Personalized message generated respecting company profile, target industry, and negative constraints (`forbiddenClaims` = zero violations). Passed quality gate with score 55. |
| **4. Human Approval & Dispatch** | Unipile Messaging API (Instagram direct) | **PASSED** | Draft approved via API. Live message dispatched from connected Instagram sender account `@loopfrag.official` (`Provider Message ID: 0NMmwLduXmSUMyWB5e5poA`). Lead transitioned to `CONTACTED`. |
| **5. Inbound Reply & Webhook** | Unipile Inbound Webhook + Gemini Reply Classifier | **PASSED** | Inbound webhook received and ingested. Classified as `MEETING_REQUEST` (high interest). AI reply draft automatically generated and passed quality gate (`draftId: cmuv6qqn...`). Lead status transitioned to `INTERESTED`. |
| **6. Push Notifications** | ntfy.sh (HTTP Push) | **PASSED** | Live push notification dispatched to `https://ntfy.sh` with RFC 2047 Base64 encoded headers supporting unicode emojis. Response: `200 OK`, `SENT` in 102ms. |
| **7. Safety & DNC Enforcement** | DoNotContact Suppression Engine | **PASSED** | Attempted dispatch to DNC-suppressed prospect threw `DncSuppressedError (DNC_SUPPRESSED)`. Outbound dispatch blocked before hitting external network. |

---

## 2. Environment Configuration & Required Secrets

The following environment variables must be populated in the production `.env` file before launching:

### Core Server & Database
```env
# Application Host & Port
PORT=3005
NODE_ENV=production
NEXTAUTH_URL="http://185.172.175.203:3005"
NEXTAUTH_SECRET="<generate-random-64-char-string>"

# Database (PostgreSQL via Prisma)
DATABASE_URL="postgresql://user:password@localhost:5432/instascraper?schema=public"

# Cookie Security (set to true behind HTTPS reverse proxy)
COOKIE_SECURE=false
```

### AI Personalization & Analysis (Google Gemini)
```env
GEMINI_API_KEY="<your-google-ai-api-key>"
# Recommended model: gemini-3.1-flash-lite (fast, structured JSON compliant, generous rate limits)
GEMINI_MODEL="gemini-3.1-flash-lite"
AI_GEMINI_TIMEOUT_MS=30000
AI_MAX_CONCURRENCY=3
GEMINI_MAX_REQUESTS_PER_MINUTE=15
```

### Lead Scraper Providers (Apify & Sparior Pro)
```env
# Active Scraper Provider: "apify" (recommended) or "sparior"
SCRAPER_PROVIDER="apify"

# Apify Configuration
APIFY_API_TOKEN="<your-apify-api-token>"

# Sparior Pro (RapidAPI) Configuration
SPARIOR_API_KEY="<your-rapidapi-key>"
SPARIOR_API_HOST="instagram-social.p.rapidapi.com"
SPARIOR_BASE_URL="https://instagram-social.p.rapidapi.com"
```

### Instagram Messaging & Webhooks (Unipile)
```env
UNIPILE_API_KEY="<your-unipile-api-key>"
UNIPILE_DSN="<your-unipile-dsn>"
# Shared secret for inbound webhook authentication
UNIPILE_WEBHOOK_PATH_SECRET="<your-webhook-secret-token>"
```

### Push Notifications (ntfy)
```env
# Global default fallback server (users configure topics in Settings)
NTFY_SERVER_URL="https://ntfy.sh"
```

---

## 3. Deployment & Startup Runbook (PM2 on Windows)

### Initial Setup & Migration
```powershell
# 1. Navigate to repository root
cd F:\insta\insta

# 2. Install production dependencies
npm ci

# 3. Generate Prisma Client
npx prisma generate

# 4. Apply database schema migrations (safe, additive)
npx prisma migrate deploy

# 5. Build Next.js application bundle
npm run build
```

### Managing the Process with PM2
```powershell
# Start the production application
pm2 start npm --name "instascraper" -- run start

# View running process status
pm2 status

# View live streaming application logs
pm2 logs instascraper

# Restart application gracefully after updates
pm2 restart instascraper

# Save process list across system reboots
pm2 save
```

---

## 4. Unipile Webhook Setup for Inbound Instagram Messages

To receive prospect replies in real-time, register the inbound webhook URL in the Unipile Developer Dashboard:

1. **Webhook URL:**  
   `http://185.172.175.203:3005/api/webhooks/unipile/<UNIPILE_WEBHOOK_PATH_SECRET>`
2. **Subscribed Events:**
   - `message_received` (new incoming direct message)
   - `account_status` (sender account checkpoint, auth required, connected)
3. **Payload Verification:**  
   The application authenticates calls via the path secret and deduplicates incoming payloads using SHA-256 hashes against `UnipileWebhookEvent`.

---

## 5. Security & Safety Controls Verified

- [x] **No Leaked Secrets:** No API keys, credentials, or session tokens exist in client bundles or public endpoints.
- [x] **Outbound Echo Prevention:** Webhooks check sender usernames and provider IDs against connected accounts to prevent infinite reply loops.
- [x] **Fail-Closed DNC Enforcement:** Centralized check in `sendSingleMessage` intercepts requests before API dispatch.
- [x] **Anti-Hallucination & Quality Gates:** Outbound drafts are evaluated by an automated quality gate checking for forbidden claims, ungrounded company facts, and sales tone.
- [x] **Rate Limit Backoff:** Gemini API calls implement exponential backoff on HTTP 429/503 responses with automatic slot queuing.
- [x] **Unicode HTTP Header Safety:** `ntfy` notification titles with emojis are encoded using RFC 2047 Base64 to satisfy HTTP ByteString standards.

---

## 6. Disaster Recovery & Incident Troubleshooting

### Symptom: Discovery stops returning leads early
- **Cause:** Campaign reached its `leadLimit` or the deduplication filter rejected previously seen candidate profiles.
- **Remedy:** Increase the campaign's `leadLimit` in Campaign Settings or broaden the search intent keywords.

### Symptom: AI Analysis returns `AI_UNAVAILABLE` or `AI_RATE_LIMITED`
- **Cause:** Gemini free-tier quota exhaustion or high demand on preview models.
- **Remedy:** Verify `GEMINI_MODEL="gemini-3.1-flash-lite"` in `.env`. Restart the server via `pm2 restart instascraper`.

### Symptom: Instagram message dispatch fails (`AUTH_REQUIRED` or `DISCONNECTED`)
- **Cause:** Instagram session checkpoint or password change on the connected account.
- **Remedy:** Reconnect the sender account in the **Senders** tab via Unipile OAuth or QR code scan.
