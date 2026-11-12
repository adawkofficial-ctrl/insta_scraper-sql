import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import { enrichLeadHandleWaterfall, HANDLE_ENRICHMENT_COOLDOWN_DAYS } from "../src/lib/services/scraper/profile-enrichment-service";

interface CommandLineArgs {
  campaignId: string | null;
}

function parseArgs(): CommandLineArgs {
  const args = process.argv.slice(2);
  let campaignId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--campaign" && i + 1 < args.length) {
      campaignId = args[i + 1];
      i++;
    } else if (arg.startsWith("--campaign=")) {
      campaignId = arg.split("=")[1] || null;
    }
  }

  return { campaignId };
}

async function main() {
  const { campaignId } = parseArgs();

  if (!campaignId) {
    console.error("Usage: npm run rehandle -- --campaign <campaignId>");
    process.exit(1);
  }

  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true },
  });

  if (!campaign) {
    console.error(`Error: Campaign "${campaignId}" not found.`);
    process.exit(1);
  }

  console.log(`================================================================================`);
  console.log(` RE-HANDLE ENRICHMENT: Campaign "${campaign.name}" (${campaign.id})`);
  console.log(` Policy: Free website waterfall only (no Apify), max 1x per ${HANDLE_ENRICHMENT_COOLDOWN_DAYS} days per lead.`);
  console.log(`================================================================================\n`);

  const allLeads = await prisma.lead.findMany({
    where: {
      campaignId,
      website: { not: null },
      OR: [
        { username: null },
        { username: "" },
      ],
    },
    select: {
      id: true,
      fullName: true,
      website: true,
      username: true,
      lastHandleEnrichmentAt: true,
      rating: true,
      reviewCount: true,
      isClaimed: true,
      isChain: true,
      email: true,
      phone: true,
      availableChannels: true,
      scoreFlags: true,
    },
  });

  const eligibleLeads = allLeads.filter((l) => l.website && l.website.trim().length > 0);

  if (eligibleLeads.length === 0) {
    console.log("No leads without an Instagram handle and with a valid website were found in this campaign.");
    process.exit(0);
  }

  console.log(`Found ${eligibleLeads.length} lead(s) with a website and no Instagram handle.\n`);

  let foundCount = 0;
  let notFoundCount = 0;
  let cooldownCount = 0;

  for (let i = 0; i < eligibleLeads.length; i++) {
    const lead = eligibleLeads[i];
    const leadLabel = lead.fullName || lead.website || lead.id;

    const res = await enrichLeadHandleWaterfall(lead, prisma);

    if (res.outcome === "found") {
      foundCount++;
      console.log(
        `[${i + 1}/${eligibleLeads.length}] FOUND: "${leadLabel}" -> @${res.handle} (source: ${res.handleSource}, confidence: ${res.handleConfidence})`,
      );
    } else if (res.outcome === "cooldown") {
      cooldownCount++;
      console.log(`[${i + 1}/${eligibleLeads.length}] COOLDOWN SKIPPED: "${leadLabel}" -> ${res.message}`);
    } else {
      notFoundCount++;
      console.log(`[${i + 1}/${eligibleLeads.length}] NOT FOUND: "${leadLabel}" -> ${res.message}`);
    }
  }

  console.log(`\n================================================================================`);
  console.log(` REHANDLE SUMMARY: Total: ${eligibleLeads.length} | Found: ${foundCount} | Not Found: ${notFoundCount} | Cooldown Skipped: ${cooldownCount}`);
  console.log(`================================================================================`);
}

main().catch((err) => {
  console.error("Fatal error during rehandle:", err);
  process.exit(1);
});

