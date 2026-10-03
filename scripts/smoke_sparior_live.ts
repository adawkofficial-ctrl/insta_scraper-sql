import "./preload_server_only.cjs";

import { SpariorClient } from "../src/lib/services/scraper/sparior/sparior-client";
import { mapSpariorProfileToLeadProfile } from "../src/lib/services/scraper/sparior/sparior-mappers";
import { getSpariorConfig } from "../src/lib/env";

async function main() {
  if (process.env.SPARIOR_LIVE_TEST !== "1") {
    console.log(
      "[smoke_sparior_live] SPARIOR_LIVE_TEST is not set to 1. Skipping live smoke test.",
    );
    process.exit(0);
  }

  const config = getSpariorConfig(true);
  console.log(
    `[smoke_sparior_live] Starting Sparior live smoke test (host: ${config.apiHost})...`,
  );

  const client = new SpariorClient();

  // Request 1: Search call
  console.log("[smoke_sparior_live] Request 1: Testing discovery search...");
  const searchResult = await client.search("fitness", { limit: 5 });

  console.log(`[smoke_sparior_live] Search completed in ${searchResult.durationMs}ms`);
  console.log(
    `[smoke_sparior_live] Rate limit remaining: ${
      searchResult.rateLimits.remaining ?? "unknown"
    }, Limit: ${searchResult.rateLimits.limit ?? "unknown"}`,
  );

  const rawData = searchResult.data as Record<string, unknown>;
  const items: unknown[] = Array.isArray(rawData?.data)
    ? (rawData.data as unknown[])
    : (((rawData?.data as Record<string, unknown>)?.items as unknown[] | undefined) ?? []);

  console.log(`[smoke_sparior_live] Profiles returned from search: ${items.length}`);

  // Request 2: Profile details call if a username was found
  let sampleUsername = "instagram";
  if (items.length > 0 && typeof items[0] === "object" && items[0] !== null) {
    const item = items[0] as Record<string, unknown>;
    const userObj =
      typeof item.user === "object" && item.user !== null
        ? (item.user as Record<string, unknown>)
        : item;
    if (typeof userObj.username === "string") {
      sampleUsername = userObj.username;
    }
  }

  console.log(`[smoke_sparior_live] Request 2: Testing profile retrieval for "${sampleUsername}"...`);
  const profileResult = await client.getProfile(sampleUsername);

  console.log(`[smoke_sparior_live] Profile completed in ${profileResult.durationMs}ms`);
  console.log(
    `[smoke_sparior_live] Rate limit remaining: ${
      profileResult.rateLimits.remaining ?? "unknown"
    }`,
  );

  const mapped = mapSpariorProfileToLeadProfile(
    (profileResult.data as Record<string, unknown>)?.data ?? profileResult.data,
  );

  if (mapped) {
    console.log("[smoke_sparior_live] Anonymized mapped profile summary:");
    console.log(
      JSON.stringify(
        {
          username: mapped.username.slice(0, 3) + "***",
          hasBiography: Boolean(mapped.biography),
          followers: mapped.followers,
          following: mapped.following,
          postsCount: mapped.postsCount,
          isVerified: mapped.isVerified,
          isBusiness: mapped.isBusiness,
          hasEmail: Boolean(mapped.email),
          hasWebsite: Boolean(mapped.website),
          source: mapped.source,
        },
        null,
        2,
      ),
    );
  }

  console.log("[smoke_sparior_live] Live smoke test completed successfully (2 requests used).");
}

main().catch((err) => {
  console.error("[smoke_sparior_live] Live smoke test failed:", err.message);
  process.exit(1);
});
