/**
 * PostgreSQL -> local MySQL staging ETL.
 *
 * Default is --dry-run. Add --apply to write.
 * Source is opened in a READ ONLY transaction.
 * Target must be localhost and the database name must contain "staging".
 */
import fs from "node:fs";
import path from "node:path";
import { Client as PgClient } from "pg";
import mariadb from "mariadb";
import {
  TABLE_ORDER,
  JSON_COLUMNS,
  buildExclusions,
  channelFlags,
  computeGuardKeys,
  formatMysqlDate,
  shouldExclude,
  md5Ids,
  mysqlConnectionConfig,
  parseArgs,
  scoreFlagId,
  type Exclusions,
  type Row,
} from "./common";

type TargetColumn = {
  name: string;
  dataType: string;
  columnType: string;
  nullable: boolean;
  maxLength: number | null;
};

type Quarantine = { table: string; id: string; reason: string };

const BATCH_SIZE = 500;
const CHECKPOINT = path.join(__dirname, ".checkpoint.json");
const QUARANTINE_DIR = __dirname;

function envUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function assertLocalTarget(url: string): void {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) {
    throw new Error("Target must be a local MySQL/MariaDB host");
  }
  const db = u.pathname.replace(/^\//, "");
  if (!db.includes("staging")) {
    throw new Error(`Target database name must contain "staging" (got ${db})`);
  }
  if (!/^(mysql|mariadb):\/\//i.test(url)) throw new Error("Target must be mysql:// or mariadb://");
}

async function readSource(sourceUrl: string): Promise<Record<string, Row[]>> {
  const client = new PgClient({ connectionString: sourceUrl });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const out: Record<string, Row[]> = {};
    for (const table of TABLE_ORDER) {
      if (table === "LeadScoreFlag") continue;
      try {
        const res = await client.query(`SELECT * FROM "${table}"`);
        out[table] = res.rows as Row[];
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "42P01") continue;
        throw err;
      }
    }
    await client.query("ROLLBACK");
    return out;
  } finally {
    await client.end();
  }
}

async function readTargetColumns(db: mariadb.Connection, database: string, table: string): Promise<TargetColumn[]> {
  const rows = await db.query(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [database, table],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    name: String(r.COLUMN_NAME),
    dataType: String(r.DATA_TYPE).toLowerCase(),
    columnType: String(r.COLUMN_TYPE),
    nullable: String(r.IS_NULLABLE).toUpperCase() === "YES",
    maxLength: r.CHARACTER_MAXIMUM_LENGTH === null ? null : Number(r.CHARACTER_MAXIMUM_LENGTH),
  }));
}

function enumValues(columnType: string): string[] {
  const m = /^enum\((.*)\)$/i.exec(columnType);
  if (!m) return [];
  return m[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "").replace(/''/g, "'"));
}

