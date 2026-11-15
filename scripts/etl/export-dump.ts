/**
 * Export the verified local staging DB to a phpMyAdmin/mysql-compatible SQL dump.
 * Includes schema, data, and _prisma_migrations. Splits at --max-bytes.
 */
import fs from "node:fs";
import path from "node:path";
import mariadb from "mariadb";
import { TABLE_ORDER, mysqlConnectionConfig, parseArgs } from "./common";

const HEADER = `-- MySQL staging dump (utf8mb4)
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS=0;
SET UNIQUE_CHECKS=0;
SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO';
`;
const FOOTER = `SET FOREIGN_KEY_CHECKS=1;
SET UNIQUE_CHECKS=1;
`;

let escapeFn: ((value: unknown) => string) | null = null;

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return escapeFn ? escapeFn(JSON.stringify(value)) : "NULL";
  }
  return escapeFn ? escapeFn(value) : "NULL";
}

function quoteId(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetEnv = String(args.target ?? "DATABASE_URL_MYSQL_STAGING");
  const url = process.env[targetEnv];
  if (!url) throw new Error(`Missing ${targetEnv}`);
  const outDir = path.resolve(String(args.out ?? "artifacts/mysql-dump"));
  const baseName = String(args.name ?? "insta_scraper_staging");
  const maxBytes = Number(args["max-bytes"] ?? 40 * 1024 * 1024);
  fs.mkdirSync(outDir, { recursive: true });

  const db = await mariadb.createConnection(mysqlConnectionConfig(url));
  escapeFn = (value: unknown) => db.escape(value);
  const database = new URL(url).pathname.replace(/^\//, "");
  console.log(`dump database=${database} -> ${outDir}`);
  try {
    const present = new Set(
      ((await db.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=?", [database])) as Array<{ name: string }>).map((r) => String(r.name)),
    );
    const tables = [...TABLE_ORDER, "_prisma_migrations"].filter((t) => present.has(t));
    const sections: string[] = [];
    for (const table of tables) {
      const createRows = (await db.query(`SHOW CREATE TABLE ${quoteId(table)}`)) as Array<Record<string, string>>;
      const createSql = createRows[0]?.["Create Table"] ?? createRows[0]?.["Create View"];
      if (!createSql) continue;
      const columns = ((await db.query(`SHOW COLUMNS FROM ${quoteId(table)}`)) as Array<{ Field: string }>).map((r) => String(r.Field));
      const rows = (await db.query(`SELECT * FROM ${quoteId(table)}`)) as Array<Record<string, unknown>>;
      const lines: string[] = [];
      lines.push(`-- Table ${table}`);
      lines.push(`DROP TABLE IF EXISTS ${quoteId(table)};`);
      lines.push(createSql + ";");
      const chunkSize = 250;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const values = chunk
          .map((row) => `(${columns.map((c) => sqlValue(row[c])).join(",")})`)
          .join(",");
        lines.push(`INSERT INTO ${quoteId(table)} (${columns.map(quoteId).join(",")}) VALUES ${values};`);
      }
      sections.push(lines.join("\n") + "\n");
    }

    const parts: string[][] = [];
    let current: string[] = [];
    let currentBytes = 0;
    for (const section of sections) {
      const bytes = Buffer.byteLength(section, "utf8");
      if (current.length > 0 && currentBytes + bytes > maxBytes) {
        parts.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(section);
      currentBytes += bytes;
    }
    if (current.length > 0) parts.push(current);

    const files: string[] = [];
    parts.forEach((part, index) => {
      const suffix = parts.length > 1 ? `.part-${String(index + 1).padStart(3, "0")}` : "";
      const file = path.join(outDir, `${baseName}${suffix}.sql`);
      fs.writeFileSync(file, HEADER + "\n" + part.join("\n") + "\n" + FOOTER, "utf8");
      files.push(file);
    });
    if (files.length > 1) {
      fs.writeFileSync(
        path.join(outDir, "IMPORT_ORDER.txt"),
        files.map((f, i) => `${i + 1}. ${path.basename(f)}`).join("\n") + "\n",
        "utf8",
      );
    }
    const totalBytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
    console.log(`parts=${files.length} total_mb=${(totalBytes / 1024 / 1024).toFixed(2)}`);
    for (const file of files) console.log(`file=${path.basename(file)} bytes=${fs.statSync(file).size}`);
  } finally {
    await db.end();
    escapeFn = null;
  }
}

main().catch((e) => { console.error("export-dump failed:", e instanceof Error ? e.message : String(e)); process.exit(1); });
