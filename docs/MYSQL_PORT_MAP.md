# MySQL Port Map (Phase 0)

**Branch:** `mysql-port` (created from `main`; `main` not modified).
**Status:** Phase 0 + Phase 1 foundation only. No real/production database touched. No data copied. No external Apify/Gemini/Unipile calls.
**Reused documents:** `docs/MYSQL_CONVERSION_AUDIT.md` (kept and expanded here).

## Target environment / constraints

| Item | Value |
|---|---|
| Local MySQL used for Phase 1 | **MySQL 8.0.46** (Docker, `127.0.0.1:3307`) |
| Local dev DB | `insta_scraper_mysql_dev` |
| Local test DB | `insta_scraper_mysql_test` |
| Hostinger target server version | **UNCONFIRMED** (`<FILL IN from phpMyAdmin "Server version">`) |
| Hostinger constraints | No `SHOW DATABASES`; no event scheduler; no `CREATE DATABASE` for shadow DBs; `prisma migrate dev` unavailable remotely; use `prisma migrate deploy`; low `max_connections`; remote access only if enabled |
| Connection pool | Default `connection_limit=5`; overridable via `DATABASE_CONNECTION_LIMIT` |
| Engine | InnoDB, `utf8mb4`, target collation to be confirmed (`utf8mb4_0900_ai_ci` on MySQL 8; MariaDB uses `utf8mb4_uca1400_*` / `utf8mb4_general_ci`) |

**If the target is MariaDB:** JSON is `LONGTEXT` with JSON validation (no native `JSON` type, no MySQL 8 JSON defaults/functional indexes), `utf8mb4_0900_*` collations do not exist, `CHECK` enforcement differs by version, `DATETIME(3)` works, `SKIP LOCKED` requires 10.6+, and `ALTER TABLE ... MODIFY ENUM` behavior differs. The Phase 1 baseline is generated on MySQL 8.0 and must be re-validated if the target is MariaDB.

---

## 1. Table inventory

**Total models/tables: 35. Difficulty: 6 high, 20 medium, 9 low.**

| Model | Fields (scalar/rel) | Enums used | Json | List fields | Decimal | Unique constraints | Indexes | Difficulty |
|---|---|---:|---:|---:|---:|---|---:|---|
| User | 24 (8/16) | — | — | — | — | `email` | 2 | low |
| Campaign | 54 (35/19) | CampaignStatus, ExecutionMode, ApprovalMode | — | 4 | — | — | 4 | **high** |
| Lead | 111 (92/19) | LeadStatus, AiStatus | 6 | 3 | 1 | `(campaignId, username)` | 32 | **high** |
| LeadSighting | 9 (7/2) | — | — | — | — | — | 3 | low |
| ScrapeJob | 28 (24/4) | ScrapeJobStatus | 2 | — | 1 | — | 5 | medium |
| DiscoveryCoverage | 10 (10/0) | — | 1 | — | — | — | 2 | medium |
| DiscoveryPlaceOutcome | 9 (9/0) | — | — | — | — | `(userId, placeId)` | 1 | low |
| Candidate | 30 (28/2) | — | 2 | — | 1 | `(campaignId, placeId)` | 3 | **high** |
| EmailSenderAccount | 29 (27/2) | — | — | — | — | — | 2 | low |
| EmailCampaignSettings | 9 (8/1) | — | — | — | — | `campaignId` | 0 | low |
| EmailSend | 26 (23/3) | — | — | — | — | `leadId` | 3 | low |
| EmailUnsubscribeToken | 8 (7/1) | — | — | — | — | `token` | 1 | low |
| Message | 40 (31/9) | MessageStatus, MessageDirection, MessageChannel | 1 | — | — | `unipileMessageId` | 12 | medium |
| MessageTemplate | 9 (7/2) | — | 1 | — | — | — | 2 | medium |
| InstagramSenderAccount | 36 (30/6) | ConnectionMethod, InstagramSenderSessionType, InstagramSenderStatus | — | — | — | `unipileAccountId`, `(userId, username)` | 7 | medium |
| OutboundSendIdempotency | 15 (14/1) | — | — | — | — | `(campaignId, leadId, step)` | 4 | low |
| CampaignExecution | 28 (23/5) | CampaignExecutionStatus, CampaignExecutionPhase, ExecutionMode | — | — | — | — | 7 | medium |
| CampaignExecutionItem | 11 (9/2) | ExecutionItemStatus | — | — | — | `(executionId, leadId)` | 4 | medium |
| BulkMessageJob | 27 (20/7) | BulkMessageJobStatus | — | — | — | — | 5 | medium |
| BulkMessageItem | 21 (18/3) | BulkMessageItemStatus | — | — | — | `draftId`, `(jobId, leadId)` | 6 | medium |
| MessageAttempt | 29 (22/7) | MessageStatus | — | — | — | — | 11 | medium |
| LeadStatusHistory | 8 (7/1) | LeadStatus | — | — | — | — | 1 | medium |
| DoNotContact | 9 (8/1) | DncChannel, DncIdentifierType, DncSource | — | — | — | `(userId, channel, identifierType, identifierNormalized)` | 2 | **high** |
| Conversation | 20 (15/5) | MessageChannel | — | — | — | `unipileChatId`, `(leadId, channel)` | 5 | medium |
| UsageLog | 16 (14/2) | UsageProvider | 1 | — | 1 | — | 4 | medium |
| CompanyProfile | 21 (19/2) | — | 3 | 3 | — | — | 1 | **high** |
| MessageDraft | 40 (34/6) | MessageChannel, DraftKind, DraftStatus | 4 | — | — | — | 6 | medium |
| DraftReview | 13 (11/2) | DraftReviewAction | 1 | — | — | — | 2 | medium |
| AiAnalysisJob | 17 (15/2) | AiAnalysisJobStatus | 1 | — | — | — | 2 | medium |
| UnipileWebhookEvent | 8 (8/0) | UnipileWebhookStatus | — | — | — | `unipileEventId` | 3 | medium |
| UnmatchedInboundMessage | 11 (11/0) | — | — | — | — | `unipileMessageId` | 4 | low |
| NotificationConfig | 10 (9/1) | NotificationEventType | — | 1 enum array | — | `userId` | 0 | **high** |
| NotificationLog | 9 (8/1) | NotificationEventType, NotificationLogStatus | — | — | — | — | 3 | medium |
| LeadEvent | 13 (10/3) | LeadEventType, MessageChannel | 1 | — | — | — | 5 | medium |
| FollowUpMessage | 22 (19/3) | FollowUpStatus | — | — | — | `idempotencyKey`, `(campaignId, leadId, step)` | 3 | medium |

