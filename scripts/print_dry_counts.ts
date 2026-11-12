import "./preload_server_only.cjs";
import "dotenv/config";
import { getDryRunCounts } from "../src/lib/services/lead/dry-run-cleanup";
import { getPrismaClient } from "../src/lib/db/prisma";

async function run() {
  const prisma = getPrismaClient();
  const counts = await getDryRunCounts();
  const sampleBusiness = await prisma.lead.count({ where: { username: { startsWith: "sample_business_" } } });
  const exampleCom = await prisma.lead.count({ where: { website: { contains: "example.com" } } });
  const phone555 = await prisma.lead.count({ where: { phone: { contains: "555" } } });
  const totalLeads = await prisma.lead.count();
  const totalJobs = await prisma.scrapeJob.count();
  const dryJobs = await prisma.scrapeJob.count({ where: { isDryRun: true } });
  console.log("COUNTS_JSON:" + JSON.stringify({
    dryLeads: counts.dryLeads,
    dryScrapeJobs: counts.dryScrapeJobs,
    drySightings: counts.drySightings,
    sampleBusiness,
    exampleCom,
    phone555,
    totalLeads,
    totalJobs,
    dryJobs
  }));
}

run().catch(console.error);

