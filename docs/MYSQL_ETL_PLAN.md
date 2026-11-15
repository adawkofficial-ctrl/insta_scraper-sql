# PostgreSQL → MySQL ETL Plan (Phase 4)

Source: **read-only** PostgreSQL `insta_scraper_prod`.
Targets: local MySQL 8.0 `insta_scraper_mysql_staging` and local MariaDB 10.11 `insta_scraper_mysql_staging`.
No hosted database, no Apify/Gemini/Unipile calls, no sends. Counts/ids only.

## Classification

- **MIGRATE**: real users, company profiles, campaigns, leads, candidates, jobs, sightings, status history, discovery coverage/outcomes, sender accounts, templates, messages/attempts, DNC, usage, notifications, drafts/reviews, AI jobs, follow-ups, webhook/unmatched rows.
- **CLEAN** (excluded from copy): dry-run/sample rows (`isDryRun=true`, `sample_*`, `*.example.com`, `55501`/`555-01`), users with `@example.com`, campaigns owned by those users or named `test`/`campaign a`/`sample`, and every row whose parent is excluded (cascade).
- **LEAVE**: none. Discovery caches are copied (small); no real table is intentionally left behind.
- **Never dropped**: real DoNotContact/suppression, messages/attempts, OutboundSendIdempotency, LeadEvents, status history, sender accounts, templates, users, profiles, campaigns, real leads. Test-owned rows are excluded, not deleted from source.

## Per-table source counts and exclusions (dry-run)

| Table | Source | Excluded (test/cascade) | Migrate |
|---|---:|---:|---:|
| User | 47 | 44 | 3 |
| CompanyProfile | 28 | 25 | 3 |
| Campaign | 31 | 30 | 1 |
| ScrapeJob | 18 | 0 | 18 |
| Candidate | 341 | 0 | 341 |
| Lead | 229 | 6 | 223 |
| LeadScoreFlag | 27 generated | 0 | 27 |
| LeadSighting | 45 | 0 | 45 |
| LeadStatusHistory | 8 | 1 | 7 |
| LeadEvent | 0 | 0 | 0 |
| DiscoveryCoverage | 44 | 1 | 43 |
| DiscoveryPlaceOutcome | 391 | 35 | 356 |
| InstagramSenderAccount | 4 | 4 | 0 |
| EmailSenderAccount | 0 | 0 | 0 |
| EmailCampaignSettings | 0 | 0 | 0 |
| EmailSend | 0 | 0 | 0 |
| EmailUnsubscribeToken | 0 | 0 | 0 |
| MessageTemplate | 9 | 9 | 0 |
| Conversation | 0 | 0 | 0 |
| Message | 7 | 7 | 0 |
| MessageAttempt | 0 | 0 | 0 |
| CampaignExecution | 0 | 0 | 0 |
| CampaignExecutionItem | 0 | 0 | 0 |
| BulkMessageJob | 0 | 0 | 0 |
| BulkMessageItem | 0 | 0 | 0 |
| OutboundSendIdempotency | 0 | 0 | 0 |
| DoNotContact | 1 | 1 | 0 |
| UsageLog | 174 | 0 | 174 |
| NotificationConfig | 0 | 0 | 0 |
| NotificationLog | 0 | 0 | 0 |
| MessageDraft | 0 | 0 | 0 |
| DraftReview | 0 | 0 | 0 |
| AiAnalysisJob | 0 | 0 | 0 |
| FollowUpMessage | 10 | 10 | 0 |
| UnipileWebhookEvent | 14 | 0 | 14 |
| UnmatchedInboundMessage | 10 | 0 | 10 |

Total: 1411 source, 173 excluded, 1265 target rows (including 27 generated LeadScoreFlag rows).

## Pre-flight scans

| Scan | Result |
|---|---|
| Over-length / strict-mode values | Initial 20 (`ScrapeJob.query` >191, `Lead.socialLink` >191). Fixed by `20261114020000_phase4_etl_long_strings`; final quarantine 0. |
| Case/accent collation collisions (username/email/domain/DNC) | **0 groups** |
| NULL/invalid NOT NULL, invalid enum, invalid JSON, invalid date/decimal | **0** (dry-run quarantine 0) |
| Source FK orphans (Lead→Campaign/User, Job/Candidate→Campaign, Candidate→Job, Sighting→Lead, Message→Campaign/Lead, DNC/Usage→User, FollowUp→Campaign) | **0** each |
| Rows referencing excluded rows | 173 cascaded exclusions (test-owned/cascade) |

## Secret / external-registration dependencies

Copied exactly as stored; never decrypted or printed:
- `InstagramSenderAccount.sessionPath` (Playwright session) and `unipileAccountId` — host/external account may require re-registration or session re-login at cutover.
- `EmailSenderAccount.smtpPasswordEncrypted` — depends on the application encryption key env; keep the same key or re-enter SMTP credentials.
- `NotificationConfig.ntfyAccessToken`/`ntfyTopic` and notification server URL — depends on env/key; topic may need re-subscription.
- `UnipileWebhookEvent` / Unipile webhook endpoint — webhook URL/secret is external and must be re-registered/rotated at cutover.
- `User.passwordHash` — copied as-is; no plaintext password exists.