### High-difficulty reasons

- **Campaign** — four scalar lists; 54 fields; list defaults; many reads in campaign/follow-up/UI code.
- **Lead** — 111 fields, three scalar lists, six Json columns, 32 indexes, three Postgres partial unique guards; every list has filters in `lead-service.ts`.
- **Candidate** — Json `socialLinks`/`rawPlaceData`, unique `(campaignId, placeId)`, large write volume from discovery/resume.
- **CompanyProfile** — three scalar lists and three Json columns used in AI prompts/settings.
- **DoNotContact** — unique identifier includes normalized username/email/domain/phone; relies on case-insensitive lookups and is a compliance-critical table.
- **NotificationConfig** — enum-array `eventTypes` with a default; no MySQL scalar-list equivalent.

### Unique constraints (all models)

```text
User.email
Lead @@unique(campaignId, username)
DiscoveryPlaceOutcome @@unique(userId, placeId)
Candidate @@unique(campaignId, placeId)
EmailCampaignSettings.campaignId
EmailSend.leadId
EmailUnsubscribeToken.token
Message.unipileMessageId
InstagramSenderAccount.unipileAccountId
InstagramSenderAccount @@unique(userId, username)
OutboundSendIdempotency @@unique(campaignId, leadId, step)
CampaignExecutionItem @@unique(executionId, leadId)
BulkMessageItem.draftId
BulkMessageItem @@unique(jobId, leadId)
DoNotContact @@unique(userId, channel, identifierType, identifierNormalized)
Conversation.unipileChatId
Conversation @@unique(leadId, channel)
UnipileWebhookEvent.unipileEventId
UnmatchedInboundMessage.unipileMessageId
NotificationConfig.userId
FollowUpMessage.idempotencyKey
FollowUpMessage @@unique(campaignId, leadId, step)
```

No database `CHECK` constraints exist in the schema or migrations.

---

## 2. Fields that need a type decision

### 2.1 Scalar lists → Json or child table

| Field | Proposed Phase 2 shape | Code that reads/filters |
|---|---|---|
| `Campaign.followUpDelayDays Int[]` | child table `CampaignFollowUpStep(campaignId, step, delayDays)` or `Json` (display/order only) | campaign service create/update/read; edit modal; execution follow-up scheduler |
| `Campaign.followUpTemplates String[]` | child table `CampaignFollowUpTemplate` (ordered) or Json | campaign service; edit modal; follow-up message generation |
| `Campaign.customNegativeKeywords String[]` | child table or Json | discovery negative-keyword matcher; campaign update |
| `Campaign.customPositiveKeywords String[]` | child table or Json | discovery query builder; campaign update |
| `Lead.availableChannels String[]` | **child table `LeadChannel(leadId, channel)`** (filtered) | `lead-service.ts:228,236,244,272` `has`; UI badges; bulk/send gate |
| `Lead.previousUsernames String[]` | child table `LeadPreviousUsername` or Json | dedup identity checks; rehandle; merge |
| `Lead.scoreFlags String[]` | **child table `LeadScoreFlag(leadId, flag)`** or Json | `lead-service.ts:348` `hasSome`; score UI; quality filters |
| `CompanyProfile.targetIndustries String[]` | Json (prompt/display only) | company-profile settings, AI prompt context |
| `CompanyProfile.targetCountries String[]` | Json | company-profile settings, AI prompt context |
| `CompanyProfile.forbiddenClaims String[]` | Json | AI draft validation/prompts |
| `NotificationConfig.eventTypes NotificationEventType[]` | child table `NotificationEventTypeConfig(configId, eventType)` or Json | notification config API/service; notification dispatch filter |

Recommended: child tables for `availableChannels`, `scoreFlags`, `eventTypes` (filtered); Json for the rest (read/write/prompt/display), with repository mapping preserving the existing API array shapes.

### 2.2 Long strings that can exceed 191 characters

Prisma MySQL maps an unannotated `String` to `VARCHAR(191)`; PostgreSQL maps it to `text`. Every long field below must be annotated; the list is the known high-risk subset, not all 354 String fields.

| Model | Fields | Recommended MySQL type |
|---|---|---|
| Campaign | `description`, `intent`, `location` | `@db.Text` (location max 1000; `@db.VarChar(1000)` also valid) |
| Lead | `fullName` | `@db.VarChar(255)` (indexed; 255×4=1020 bytes) |
| Lead | `biography`, `website`, `profileUrl`, `profileUrlCanonical`, `emailSourceUrl`, `aiFailedReason`, `location` | `@db.Text` |
| Lead | `websiteKey`, `groupKey`, `discoveryKeyword`, `discoveryCity`, `messageVariant`, `gmapsPlaceId`, `category`, `websiteDomain`, `username`, `usernameNormalized`, `emailNormalized`, `phoneNormalized` | `@db.VarChar(191)` (indexed; see key table) |
| ScrapeJob | `errorMessage` | `@db.Text` |
| Candidate | `address`, `errorMessage`, `rawPlaceData` (Json) | Text/Json |
| Message | `body`, `text`, `messageText` | `@db.LongText` |
| Message | `errorMessage`, `aiAnalysis` (Json) | Text/Json |
| MessageTemplate | `body` | `@db.LongText` |
| EmailSend | `body` | `@db.LongText` |
| EmailSend | `subject`, `errorMessage`, `recipient` | `@db.VarChar(255)` / Text / `@db.VarChar(254)` |
| EmailCampaignSettings | `subjectTemplate`, `bodyTemplate` | Text/LongText |
| EmailSenderAccount | `smtpPasswordEncrypted`, `lastError` | LongText/Text |
| InstagramSenderAccount | `sessionPath`, `lastError` | Text |
| CompanyProfile | `description`, `objectionNotes` | Text/LongText |
| MessageDraft | `body`, `editedBody`, `rejectNotes` | LongText/Text |
| FollowUpMessage | `templateText`, `renderedBody`, `errorMessage` | Text/LongText/Text |
| NotificationConfig | `ntfyServerUrl`, `ntfyAccessToken` | Text/LongText |
| NotificationLog | `errorReason` | Text |
| UnipileWebhookEvent | `failReason` | Text |
| UnmatchedInboundMessage | `text` | LongText |
| AI/Draft/Usage JSON-like text | all `Json` fields | native `JSON` (not text) |

