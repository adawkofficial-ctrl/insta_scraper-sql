import "dotenv/config";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl } = require("../test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.DATABASE_URL_MYSQL_LOCAL = process.env.DATABASE_URL;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("../preload_server_only.cjs");

import { getPrismaClient } from "../../src/lib/db/prisma";

async function main() {
  const prisma = getPrismaClient();
  const tag = `recovery_${Date.now()}`;
  const user = await prisma.user.create({ data: { email: `${tag}@example.com`, passwordHash: "x" } });
  const profile = await prisma.companyProfile.create({ data: { userId: user.id, name: "Recovery Co" } });
  const campaign = await prisma.campaign.create({ data: { userId: user.id, companyProfileId: profile.id, name: "Recovery Campaign" } });
  const job = await prisma.scrapeJob.create({
    data: { campaignId: campaign.id, provider: "google_maps", status: "RUNNING", query: "dentist", location: "Toronto" },
  });
  await prisma.candidate.create({
    data: {
      campaignId: campaign.id,
      scrapeJobId: job.id,
      placeId: `${tag}_place`,
      name: "Recovered Dental",
      handle: `${tag}_handle`,
      status: "ENRICH_PENDING",
      handleSource: "homepage",
      handleConfidence: "high",
    },
  });

  const child = spawnSync("npx", ["tsx", "-r", "./scripts/preload_server_only.cjs", "scripts/etl/recovery-run.ts"], {
    cwd: process.cwd(),
    shell: true,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DATABASE_URL_MYSQL_LOCAL: process.env.DATABASE_URL_MYSQL_LOCAL, NODE_ENV: "test" },
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  assert(child.status === 0, `recovery child failed: ${output.slice(-500)}`);
  assert(/resumed=[1-9]/.test(output), `recovery did not resume: ${output.slice(-500)}`);

  const jobAfter = await prisma.scrapeJob.findUniqueOrThrow({ where: { id: job.id } });
  const lead = await prisma.lead.findFirst({ where: { campaignId: campaign.id, username: `${tag}_handle` } });
  assert.equal(jobAfter.status, "COMPLETED");
  assert.ok(lead, "recovered lead was not persisted");
  console.log(`PASS startup recovery after process restart: job=${job.id} lead=${lead.id} status=${jobAfter.status}`);
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => { console.error("recovery smoke failed:", err instanceof Error ? err.message : String(err)); process.exit(1); });
