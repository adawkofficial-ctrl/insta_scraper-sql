# Production Readiness — InstaScraper

Status legend: PASS / FAIL / BLOCKED / SKIPPED / WARNING. This document describes what
exists in the repository; it does not claim infrastructure is provisioned.

## Architecture

- **Next.js 16 (App Router, Node runtime)** — UI + API route handlers.
- **PostgreSQL via Prisma 7** (`@prisma/adapter-pg`, driver adapter).
- **Apify** (server-side only): `apify/instagram-search-scraper` (discovery) and
  `apify/instagram-profile-scraper` (enrichment).
- **Playwright** (server-side only) for controlled, human-in-the-loop Instagram DMs.
- **Workers run in-process** inside the Next.js server (bulk messaging + campaign
  execution). There is no separate worker process/bin. See "Worker lifecycle".

## Required environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (server-only) |
| `AUTH_SECRET` | Yes (prod) | ≥32 chars; auth fails closed in production if missing |
| `APIFY_API_TOKEN` | Yes for scraping | Server-only |
| `INSTAGRAM_BROWSER_PROFILE_DIR` | For messaging | Server-side persistent browser profile dir |
| `AI_PROVIDER` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | No | AI personalization (default `local`) |
| `APIFY_PROFILE_ACTOR_ID` / `APIFY_DISCOVERY_ACTOR_ID` | No | Optional actor overrides |
| `NODE_ENV` | Auto | `production` enables secure cookies + fail-closed checks |

`.env.example` contains names + safe placeholders only. **No secret may ever be
`NEXT_PUBLIC_*`.** Verified: no client component imports server-only modules and no
`NEXT_PUBLIC_*` usage exists.

## Database setup & migrations

```bash
npx prisma generate            # npm run prisma:generate
npx prisma migrate deploy      # npm run db:migrate:deploy   (production)
npx prisma migrate status      # npm run db:migrate:status
```

- **Never** run `prisma migrate reset` or `prisma db push` against production.
- Migration history was reconciled and verified: applying all migrations to an empty
  database creates every table and column with **no drift** ("No difference detected").

## Application start

```bash
npm run build
npm run start          # serves UI + API; in-process workers run here
```

There is no separate worker start command. Production implications: the process must
stay alive for background jobs; use a platform that does not freeze the process after
the HTTP response (not a short-lived serverless function).

## Health & readiness

- `GET /api/health` — liveness + DB ping (`{ status, services.database }`).
- `GET /api/health/ready` — readiness: `DATABASE_URL`, `AUTH_SECRET`, DB connectivity;
  returns `200 ready` / `503 not_ready` with only `configured`/`missing` states (no secrets).

## Apify configuration

- Token is read server-side only (`getApifyClient`), never logged or returned.
- Runs are bounded by the requested lead limit (`maxItems` + app-side cap 1–100).
- Actor error items are never persisted as empty leads.
- **Costs**: Apify usage is billed by your Apify account/actor usage.

## Instagram messaging requirements

Messaging requires an authenticated persistent browser profile. The app distinguishes
`AUTH_REQUIRED`, `SESSION_UNAVAILABLE`, `RECIPIENT_NOT_FOUND`, `COMPOSER_NOT_FOUND`,
`SEND_TIMEOUT`, `RATE_LIMITED`, `PLATFORM_BLOCKED`, `CAPTCHA_REQUIRED`,
`ACCOUNT_RESTRICTED`, `BROWSER_ERROR`, `NETWORK_ERROR`, `UNKNOWN`. It never bypasses
authentication/CAPTCHA/rate limits, never fabricates success, and never auto-retries an
`UNKNOWN` delivery. Cookies/session state are never logged or returned to clients.

## Rate limiting

No application-level rate limiter is implemented (WARNING). Protect sensitive endpoints
at the edge/proxy (login, discovery, enrichment, send, bulk, execution, retry). Do not
set limits so aggressive that normal campaign execution fails.

## Logging / observability

Structured `logger` with sanitization (connection strings, tokens, cookies, bearer,
JWTs, filesystem paths, stack frames stripped). Request correlation via `x-request-id`
(middleware → logs + response header). Never logged: passwords, cookies, tokens,
authorization headers, session storage.

## Backups & recovery

- Database backups are an **infrastructure responsibility** — none are configured by
  this repository.
- Rollback: deploy previous build + `prisma migrate deploy` (migrations are additive;
  test rollback against a staging copy first).
- Worker recovery: DB leases (`leaseUntil`/`heartbeatAt`) + `recover-stale` endpoints;
  unconfirmed sends become `UNKNOWN`, never auto-resent.

## Deployment checklist (infrastructure owner)

1. Provision PostgreSQL; set `DATABASE_URL`.
2. Set `AUTH_SECRET` (≥32 random chars) and `APIFY_API_TOKEN`.
3. Run `npm ci`, `npm run prisma:generate`, `npm run db:migrate:deploy`.
4. `npm run build` then `npm run start` (single long-lived instance per worker group).
5. Configure HTTPS at the edge; cookies become `secure` automatically in production.
6. Configure edge rate limiting + request logging (redacted).
7. Provision and mount the persistent browser profile for messaging (server-side).
8. Verify `/api/health` = 200 and `/api/health/ready` = 200.
9. Schedule DB backups and log retention.
10. Run the smoke checklist (below) with an authorized test account only.

## Smoke checklist (no unsolicited Instagram sends)

1. App loads; login/logout; register.
2. Create campaign; set intent/location/category/leadLimit.
3. Discovery endpoint responds (validation + 404 for foreign campaigns).
4. Leads persist and appear in the directory (pagination/filters).
5. Template create/render/preview (preview is non-sending).
6. Execution preflight + status; pause/resume/cancel transitions.
7. Analytics totals match DB.
8. `/api/health` and `/api/health/ready` = 200.
9. Messaging: only with an authorized test account and explicit confirmation.

## Known limitations

- In-process workers (no separate worker service).
- No application-level rate limiting.
- No CSP / HSTS configured (HSTS requires guaranteed HTTPS; CSP untested dependencies).
- Campaign deletion cascades campaign-scoped data incl. message-attempt audit rows.
- Dependency advisories in the Prisma **CLI** chain (dev tooling) — breaking fix declined.
- Real Instagram messaging cannot be verified without an authenticated session.
