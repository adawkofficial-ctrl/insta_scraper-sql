/**
 * Read-only guard-key verification.
 * Recomputes activeInstagramGuard/activeUsernameGuard/activeEmailGuard for
 * every lead and reports rows whose stored guard keys do not match.
 *
 * Never points at production: prefers DATABASE_URL_TEST / DATABASE_URL_MYSQL_LOCAL.
 */
import "dotenv/config";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { extractDatabaseName } = require("./test_db_guard.cjs");
const connectionString =
  process.env.DATABASE_URL_TEST ||
  process.env.DATABASE_URL_MYSQL_LOCAL ||
  process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Missing DATABASE_URL_TEST / DATABASE_URL_MYSQL_LOCAL / DATABASE_URL");
  process.exit(1);
}
const dbName = extractDatabaseName(connectionString);
if (/prod|live/i.test(dbName)) {
  console.error(`Refusing to run against non-test database "${dbName}".`);
  process.exit(1);
}
const verifiedConnectionString = connectionString;
process.env.DATABASE_URL = verifiedConnectionString;
process.env.DATABASE_URL_MYSQL_LOCAL = verifiedConnectionString;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { verifyLeadGuardKeys } from "../src/lib/services/lead/guard-keys";
import { getPrismaClient } from "../src/lib/db/prisma";

async function main() {
  const parsed = new URL(verifiedConnectionString);
  console.log(`Guard-key verification -> host=${parsed.hostname}:${parsed.port || "3306"} db=${dbName}`);
  const result = await verifyLeadGuardKeys();
  console.log(`Checked ${result.checked} lead row(s).`);
  if (result.mismatches.length === 0) {
    console.log("PASS: all guard keys match their identity fields.");
  } else {
    console.error(`FAIL: ${result.mismatches.length} guard-key mismatch(es):`);
    for (const mismatch of result.mismatches.slice(0, 50)) {
      console.error(JSON.stringify(mismatch));
    }
    if (result.mismatches.length > 50) {
      console.error(`... ${result.mismatches.length - 50} more`);
    }
    process.exitCode = 1;
  }
  await getPrismaClient().$disconnect();
}

main().catch((err) => {
  console.error("Guard-key verification failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
