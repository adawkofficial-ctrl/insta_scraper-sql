import "dotenv/config";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl } = require("../test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.DATABASE_URL_MYSQL_LOCAL = process.env.DATABASE_URL;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("../preload_server_only.cjs");

import { recoverUnfinishedScrapeJobs } from "../../src/lib/services/discovery/startup-recovery";
import { getPrismaClient } from "../../src/lib/db/prisma";

async function main() {
  const result = await recoverUnfinishedScrapeJobs();
  console.log(`recovery scanned=${result.scanned} resumed=${result.resumed} failed=${result.failed} jobIds=${result.jobIds.join(",")}`);
  await getPrismaClient().$disconnect();
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
