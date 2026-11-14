# PostgreSQL → MySQL Conversion Audit

**Status:** read-only audit. No code, schema, migrations, or data were changed. No secrets are included.
**Project:** `insta_scraper` (Next.js + Prisma 7 + PostgreSQL).
**Audit date:** 2026-11-14.

## Executive summary

The application is tightly coupled to PostgreSQL in four places:

1. **11 scalar-list fields** (`String[]`, `Int[]`, enum array). Prisma does not support scalar lists on MySQL; these need join tables or JSON + repository mapping.
2. **Case-insensitive Prisma filters** (`mode: "insensitive"`) in 18 places. MySQL/Prisma does not support `mode`; behavior must be reproduced with normalized columns or collation, especially in DNC/suppression and messaging search.
3. **PostgreSQL-only migration DDL**: enum types (`CREATE/ALTER TYPE`), `JSONB`, `TEXT[]`/`INTEGER[]`, partial unique indexes, `ON CONFLICT`, `DISTINCT ON`, `::` casts, `DO $$`, `pg_constraint`, `md5(random()::text)`.
4. **PostgreSQL wire/adapter assumptions**: `provider = "postgresql"`, `@prisma/adapter-pg`, `PrismaPg` in ~30 scripts, PostgreSQL `CREATE DATABASE` test setup, and a Postgres-specific savepoint workaround in dedup.

The send gate / idempotency path has one raw row-lock (`SELECT ... FOR UPDATE`) and relies on a composite unique idempotency key plus a sender-row lock. MySQL can express these, but transaction isolation and gap-lock behavior differ and must be re-tested under concurrency.

**Recommendation: keep PostgreSQL on a VPS/external host.** The conversion is a multi-week project with direct compliance and outbound-safety risk. Unless MySQL is a hard business/hosting constraint, the expected cost (roughly **280–440 engineering hours**, plus contingency) is much higher than running Postgres on a managed/VPS host.

---

## 1. Prisma schema inventory

### 1.1 Scalar lists (unsupported on MySQL)

Prisma MySQL does not support scalar lists. Each field below must become either a join table (preferred where the field is filtered) or a `Json` column plus mapping code (acceptable for display/prompt-only arrays).

| Model.field | Type | schema line | App references |
|---|---|---:|---:|
| `Campaign.followUpDelayDays` | `Int[]` | 283 | 33 |
| `Campaign.followUpTemplates` | `String[]` | 284 | 32 |
| `Campaign.customNegativeKeywords` | `String[]` | 321 | 16 |
| `Campaign.customPositiveKeywords` | `String[]` | 322 | 20 |
| `Lead.availableChannels` | `String[]` | 391 | 115 |
| `Lead.previousUsernames` | `String[]` | 406 | 7 |
| `Lead.scoreFlags` | `String[]` | 425 | 26 |
| `CompanyProfile.targetIndustries` | `String[]` | 1187 | 61 |
| `CompanyProfile.targetCountries` | `String[]` | 1188 | 32 |
| `CompanyProfile.forbiddenClaims` | `String[]` | 1194 | 58 |
| `NotificationConfig.eventTypes` | `NotificationEventType[]` | 1369 | 29 |

Critical filters that will not translate as-is:

- `src/lib/services/lead/lead-service.ts:228,236,244,272` — `availableChannels: { has: ... }`.
- `src/lib/services/lead/lead-service.ts:348` — `scoreFlags: { hasSome: flags }`.

Everything else is read/join/prompt/UI usage and can be mapped through a repository layer.

### 1.2 Enums (32)

MySQL supports enums, but not PostgreSQL `CREATE TYPE`; Prisma MySQL emits inline `ENUM(...)` columns. Adding values later requires `ALTER TABLE ... MODIFY COLUMN`, which rebuilds the table and has different locking behavior.