**Indexed/unique long strings and key lengths** (utf8mb4 InnoDB max 3072 bytes; 191 chars = 764 bytes):

| Index | Column(s) | Recommended | Bytes (approx.) |
|---|---|---|---|
| `User.email` unique | `email` | `@db.VarChar(254)` | 1016 |
| `Lead @@unique(campaignId, username)` | `campaignId` (25), `username` (30–191) | `@db.VarChar(191)` | 100 + 764 |
| `Lead` index `profileUrl` | `profileUrl` | `@db.VarChar(191)` prefix + `profileUrlHash CHAR(64)` index for exact match | 764 + 256 |
| `Lead` index `(userId, websiteKey)` | `websiteKey` | `@db.VarChar(191)` + `websiteKeyHash CHAR(64)` | 100 + 764 + 256 |
| `Lead` index `gmapsPlaceId`, `groupKey`, `discoveryKeyword`, `discoveryCity` | each | `@db.VarChar(191)` | 764 each |
| `DoNotContact` unique | `userId`, `channel`, `identifierType`, `identifierNormalized` | `@db.VarChar(320)` (email max 320) | 100 + 2 + 2 + 1280 ≈ 1384 |
| `Message.unipileMessageId` unique | `unipileMessageId` | `@db.VarChar(191)` | 764 |
| `EmailUnsubscribeToken.token` unique | `token` | `@db.VarChar(191)` | 764 |
| `InstagramSenderAccount.unipileAccountId` unique | `unipileAccountId` | `@db.VarChar(191)` | 764 |
| `Conversation.unipileChatId` unique | `unipileChatId` | `@db.VarChar(191)` | 764 |
| `UnipileWebhookEvent.unipileEventId` unique | `unipileEventId` | `@db.VarChar(191)` | 764 |
| `UnmatchedInboundMessage.unipileMessageId` unique | `unipileMessageId` | `@db.VarChar(191)` | 764 |
| `OutboundSendIdempotency @@unique(campaignId, leadId, step)` | three strings | `@db.VarChar(191)` | ~100+100+764 |
| `FollowUpMessage @@unique(campaignId, leadId, step)` | three strings | `@db.VarChar(191)` | ~100+100+764 |

Collation implications: MySQL's default `utf8mb4_0900_ai_ci` is case- and accent-insensitive. This changes uniqueness and equality for usernames, emails, domains, handles, and names. Opaque IDs/tokens/hashes should use `utf8mb4_0900_as_cs` (or `utf8mb4_bin`), otherwise two IDs differing only by case could collide. See §3.

### 2.3 Json columns with defaults/indexes

- `CompanyProfile.services Json @default("[]")` — MySQL JSON columns cannot be declared with a plain `DEFAULT '[]'`; use application default, a nullable column, or MySQL 8.0.13 expression default `DEFAULT (JSON_ARRAY())` in a raw migration if MariaDB compatibility is not required.
- All other Json columns are nullable with no DB default and can be migrated as `JSON`.
- **No Json indexes exist in the schema.** `Lead.rawProfileData` is filtered by Prisma `path` (`lead-service.ts:306,315`); MySQL cannot index it directly. Consider generated columns + index in Phase 2 if the filter becomes hot.
- `NotificationConfig.eventTypes` is an enum array, not Json; see 2.1.

### 2.4 Decimal precision

| Field | Annotation | MySQL type |
|---|---|---|
| `Lead.acquisitionCostUsd` | `@db.Decimal(10, 4)` | `DECIMAL(10,4)` |
| `ScrapeJob.costUsd` | `@db.Decimal(10, 4)` | `DECIMAL(10,4)` |
| `Candidate.costUsd` | `@db.Decimal(10, 4)` | `DECIMAL(10,4)` |
| `UsageLog.estimatedCostUsd` | `@db.Decimal(12, 6)` | `DECIMAL(12,6)` |

Keep `Float` for ratings/confidence/budget share; MySQL `DOUBLE` has the same practical precision. Money must stay Decimal; do not convert to Float.

### 2.5 DateTime precision and UTC

- Prisma MySQL maps `DateTime` to `DATETIME(3)` by default. Phase 1 keeps that; explicit `@db.DateTime(3)` may be added for clarity.
- Store UTC: set the MariaDB driver `timezone: "Z"` and MySQL session `time_zone = '+00:00'`.
- Migration/backfill `NOW()`/`CURRENT_TIMESTAMP` use session timezone; use `UTC_TIMESTAMP(3)` in MySQL migrations or app-supplied timestamps.
- `@updatedAt` is set by Prisma client; do not rely on MySQL `ON UPDATE CURRENT_TIMESTAMP`.
- Daily/hourly sender caps (`sentTodayDate`, `sentThisHourWindow`) and working-hours logic are timezone-sensitive; re-test DST and UTC boundaries.

### 2.6 Boolean/Int differences

- `Boolean` → MySQL `TINYINT(1)`; filters and raw `= true` work.
- `Int` → MySQL `INT` (32-bit), same practical range; `leadLimit` max 2,147,483,647 fits.
- No `BigInt`/`Bytes` fields in the schema.
- `Float` → `DOUBLE`; no exact-decimal uses.

### 2.7 Enums

- 32 enums; values are uppercase letters/digits/underscore, no MySQL-disliked characters.
- Prisma MySQL supports enums as inline `ENUM(...)`; there is no `CREATE TYPE`.
- `NotificationConfig.eventTypes` is the only enum array; convert to child table/Json.
- MySQL enum values are compared under the column collation; PostgreSQL enums are case-sensitive. The app uses exact uppercase constants, so behavior should be stable, but `ALTER TABLE ... MODIFY COLUMN` may rebuild large tables when adding a value. Consider lookup tables if status churn is expected.

---

## 3. Constraints / indexes

### 3.1 Partial unique indexes (PostgreSQL-only)

`prisma/migrations/20260928130500_step4_dedup_unique_guards/migration.sql` creates:

