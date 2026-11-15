# MySQL Cutover / Rollback Runbook (Phase 5)

Target: Hostinger managed MySQL/MariaDB. Source: PostgreSQL `insta_scraper_prod` (read-only). Keep `OUTBOUND_SENDING_ENABLED=false` at every step. Never paste connection strings or secrets into tickets/logs.

Hosting facts (fill in before cutover): server engine/version `__________`, plan `__________`, Remote MySQL `yes/no`, SSH `yes/no`, Node versions `__________`, limits `__________`.

## 0. Time estimates

| Step | Estimate |
|---|---:|
| Backup + tag + host DB creation | 10–15 min |
| Freeze + final ETL/verify | 5–10 min |
| Dump export + import + checksums | 10–20 min |
| Owner assignment + deploy + smoke login | 10–15 min |
| Total cutover window | **35–60 min** |

## 1. Pre-cutover checklist

- [ ] Rotate `AUTH_SECRET`, `ADMIN_PASSWORD`, `UNIPILE_WEBHOOK_PATH_SECRET`; keep values in your password manager.
- [ ] Back up PostgreSQL (read-only source): `pg_dump "$PG_PROD_URL" -Fc -f postgres-final-$(date +%Y%m%d).dump`
- [ ] Keep the backup outside the app host; verify restore to a scratch DB locally.
- [ ] Tag the last Postgres commit on `main`: `git tag postgres-final && git push origin postgres-final`
- [ ] In hPanel: create an **empty** MySQL database and user. Record DB name/host/port only.
- [ ] Run `npm run preflight:host -- --target HOSTED_DATABASE_URL_ENV` from a machine with access; expect `PREFLIGHT PASS`. Fix blockers first.
- [ ] Set hosted env vars **by name** (values entered by you):
  - Required: `NODE_ENV=production`, `DATABASE_URL` (`mysql://user:pass@host:3306/db?connection_limit=5` plus TLS params if remote), `AUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `APIFY_API_TOKEN`, `GEMINI_API_KEY`, `UNIPILE_*`, `UNIPILE_WEBHOOK_PATH_SECRET`, `APP_PUBLIC_URL`, `COOKIE_SECURE=true`, `OUTBOUND_SENDING_ENABLED=false`
  - Must NOT be set: `APIFY_DRY_RUN`, `MOCK_*`, `DISABLE_AUTH_RATE_LIMIT`, `PORT`
  - Optional for small `max_user_connections`: lower `DATABASE_CONNECTION_LIMIT` (e.g. `3`) and keep `DATABASE_ACQUIRE_TIMEOUT_MS`.

## 2. Freeze

- [ ] Stop the local app and all workers/cron loops. Confirm no running `ScrapeJob`/`CampaignExecution`/`BulkMessageJob` rows in `RUNNING`.
- [ ] Do not start any Apify/Gemini/Unipile work during the window.

## 3. Final ETL + verification

```bash
npm run etl:mysql -- --source SOURCE_PG_URL --target DATABASE_URL_MYSQL_STAGING --apply
npm run etl:verify -- --source SOURCE_PG_URL --target DATABASE_URL_MYSQL_STAGING
```

Expected: `quarantine=0`; verify `SUMMARY: 82 PASS / 0 FAIL`. Review `docs/ETL_EXCLUSIONS_REVIEW.md` first; do not proceed if you have not accepted the flagged campaigns (`FollowUp Test Campaign`, `Safety Campaign`).

## 4. Dump, import, checksums

```bash
npm run etl:export-dump -- --target DATABASE_URL_MYSQL_STAGING
```

Expected: `parts=1` (or numbered parts + `IMPORT_ORDER.txt`), size printed.

Import into the hosted DB via phpMyAdmin (Import) or `mysql < insta_scraper_staging.sql`. The dump sets `FOREIGN_KEY_CHECKS=0` and re-enables it at the end. Import parts in order.

Target-side verification without remote access:

```bash
npm run etl:checksums-sql -- --target DATABASE_URL_MYSQL_STAGING
```

Paste `docs/TARGET_CHECKSUMS.sql` into phpMyAdmin on the hosted DB, export results as JSON/CSV, then:

```bash
npm run etl:compare-checksums -- <phpmyadmin-results.json|.csv>
```

Expected: all table checks and invariants PASS (`SUMMARY: 48 PASS / 0 FAIL` on the verified data set).

If Remote MySQL exists, the alternative is: `DATABASE_URL=<hosted> npx prisma migrate deploy`, then `etl:mysql --apply` with TLS params; still run checksums.

## 5. Owner assignment and deploy

```bash
# dry-run first
npm run cutover:assign-owner -- --target HOSTED_DATABASE_URL_ENV --email "$ADMIN_EMAIL"
# apply
npm run cutover:assign-owner -- --target HOSTED_DATABASE_URL_ENV --email "$ADMIN_EMAIL" --apply
```

Expected: `campaigns_to_assign=N`; apply prints `assigned_campaigns=N`. Re-run is idempotent (0 to assign).

Deploy from GitHub (only after steps 1–4): merge `mysql-port` into `main`, let Hostinger build/deploy. Then:

```bash
curl -fsS "$APP_PUBLIC_URL/api/health/ready" | jq '.status, .checks.database_engine, .checks.database_version, .checks.database_migrations'
```

Expected: `ready`, `mysql` or `mariadb`, version, `up_to_date`. Then log in with the configured admin; campaign list shows the migrated campaign; lead count matches expected (223 on the rehearsal set); DNC lookup of 20 known identifiers is suppressed.

## 6. Hosted smoke job

- [ ] Manually run a tiny Google Maps discovery (15 places) from the hosted app.
- [ ] Confirm candidates persist and a Lead/HANDLE_FOUND row appears; keep sending OFF.
- [ ] Watch `/api/health/ready` pool value and logs for strict-length/deadlock/connection errors.

## 7. Re-register when sending is enabled

- Unipile account/sender connection and webhook URL (new domain) + `UNIPILE_WEBHOOK_PATH_SECRET`.
- Re-login/recreate Playwright sessions if `sessionPath` is host-bound.
- Re-enter SMTP password if the encryption key differs.
- Keep `OUTBOUND_SENDING_ENABLED=false` until DNC, caps, warm-up, and webhook tests pass.

## 8. Rollback / go-no-go

Go only if: preflight PASS, verify 82/0, checksums 48/0, health ready, login + counts + DNC smoke pass.

Rollback:
- Keep the Postgres DB and `postgres-final` tag untouched.
- Point the app back to the Postgres connection string and deploy the tagged Postgres commit (`postgres-final`).
- Do not delete the Hostinger DB; it can be dropped after the decision window.

Decision point: immediately after step 5. If any check fails, roll back; do not attempt partial fixes in production.

## 9. Post-cutover

- Enable hPanel backups or a scheduled `mysqldump` (off-host, encrypted). Test a restore.
- Monitor: connection errors/too many connections, strict-mode length errors, deadlock retries (1213/1205), startup-recovery log lines, scrape-job completion.
- Future schema changes: generate a new migration locally, apply with `prisma migrate deploy` where remote access exists, or apply the generated SQL in phpMyAdmin when it does not. **Never edit the baseline or applied migrations.**
- Keep `prisma/migrations-postgres/` for the tag; it is not used at runtime.
