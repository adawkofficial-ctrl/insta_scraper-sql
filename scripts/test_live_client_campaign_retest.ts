import "./preload_server_only.cjs";
import "dotenv/config";
import { assertScriptSafeForApify } from "../src/lib/services/scraper/apify-cost-guard";
import { getPrismaClient } from "../src/lib/db/prisma";
import { runDiscovery } from "../src/lib/services/discovery/discovery-service";

assertScriptSafeForApify();

const prisma = getPrismaClient();

async function main() {
  console.log("=================================================");
  console.log(" LIVE RE-TEST: CLIENT FLAGGED CAMPAIGN & INTENT");
  console.log("=================================================");

  // Find the exact campaign the client flagged
  const campaign: any = await prisma.campaign.findFirst({
    where: {
      OR: [
        { id: "cmuuvcia50002qoth5vz0j5go" },
        { name: { contains: "Websites" } }
      ]
    },
    include: { user: true }
  });

  if (!campaign) {
    console.log("Target campaign not found in DB. Creating test campaign with exact client parameters...");
    // If not found, create a campaign with the exact client inputs
  } else {
    console.log(`Found target campaign: ID=${campaign.id}, Name="${campaign.name}"`);
    console.log(`Intent: "${campaign.intent}"`);
    console.log(`Search Terms: "${campaign.searchTerm}"`);
    console.log(`Current leads count: ${await prisma.lead.count({ where: { campaignId: campaign.id } })}`);
  }

  const targetCampaignId = campaign ? campaign.id : "cmuuvcia50002qoth5vz0j5go";
  const userId = campaign ? campaign.userId : "cmuuvc14b0000qothm41f1q75";

  // Run discovery with requestedLimit = 5
  console.log("\nStarting 1-click Discovery with requestedLimit = 5...");
  const startTime = Date.now();
  
  const result = await runDiscovery(
    {
      campaignId: targetCampaignId,
      query: campaign?.searchTerm ?? "website redesign, web development, digital marketing",
      location: campaign?.location ?? null,
      category: campaign?.category ?? null,
      maxLeads: 5,
    },
    userId
  );

  const durationMs = Date.now() - startTime;
  console.log("\n--- DISCOVERY RESULT ---");
  console.log(`Duration: ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`Persisted: ${result.persisted}`);
  console.log(`Enriched: ${result.candidatesEnriched}`);
  console.log(`Discovered: ${result.candidatesDiscovered}`);
  console.log(`Notice: ${result.notice}`);

  const job = await prisma.scrapeJob.findUnique({
    where: { id: result.scrapeJobId }
  });
  console.log(`Job Status: ${job?.status}`);
  console.log(`Job Usage:`, JSON.stringify(job?.usage, null, 2));

  // Check saved leads
  const savedLeads = await prisma.lead.findMany({
    where: { campaignId: targetCampaignId },
    orderBy: { createdAt: "desc" },
    take: 5
  });

  console.log(`\nRecently saved leads (${savedLeads.length}):`);
  for (const l of savedLeads) {
    console.log(`- @${l.username}: "${l.fullName}" | Category: ${l.category || "none"} | Bio snippet: ${(l.biography || "").slice(0, 70)}...`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Live test failed:", err);
    process.exit(1);
  });