```sql
CREATE UNIQUE INDEX "Lead_userId_instagramUserId_active_key"
  ON "Lead" ("userId", "instagramUserId")
  WHERE "instagramUserId" IS NOT NULL AND "duplicateOfLeadId" IS NULL;

CREATE UNIQUE INDEX "Lead_userId_usernameNormalized_active_key"
  ON "Lead" ("userId", "usernameNormalized")
  WHERE "usernameNormalized" IS NOT NULL AND "duplicateOfLeadId" IS NULL;

CREATE UNIQUE INDEX "Lead_userId_emailNormalized_active_key"
  ON "Lead" ("userId", "emailNormalized")
  WHERE "emailNormalized" IS NOT NULL AND "duplicateOfLeadId" IS NULL;
```

MySQL has no partial indexes. Proposed equivalent: generated stored nullable guard columns + unique indexes.

```sql
ALTER TABLE `Lead`
  ADD COLUMN `activeInstagramGuard` VARCHAR(191)
    GENERATED ALWAYS AS (
      IF(`duplicateOfLeadId` IS NULL AND `instagramUserId` IS NOT NULL,
         `instagramUserId`, NULL)
    ) STORED,
  ADD COLUMN `activeUsernameGuard` VARCHAR(191)
    GENERATED ALWAYS AS (
      IF(`duplicateOfLeadId` IS NULL AND `usernameNormalized` IS NOT NULL,
         `usernameNormalized`, NULL)
    ) STORED,
  ADD COLUMN `activeEmailGuard` VARCHAR(191)
    GENERATED ALWAYS AS (
      IF(`duplicateOfLeadId` IS NULL AND `emailNormalized` IS NOT NULL,
         `emailNormalized`, NULL)
    ) STORED;

CREATE UNIQUE INDEX `Lead_userId_instagramUserId_active_key`
  ON `Lead` (`userId`, `activeInstagramGuard`);
CREATE UNIQUE INDEX `Lead_userId_usernameNormalized_active_key`
  ON `Lead` (`userId`, `activeUsernameGuard`);
CREATE UNIQUE INDEX `Lead_userId_emailNormalized_active_key`
  ON `Lead` (`userId`, `activeEmailGuard`);
```

Caveats: MySQL unique indexes allow multiple NULLs, so duplicate-linked rows remain excluded. Prisma does not model generated columns; this must be a raw migration and will appear as drift in `prisma migrate diff` unless the generated columns are excluded or accepted as documented drift. Alternative: nullable guard columns maintained by the application (weaker; concurrent writers can bypass). Do not drop these guards.

### 3.2 Unique key lengths / collation

See §2.2 for the key-length table. All proposed unique keys fit under the 3072-byte utf8mb4 limit. Use `utf8mb4_0900_as_cs`/`utf8mb4_bin` for opaque IDs and tokens, and `utf8mb4_0900_ai_ci` for searchable names/emails/domains. MariaDB does not provide `0900` collations; use `utf8mb4_bin`/`utf8mb4_general_ci` and verify.

**Case-sensitive vs insensitive matters:**

- Desired insensitive: `User.email`, `Lead.emailNormalized`, `Lead.username/usernameNormalized`, `InstagramSenderAccount.username`, `DoNotContact.identifierNormalized`, `Lead.websiteDomain`, `Lead.fullName/category` search, `Campaign.name` search, `Bulk` search.
- Desired sensitive: all `id`/cuid values, `EmailUnsubscribeToken.token`, `InstagramSenderAccount.unipileAccountId`, `Message.unipileMessageId`, `Conversation.unipileChatId`, `UnipileWebhookEvent.unipileEventId`, `UnmatchedInboundMessage.unipileMessageId`, `OutboundSendIdempotency.step`, `contentHash`, `rawPayloadHash`, `websiteKey` (normalized but exact), `InstagramSenderAccount.sessionPath`, file paths.
- `mode: "insensitive"` currently makes searches case-insensitive; removing it relies on MySQL collation. If the target uses `utf8mb4_bin` or a case-sensitive collation, searches will silently become case-sensitive. If it uses `ai_ci`, searches become accent-insensitive as well.

---

## 4. Code map

### 4.1 PrismaClient / PrismaPg (30 files) — CRITICAL foundation

All of these construct a Postgres adapter directly and must use the central factory:

```text
src/lib/db/prisma.ts
scripts/apply-duplicate-links.ts
scripts/backfill-identity.ts
scripts/check_counts.ts
scripts/report-duplicates.ts
scripts/step15_e2e_verification.ts
scripts/test_auth_production_readiness.ts
scripts/test_migration_backfill.ts
scripts/test_ntfy_notifications.ts
scripts/test_step10_analytics.ts
scripts/test_step11_auth.ts
scripts/test_step13_full_qa.ts
scripts/test_step14_discovery.ts
scripts/test_step14_limits_templates_execution.ts
scripts/test_step15_e2e_discovery_flow.ts
scripts/test_step7_messaging.ts
scripts/test_step8_templates_ai.ts
scripts/test_step8_unipile_webhooks.ts
scripts/test_step9_campaign_execution.ts
scripts/test_task11_errors.ts
scripts/test_task12_security_qa.ts
scripts/test_task13_e2e_regression.ts
scripts/test_task17_bulk_template_loading.ts
scripts/test_task18b_sender_api_idor.ts
scripts/test_task19_sender_ui_lifecycle.ts
scripts/test_task2_rich_profile_leads.ts
scripts/test_task3_lead_limits_hardening.ts
scripts/test_task4_templates.ts
scripts/test_task8_execution_engine.ts
scripts/verify_step14_campaign_ui.ts
```

Change: delete `@prisma/adapter-pg`/`PrismaPg` imports and use `createPrismaClient()` from `src/lib/db/prisma.ts` (same adapter for app and scripts). The exact Phase 1 package is `@prisma/adapter-mariadb@7.10.0` + `mariadb@3.4.5` (confirmed from installed Prisma 7.10.0 dependency list and adapter typings; API: `new PrismaMariaDb(poolConfig | connectionString)`).

### 4.2 `mode: "insensitive"` (18 uses)