```text
CampaignStatus (8): DRAFT, READY, RUNNING, PAUSED, COMPLETED, PARTIAL, FAILED, CANCELLED
ExecutionMode (2): MANUAL, REVIEW_REQUIRED
CampaignExecutionStatus (9): PREVIEW, DRAFT, READY, RUNNING, PAUSED, COMPLETED, PARTIAL, FAILED, CANCELLED
CampaignExecutionPhase (5): DISCOVERY, ENRICHMENT, READY, MESSAGING, FINALIZING
ExecutionItemStatus (7): PENDING, APPROVED, SENDING, SKIPPED, SENT, FAILED, SUPPRESSED_DNC
ScrapeJobStatus (5): PENDING, RUNNING, COMPLETED, COMPLETED_WITH_WARNINGS, FAILED
InstagramSenderSessionType (2): PERSISTENT_PROFILE, STORAGE_STATE
InstagramSenderStatus (10): CONNECTING, CONNECTED, AUTH_REQUIRED, EXPIRED, ERROR, DISCONNECTED, ACTIVE, WARMING, PAUSED, NEEDS_ATTENTION
ConnectionMethod (2): PLAYWRIGHT, UNIPILE
MessageStatus (5): DRAFT, SENDING, SENT, FAILED, UNKNOWN
LeadStatus (14): NEW, ENRICH_PENDING, QUALIFYING, QUALIFIED, READY_FOR_OUTREACH, QUEUED, CONTACTED, REPLIED, INTERESTED, FOLLOW_UP, MEETING, CONVERTED, NOT_INTERESTED, DO_NOT_CONTACT
AiStatus (4): PENDING, DONE, FAILED, SKIPPED
DncChannel (4): INSTAGRAM, EMAIL, PHONE, ALL
DncIdentifierType (5): USERNAME, INSTAGRAM_ID, EMAIL, DOMAIN, PHONE
DncSource (4): MANUAL, REPLY_OPT_OUT, UNSUBSCRIBE, IMPORT
MessageDirection (2): OUTBOUND, INBOUND
MessageChannel (2): INSTAGRAM, EMAIL
UsageProvider (5): SPARIOR, APIFY, GEMINI, ZAPIER, OTHER
DraftStatus (7): DRAFT, APPROVED, REJECTED, SUPERSEDED, SENT, PENDING_REVIEW, BLOCKED
DraftReviewAction (8): APPROVE, REJECT, EDIT, REGENERATE, RECHECK, OVERRIDE_WARNING, AUTO_APPROVE, REVOKE_APPROVAL
RejectReason (7): TOO_GENERIC, WRONG_FACT, TOO_SALESY, BAD_TONE, NOT_TARGET, TOO_LONG, OTHER
LeadEventType (8): SENT, DELIVERED, REPLIED, POSITIVE_REPLY, NEGATIVE_REPLY, UNSUBSCRIBE_OR_DNC, MEETING_BOOKED, WON
ReplyIntent (8): INTERESTED, PRICE_REQUEST, MEETING_REQUEST, QUESTION, NOT_INTERESTED, OUT_OF_OFFICE, FOLLOW_UP_LATER, UNCLEAR
DraftKind (2): OUTREACH, REPLY
ApprovalMode (2): MANUAL, AUTO_ELIGIBLE
AiAnalysisJobStatus (6): PENDING, RUNNING, COMPLETED, FAILED, CANCELLED, PAUSED
BulkMessageJobStatus (8): DRAFT, QUEUED, RUNNING, PAUSED, COMPLETED, PARTIAL, FAILED, CANCELLED
BulkMessageItemStatus (8): QUEUED, PROCESSING, SENT, FAILED, SKIPPED, CANCELLED, UNKNOWN, SUPPRESSED_DNC
UnipileWebhookStatus (4): RECEIVED, PROCESSED, IGNORED, FAILED
NotificationEventType (6): LEAD_REPLIED, HIGH_VALUE_LEAD, SENDER_ERROR, SESSION_EXPIRED, SYSTEM_ERROR, DAILY_SUMMARY
NotificationLogStatus (3): SENT, FAILED, SKIPPED_DISABLED
FollowUpStatus (8): SCHEDULED, SENT, CANCELLED_REPLIED, CANCELLED_DNC, CANCELLED_MANUAL, NEEDS_EDIT, FAILED, SKIPPED
```

### 1.3 Json columns (MySQL `JSON` is supported; `JSONB` is not)

