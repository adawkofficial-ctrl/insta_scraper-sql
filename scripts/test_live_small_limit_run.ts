import "dotenv/config";
import { assertScriptSafeForApify } from "../src/lib/services/scraper/apify-cost-guard";
import { getPrismaClient } from "../src/lib/db/prisma";
import { runDiscovery } from "../src/lib/services/discovery/discovery-service";

assertScriptSafeForApify();

async function main() {
  const prisma = getPrismaClient();

  // Find or create a test user
  let user = await prisma.user.findFirst();
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: "test_pipeline@example.com",
        passwordHash: "dummy_hash",
        name: "Test User",
      },
    });
  }

  // Create a clean test campaign with location="Rawalpindi"
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      name: `Live Test Rawalpindi ${Date.now()}`,
      intent: "hospital medical clinic",
      location: "Rawalpindi",
      category: "Healthcare",
      leadLimit: 2,
    } as any,
  });

  console.log(`[LIVE TEST] Created test campaign ${campaign.id} with location="Rawalpindi"`);

  const result = await runDiscovery(
    {
      campaignId: campaign.id,
      query: "hospital medical clinic",
      location: "Rawalpindi",
      category: "Healthcare",
      maxLeads: 2,
    },
    user.id,
    (ev) => {
      console.log(`[PROGRESS] ${ev.stage}: ${ev.message}`);
    },
  );

  console.log("\n=================================================================");
  console.log("   LIVE DISCOVERY RUN RESULTS                                    ");
  console.log("=================================================================");
  console.log(`Campaign ID: ${result.campaignId}`);
  console.log(`Candidates Discovered: ${result.candidatesDiscovered}`);
  console.log(`Candidates Enriched: ${result.candidatesEnriched}`);
  console.log(`Leads Persisted: ${result.persisted}`);
  console.log(`Skip breakdown:`, JSON.stringify(result.skipCounts, null, 2));

  // Inspect persisted leads in DB
  const leads = await prisma.lead.findMany({
    where: { campaignId: campaign.id },
  });

  console.log(`\nPersisted leads count in DB: ${leads.length}`);
  let bioContactCount = 0;
  let websiteFallbackCount = 0;
  let neitherCount = 0;

  for (const l of leads) {
    console.log(`\n- Lead @${l.username}:`);
    console.log(`  Full Name: ${l.fullName}`);
    console.log(`  Location: ${l.location}`);
    console.log(`  Bio: ${l.biography?.slice(0, 80)}...`);
    console.log(`  Email: ${l.email ?? "none"} (normalized: ${l.emailNormalized ?? "none"})`);
    console.log(`  Phone: ${l.phone ?? "none"} (normalized: ${l.phoneNormalized ?? "none"})`);
    console.log(`  Website: ${l.website ?? "none"}`);
    console.log(`  Contact Source: ${l.contactSource ?? "none"}`);
    console.log(`  Channels: IG=${l.hasInstagram} email=${l.hasEmail} phone=${l.hasPhone} web=${l.hasWebsite} social=${l.hasOtherSocial}`);

    if (l.contactSource === "instagram_bio") bioContactCount++;
    else if (l.contactSource === "website_fallback") websiteFallbackCount++;
    else neitherCount++;
  }

  // Check Apify usage logs created for this campaign
  const usageLogs = await prisma.usageLog.findMany({
    where: { campaignId: campaign.id },
  });
  console.log(`\nUsageLogs created: ${usageLogs.length}`);
  for (const u of usageLogs) {
    console.log(`- ${u.operation}: cost=${u.estimatedCostUsd ?? "n/a"} USD, items=${u.itemsReturned}, metadata=${JSON.stringify(u.metadata)}`);
  }

  console.log("\nContact Source Summary:");
  console.log(`- Instagram Bio: ${bioContactCount}`);
  console.log(`- Website Fallback: ${websiteFallbackCount}`);
  console.log(`- Neither: ${neitherCount}`);
}

main().catch((err) => {
  console.error("Live test failed:", err);
  process.exit(1);
});