```text
src/lib/services/compliance/dnc-service.ts:830,845,856,976,981,987,1093
src/lib/services/lead/lead-service.ts:110,111,112,124,125
src/lib/services/messaging/bulk-messaging-service.ts:315,316,317,326,327
src/lib/services/unipile/webhook-service.ts:526
```

Change: remove `mode`; rely on normalized columns exact match or MySQL collation. Behavior changes: `contains` becomes collation-dependent (accent-insensitive on `ai_ci`), and `equals` on usernames/emails/domains becomes case-insensitive (usually desired). DNC lines are **CRITICAL**: a missed suppression match can cause a compliance violation.

### 4.3 Raw SQL — CRITICAL / locking

| File:line | SQL / change |
|---|---|
| `src/lib/services/messaging/send-gate.ts:1143` | `SELECT ... FOR UPDATE` — **CRITICAL** send gate. Re-test under MySQL REPEATABLE READ; add deadlock/lock-wait retry; backtick quoting. |
| `src/lib/services/dedup/dedup-service.ts:258,261,264,265` | `SAVEPOINT` — **CRITICAL** dedup/idempotency. MySQL duplicate-key does not abort the transaction; remove/adapt savepoint and retry on 1213/1205. |
| `src/app/api/health/route.ts:13` | `current_database()` → `DATABASE()` |
| `src/app/api/health/ready/route.ts:113,118` | `SELECT 1` portable; `_prisma_migrations` query verify |
| `scripts/seed_admin_account.ts:44` | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — remove/replace with migration |
| `scripts/test_migration_backfill.ts:18-76` | PG DDL/backfill: `DISTINCT ON`, `md5(random()::text)`, `'[]'::jsonb`, `'{}'::text[]`, `NOW()`, `SET NOT NULL`, `pg_constraint` — rewrite or mark test-only |
| `scripts/test_ntfy_notifications.ts:109` | `information_schema.columns` — verify MySQL database/case filter |
| `scripts/test_step8_unipile_webhooks.ts:84` | `UPDATE ... REPLACE/LIKE` — backtick identifiers |
| `scripts/check_counts.ts:13`, `scripts/test_step_company_profile_per_campaign.ts:356,361` | quoted identifiers only; backticks/Prisma raw |
| `scripts/preflight.ts:207` | `SELECT 1` portable |

No app raw SQL uses `ON CONFLICT`, `RETURNING`, `ILIKE`, `DISTINCT ON`, `generate_series`, array operators, JSONB operators, `DO $$`, `pg_constraint`, or `$1` placeholders. Those appear only in migrations/tests.

### 4.4 Code that filters/sorts/reads list fields

- `src/lib/services/lead/lead-service.ts:228,236,244,272,348` — `availableChannels`/`scoreFlags` filters.
- `src/lib/services/campaign/campaign-service.ts:428-485,1096-1122` — follow-up arrays read/validate/write.
- `src/components/create-campaign-modal.tsx:183-190`, `edit-campaign-modal.tsx:115-217`, `company-profile-settings.tsx:110-176`, `notifications-settings-panel.tsx:65-126` — UI array handling.
- `src/lib/services/ai/prompts/lead-context.ts:99-110`, `reply-draft-v1.ts:105`, `draft-service.ts:58` — company profile arrays in prompts.
- `src/app/api/notifications/config/route.ts:26-121` — enum array validation/write.
- `src/lib/services/messaging/follow-up-service.ts` — follow-up delay/template arrays.
- Discovery/negative keywords: `campaign-service`/discovery services use custom keyword arrays.

### 4.5 Test setup, shadow DB, health

- `scripts/setup-test-db.cjs` — Postgres `pg` admin client and `CREATE DATABASE`; must become a MySQL connection and local-only `CREATE DATABASE` (target has no CREATE DATABASE). On Hostinger, tests should use a pre-created DB.
- `scripts/test_db_guard.cjs` — Postgres URL/DB-name guard and default URL; update to `mysql://`, `insta_scraper_mysql_test`, and reject prod names.
- `scripts/run-all-tests.ts` — starts a test server with `DATABASE_URL`; no PG-specific driver except through app; update test DB guard/env.
- `src/app/api/health/route.ts` and `ready/route.ts` — health DB name and migration check.
- `prisma7.config.ts` — `SHADOW_DATABASE_URL`; local MySQL can create a shadow DB, Hostinger cannot. Baseline is generated locally and applied remotely with `migrate deploy`.

### 4.6 Postgres mentions (47 files)

```text
docs/MYSQL_CONVERSION_AUDIT.md, docs/PILOT_DEPLOY.md,
docs/PRODUCTION_CHECKLIST.md, docs/PRODUCTION_READINESS.md,
docs/PRODUCTION_READINESS_REPORT.md,
prisma/schema.prisma,
scripts/apply-duplicate-links.ts, scripts/backfill-identity.ts,
scripts/check_counts.ts, scripts/preflight.ts, scripts/report-duplicates.ts,
scripts/setup-test-db.cjs, scripts/step15_e2e_verification.ts,
scripts/test_admin_env_auth.ts, scripts/test_auth_production_readiness.ts,
scripts/test_db_guard.cjs, scripts/test_migration_backfill.ts,
scripts/test_ntfy_notifications.ts, scripts/test_pre_pilot_safety.ts,
scripts/test_step10_analytics.ts, scripts/test_step11_auth.ts,
scripts/test_step13_full_qa.ts, scripts/test_step14_discovery.ts,
scripts/test_step14_limits_templates_execution.ts,
scripts/test_step15_e2e_discovery_flow.ts, scripts/test_step7_messaging.ts,
scripts/test_step8_templates_ai.ts, scripts/test_step8_unipile_webhooks.ts,
scripts/test_step9_campaign_execution.ts, scripts/test_task11_errors.ts,
scripts/test_task12_security_qa.ts, scripts/test_task13_e2e_regression.ts,
scripts/test_task17_bulk_template_loading.ts,
scripts/test_task18b_sender_api_idor.ts,
scripts/test_task19_sender_ui_lifecycle.ts,
scripts/test_task2_rich_profile_leads.ts,
scripts/test_task3_lead_limits_hardening.ts, scripts/test_task4_templates.ts,
scripts/test_task8_execution_engine.ts, scripts/verify_step14_campaign_ui.ts,
scripts/verify_step6_frontend_flow.ts,
src/app/campaigns/[campaignId]/page.tsx,
src/lib/constants/campaign-limits.ts, src/lib/db/prisma.ts,
src/lib/services/campaign/campaign-service.ts,
src/lib/services/dedup/dedup-service.ts,
src/lib/services/errors/sanitize.ts
```