| Model.field | schema line |
|---|---:|
| `Lead.relatedProfiles` | 364 |
| `Lead.latestPosts` | 365 |
| `Lead.rawProfileData` | 366 |
| `Lead.aiAnalysis` | 395 |
| `Lead.scoreBreakdown` | 424 |
| `Lead.acquisitionCostBreakdown` | 438 |
| `ScrapeJob.usage` | 550 |
| `ScrapeJob.costBreakdown` | 553 |
| `DiscoveryCoverage.placeIds` | 575 |
| `Candidate.socialLinks` | 624 |
| `Candidate.rawPlaceData` | 625 |
| `Message.aiAnalysis` | 769 |
| `MessageTemplate.variants` | 803 |
| `UsageLog.metadata` | 1165 |
| `CompanyProfile.services` | 1186 |
| `CompanyProfile.preferredLength` | 1192 |
| `CompanyProfile.exampleMessages` | 1196 |
| `MessageDraft.personalizationPointsUsed` | 1221 |
| `MessageDraft.generationMeta` | 1222 |
| `MessageDraft.qualityResult` | 1228 |
| `MessageDraft.warningOverrides` | 1241 |
| `DraftReview.meta` | 1269 |
| `AiAnalysisJob.options` | 1293 |
| `LeadEvent.metadata` | 1401 |

JSON filters in application code:

- `src/lib/services/lead/lead-service.ts:306` and `:315` — `rawProfileData: { path: ["enrichmentStatus"], ... }`. Prisma's JSON `path` filtering is PostgreSQL-oriented; MySQL requires JSON path syntax (`$.enrichmentStatus`) and different null semantics.

### 1.4 Native type attributes / Postgres-only Prisma features

- `@db.*` attributes: **4 only**, all portable decimal types:
  - `Lead.acquisitionCostUsd` line 435 — `@db.Decimal(10, 4)`
  - `ScrapeJob.costUsd` line 552 — `@db.Decimal(10, 4)`
  - `Candidate.costUsd` line 605 — `@db.Decimal(10, 4)`
  - `UsageLog.estimatedCostUsd` line 1163 — `@db.Decimal(12, 6)`
- No `@db.Uuid`, `@db.JsonB`, `@db.Citext`, `@db.Inet`, `@db.Array`, or other PostgreSQL-only native types.
- `mode: "insensitive"`: **18 uses** (MySQL/Prisma does not support `mode`):
  - `src/lib/services/compliance/dnc-service.ts:830,845,856,976,981,987,1093`
  - `src/lib/services/lead/lead-service.ts:110,111,112,124,125`
  - `src/lib/services/messaging/bulk-messaging-service.ts:315,316,317,326,327`
  - `src/lib/services/unipile/webhook-service.ts:526`
- `createMany`: **10 calls**; `skipDuplicates`: **0 calls**. `createMany` is supported by MySQL; no `INSERT ... ON CONFLICT DO NOTHING` behavior is currently used.
- `PrismaPg` / `@prisma/adapter-pg`: **~30 files / 60 occurrences**. `src/lib/db/prisma.ts` and every script that constructs its own client use the Postgres driver adapter.
- Datasource provider is `postgresql`; `prisma7.config.ts` uses `DATABASE_URL`, `DIRECT_URL`, `SHADOW_DATABASE_URL`.
- Test DB guard/setup use PostgreSQL-specific database creation and URL handling: `scripts/test_db_guard.cjs`, `scripts/setup-test-db.cjs`, `scripts/run-all-tests.ts`.

**String sizing risk:** 354 `String` fields have no native annotation. Prisma's MySQL connector maps unannotated `String` to `VARCHAR(191)`, whereas PostgreSQL maps it to `text`. Long fields need `@db.Text`/`@db.MediumText`/`@db.LongText` (e.g. `Message.body`, `Message.messageText`, `Message.errorMessage`, `EmailSend.body`, `MessageTemplate.body`, `MessageDraft.body/editedBody`, `Lead.biography`, `ScrapeJob.errorMessage`, `CompanyProfile.description`, `FollowUpMessage.*`, `NotificationLog` fields). Missing annotations can silently truncate or throw on insert depending on MySQL strict mode.

---

## 2. Raw SQL inventory

All matches were found with `rg`-equivalent search for `$queryRaw`, `$executeRaw`, `$queryRawUnsafe`, `$executeRawUnsafe`, plus PostgreSQL operators.

