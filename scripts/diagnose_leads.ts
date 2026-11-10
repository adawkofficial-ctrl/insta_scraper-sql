import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  evaluateProfileRelevance,
  decideRelevance,
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
} from "../src/lib/services/discovery/lead-relevance";

async function main() {
  const prisma = getPrismaClient();
  const campaigns = await prisma.campaign.findMany({
    include: {
      leads: {
        orderBy: { createdAt: "desc" },
        take: 30,
      },
      scrapeJobs: {
        orderBy: { createdAt: "desc" },
        take: 5,
      },
    },
  });

  console.log(`Found ${campaigns.length} campaigns`);
  for (const c of campaigns) {
    if (c.leads.length === 0) continue;
    console.log(`\n======================================================`);
    console.log(`CAMPAIGN: ${c.id} | Name: "${c.name}"`);
    console.log(`Intent: "${c.intent}" | Cat: "${c.category}" | Loc: "${c.location}"`);
    console.log(`Total Leads in campaign: ${c.leads.length}`);

    for (const lead of c.leads) {
      const profile = {
        username: lead.username,
        fullName: lead.fullName,
        biography: lead.biography,
        category: lead.category,
        businessCategoryName: lead.businessCategoryName,
        location: lead.location,
        externalUrl: lead.externalUrl,
        website: lead.website,
        followers: lead.followers,
      };

      const rel = evaluateProfileRelevance(profile as any, {
        intent: c.intent,
        category: c.category,
        location: c.location,
      });
      const dec = decideRelevance(rel);

      console.log(`\n  Lead: @${lead.username} (${lead.fullName ?? "No Name"})`);
      console.log(`    Category: ${lead.category || lead.businessCategoryName || "None"}`);
      console.log(`    Bio: ${(lead.biography || "").replace(/\n/g, " ").slice(0, 120)}`);
      console.log(`    Location: ${lead.location || "None"}`);
      console.log(`    Relevance Evaluation:`);
      console.log(`      intentTerms: [${rel.intentTerms.join(", ")}]`);
      console.log(`      matchedIntentTerms: [${rel.matchedIntentTerms.join(", ")}]`);
      console.log(`      categoryMatch: ${rel.categoryMatch} (matched: [${rel.matchedCategoryTerms.join(", ")}])`);
      console.log(`      locationMatch: ${rel.locationMatch} (matched: [${rel.matchedLocationTerms.join(", ")}])`);
      console.log(`      Decision: relevant=${dec.relevant}${!dec.relevant ? ` (${dec.reason})` : ""}`);
    }
  }
}

main().catch(console.error).finally(() => process.exit(0));