Change: update env/docs to MySQL URLs and remove `PrismaPg`/`postgresql` assumptions.

---

## 5. Transaction / locking behavior

| Path | Current behavior | MySQL requirement / risk |
|---|---|---|
| `reserveSendSlot` (`send-gate.ts:1051`) | Interactive transaction; `FOR UPDATE` on sender row (line 1143); idempotency unique upsert (line 1253). | **CRITICAL.** Use `READ COMMITTED` for the reservation transaction (or prove `REPEATABLE READ` is safe); keep the unique idempotency key; add retry for MySQL 1213 (deadlock) and 1205 (lock wait timeout) with jitter. InnoDB gap locks on secondary indexes can increase deadlocks; verify no duplicate sends under 20–50 concurrent workers. |
| `releaseSendSlot` | Updates sender counters and idempotency status. | Atomic `UPDATE ... SET counter = GREATEST(counter - 1, 0)`; idempotent release; retry deadlocks. |
| Dedup (`dedup-service.ts`) | PostgreSQL transaction aborts on unique violation; savepoints used to recover. | MySQL statement-level duplicate-key does not poison the transaction; simplify/remove savepoints, but keep unique guards. Add deadlock retry. Concurrent insert protection depends on the partial-index replacement. |
| Job claiming (`claimNextQueuedItem`) | `findFirst` + conditional `updateMany` (optimistic). | Works on MySQL; consider `READ COMMITTED`; if throughput grows, use `SELECT ... FOR UPDATE SKIP LOCKED` (MySQL 8.0+) via raw SQL. |
| Execution lease (`claimExecutionLease`/`releaseExecutionLease`, heartbeat) | Conditional update/lease fields. | Use `READ COMMITTED` for claim/release; add deadlock retry; ensure lease expiry comparisons use UTC. |
| Counters / analytics | Increments and `updateMany`. | Use atomic SQL increments; avoid read-modify-write loops. |
| Transactions in bulk/draft/execution services | Interactive and array transactions. | MySQL supports both; verify no use of PostgreSQL-only isolation levels and set `READ COMMITTED` where row locking is intended. |

Default isolation: MySQL InnoDB = `REPEATABLE READ`; Postgres/Prisma default = `READ COMMITTED`. Use `transactionOptions: { isolationLevel: "ReadCommitted" }` for lock-sensitive paths and document exceptions.

---

## 6. Migrations plan

- The 40 Postgres migrations in `prisma/migrations` are not portable. On `mysql-port`, keep them in `prisma/migrations-postgres/` (or only in `main` history) and create a **single MySQL baseline** from the converted schema.
- Phase 1: generate `prisma/migrations/<timestamp>_mysql_baseline/migration.sql` from the MySQL schema against an empty local DB; apply with `prisma migrate deploy`; verify with `prisma migrate diff` (local shadow DB only).
- Later data copy order (parents → children):

```text
User
CompanyProfile
Campaign
ScrapeJob
Candidate
Lead
LeadSighting, LeadStatusHistory, LeadEvent
DiscoveryCoverage, DiscoveryPlaceOutcome
InstagramSenderAccount, EmailSenderAccount
MessageTemplate
Conversation, Message, MessageAttempt
CampaignExecution, CampaignExecutionItem
BulkMessageJob, BulkMessageItem
OutboundSendIdempotency
DoNotContact
UsageLog, NotificationConfig, NotificationLog
MessageDraft, DraftReview, AiAnalysisJob
FollowUpMessage
UnipileWebhookEvent, UnmatchedInboundMessage
```

- Copy in FK order or disable FK checks per table batch; validate counts, orphan checks, enum values, JSON validity, and the three dedup guards after copy.

---

## 7. Phase plan and top risks

| Phase | Scope | Estimate |
|---|---|---:|
| 0 | This map + inventory + code/constraint analysis | 8–12 h |
| 1 | Central MySQL factory, provider/datasource, long-string annotations, baseline migration, MySQL test harness, smoke test | 16–24 h |
| 2 | Scalar-list redesign (Json vs child tables), partial-index guard columns, MySQL-specific indexes/collations, schema finalization | 60–90 h |
| 3 | Query/code conversion: remove `mode`, array filters, JSON path, raw SQL, 30 script clients, health/test setup | 50–80 h |
| 4 | Data ETL, backfills, dedup guard verification, MySQL test-suite conversion and concurrency tests | 50–80 h |
| 5 | Staging/cutover, performance tuning, rollback rehearsal, docs | 20–30 h |
| | **Remaining Phase 2–5 total** | **180–280 h** |
| | **Full project including Phase 0–1** | **204–316 h** |

### Top 10 risks (ranked)

1. **Duplicate sends / idempotency** if `FOR UPDATE` + unique-key behavior under MySQL isolation differs. Mitigate with READ COMMITTED, deadlock retry, concurrency tests.
2. **DNC/suppression misses** after removing `mode: "insensitive"` or changing collation. Normalize identifiers and test every DNC path.
3. **Duplicate leads** because partial unique indexes cannot be expressed directly. Implement generated guard columns/unique indexes and load-test.
4. **Silent text truncation** from `VARCHAR(191)` on 354 String fields. Annotate Text/LongText and test long payloads.
5. **Scalar-list redesign regressions** in `availableChannels`/`scoreFlags` filters and campaign follow-up arrays.
6. **Timestamp/timezone drift** in sender caps, working hours, leases, and `NOW()` backfills. Force UTC and test DST/timezones.
7. **Collation-driven uniqueness changes**: case/accent-insensitive unique keys may reject previously distinct rows.
8. **JSON semantics differences** (JSONB vs JSON, null vs missing, path filters) in `rawProfileData` and webhook payloads.
9. **Migration drift/no shadow DB** on Hostinger; baseline must be generated locally and applied with `migrate deploy`.
10. **MariaDB divergence** (JSON=LONGTEXT, collations, enum/DDL behavior) if the target is not MySQL 8.

---

## 8. Phase 1 TODO checklist (explicit)