| File:line | SQL / purpose | PG-specific? | Send gate / idempotency / locking? |
|---|---|---|---|
| `src/app/api/health/ready/route.ts:113` | `SELECT 1` database ping | No | No |
| `src/app/api/health/ready/route.ts:118` | `SELECT migration_name, rolled_back_at FROM _prisma_migrations ...` | Low: Prisma migration table exists in MySQL; verify column naming/`finished_at` semantics | No |
| `src/app/api/health/route.ts:13` | `SELECT current_database() AS name` | **Yes** (`current_database()`); MySQL uses `DATABASE()` | No |
| `src/lib/services/dedup/dedup-service.ts:258,261,264,265` | `SAVEPOINT`, `RELEASE SAVEPOINT`, `ROLLBACK TO SAVEPOINT` around dedup upserts | Supported by MySQL, but the workaround exists because PostgreSQL aborts the whole transaction on a unique violation (25P02). MySQL does not abort the transaction on duplicate-key; semantics must be re-tested. | **Dedup / idempotency** |
| `src/lib/services/messaging/send-gate.ts:1143` | `SELECT id FROM "InstagramSenderAccount" WHERE id = ${...} FOR UPDATE` | `FOR UPDATE` works in InnoDB; double-quoted identifier must become backtick/Prisma-safe. Row lock + idempotency composite key protect concurrent slot allocation. | **Send gate / locking / idempotency** |
| `scripts/check_counts.ts:13` | `SELECT count(*) ... FROM "Campaign" WHERE "companyProfileId" IS NULL` | Only identifier quoting | No |
| `scripts/preflight.ts:207` | `SELECT 1` | No | No |
| `scripts/seed_admin_account.ts:44` | `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "role" ...` | `ADD COLUMN IF NOT EXISTS` is version-dependent in MySQL; remove and rely on migrations | No |
| `scripts/test_migration_backfill.ts:18,21,24,27,51,73,74,75,76` | PG DDL/backfill: `DROP INDEX`, `ADD COLUMN IF NOT EXISTS`, `SET NOT NULL`, `ADD CONSTRAINT`, `DISTINCT ON`, `md5(random()::text)`, `'[]'::jsonb`, `'{}'::text[]`, `NOW()` | **Yes, extensively** | No (test-only) |
| `scripts/test_ntfy_notifications.ts:109` | `SELECT column_name FROM information_schema.columns WHERE table_name = 'NotificationLog'` | Mostly portable; verify MySQL schema/case filter | No |
| `scripts/test_step8_unipile_webhooks.ts:84` | `UPDATE "InstagramSenderAccount" SET "connectionMethod" = ... WHERE "sessionPath" LIKE ...` | Double-quoted identifiers; `REPLACE`/`LIKE` portable | No |
| `scripts/test_step_company_profile_per_campaign.ts:356,361` | Raw `count(*)` / `LEFT JOIN` verification with quoted identifiers | Only identifier quoting | No |

No application raw SQL uses `ILIKE`, `RETURNING`, `ON CONFLICT`, `DISTINCT ON`, array operators (`@>`, `<@`, `&&`), `generate_series`, or JSONB operators. Those appear only in migrations/tests (see §3).

**Locking / send gate detail**

- `reserveSendSlot` (`src/lib/services/messaging/send-gate.ts:1051`) runs an interactive transaction; line 1143 locks the sender row; line 1253 upserts `OutboundSendIdempotency` on the composite key `(campaignId, leadId, step)`; lines 1171–1180 reject a still-reserved duplicate.
- `OutboundSendIdempotency` has a unique index on `(campaignId, leadId, step)` (`20261107140000_outbound_send_safety_gate/migration.sql:47`).
- MySQL InnoDB supports `FOR UPDATE`, but Prisma's MySQL default isolation is `REPEATABLE READ` (Postgres/Prisma commonly runs `READ COMMITTED`). Gap locks, deadlock behavior, and `SELECT ... FOR UPDATE` with non-indexed predicates differ. This path must be load-tested with concurrent reservations before cutover.
- `SAVEPOINT` in `dedup-service.ts` is not needed on MySQL for duplicate-key handling, but removing/changing it changes error recovery semantics; test P2002 race paths.

---

## 3. Migration inventory (PostgreSQL-specific SQL)

Every one of the 40 migrations uses Prisma-style **double-quoted CamelCase identifiers**. MySQL accepts backticks and is case-sensitive for table names on Linux by default (`lower_case_table_names=0`), so the migration history cannot be edited in place; it should be regenerated for MySQL and the existing database converted separately.

Feature matrix (generated from `prisma/migrations/*/migration.sql`):

