import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";

async function main() {
  const prisma = getPrismaClient();
  const jobs = await prisma.scrapeJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      campaignId: true,
      query: true,
      location: true,
      category: true,
      requestedLimit: true,
      candidatesDiscovered: true,
      candidatesEnriched: true,
      candidatesSkipped: true,
      processedCount: true,
      errorMessage: true,
      usage: true,
      createdAt: true,
    },
  });

  console.log(`ScrapeJobs count: ${jobs.length}`);
  for (const j of jobs) {
    console.log(JSON.stringify(j, null, 2));
  }
}

main().catch(console.error).finally(() => process.exit(0));