```text
TODO(mysql-port): Phase 2 - replace Lead availableChannels/scoreFlags/previousUsernames list fields
TODO(mysql-port): Phase 2 - replace Campaign follow-up/keyword list fields
TODO(mysql-port): Phase 2 - replace CompanyProfile targetIndustries/targetCountries/forbiddenClaims
TODO(mysql-port): Phase 2 - replace NotificationConfig.eventTypes enum array
TODO(mysql-port): Phase 2 - add generated guard columns + unique indexes for the 3 partial Lead indexes
TODO(mysql-port): Phase 2 - finalize long-string annotations for remaining String fields
TODO(mysql-port): Phase 2 - decide JSON default strategy for CompanyProfile.services
TODO(mysql-port): Phase 2 - set per-column collations (utf8mb4_0900_as_cs vs ai_ci) and MariaDB fallback
TODO(mysql-port): Phase 3 - remove all mode:"insensitive" and replace with normalized/collation behavior
TODO(mysql-port): Phase 3 - rewrite send-gate FOR UPDATE, dedup SAVEPOINT, health current_database()
TODO(mysql-port): Phase 3 - rewrite seed/migration/test raw SQL and quoted identifiers
TODO(mysql-port): Phase 3 - update all 30 PrismaPg script clients to the central factory
TODO(mysql-port): Phase 3 - update setup-test-db/test_db_guard/run-all-tests and docs/env
TODO(mysql-port): Phase 4 - ETL, dedup guard verification, concurrency tests
TODO(mysql-port): Phase 5 - cutover/rollback plan
```

## 8.1 Phase 1 status (implemented on `mysql-port`)

```text
Local MySQL: 8.0.46 at 127.0.0.1:3307 (Docker)
Dev DB: insta_scraper_mysql_dev (baseline applied)
Test DB: insta_scraper_mysql_test (baseline applied)
Baseline migration: prisma/migrations/20261114000000_mysql_baseline
Old Postgres migrations: prisma/migrations-postgres/ (40, kept for main)
Tables created: 35 + _prisma_migrations
Drift check: prisma migrate diff -> No difference detected (exit 0)
Smoke test: scripts/test_mysql_smoke.ts -> PASS (create user/profile/campaign/lead, read, cascade delete)
Typecheck: 65 errors, all expected Phase 2/3 work (22 unsupported Json/filter operators,
  16 type assignability from list placeholders, 14 JsonValue property/method errors,
  4 argument-shape errors, 2 non-iterable Json, 2 index errors, 2 null guards,
  2 overload errors, 1 missing campaign relation in a selected lead type)
Lint: 0 errors, 6 pre-existing warnings
```

Phase 1 schema placeholders: 11 scalar-list fields are temporarily `Json?`/`Json` with `TODO(mysql-port): Phase 2`; `CompanyProfile.services` is nullable until the JSON-default decision; partial unique indexes are not in the baseline (Phase 2); `mode: "insensitive"` and raw SQL are untouched (Phase 3).

## 8.2 Phase 2 status (implemented on `mysql-port`)

### Decisions applied

| Field | Final representation |
|---|---|
| `Lead.availableChannels` | boolean columns `hasInstagram`, `hasEmail`, `hasPhone`, `hasWebsite`, `hasOtherSocial`, indexed, synced by `withLeadChannelFlags()` / `leadChannelsFromFlags()` |
| `Lead.scoreFlags` | child table `LeadScoreFlag(leadId, flag)`, unique `(leadId, flag)`, index `(flag)`; filters use `some: { flag: { in } }` |
| `Lead.previousUsernames` | `Json` string[]; `parseLeadPreviousUsernames()` |
| `Campaign.followUpDelayDays` | `Json` number[]; `parseCampaignFollowUpDelayDays()` |
| `Campaign.followUpTemplates` | `Json` string[]; `parseCampaignFollowUpTemplates()` |
| `Campaign.customNegativeKeywords` / `customPositiveKeywords` | `Json` string[]; `parseCampaignNegativeKeywords()` / `parseCampaignPositiveKeywords()` |
| `CompanyProfile.targetIndustries` / `targetCountries` / `forbiddenClaims` / `services` | nullable `Json` string[]; typed accessors; `services` defaults to `[]` in code |
| `NotificationConfig.eventTypes` | nullable `Json`; `parseNotificationEventTypes()` + app-side filtering |

### Guard keys

- `Lead.activeInstagramGuard = IF(duplicateOfLeadId IS NULL AND instagramUserId IS NOT NULL, instagramUserId, NULL)`
- `Lead.activeUsernameGuard = IF(duplicateOfLeadId IS NULL AND usernameNormalized IS NOT NULL, usernameNormalized, NULL)`
- `Lead.activeEmailGuard = IF(duplicateOfLeadId IS NULL AND emailNormalized IS NOT NULL, emailNormalized, NULL)`
- Normal unique indexes on `(userId, active*Guard)`; NULL means not guarded.
- Computed centrally by the Prisma client extension in `src/lib/db/prisma.ts` for create/createMany/update/updateMany/upsert.
- `scripts/verify_guard_keys.ts` recomputes every row and exits non-zero on mismatch.

### Migration policy

- Baseline: `prisma/migrations/20261114000000_mysql_baseline` (generated from the final Phase 2 schema, applied to empty local dev/test DBs).
- **From the first real deployment onward this baseline is NEVER edited. Only new migrations are added.**
- Old Postgres migrations remain in `prisma/migrations-postgres/` (and `main` history).

### Verified

- `prisma validate`, `prisma generate`, `prisma migrate deploy`, `prisma migrate diff --exit-code`: clean (no drift).
- Typecheck: 0 errors.
- Lint: 0 errors, 6 pre-existing warnings.
- New tests: guard keys (including concurrent inserts + corrupted-row verification), strict truncation, DNC case/whitespace/accent variants — all pass.
- Full MySQL suite: `59 PASS / 14 FAIL / 0 BLOCKED / 6 SKIPPED`, `2274 passed / 12 failed`. All 14 failures are the Phase 3 raw-SQL list below; no other suite fails.

### Known Phase 3 failures (raw SQL only)

