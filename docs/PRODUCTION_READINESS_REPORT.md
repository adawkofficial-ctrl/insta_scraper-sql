# Production Readiness Report (TASK 14)

Statuses: **PASS / FAIL / BLOCKED / SKIPPED / WARNING**. No claim of "100% secure" or
"guaranteed production ready".

## A. What was audited
package.json + scripts, next.config.ts, tsconfig, ESLint, Prisma schema + all migrations,
all `src/app/api/**` routes, `src/lib/**` services (auth, discovery, scraper/Apify,
messaging/Playwright, execution/workers, analytics, errors), components, middleware,
health endpoints, tests/scripts, environment usage, client/server boundaries, build output.

## B. What was changed
- `src/app/api/health/ready/route.ts` — new readiness probe (config + DB) with sanitized
  `configured`/`missing` states.
- Apify actor IDs are now env-overridable (`APIFY_PROFILE_ACTOR_ID`,
  `APIFY_DISCOVERY_ACTOR_ID`) with built-in defaults.
- `package.json` — added `typecheck`, `prisma:validate`, `prisma:generate`,
  `db:migrate:deploy`, `db:migrate:status` scripts (no destructive commands).
- `.env.example` — documented required vs optional vars + actor overrides.
- `docs/PRODUCTION_READINESS.md` — deployment/ops documentation.

## C. What was removed
Nothing deleted. No debug endpoints, mock production behavior, hardcoded credentials, or
`NEXT_PUBLIC_*` secrets were found to remove. Leftover debug `console.log`s in production
paths were already removed in TASK 11; remaining logging is the sanitizing `logger`.

## D. What was hardened
- **Migration drift fixed (major):** `BulkMessageJob`, `BulkMessageItem`, `MessageAttempt`
  were missing from migrations; `Message` columns (`providerMessageId`, `errorCode`,
  `idempotencyKey`, `contentHash`) and `MessageStatus.UNKNOWN` were also absent. Added
  baseline migrations (marked applied on the existing DB, no reset). Verified by
  `prisma migrate deploy` on an empty scratch DB → all tables created, and
  `migrate diff` → **"No difference detected"**.
- Readiness probe distinguishes config vs dependency failures without leaking secrets.
- Actor IDs configurable for production.

## E. Test results
`npm test` (TASK 13 runner, deterministic suites): **11 suites PASS / 0 FAIL / 0 BLOCKED /
4 SKIPPED — 557 assertions passed, 0 failed**.
Skipped (external Apify provider/budget): `test_task2_rich_profile_leads`,
`test_task3_lead_limits_hardening`, `test_step14_discovery`,
`test_step15_e2e_discovery_flow`.

## F. Build result
`npm run build` → **PASS (exit 0)**, no compile/type errors.

## G. Database / migration result
- `prisma format` → PASS; `prisma validate` → PASS ("schema is valid"); `prisma generate` → PASS.
- Fresh-database replay → **PASS** (all 11 tables); schema/migration drift → **none detected**.
- No `migrate reset` / `db push` used for deployment; production path is `migrate deploy`.

## H. Security findings
| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | Migration history incomplete (3 tables + Message columns/enum) → clean deploys would fail | **FIXED** (baseline migrations, verified replay) |
| 2 | Medium | No application-level rate limiting on sensitive endpoints | **WARNING / BLOCKED** (edge mitigation required; no limiter implemented) |
| 3 | Low | Dev-only advisories in Prisma CLI chain (`deepmerge-ts`, unused `mysql2`) | **WARNING** (breaking fix declined) |
| 4 | Low | No CSP / HSTS headers | **WARNING** (HSTS needs guaranteed HTTPS; CSP untested) |
| — | — | Tenant isolation / IDOR / secret leakage / error sanitization | Reviewed via TASK 12/13 suites — no new issues |

Client-bundle audit after build: 0 files containing `apify_api_`, `postgresql://`,
`DATABASE_URL`, `APIFY_API_TOKEN`, `AUTH_SECRET`, `PrismaClient`; 0 `server-only` leaks.
(One chunk contains the literal string "playwright" in a UI string — not a server import.)

## I. Deployment requirements (infrastructure owner)
See `docs/PRODUCTION_READINESS.md` §Deployment checklist. Highlights: PostgreSQL + backups,
`AUTH_SECRET` (≥32), `APIFY_API_TOKEN`, persistent browser profile for messaging, HTTPS at
edge (cookies become `secure`), edge rate limiting, single long-lived instance for in-process
workers, `prisma migrate deploy` on release.

## J. Known limitations
- Workers run in-process (no separate worker service/command).
- No application-level rate limiting.
- No CSP/HSTS configured.
- Campaign deletion cascades campaign-scoped data, including message-attempt audit rows.
- Real Instagram messaging cannot be verified without an authenticated session.
- `npm audit` dev-tooling advisories unresolved (breaking fix declined).

## K. BLOCKED items
- **Real Instagram messaging / Playwright send** — BLOCKED: no authenticated Instagram
  browser session available; must not fabricate success.
- **Authenticated browser UI E2E + real discovery runs** — BLOCKED/SKIPPED: require an
  authenticated session and Apify provider budget.
- **Rate limiting** — BLOCKED in-app (no limiter); requires edge/proxy configuration.

## L. SKIPPED items
- Apify provider suites (4) — skipped to avoid incurring real provider usage/cost.
- Browser UI verification suites — skipped (no authenticated session).

## M. Recommended next operational steps
1. Configure edge rate limiting + HTTPS/HSTS + CSP (test CSP against real assets first).
2. Decide on a separate worker process if horizontal scaling is required.
3. Add DB backup/restore drills and a staging rollback rehearsal.
4. Re-run the Apify-dependent suites with a funded token before launch.
5. Track the Prisma CLI advisories; upgrade when a compatible non-breaking release lands.
