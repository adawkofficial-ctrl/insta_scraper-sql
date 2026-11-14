/**
 * Read-only ETL verification: PostgreSQL source vs local MySQL staging target.
 * Prints counts, ids/checksums and mismatch ids only. Never prints personal data.
 */
import { Client as PgClient } from "pg";
import mariadb from "mariadb";
import {
  TABLE_ORDER,
  buildExclusions,
  channelFlags,
  computeGuardKeys,
  formatMysqlDate,
  shouldExclude,
  md5Ids,
  mysqlConnectionConfig,
  parseArgs,
  scoreFlagId,
  type Row,
} from "./common";

type Check = { name: string; pass: boolean; detail: string };

function envUrl(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function readSource(url: string): Promise<Record<string, Row[]>> {
  const client = new PgClient({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const out: Record<string, Row[]> = {};
    for (const table of TABLE_ORDER) {
      if (table === "LeadScoreFlag") continue;
      try {
        out[table] = (await client.query(`SELECT * FROM "${table}"`)).rows as Row[];
      } catch (err) {
        if ((err as { code?: string }).code === "42P01") continue;
        throw err;
      }
    }
    await client.query("ROLLBACK");
    return out;
  } finally {
    await client.end();
  }
}

function quoteId(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

function norm(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).toLowerCase().trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceUrl = envUrl(String(args.source ?? "DATABASE_URL"));
  const targetUrl = envUrl(String(args.target ?? "DATABASE_URL_MYSQL_STAGING"));
  const sourceDb = new URL(sourceUrl).pathname.replace(/^\//, "");
  const targetDb = new URL(targetUrl).pathname.replace(/^\//, "");
  console.log(`Verify source=postgres db=${sourceDb} -> target=${new URL(targetUrl).hostname} db=${targetDb}`);

  const source = await readSource(sourceUrl);
  const exclusions = buildExclusions(source);
  const target = await mariadb.createConnection(mysqlConnectionConfig(targetUrl));
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  try {
    const expected: Record<string, Row[]> = {};
    for (const table of TABLE_ORDER) {
      if (table === "LeadScoreFlag") {
        const rows: Row[] = [];
        for (const lead of (source.Lead ?? []).filter((r) => !shouldExclude("Lead", r, exclusions))) {
          if (Array.isArray(lead.scoreFlags)) {
            for (const flag of new Set(lead.scoreFlags.map(String))) rows.push({ id: scoreFlagId(String(lead.id), flag), leadId: lead.id, flag });
          }
        }
        expected[table] = rows;
        continue;
      }
      expected[table] = (source[table] ?? []).filter((r) => !shouldExclude(table, r, exclusions));
    }

    for (const table of TABLE_ORDER) {
      const srcRows = expected[table] ?? [];
      const targetCountRows = (await target.query(`SELECT COUNT(*) AS n FROM ${quoteId(table)}`)) as Array<{ n: bigint }>;
      const targetCount = Number(targetCountRows[0]?.n ?? 0);
      add(`${table}.count`, srcRows.length === targetCount, `source=${srcRows.length} target=${targetCount}`);

      const targetIds = ((await target.query(`SELECT id FROM ${quoteId(table)}`)) as Array<{ id: string }>).map((r) => String(r.id));
      const srcIds = srcRows.map((r) => String(r.id));
      const srcChecksum = md5Ids(srcIds);
      const targetChecksum = md5Ids(targetIds);
      add(`${table}.id_checksum`, srcChecksum === targetChecksum, `source=${srcChecksum} target=${targetChecksum}`);
    }

    // Guard keys on target.
    const targetLeads = (await target.query(
      "SELECT id, instagramUserId, usernameNormalized, emailNormalized, duplicateOfLeadId, activeInstagramGuard, activeUsernameGuard, activeEmailGuard, hasInstagram, hasEmail, hasPhone, hasWebsite, hasOtherSocial FROM `Lead`",
    )) as Row[];
    const guardMismatchIds = targetLeads
      .filter((row) => {
        const expectedKeys = computeGuardKeys(row);
        return (
          expectedKeys.activeInstagramGuard !== (row.activeInstagramGuard ?? null) ||
          expectedKeys.activeUsernameGuard !== (row.activeUsernameGuard ?? null) ||
          expectedKeys.activeEmailGuard !== (row.activeEmailGuard ?? null)
        );
      })
      .map((r) => String(r.id));
    add("Lead.guard_keys", guardMismatchIds.length === 0, `mismatches=${guardMismatchIds.length} ids=${guardMismatchIds.slice(0, 20).join(",")}`);

    // Channel booleans vs source channels.
    const sourceLeadById = new Map((expected.Lead ?? []).map((r) => [String(r.id), r]));
    const channelMismatchIds = targetLeads
      .filter((row) => {
        const src = sourceLeadById.get(String(row.id));
        if (!src) return false;
        const flags = channelFlags(src);
        return (
          Boolean(row.hasInstagram) !== flags.hasInstagram ||
          Boolean(row.hasEmail) !== flags.hasEmail ||
          Boolean(row.hasPhone) !== flags.hasPhone ||
          Boolean(row.hasWebsite) !== flags.hasWebsite ||
          Boolean(row.hasOtherSocial) !== flags.hasOtherSocial
        );
      })
      .map((r) => String(r.id));
    add("Lead.channel_booleans", channelMismatchIds.length === 0, `mismatches=${channelMismatchIds.length} ids=${channelMismatchIds.slice(0, 20).join(",")}`);

    // DNC and send history invariants.
    const dncTarget = Number(((await target.query("SELECT COUNT(*) AS n FROM `DoNotContact`")) as Array<{ n: bigint }>)[0]?.n ?? 0);
    add("DoNotContact.count", dncTarget === expected.DoNotContact.length, `source=${expected.DoNotContact.length} target=${dncTarget}`);
    const msgTarget = Number(((await target.query("SELECT COUNT(*) AS n FROM `Message`")) as Array<{ n: bigint }>)[0]?.n ?? 0);
    add("Message.count", msgTarget === expected.Message.length, `source=${expected.Message.length} target=${msgTarget}`);
    const attemptTarget = Number(((await target.query("SELECT COUNT(*) AS n FROM `MessageAttempt`")) as Array<{ n: bigint }>)[0]?.n ?? 0);
    add("MessageAttempt.count", attemptTarget === expected.MessageAttempt.length, `source=${expected.MessageAttempt.length} target=${attemptTarget}`);
    const idemTarget = Number(((await target.query("SELECT COUNT(*) AS n FROM `OutboundSendIdempotency`")) as Array<{ n: bigint }>)[0]?.n ?? 0);
    add("OutboundSendIdempotency.count", idemTarget === expected.OutboundSendIdempotency.length, `source=${expected.OutboundSendIdempotency.length} target=${idemTarget}`);
    const followTarget = Number(((await target.query("SELECT COUNT(*) AS n FROM `FollowUpMessage`")) as Array<{ n: bigint }>)[0]?.n ?? 0);
    add("FollowUpMessage.count", followTarget === expected.FollowUpMessage.length, `source=${expected.FollowUpMessage.length} target=${followTarget}`);

    // Field sample: 200 leads, 50 messages (ids only on mismatch).
    const sampleLeads = (expected.Lead ?? []).slice(0, 200);
    const targetLeadRows = (await target.query("SELECT id, fullName, username, emailNormalized, status FROM `Lead`")) as Row[];
    const targetLeadById = new Map(targetLeadRows.map((r) => [String(r.id), r]));
    const leadMismatchIds = sampleLeads
      .filter((src) => {
        const dst = targetLeadById.get(String(src.id));
        if (!dst) return true;
        return (
          String(src.fullName ?? "") !== String(dst.fullName ?? "") ||
          String(src.username ?? "") !== String(dst.username ?? "") ||
          norm(src.emailNormalized) !== norm(dst.emailNormalized) ||
          String(src.status ?? "") !== String(dst.status ?? "")
        );
      })
      .map((r) => String(r.id));
    add("Lead.field_sample_200", leadMismatchIds.length === 0, `mismatches=${leadMismatchIds.length} ids=${leadMismatchIds.slice(0, 20).join(",")}`);

    const sampleMessages = (expected.Message ?? []).slice(0, 50);
    const targetMessageRows = (await target.query("SELECT id, status, leadId FROM `Message`")) as Row[];
    const targetMessageById = new Map(targetMessageRows.map((r) => [String(r.id), r]));
    const messageMismatchIds = sampleMessages
      .filter((src) => {
        const dst = targetMessageById.get(String(src.id));
        return !dst || String(src.status ?? "") !== String(dst.status ?? "") || String(src.leadId ?? "") !== String(dst.leadId ?? "");
      })
      .map((r) => String(r.id));
    add("Message.field_sample_50", messageMismatchIds.length === 0, `mismatches=${messageMismatchIds.length} ids=${messageMismatchIds.slice(0, 20).join(",")}`);

    // Timezone sample 100 timestamps.
    const targetTimeRows = (await target.query("SELECT id, createdAt FROM `Lead` ORDER BY id LIMIT 100")) as Row[];
    const tzMismatch = targetTimeRows.filter((row) => {
      const src = sourceLeadById.get(String(row.id));
      if (!src) return true;
      const srcValue = formatMysqlDate(src.createdAt);
      const targetValue = row.createdAt === null || row.createdAt === undefined ? null : String(row.createdAt).replace("T", " ").replace("Z", "");
      return srcValue !== targetValue;
    }).length;
    add("Lead.timezone_sample_100", tzMismatch === 0, `mismatches=${tzMismatch}`);
  } finally {
    await target.end();
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name} :: ${c.detail}`);
  console.log(`SUMMARY: ${checks.length - failed.length} PASS / ${failed.length} FAIL`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Verify failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
