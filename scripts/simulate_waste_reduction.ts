import "./preload_server_only.cjs";
import "dotenv/config";
import { assertScriptSafeForApify } from "../src/lib/services/scraper/apify-cost-guard";
import { getApifyClient } from "../src/lib/services/scraper/apify-client";

assertScriptSafeForApify();
import { prefilterCandidate } from "../src/lib/services/discovery/lead-relevance";

async function main() {
  const client = getApifyClient();

  // Search run 5Kja4kflN1Tabua8i from diagnosis
  console.log("Fetching items from historical search run 5Kja4kflN1Tabua8i...");
  const searchRun = await client.run("5Kja4kflN1Tabua8i").get();
  if (!searchRun?.defaultDatasetId) {
    console.error("No default dataset id found");
    return;
  }

  const { items: searchItems } = await client
    .dataset(searchRun.defaultDatasetId)
    .listItems({ limit: 100 });

  const campaign = {
    intent: "fitness gyms and fitness businesses",
    location: "Rawalpindi",
    category: "Fitness",
  };

  const total = searchItems.length;
  let rejected = 0;
  let proceed = 0;
  const reasons: Record<string, number> = {};
  const rejectedExamples: Array<{ username: string; reason: string; detail?: string }> = [];
  const proceedExamples: Array<{ username: string; detail?: string }> = [];

  for (const item of searchItems as any[]) {
    const candidate = {
      username: item.username,
      profileUrl: item.url,
      fullName: item.fullName,
      biography: item.biography || item.bio,
      category: item.category,
      businessCategoryName: item.businessCategoryName,
      location: item.location,
      businessAddress: item.businessAddress,
      followersCount: item.followersCount || item.followers,
      followers: item.followersCount || item.followers,
    };

    const res = prefilterCandidate(candidate, campaign);
    if (res.action === "REJECT") {
      rejected++;
      const reasonKey = res.underlyingReason || "UNKNOWN";
      reasons[reasonKey] = (reasons[reasonKey] || 0) + 1;
      if (rejectedExamples.length < 5) {
        rejectedExamples.push({ username: item.username, reason: reasonKey, detail: res.detail });
      }
    } else {
      proceed++;
      if (proceedExamples.length < 5) {
        proceedExamples.push({ username: item.username, detail: (item.biography || "").slice(0, 40) });
      }
    }
  }

  console.log("=================================================================");
  console.log("   LIVE SIMULATION: WASTED ENRICHMENT COST REDUCTION            ");
  console.log("=================================================================");
  console.log(`Total Candidates Discovered:               ${total}`);
  console.log(`Pre-Filter Rejected (Enrichments SAVED):   ${rejected} (${((rejected / total) * 100).toFixed(1)}%)`);
  console.log(`Proceeded to Authoritative Enrichment:     ${proceed} (${((proceed / total) * 100).toFixed(1)}%)`);
  console.log("\nRejection Breakdown by Underlying Reason:");
  for (const [r, cnt] of Object.entries(reasons)) {
    console.log(`  - ${r}: ${cnt} (${((cnt / rejected) * 100).toFixed(1)}% of rejections)`);
  }
  console.log("\nSample Pre-filter Rejections (Saved $):");
  for (const ex of rejectedExamples) {
    console.log(`  - @${ex.username} -> ${ex.reason}: ${ex.detail}`);
  }
  console.log("\nSample Passing Candidates (Preserved for Enrichment):");
  for (const ex of proceedExamples) {
    console.log(`  - @${ex.username} -> "${ex.detail}..."`);
  }
}

main().catch(console.error).finally(() => process.exit(0));