```text
20260919105726_init_campaign_leads: enumDDL, quotedIdentifiers
20260919131804_lead_created_at_and_scrape_job_cascade: quotedIdentifiers
20260919133430_add_message_model: enumDDL, quotedIdentifiers
20260919133435_message_production_columns: quotedIdentifiers
20260919133440_message_status_unknown: enumDDL, quotedIdentifiers
20260919134121_add_message_template_model: quotedIdentifiers
20260919135051_add_campaign_execution_models: enumDDL, quotedIdentifiers
20260919142000_add_user_and_campaign_ownership: onConflict, quotedIdentifiers
20260919171418_add_lead_rich_fields_and_sending_status: enumDDL, jsonb, quotedIdentifiers
20260919184527_add_discovery_fields: quotedIdentifiers
20260919202357_add_task2_rich_profile_fields: jsonb, quotedIdentifiers
20260920083000_add_bulk_messaging_tables: enumDDL, quotedIdentifiers
20260920085000_task8_campaign_execution_engine: enumDDL, quotedIdentifiers
20260920090000_add_instagram_sender_account: enumDDL, quotedIdentifiers
20260928090009_step1_lead_status_and_foundation: enumDDL, jsonb, quotedIdentifiers
20260928093436_step2_add_suppressed_dnc_enums: enumDDL, quotedIdentifiers
20260928125227_step3_add_scrape_job_usage_and_stop_reason: jsonb, quotedIdentifiers
20260928130000_step4_dedup_identity: arrays, casts, quotedIdentifiers
20260928130500_step4_dedup_unique_guards: doBlock, partialIndex, quotedIdentifiers
20260928160000_step5_ai_analysis: enumDDL, jsonb, arrays, casts, quotedIdentifiers
20260928161314_step6_quality_and_approval: enumDDL, jsonb, quotedIdentifiers
20260928162123_step6_draft_send_items: quotedIdentifiers
20260928163000_step6_draft_item_unique: quotedIdentifiers
20260930213000_add_lead_contact_channels_and_phone: arrays, casts, quotedIdentifiers
20261001110000_step_company_profile_per_campaign: jsonb, arrays, distinctOn, casts, nowFunc, addColIfNotExists, dropIfExists, quotedIdentifiers, md5Random
20261001160000_step8_unipile_webhook_inbound_schema: enumDDL, quotedIdentifiers
20261002042402_step9_reply_intent_and_drafts: enumDDL, quotedIdentifiers
20261003093000_add_lead_social_link_and_platform: quotedIdentifiers
20261003111509_add_notifications_config_and_logs: enumDDL, arrays, casts, quotedIdentifiers
20261107102000_add_gmaps_and_multichannel_leads: enumDDL, addColIfNotExists, quotedIdentifiers
20261107123500_add_lead_quality_score_and_chain_detection: jsonb, arrays, casts, addColIfNotExists, quotedIdentifiers
20261107140000_outbound_send_safety_gate: enumDDL, doBlock, pgConstraint, addColIfNotExists, quotedIdentifiers
20261107160000_outcome_tracking_and_analytics: enumDDL, jsonb, quotedIdentifiers
20261108100000_add_follow_ups: enumDDL, arrays, casts, quotedIdentifiers
20261108110000_sync_schema_drift: addColIfNotExists, quotedIdentifiers
20261109120000_add_dry_run_isolation: casts, addColIfNotExists, quotedIdentifiers
20261110120000_add_group_dedup_and_handle_enrichment: addColIfNotExists, quotedIdentifiers
20261110130000_add_discovery_coverage: jsonb, quotedIdentifiers
20261111070000_add_email_channel: quotedIdentifiers
20261113000000_add_candidate_and_statuses: enumDDL, jsonb, quotedIdentifiers
```

Highest-risk migrations:

- `20260928130500_step4_dedup_unique_guards` — three **partial unique indexes** (`WHERE ... IS NOT NULL AND duplicateOfLeadId IS NULL`) and a `DO $$ ... RAISE EXCEPTION` block. MySQL 8 does not support partial indexes. Options: generated columns + unique indexes, triggers, or application-level locking (weaker). This is the final concurrency guard for duplicate leads.
- `20261107140000_outbound_send_safety_gate` — `ALTER TYPE ... ADD VALUE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DO $$`/`pg_constraint`, and the idempotency table/index creation.
- `20260928160000_step5_ai_analysis`, `20261108100000_add_follow_ups`, `20260930213000_add_lead_contact_channels_and_phone`, `20261003111509_add_notifications_config_and_logs` — array columns (`TEXT[]`, `INTEGER[]`, enum arrays).
- `20261001110000_step_company_profile_per_campaign` — `DISTINCT ON`, `md5(random()::text || clock_timestamp()::text)`, `'[]'::jsonb`, `'{}'::text[]`, `NOW()`.
- `20260919142000_add_user_and_campaign_ownership` — `ON CONFLICT ("id") DO NOTHING`.
- `20261109120000_add_dry_run_isolation` — `"usage"->>'isDryRun'`, `"usage"::text LIKE`, `::boolean` casts.
- All enum migrations — `CREATE TYPE ... AS ENUM` and `ALTER TYPE ... ADD VALUE` (MySQL uses inline enum columns or lookup tables).

