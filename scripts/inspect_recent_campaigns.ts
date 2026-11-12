import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";

async function run() {
  const prisma = getPrismaClient();
  const recentCampaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    include: {
      leads: { take: 10 },
      scrapeJobs: { take: 5, orderBy: { createdAt: "desc" } }
    }
  });
  for (const c of recentCampaigns) {
    console.log(`Campaign ${c.id} "${c.name}": ${c.leads.length} leads in take, intent="${c.intent}", location="${c.location}"`);
    for (const l of c.leads) {
      console.log(`  Lead: id=${l.id}, user=${l.username}, isDryRun=${l.isDryRun}, source=${l.source}, site=${l.website}, phone=${l.phone}`);
    }
    for (const j of c.scrapeJobs) {
      console.log(`  Job: id=${j.id}, isDryRun=${j.isDryRun}, status=${j.status}, provider=${j.provider}, error=${j.errorMessage}`);
    }
  }
}

run().catch(console.error);