## ETL tool

`scripts/etl/run.ts` (`npm run etl:mysql -- --source SOURCE_PG_URL --target MYSQL_STAGING_URL [--dry-run] [--tables a,b] [--resume] [--apply])`
- Default dry-run; `--apply` writes.
- Source opened `BEGIN TRANSACTION READ ONLY`, `REPEATABLE READ`.
- Batches 500, each batch transaction, upserts by primary key (idempotent).
- IDs and timestamps preserved; UTC `YYYY-MM-DD HH:MM:SS.mmm`.
- Arrays/Json through the typed schema shape; `Lead.availableChannels` → 5 booleans; `Lead.scoreFlags` → `LeadScoreFlag`; guard keys computed by the same function.
- Quarantine JSONL (`table,id,reason`) and non-zero exit unless `--allow-quarantine`.
- Target must be local and database name must contain `staging`.

`scripts/etl/verify.ts` (`npm run etl:verify -- ...`) checks per-table counts, id checksums, guard keys, channel booleans, DNC/message/attempt/idempotency/follow-up invariants, 200-lead/50-message field samples, and 100 timestamp round-trips.

## Rehearsal results

- Dry-run: 0 quarantine, 0 collisions, 0 orphans.
- Real run MySQL: 1265 written, 0 quarantine, 2.0 s, **~647 rows/s**.
- Verify MySQL: **82 PASS / 0 FAIL**.
- Repeat from empty staging: 1265 written, verify **82 PASS / 0 FAIL**.
- Resume test (partial tables + `--resume`): verify **82 PASS / 0 FAIL**.
- MariaDB staging: 1265 written, 0 quarantine, 1.3 s, **~981 rows/s**; verify **82 PASS / 0 FAIL**.

## Staging smoke (app run against staging)

`scripts/etl/smoke-staging.ts` (sending disabled):
- health 200, health/ready 200
- login 200
- campaign list = 1 real campaign
- campaign lead count = 223
- lead list/detail 200; lead has a sighting row; lead events readable
- 20 DNC entries added via API; all 20 case/whitespace variants suppressed

Result: **11 PASS / 0 FAIL**. The staging-only smoke admin owns the copied campaign; source was not modified.

## Phase 5 rehearsal (final)

- **TEXT widening** (migration `20261115000000_phase5_widen_external_text`): 27 external/long columns are `@db.Text`; no `DEFAULT` on TEXT/LONGTEXT. Strictness suite: **5 PASS / 0 FAIL** (3,000-char writes across text classes).
- **Production build/start**: `npm run build` PASS (webpack; `prisma generate` in `prebuild`). `npm start` runs startup recovery then `next start` on `PORT`; `/api/health/ready` returned `ready`, `mysql`, `8.0.46`, `database_migrations: up_to_date`. Required production overrides: `COOKIE_SECURE=true`, no `DISABLE_AUTH_RATE_LIMIT`.
- **Dump**: `etl:export-dump` produced `artifacts/mysql-dump/insta_scraper_staging.sql` (`parts=1`, 2.95 MB); import into MySQL and MariaDB then verify **82 PASS / 0 FAIL** on both.
- **Checksums**: `etl:checksums-sql` generates 37 table checks + 11 invariants; comparison against the imported dump **48 PASS / 0 FAIL**.
- **Startup recovery**: after a process restart with a persisted `RUNNING` job and `ENRICH_PENDING` candidate, recovery resumed the job, persisted the lead without paid actor calls, and completed the job (`PASS`; see `scripts/etl/recovery-smoke.ts`).
- **Preflight**: local MySQL 8.0.46 PASS (`utf8mb4_0900_ai_ci`, `innodb=yes`, `json=yes`, `max_connections=151`).
- **Final suites (commit `e071ce7`)**: MySQL 8.0.46 **73 PASS / 0 FAIL / 6 SKIPPED, 2681 assertions**; MariaDB 10.11 **73 PASS / 0 FAIL / 6 SKIPPED, 2672 assertions**; drift `No difference detected`; typecheck 0; lint 0 errors/6 pre-existing warnings.
- **Runbook**: `docs/CUTOVER_RUNBOOK.md`.

## Cutover TODOs

- Re-register Unipile accounts/webhooks; re-login or re-create Playwright sessions on the new host.
- Preserve the encryption key env or re-enter SMTP/ntfy secrets.
- Fill Hostinger facts (engine/version, plan, Remote MySQL/SSH, Node versions, limits) and run preflight against the hosted DB.
- Freeze writes, run final delta ETL + verify, switch connection string, keep PostgreSQL read-only rollback.
- Confirm 50k-row EXPLAIN/ANALYZE on the production-sized target and `max_connections`; lower `DATABASE_CONNECTION_LIMIT` if the plan caps user connections.