---

## 4. Test / tooling impact

All **70 suites** in `scripts/run-all-tests.ts` depend on the PostgreSQL test harness (Postgres URL guard, `scripts/setup-test-db.cjs`, Prisma PG adapter, 40 migrations, Postgres-specific `CREATE DATABASE`/shadow DB). That is a baseline conversion cost independent of test content.

Suites with direct dependency on the risky features:

| Suite | Why it is affected |
|---|---|
| `test_step1_schema.ts` | Asserts schema shape, enums, scalar-list columns, JSON columns, indexes |
| `test_step2_dnc.ts` | DNC/suppression; case-insensitive matching and enum channels |
| `test_step4_dedup.ts` | Partial unique indexes, savepoints, `previousUsernames` array, duplicate races |
| `test_step6_quality_approval.ts` | Draft enums, `qualityResult` JSON, approval transactions |
| `test_step8_unipile_webhooks.ts` | Raw `UPDATE` with quoted identifiers; webhook enums/JSON |
| `test_step9_reply_intent_and_drafts.ts` | Reply enums and draft JSON |
| `test_step9_reply_send.ts` | Send gate/idempotency transactions |
| `test_task3_lead_limits_hardening.ts` | Campaign scalar lists, `leadLimit`, API boundary behavior |
| `test_task4_templates.ts` | JSON `variants` and template CRUD |
| `test_task5_single_lead_messaging.ts` | Send gate/idempotency |
| `test_task6_bulk_messaging.ts` | Bulk idempotency, `createMany`, channel arrays |
| `test_task7_messaging_safety.ts` | Send gate, DNC, suppression |
| `test_task8_execution_engine.ts` | Execution enums, interactive transactions, lease/locking |
| `test_task9_ui_execution_hardening.ts` | Execution enums and transaction state |
| `test_task10_analytics_hardening.ts` | JSON metadata and decimal aggregation |
| `test_task12_security_qa.ts` | DNC/case-insensitive lookups and tenant isolation |
| `test_task13_e2e_regression.ts` | End-to-end send gate / idempotency |
| `test_outbound_send_safety.ts` | `FOR UPDATE` path, concurrent reservation cap, idempotency |
| `test_outbound_kill_switch.ts` | Send gate |
| `test_pre_pilot_safety.ts` | Send gate / outbound safety |
| `test_follow_up_messages.ts` | `FollowUpStatus` enum, JSON raw data, send path |
| `test_enrichment_persistence_resume.ts` | `rawProfileData` JSON, status enums, persistence |
| `test_website_enrichment.ts` | JSON contacts/criteria, status enums, candidate persistence |
| `test_lead_pipeline_optimization.ts` | JSON `rawProfileData` path filter |
| `test_ntfy_notifications.ts` | `NotificationConfig.eventTypes` enum array; `information_schema` raw SQL |
| `test_step_company_profile_per_campaign.ts` | Raw count/join SQL, JSON `services`, text arrays |
| `test_migration_backfill.ts` | PostgreSQL DDL/backfill (not part of the standard runner) |
| `test_dry_run_isolation_and_messages.ts` | Dry-run backfill relies on JSON operators/casts in migration |
| Discovery/enrichment suites (`test_google_maps_discovery`, `test_gmaps_toronto_pipeline`, `test_post_maps_pipeline`, `test_google_maps_cost_reduction`, `test_apify_cost_guard`, `test_lazy_profile_enrichment`, `test_discovery_fixes`, `test_dm_no_handle_block`) | JSON usage/blobs, status enums, `availableChannels`/`scoreFlags` arrays, campaign arrays |
| External suites (`test_task2_rich_profile_leads`, `test_task3_lead_limits_hardening`, `test_step14_discovery`, `test_step15_e2e_discovery_flow`, `test_task19_sender_ui_lifecycle`, `test_task22_campaign_no_poll`) | Skipped by default, but must be re-validated on MySQL when enabled |

