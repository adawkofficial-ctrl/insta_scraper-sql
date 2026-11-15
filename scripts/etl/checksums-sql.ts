/**
 * Generate the target checksum SQL for phpMyAdmin and the expected values.
 * Counts/hashes only; no personal data.
 */
import fs from "node:fs";
import path from "node:path";
import mariadb from "mariadb";
import { TABLE_ORDER, mysqlConnectionConfig, parseArgs } from "./common";

const BUSINESS_EXPR: Record<string, string> = {
  Lead: "CONCAT_WS('|',id,status,COALESCE(usernameNormalized,''),COALESCE(emailNormalized,''),hasInstagram,hasEmail,hasPhone,hasWebsite,hasOtherSocial)",
  DoNotContact: "CONCAT_WS('|',id,channel,identifierType,identifierNormalized)",
  Message: "CONCAT_WS('|',id,status,leadId)",
  MessageAttempt: "CONCAT_WS('|',id,status,messageId)",
  OutboundSendIdempotency: "CONCAT_WS('|',id,status,step)",
  FollowUpMessage: "CONCAT_WS('|',id,status,leadId)",
  Campaign: "CONCAT_WS('|',id,status,location)",
  Candidate: "CONCAT_WS('|',id,status,campaignId)",
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env[String(args.target ?? "DATABASE_URL_MYSQL_STAGING")];
  if (!url) throw new Error("Missing target database URL env");
  const db = await mariadb.createConnection(mysqlConnectionConfig(url));
  const database = new URL(url).pathname.replace(/^\//, "");
  const tables = new Set(
    ((await db.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=?", [database])) as Array<{ name: string }>).map((r) => String(r.name)),
  );
  await db.query("SET SESSION group_concat_max_len=10000000");
  const expected: Record<string, unknown> = { database, generatedAt: new Date().toISOString(), tables: {}, invariants: {} };
  const sql: string[] = [];
  sql.push("SET SESSION group_concat_max_len=10000000;");
  const tableChecks = [...TABLE_ORDER, "_prisma_migrations"].filter((t) => tables.has(t));
  for (const table of tableChecks) {
    const business = BUSINESS_EXPR[table] ?? "id";
    const idExpr = "GROUP_CONCAT(id ORDER BY id SEPARATOR ',')";
    const businessExpr = `GROUP_CONCAT(${business} ORDER BY id SEPARATOR ',')`;
    const row = (await db.query(
      `SELECT COUNT(*) AS row_count, MD5(${idExpr}) AS id_checksum, MD5(${businessExpr}) AS business_checksum FROM \`${table}\``,
    ))[0] as Record<string, unknown>;
    const entry = {
      row_count: Number(row.row_count),
      id_checksum: String(row.id_checksum ?? ""),
      business_checksum: String(row.business_checksum ?? ""),
    };
    (expected.tables as Record<string, unknown>)[table] = entry;
    sql.push(
      `SELECT '${table}' AS table_name, COUNT(*) AS row_count, MD5(${idExpr}) AS id_checksum, MD5(${businessExpr}) AS business_checksum FROM \`${table}\`;`,
    );
  }
  const invariants: Record<string, number> = {
    DNC_COUNT: Number((await db.query("SELECT COUNT(*) n FROM `DoNotContact`"))[0].n),
    MESSAGE_COUNT: Number((await db.query("SELECT COUNT(*) n FROM `Message`"))[0].n),
    MESSAGE_ATTEMPT_COUNT: Number((await db.query("SELECT COUNT(*) n FROM `MessageAttempt`"))[0].n),
    IDEMPOTENCY_COUNT: Number((await db.query("SELECT COUNT(*) n FROM `OutboundSendIdempotency`"))[0].n),
    IDEMPOTENCY_ALREADY_SENT: Number((await db.query("SELECT COUNT(*) n FROM `OutboundSendIdempotency` WHERE status='ALREADY_SENT'"))[0].n),
    IDEMPOTENCY_RESERVED: Number((await db.query("SELECT COUNT(*) n FROM `OutboundSendIdempotency` WHERE status='RESERVED'"))[0].n),
    GUARD_INSTAGRAM_NONNULL: Number((await db.query("SELECT COUNT(*) n FROM `Lead` WHERE activeInstagramGuard IS NOT NULL"))[0].n),
    GUARD_USERNAME_NONNULL: Number((await db.query("SELECT COUNT(*) n FROM `Lead` WHERE activeUsernameGuard IS NOT NULL"))[0].n),
    GUARD_EMAIL_NONNULL: Number((await db.query("SELECT COUNT(*) n FROM `Lead` WHERE activeEmailGuard IS NOT NULL"))[0].n),
  };
  const statusRows = (await db.query("SELECT status, COUNT(*) n FROM `Lead` GROUP BY status")) as Array<{ status: string; n: bigint }>;
  for (const statusRow of statusRows) {
    invariants[`LEADS_STATUS_${statusRow.status}`] = Number(statusRow.n);
  }
  expected.invariants = invariants;
  for (const [name, value] of Object.entries(invariants)) {
    sql.push(`SELECT 'INV:${name}' AS table_name, ${value} AS row_count, '' AS id_checksum, '' AS business_checksum;`);
  }
  await db.end();

  fs.mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "docs", "TARGET_CHECKSUMS.sql"), sql.join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(process.cwd(), "docs", "expected-checksums.json"), JSON.stringify(expected, null, 2), "utf8");
  console.log(`Wrote docs/TARGET_CHECKSUMS.sql and docs/expected-checksums.json tables=${tableChecks.length} invariants=${Object.keys(invariants).length}`);
}

main().catch((e) => { console.error("checksums-sql failed:", e instanceof Error ? e.message : String(e)); process.exit(1); });
