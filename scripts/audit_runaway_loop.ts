import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import { UsageProvider } from "../src/generated/prisma/client";

async function main() {
  const prisma = getPrismaClient();

  const jobs = await prisma.scrapeJob.findMany({
    where: {
      createdAt: {
        gte: new Date("2026-10-22T06:35:00Z"),
        lte: new Date("2026-10-22T07:20:00Z"),
      },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`=== SCRAPE JOBS IN 11:39-12:17 AUDIT WINDOW (Total: ${jobs.length}) ===\n`);
  for (const j of jobs) {
    console.log(`----------------------------------------------------------------`);
    console.log(`Job ID: ${j.id}`);
    console.log(`  Campaign: ${j.campaignId}`);
    console.log(`  Created: ${j.createdAt.toISOString()} | Completed: ${j.completedAt?.toISOString()}`);
    console.log(`  Query: "${j.query}" | Location: "${j.location}" | TargetLimit: ${j.inputCount} | Saved Leads: ${j.processedCount} | Candidates: ${j.candidatesDiscovered}`);
    console.log(`  Status: ${j.status} | StopReason: ${j.stopReason}`);
    console.log(`  ErrorMessage: ${j.errorMessage}`);
    const u = (j.usage ?? {}) as any;
    console.log(`  Usage roundsExecuted: ${u.roundsExecuted}`);
    console.log(`  Usage requestsUsed: ${u.requestsUsed}`);
    console.log(`  Usage executedQueries: ${JSON.stringify(u.executedQueries)}`);
    console.log(`  Usage discoveryRunIds (${u.discoveryRunIds?.length ?? 0}): ${JSON.stringify(u.discoveryRunIds)}`);
    console.log(`  Usage enrichmentRunIds (${u.enrichmentRunIds?.length ?? 0}): ${JSON.stringify(u.enrichmentRunIds)}`);
    console.log(`  Usage discoveryCostUsd: $${u.discoveryCostUsd ?? 0}, enrichmentCostUsd: $${u.enrichmentCostUsd ?? 0}, totalCost: $${u.estimatedApifyCost ?? 0}`);
    console.log(`  Usage placesReturned: ${u.placesReturned}, placesWithInstagram: ${u.placesWithInstagram}, outOfArea: ${u.outOfAreaCount}, noInstagram: ${u.noInstagramCount}`);
    console.log(`  Usage leadsEnriched: ${u.leadsEnriched}, newLeadsCreated: ${u.newLeadsCreated}`);
  }

  const logs = await prisma.usageLog.findMany({
    where: {
      createdAt: {
        gte: new Date("2026-10-22T06:35:00Z"),
        lte: new Date("2026-10-22T07:20:00Z"),
      },
      provider: UsageProvider.APIFY,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\n=== APIFY USAGE LOGS IN AUDIT WINDOW (Total: ${logs.length}) ===\n`);
  for (const l of logs) {
    const meta = (l.metadata ?? {}) as any;
    console.log(
      `[${l.createdAt.toISOString()}] Operation: ${l.operation} | RunId: ${meta.runId} | Actor: ${meta.actorId} | Cost: $${l.estimatedCostUsd} | Items: ${l.itemsReturned} | Status: ${meta.status} | JobId: ${meta.scrapeJobId ?? meta.jobId}`
    );
  }
}

main().catch(console.error).finally(() => process.exit(0));

