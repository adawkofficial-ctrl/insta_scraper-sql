/**
 * Host compatibility preflight. Read-only. Prints host/database names and
 * capability info only; never prints the connection URL or secrets.
 */
import os from "node:os";
import mariadb from "mariadb";
import { mysqlConnectionConfig } from "./common";

const REQUIRED_DML = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const REQUIRED_DDL = ["CREATE", "ALTER", "INDEX", "DROP"];
const OPTIONAL = ["REFERENCES", "LOCK TABLES"];

async function main() {
  const url = process.env.DATABASE_URL || process.env.DATABASE_URL_MYSQL_LOCAL;
  if (!url) throw new Error("Missing DATABASE_URL / DATABASE_URL_MYSQL_LOCAL");
  const u = new URL(url);
  console.log(`node=${process.version} platform=${process.platform} arch=${process.arch}`);
  console.log(`memory_total_mb=${Math.round(os.totalmem() / 1024 / 1024)} memory_free_mb=${Math.round(os.freemem() / 1024 / 1024)}`);
  console.log(`host=${u.hostname} port=${u.port || "3306"} database=${u.pathname.replace(/^\//, "")}`);

  const db = await mariadb.createConnection(mysqlConnectionConfig(url));
  const blockers: string[] = [];
  const warnings: string[] = [];
  try {
    const info = (await db.query(
      "SELECT VERSION() version, @@version_comment comment, @@max_connections maxConnections, @@max_user_connections maxUserConnections, @@sql_mode sqlMode, @@collation_server collation, @@character_set_server charset, @@time_zone timeZone",
    ))[0];
    const engine = String(info.comment).toLowerCase().includes("mariadb") ? "mariadb" : "mysql";
    console.log(`engine=${engine} version=${info.version}`);
    console.log(`max_connections=${info.maxConnections} max_user_connections=${info.maxUserConnections}`);
    console.log(`sql_mode=${info.sqlMode}`);
    console.log(`charset=${info.charset} collation=${info.collation} time_zone=${info.timeZone}`);
    if (!/STRICT_ALL_TABLES|STRICT_TRANS_TABLES/i.test(String(info.sqlMode))) blockers.push("strict_sql_mode_missing");
    if (String(info.charset).toLowerCase() !== "utf8mb4") blockers.push("charset_not_utf8mb4");

    let innodb = false;
    try {
      const rows = (await db.query("SELECT SUPPORT FROM information_schema.ENGINES WHERE ENGINE='InnoDB'")) as Array<{ SUPPORT: string }>;
      innodb = String(rows[0]?.SUPPORT ?? "").toUpperCase() !== "NO";
    } catch {}
    console.log(`innodb=${innodb ? "yes" : "no"}`);
    if (!innodb) blockers.push("innodb_unavailable");

    let json = false;
    try { await db.query("SELECT JSON_VALID('{\"a\":1}')"); json = true; } catch {}
    console.log(`json=${json ? (engine === "mariadb" ? "yes (LONGTEXT alias)" : "yes") : "no"}`);

    let privileges = "";
    try {
      const grants = (await db.query("SHOW GRANTS FOR CURRENT_USER()")) as Array<Record<string, string>>;
      privileges = grants.map((g) => Object.values(g).join(" ")).join(" ").toUpperCase();
    } catch {}
    const missing = (list: string[]) => list.filter((p) => !privileges.includes("ALL PRIVILEGES") && !privileges.includes(p));
    const missingDml = missing(REQUIRED_DML);
    const missingDdl = missing(REQUIRED_DDL);
    const missingOptional = missing(OPTIONAL);
    console.log(`privileges_dml=${missingDml.length === 0 ? "ok" : "missing:" + missingDml.join(",")}`);
    console.log(`privileges_ddl=${missingDdl.length === 0 ? "ok" : "missing:" + missingDdl.join(",")}`);
    console.log(`privileges_optional=${missingOptional.length === 0 ? "ok" : "missing:" + missingOptional.join(",")}`);
    if (missingDml.length > 0) blockers.push("missing_dml_privileges");
    if (missingDdl.length > 0) warnings.push("missing_ddl_privileges_use_sql_import");
    if (missingOptional.length > 0) warnings.push("missing_optional_privileges");
  } finally {
    await db.end();
  }

  for (const warning of warnings) console.log(`WARNING ${warning}`);
  for (const blocker of blockers) console.log(`BLOCKER ${blocker}`);
  console.log(blockers.length === 0 ? "PREFLIGHT PASS" : "PREFLIGHT FAIL");
  if (blockers.length > 0) process.exit(1);
}

main().catch((e) => { console.error("preflight failed:", e instanceof Error ? e.message : String(e)); process.exit(1); });