| Suite | Exact error |
|---|---|
| `test_step3_sparior`, `test_task24_sparior_keyword_discovery`, `test_task_intent_and_continuation`, `test_discovery_runaway_guard`, `test_step4_dedup`, `test_discovery_pipeline_stages`, `test_discovery_fixes` | `P2010 ... This command is not supported in the prepared statement protocol yet` from dedup `SAVEPOINT` / `RELEASE SAVEPOINT` |
| `test_step6_quality_approval`, `test_task18_instagram_sender`, `test_step9_reply_send`, `test_outbound_send_safety`, `test_e2e_full_pipeline`, `test_pre_pilot_safety`, `test_task11_errors` | `P2010 ... syntax ... near '"InstagramSenderAccount" WHERE id = ? FOR UPDATE'` from send-gate raw lock |

## 8.3 Phase 3 status (raw SQL, locking, concurrency, engines)

### Raw SQL rewrites

| Location | Before | After |
|---|---|---|
| `src/lib/services/dedup/dedup-service.ts` | `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT` around update/create | Removed. Catch P2002 per statement, re-read/link, fallback update strips `username`, `usernameNormalized`, `emailNormalized`, `instagramUserId`, `profileUrlCanonical`, `previousUsernames`, `scoreFlags`; whole campaign persist transaction uses `withMysqlRetry`. |
| `src/lib/services/messaging/send-gate.ts` | `SELECT id FROM "InstagramSenderAccount" ... FOR UPDATE` | `tx.$queryRaw(Prisma.sql\`SELECT id FROM \`InstagramSenderAccount\` WHERE id = ${id} FOR UPDATE\`)`; `READ COMMITTED`; `withMysqlRetry`; reuses the transaction client for `canSendNow`/DNC. |
| `src/app/api/health/route.ts` | `current_database()` | `DATABASE()` |
| `scripts/test_step8_unipile_webhooks.ts` / `test_step_company_profile_per_campaign.ts` | double-quoted identifiers | backticks |
| `scripts/test_mysql_guard_keys.ts` / `test_mysql_concurrency.ts` | none | backtick raw SQL only for test corruption/negative control |

`withMysqlRetry` (`src/lib/db/mysql-retry.ts`) retries P2034 / MySQL 1213 / 1205 three times with jitter.

### Concurrency results

`scripts/test_mysql_concurrency.ts` (real DB, no DB mocks): **13 PASS / 0 FAIL**.
- 50 iterations × 30 workers on daily cap 8 / hourly cap 4: exactly 4 succeed; counters exact.
- 20 workers same `(campaign, lead, step)`: exactly 1 reservation.
- Two senders round-robin: neither exceeds cap.
- Opposite lock order: retry helper resolves; final state consistent.
- Expired RESERVED slot recovered; counters survive a new client instance.
- 20 parallel dedup creates: 1 active lead, 19 linked duplicates; guard keys consistent.
- Negative control: bypassing guard-key maintenance is detected.

### Engine comparison

| Engine | Suites | Assertions | Drift |
|---|---|---|---|
| MySQL 8.0.46 | 73 PASS / 0 FAIL / 0 BLOCKED / 6 SKIPPED | 2665 passed / 0 failed | `No difference detected` |
| MariaDB 10.11 | 73 PASS / 0 FAIL / 0 BLOCKED / 6 SKIPPED | 2674 passed / 0 failed | `migrate diff` reports JSON columns as type-changed because MariaDB stores JSON as LONGTEXT |

MariaDB is green at the application/test level; its JSON=LONGTEXT storage difference is expected and documented (not a data correctness failure).

### Performance sanity (45,000 seeded leads)

`20261114010000_phase3_lead_list_indexes` adds:
- `Lead(campaignId, createdAt)`
- `Lead(campaignId, hasInstagram, createdAt)`
- `Lead(campaignId, hasEmail, createdAt)`
- `Lead(campaignId, hasWebsite, createdAt)`

EXPLAIN:
- Lead list: `Lead_campaignId_createdAt_idx`, ~21,894 rows estimated, backward scan; boolean composites are available.
- Dedup lookup: `Lead_userId_usernameNormalized_idx`, rows=1.
- Send-gate lock: PRIMARY, const, rows=1.
- Candidate lookup: const/no-match (unique key).

No additional index is required for the tested filters; the boolean composites remain available for selective filters.

### Test-edit audit

No assertion was removed or skipped. Test edits were:
- MySQL representation changes (`availableChannels`→booleans, `scoreFlags` relation, Json accessors, backtick raw SQL).
- Cap tests updated to the confirmed “campaigns have no 100 cap” decision (101/999999 now accepted; invalid cases are 0/negative/decimal/2^31).
- Fixture fixes: real `userId` for UsageLog FK, isolated user for orchestrator dedup, MySQL URLs in DB-guard tests, real MIME/emoji expectations, stable lazy-enrichment timestamps.
- `test_task8_execution_engine` commit 658ce3f: adds bounded pause/resume retry because the async worker can finish/auto-pause between the PAUSED assertion and the endpoint call; all endpoint/status assertions remain. If a zero-retry test is required, replace this fixture with a manually created RUNNING execution (no worker).
- `test_task9_ui_execution_hardening` uses the same bounded pause retry for the same async-worker race.
- `test_task18_instagram_sender` replaces a fixed 80 ms sleep with a status poll (stronger).

## 9. Open questions

1. Confirm the exact Hostinger server version and whether it is **MySQL 8** or **MariaDB** (phpMyAdmin “Server version”).
2. Scalar lists: prefer **child tables** for filtered fields (`availableChannels`, `scoreFlags`, `eventTypes`) and **Json** for prompt/display arrays? Confirm.
3. Collation policy: use `utf8mb4_0900_ai_ci` for names/emails and `utf8mb4_0900_as_cs`/`utf8mb4_bin` for opaque IDs? MariaDB fallback?
4. Is JSON acceptable for `Campaign.followUpDelayDays`/`followUpTemplates`, or must follow-up order be relational?
5. Should `CompanyProfile.services` become nullable, application-default, or a MySQL expression default?
6. Is a generated-column workaround acceptable for the three partial unique indexes, given Prisma cannot model them?
7. For the target: pre-created test DB name and credentials (no `CREATE DATABASE` privilege).
8. Remote access availability and required TLS settings for the MySQL connection.
9. Whether the data copy will include production data at all (Phase 4), and who owns the ETL window.
10. Whether `connection_limit=5` is sufficient for the target's `max_connections` (confirm limit).