Also affected tooling: `scripts/setup-test-db.cjs` (Postgres admin `CREATE DATABASE`), `scripts/test_db_guard.cjs` (Postgres URL/DB-name guard), `scripts/run-all-tests.ts` (PG adapter/server health), `prisma7.config.ts` (provider/shadow DB), `scripts/backfill-identity.ts`, `scripts/apply-duplicate-links.ts`, `scripts/report-duplicates.ts`, `scripts/check_counts.ts`, `scripts/preflight.ts`, `scripts/seed_admin_account.ts`.

---

## 5. Ranked conversion plan and effort

Estimates assume one senior engineer familiar with Prisma/Postgres/MySQL; ranges include implementation and focused verification, not full product QA.

| Rank | Area | Work | Estimate |
|---:|---|---|---:|
| 1 | Schema portability | Replace 11 scalar lists (join tables for `availableChannels`/`scoreFlags`/`eventTypes`; JSON + mapping for prompt/display arrays); audit 354 `String` fields for `@db.Text`/`LongText`; decide enum strategy; add MySQL indexes; recreate partial unique indexes via generated columns/triggers | **60–90 h** |
| 2 | Adapter, config, scripts | Switch `provider`, `@prisma/adapter-pg` → MySQL adapter/driver, update `src/lib/db/prisma.ts` and ~30 script clients, test DB setup/guard, shadow DB, URLs, Docker/dev docs | **12–20 h** |
| 3 | Migration history | Regenerate 40 migrations for MySQL; port enum DDL, JSONB→JSON, arrays, `ON CONFLICT`, `DISTINCT ON`, casts, `DO $$`, `pg_constraint`, `md5(random())`, partial indexes; verify deploy on empty DB and existing-data backfills | **40–60 h** |
| 4 | Query semantics | Replace 18 `mode: "insensitive"` uses (normalized columns or `LOWER`/collation); rewrite array `has`/`hasSome`; rewrite JSON `path` filters; raw SQL (`current_database`, savepoints, quoted identifiers, seed DDL, test SQL) | **35–55 h** |
| 5 | Locking / send gate / idempotency / dedup | Re-test `reserveSendSlot` `FOR UPDATE` + composite unique key under MySQL isolation; verify no duplicate sends; port dedup partial-index guards and savepoint error paths; load-test concurrency/deadlocks | **24–40 h** |
| 6 | Data conversion / ETL | Dump/transform arrays→JSON/join rows, JSONB→JSON, enum values, timestamps, decimals; verify row counts, nulls, cascade FKs, unique guards; rollback plan | **24–40 h** |
| 7 | Tests | Convert test harness and directly affected suites; re-run all 70 suites + concurrency tests; add MySQL-specific regression tests for collation/DNC/idempotency | **50–80 h** |
| 8 | Staging/cutover | Dual-run/shadow verification, performance/index tuning, backup/restore drill, cutover and rollback rehearsal | **16–24 h** |
| | **Total** | | **261–409 h** |
| | **With 20% contingency** | | **313–491 h** (~8–12 weeks solo, 4–6 weeks with 2–3 engineers) |

Suggested order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Do not start ETL until the schema and locking design are frozen.

---

