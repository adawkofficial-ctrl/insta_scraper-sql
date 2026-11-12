import "./preload_server_only.cjs";
import "dotenv/config";
import { assertScriptSafeForApify } from "../src/lib/services/scraper/apify-cost-guard";
import { getApifyClient } from "../src/lib/services/scraper/apify-client";

assertScriptSafeForApify();
import {
  evaluateProfileRelevance,
  decideRelevance,
} from "../src/lib/services/discovery/lead-relevance";

async function main() {
  const client = getApifyClient();
  const run = await client.run("kdiSn92pVRTGlcQz8").get();
  console.log("Run status:", run?.status, "datasetId:", run?.defaultDatasetId);
  if (!run?.defaultDatasetId) return;

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`Enriched items in run: ${items.length}`);

  const campaign = {
    intent: "businesses needing website redesign, companies looking for UI UX design, SaaS companies with outdated websites, businesses improving their digital presence",
    category: "Digital Design & Development",
    location: "United States",
  };

  for (const item of items as any[]) {
    const profile = {
      username: item.username,
      fullName: item.fullName,
      biography: item.biography,
      category: item.categoryName,
      businessCategoryName: item.businessCategoryName,
      location: item.locationName || item.city,
      externalUrl: item.externalUrl,
      website: item.externalUrl,
      followers: item.followersCount,
      latestPosts: item.latestPosts,
    };

    const rel = evaluateProfileRelevance(profile as any, campaign);
    const dec = decideRelevance(rel);
    console.log(`\nCandidate: @${item.username} | ${item.fullName}`);
    console.log(`  Category: ${item.businessCategoryName || item.categoryName}`);
    console.log(`  Bio: ${(item.biography || "").replace(/\n/g, " ")}`);
    console.log(`  Matched intent terms: [${rel.matchedIntentTerms.join(", ")}]`);
    console.log(`  Matched category terms: [${rel.matchedCategoryTerms.join(", ")}]`);
    console.log(`  Matched location terms: [${rel.matchedLocationTerms.join(", ")}]`);
    console.log(`  Decision: relevant=${dec.relevant}${!dec.relevant ? ` (${dec.reason})` : ""}`);
  }
}

main().catch(console.error).finally(() => process.exit(0));
