/**
 * Free website enrichment for existing leads:
 *   npm run rehandle -- --campaign <campaignId> [--force]
 *
 * Fetches each lead's own website (homepage + up to 4 same-domain pages) and
 * extracts Instagram, other socials, emails, and phones. No Apify/Gemini/
 * Unipile calls. Never overwrites an existing Instagram handle. At most once
 * per 7 days per lead unless --force is passed.
 */
import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import { enrichLeadsFromWebsites } from "../src/lib/services/enrichment/website-lead-enricher";
import { HANDLE_ENRICHMENT_COOLDOWN_DAYS } from "../src/lib/services/scraper/profile-enrichment-service";

interface CommandLineArgs {
  campaignId: string | null;
  force: boolean;
}

function parseArgs(): CommandLineArgs {
  const args = process.argv.slice(2);
  let campaignId: string | null = null;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--campaign" && i + 1 < args.length) {
      campaignId = args[i + 1];
      i++;
    } else if (arg.startsWith("--campaign=")) {
      campaignId = arg.split("=")[1] || null;
    } else if (arg === "--force") {
      force = true;
    }
  }

  return { campaignId, force };
}

async function main() {
  const { campaignId, force } = parseArgs();

  if (!campaignId) {
    console.error("Usage: npm run rehandle -- --campaign <campaignId> [--force]");
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
  console.log(` WEBSITE ENRICHMENT: Campaign "${campaign.name}" (${campaign.id})`);
  console.log(
    ` Policy: Free website scraper only (no Apify), max 1x per ${HANDLE_ENRICHMENT_COOLDOWN_DAYS} days per lead${force ? " (forced)" : ""}.`,
  );
  console.log(`================================================================================\n`);

  const result = await enrichLeadsFromWebsites({
    campaignId,
    force,
    concurrency: 15,
  });

  for (const [index, row] of result.results.entries()) {
    const label = row.name || row.website || row.id;
    const found = [row.handle ? `IG @${row.handle}` : null, row.email, ...row.socials]
      .filter(Boolean)
      .join(" | ");
    console.log(
      `[${index + 1}/${result.results.length}] ${row.outcome.toUpperCase()}: "${label}" -> ${found || row.message}`,
    );
  }

  console.log(`\n================================================================================`);
  console.log(
    ` WEBSITE ENRICHMENT SUMMARY: Eligible: ${result.totalEligible} | Handles: ${result.handlesFound} | Emails: ${result.emailsFound} | Socials: ${result.socialsFound} | NotFound: ${result.notFound} | Cooldown: ${result.cooldownSkipped}`,
  );
  console.log(`================================================================================`);
}

main().catch((err) => {
  console.error("Fatal error during website enrichment:", err);
  process.exit(1);
});