## 6. Main risks and silent behavior changes

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Case sensitivity / collation** | `mode: "insensitive"` is unsupported on MySQL. MySQL's default `utf8mb4_0900_ai_ci` is case- and accent-insensitive, so `contains`/`equals` may match differently than PostgreSQL; unique indexes may treat `Foo` and `foo` as duplicates. DNC/suppression could miss or over-match. | Store normalized columns (`usernameNormalized`, `emailNormalized`, `websiteDomain`, DNC `identifierNormalized`) and use exact matches; explicitly set collation; add DNC regression tests. |
| **Text truncation** | Prisma MySQL maps unannotated `String` to `VARCHAR(191)`. Long message bodies, bios, errors, templates, session/token fields may truncate or throw. | Audit all 354 String fields; annotate `@db.Text`/`@db.LongText`; verify with long fixtures. |
| **Scalar-list semantics** | `String[]`/`Int[]` are unsupported on MySQL. JSON replacement loses `has`/`hasSome` query semantics and ordering guarantees. | Join tables for filtered fields; JSON + repository mapping for display/prompt fields; add tests for filters and ordering. |
| **Partial unique indexes** | Dedup guards (`WHERE duplicateOfLeadId IS NULL`) cannot be expressed in MySQL. Losing them permits concurrent duplicate leads. | Generated columns + unique indexes, or triggers; load-test concurrent inserts. |
| **Transaction isolation** | PostgreSQL/Prisma generally runs `READ COMMITTED`; MySQL InnoDB defaults to `REPEATABLE READ`. `FOR UPDATE`, gap locks, and read-your-writes behavior differ; send-gate counters/idempotency races may change. | Set isolation explicitly; test concurrent `reserveSendSlot`; monitor deadlocks; consider `READ COMMITTED` if MySQL supports the required behavior. |
| **Timestamps / timezones** | PostgreSQL `timestamp(3)` and MySQL `DATETIME(3)` have different driver/timezone handling; `NOW()`/`CURRENT_TIMESTAMP` use session timezone. Daily/hourly caps and working-hours logic can shift. | Store UTC; set MySQL session `time_zone='+00:00'`; use Prisma `now()`/app clocks; test timezone/DST boundaries. |
| **Decimal precision** | `Decimal(10,4)`/`(12,6)` are supported, but MySQL strict mode/rounding and `Float` behavior can differ from PostgreSQL. Cost analytics may drift. | Keep Decimal; compare aggregates on identical fixtures; use `DECIMAL` for money, not Float. |
| **Enum ordering/value changes** | PostgreSQL enum types support `ADD VALUE`; MySQL `ENUM` changes may rebuild tables and reorder values. Prisma enum ordering is numeric by declaration; reports/sorts can change. | Use lookup tables or explicit string codes if enum evolution is frequent; test `ORDER BY` on status. |
| **JSON semantics** | `JSONB` is binary/normalized; MySQL `JSON` preserves text formatting and has different path/null behavior. JSON `path` filters and `->>`/`::` operators need rewriting. | Use `JSON_EXTRACT`/`JSON_UNQUOTE`; test null vs missing keys; avoid JSONB-only operators. |
| **Identifier case** | MySQL table names are case-sensitive on Linux unless `lower_case_table_names` is set; Prisma's CamelCase quoted names can break on some hosts. | Pin MySQL config; regenerate migrations with consistent casing; avoid case-only renames. |
| **`ON CONFLICT` / upsert** | Prisma `upsert` works on MySQL, but raw `ON CONFLICT`/seed migrations do not. | Rewrite as `INSERT ... ON DUPLICATE KEY UPDATE` or Prisma upsert; test idempotent re-runs. |
| **`DISTINCT ON`** | MySQL has no `DISTINCT ON`; replacements with `GROUP BY`/window functions can pick a different row. | Rewrite with `ROW_NUMBER()` and explicit ordering; test backfill results. |
| **`FOR UPDATE` / gap locks** | InnoDB locks ranges depending on indexes/isolation; concurrent sends may deadlock or serialize differently. | Ensure indexes on lock predicates; test high concurrency; keep retry/backoff. |
| **Prisma adapter** | Prisma 7 uses driver adapters; switching from `@prisma/adapter-pg` affects types, transactions, JSON, and error codes. | Use the supported MySQL/MariaDB adapter; re-run all raw/transaction paths. |

---

## 7. Recommendation

**Keep PostgreSQL, hosted on a VPS or managed external service** (e.g. a small managed Postgres instance or self-hosted Postgres with backups). Reasons:

- The project depends on scalar lists, case-insensitive filters, partial unique indexes, JSON filters, and PostgreSQL-specific migration DDL in core compliance and outbound-safety paths.
- The conversion is not a driver swap: schema redesign, migration history regeneration, data ETL, and concurrency re-validation are required.
- Expected effort is **~260–410 hours** (more with contingency), with meaningful risk of duplicate sends, missed DNC matches, or duplicate lead creation during/after cutover.
- Running Postgres on a VPS/managed host is operationally cheaper and lower-risk than a multi-week MySQL migration.

If MySQL is mandatory (hosting policy or vendor constraint), treat it as a separate project with a dedicated branch, a frozen schema period, a MySQL staging database, and a phased plan in the order above. Do not attempt an in-place migration of the existing database without a full ETL rehearsal and rollback plan.