function quoteId(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

function buildLeadRow(row: Row, targetColumns: TargetColumn[]): Record<string, unknown> {
  const next: Row = { ...row };
  delete next.availableChannels;
  delete next.scoreFlags;
  Object.assign(next, channelFlags(row), computeGuardKeys(row));
  return next;
}

function convertRow(
  table: string,
  row: Row,
  targetColumns: TargetColumn[],
): { data: Record<string, unknown> | null; reason: string | null } {
  const prepared = table === "Lead" ? buildLeadRow(row, targetColumns) : row;
  const data: Record<string, unknown> = {};
  const jsonCols = JSON_COLUMNS[table] ?? new Set<string>();
  for (const column of targetColumns) {
    if (!(column.name in prepared)) continue;
    let value = prepared[column.name];
    if (value === undefined) value = null;
    if (value === null) {
      if (!column.nullable) return { data: null, reason: `NULL_NOT_ALLOWED:${column.name}` };
      data[column.name] = null;
      continue;
    }
    if (jsonCols.has(column.name)) {
      try {
        data[column.name] = typeof value === "string" ? value : JSON.stringify(value);
        JSON.parse(String(data[column.name]));
      } catch {
        return { data: null, reason: `INVALID_JSON:${column.name}` };
      }
      continue;
    }
    if (column.dataType === "json") {
      try {
        data[column.name] = JSON.stringify(value);
      } catch {
        return { data: null, reason: `INVALID_JSON:${column.name}` };
      }
      continue;
    }
    if (column.dataType === "enum") {
      const allowed = enumValues(column.columnType);
      const stringValue = String(value);
      if (!allowed.includes(stringValue)) {
        return { data: null, reason: `INVALID_ENUM:${column.name}:${stringValue}` };
      }
      data[column.name] = stringValue;
      continue;
    }
    if (["datetime", "timestamp"].includes(column.dataType)) {
      const formatted = formatMysqlDate(value);
      if (!formatted) return { data: null, reason: `INVALID_DATE:${column.name}` };
      data[column.name] = formatted;
      continue;
    }
    if (column.dataType === "boolean") {
      data[column.name] = value === true || value === 1 || value === "1" ? 1 : 0;
      continue;
    }
    if (value instanceof Date) {
      data[column.name] = formatMysqlDate(value);
      continue;
    }
    if (typeof value === "boolean") {
      data[column.name] = value ? 1 : 0;
      continue;
    }
    if (typeof value === "object") {
      try {
        data[column.name] = JSON.stringify(value);
      } catch {
        return { data: null, reason: `UNSUPPORTED_OBJECT:${column.name}` };
      }
      continue;
    }
    if (column.maxLength !== null && typeof value === "string" && value.length > column.maxLength) {
      return { data: null, reason: `TOO_LONG:${column.name}:${value.length}>${column.maxLength}` };
    }
    data[column.name] = value;
  }
  return { data, reason: null };
}

async function insertBatch(
  db: mariadb.Connection,
  table: string,
  rows: Array<Record<string, unknown>>,
  targetColumns: TargetColumn[],
): Promise<void> {
  if (rows.length === 0) return;
  const columns = targetColumns.map((c) => c.name).filter((name) => name in rows[0]);
  if (columns.length === 0) return;
  const placeholders = `(${columns.map(() => "?").join(",")})`;
  const updates = columns.filter((c) => c !== "id").map((c) => `${quoteId(c)}=VALUES(${quoteId(c)})`).join(",");
  const sql =
    `INSERT INTO ${quoteId(table)} (${columns.map(quoteId).join(",")}) VALUES ` +
    rows.map(() => placeholders).join(",") +
    (updates ? ` ON DUPLICATE KEY UPDATE ${updates}` : "");
  const values = rows.flatMap((row) => columns.map((c) => row[c] ?? null));
  await db.query(sql, values);
}

function collisionReport(source: Record<string, Row[]>, exclusions: Exclusions): string[] {
  const lines: string[] = [];
  const leadRows = (source.Lead ?? []).filter((r) => !shouldExclude("Lead", r, exclusions));
  const group = (keyFn: (row: Row) => string | null, label: string) => {
    const map = new Map<string, string[]>();
    for (const row of leadRows) {
      const key = keyFn(row);
      if (!key) continue;
      const ids = map.get(key) ?? [];
      ids.push(String(row.id));
      map.set(key, ids);
    }
    const collisions = [...map.entries()].filter(([, ids]) => ids.length > 1);
    lines.push(`${label}: ${collisions.length} collision group(s), ${collisions.reduce((n, [, ids]) => n + ids.length, 0)} rows`);
    for (const [, ids] of collisions.slice(0, 10)) lines.push(`  ids=${ids.join(",")}`);
  };
  group((r) => (r.usernameNormalized ? `${r.userId}|${String(r.usernameNormalized).toLowerCase()}` : null), "Lead.usernameNormalized");
  group((r) => (r.emailNormalized ? `${r.userId}|${String(r.emailNormalized).toLowerCase()}` : null), "Lead.emailNormalized");
  group((r) => (r.websiteDomain ? `${r.userId}|${String(r.websiteDomain).toLowerCase()}` : null), "Lead.websiteDomain");
  const dncRows = (source.DoNotContact ?? []).filter((r) => !shouldExclude("DoNotContact", r, exclusions));
  const dncMap = new Map<string, string[]>();
  for (const row of dncRows) {
    const key = `${row.userId}|${row.channel}|${row.identifierType}|${String(row.identifierNormalized).toLowerCase()}`;
    const ids = dncMap.get(key) ?? [];
    ids.push(String(row.id));
    dncMap.set(key, ids);
  }
  const dncCollisions = [...dncMap.values()].filter((ids) => ids.length > 1);
  lines.push(`DNC.identifierNormalized: ${dncCollisions.length} collision group(s), ${dncCollisions.reduce((n, ids) => n + ids.length, 0)} rows`);
  for (const ids of dncCollisions.slice(0, 10)) lines.push(`  ids=${ids.join(",")}`);
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceEnv = String(args.source ?? "DATABASE_URL");
  const targetEnv = String(args.target ?? "DATABASE_URL_MYSQL_STAGING");
  const sourceUrl = envUrl(sourceEnv);
  const targetUrl = envUrl(targetEnv);
  assertLocalTarget(targetUrl);
  const dryRun = args.apply !== true;
  const allowQuarantine = args["allow-quarantine"] === true;
  const resume = args.resume === true;
  const onlyTables = typeof args.tables === "string" ? new Set(args.tables.split(",").map((t) => t.trim()).filter(Boolean)) : null;

  const sourceDb = new URL(sourceUrl).pathname.replace(/^\//, "");
  const targetDb = new URL(targetUrl).pathname.replace(/^\//, "");
  console.log(`ETL source=postgres db=${sourceDb} -> target=${new URL(targetUrl).hostname} db=${targetDb} mode=${dryRun ? "dry-run" : "APPLY"}`);

  const source = await readSource(sourceUrl);
  const exclusions = buildExclusions(source);
  const quarantine: Quarantine[] = [];
  const checkpoint = resume && fs.existsSync(CHECKPOINT)
    ? JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")) as Record<string, boolean>
    : {};
  const target = await mariadb.createConnection(mysqlConnectionConfig(targetUrl));
  const started = Date.now();
  let totalWritten = 0;
  let totalSource = 0;
  let totalExcluded = 0;
  let totalConverted = 0;

  try {
    console.log("Pre-flight collisions:");
    for (const line of collisionReport(source, exclusions)) console.log("  " + line);

    for (const table of TABLE_ORDER) {
      if (onlyTables && !onlyTables.has(table)) continue;
      if (checkpoint[table]) { console.log(`${table}: skipped (checkpoint)`); continue; }
      if (table === "LeadScoreFlag") {
        const leads = (source.Lead ?? []).filter((r) => !shouldExclude("Lead", r, exclusions));
        const rows: Array<Record<string, unknown>> = [];
        for (const lead of leads) {
          const flags = Array.isArray(lead.scoreFlags) ? lead.scoreFlags.map(String) : [];
          for (const flag of new Set(flags)) {
            rows.push({ id: scoreFlagId(String(lead.id), flag), leadId: String(lead.id), flag });
          }
        }
        if (!dryRun) {
          const columns = await readTargetColumns(target, targetDb, table);
          for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            await target.beginTransaction();
            await insertBatch(target, table, rows.slice(i, i + BATCH_SIZE), columns);
            await target.commit();
          }
          totalWritten += rows.length;
        } else {
          totalConverted += rows.length;
        }
        console.log(`${table}: rows=${rows.length} ${dryRun ? "would-write" : "written"}`);
        checkpoint[table] = true;
        fs.writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2), "utf8");
        continue;
      }
      const sourceRows = source[table];
      if (!sourceRows) { console.log(`${table}: source table missing; skipped`); continue; }
      totalSource += sourceRows.length;
      const rows = sourceRows.filter((r) => !shouldExclude(table, r, exclusions));
      totalExcluded += sourceRows.length - rows.length;
      const columns = await readTargetColumns(target, targetDb, table);
      if (columns.length === 0) { console.log(`${table}: target table missing; skipped`); continue; }
      const converted: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        const result = convertRow(table, row, columns);
        if (result.data) converted.push(result.data);
        else quarantine.push({ table, id: String(row.id ?? "?"), reason: result.reason ?? "CONVERSION_ERROR" });
      }
      totalConverted += converted.length;
      if (!dryRun) {
        for (let i = 0; i < converted.length; i += BATCH_SIZE) {
          const batch = converted.slice(i, i + BATCH_SIZE);
          try {
            await target.beginTransaction();
            await insertBatch(target, table, batch, columns);
            await target.commit();
            totalWritten += batch.length;
          } catch (err) {
            await target.rollback();
            for (const row of batch) {
              quarantine.push({ table, id: String(row.id ?? "?"), reason: `INSERT_FAILED:${(err as Error).message.slice(0, 160)}` });
            }
          }
        }
      }
      console.log(`${table}: source=${sourceRows.length} excluded=${sourceRows.length - rows.length} converted=${converted.length} ${dryRun ? "would-write" : "written"}`);
      checkpoint[table] = true;
      fs.writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2), "utf8");
    }
  } finally {
    await target.end();
  }

  if (quarantine.length > 0) {
    const file = path.join(QUARANTINE_DIR, `.quarantine-${Date.now()}.jsonl`);
    fs.writeFileSync(file, quarantine.map((q) => JSON.stringify(q)).join("\n"), "utf8");
    console.log(`QUARANTINE: ${quarantine.length} row(s) -> ${path.basename(file)}`);
  }
  const duration = (Date.now() - started) / 1000;
  console.log(`SUMMARY: source=${totalSource} excluded=${totalExcluded} converted=${totalConverted} written=${totalWritten} quarantine=${quarantine.length} duration=${duration.toFixed(1)}s rows/sec=${(totalWritten / Math.max(duration, 0.001)).toFixed(1)}`);
  if (quarantine.length > 0 && !allowQuarantine) {
    console.error("ETL failed: quarantine is not empty (use --allow-quarantine to accept).");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("ETL failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
