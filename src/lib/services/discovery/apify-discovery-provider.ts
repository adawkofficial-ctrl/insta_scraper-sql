import "server-only";


import { getServerEnv } from "@/lib/env";
import { runActorSafely } from "../scraper/apify-cost-guard";
import { normalizeInstagramUsername } from "../scraper/instagram-profile";
import type {
  DiscoveredProfile,
  DiscoveryInput,
  DiscoveryProvider,
  DiscoveryResult,
} from "./discovery-provider";

// Verified against the Actor's current input schema (OpenAPI):
//   search (string, required), searchType: "place" | "user" | "hashtag" | "popular",
//   searchLimit (integer 1..250), enhanceUserSearchWithFacebookPage, liveSearch.
// Profile discovery uses searchType "user".
export const DISCOVERY_ACTOR_ID = "apify/instagram-search-scraper";

const SEARCH_TYPE_PROFILE = "user";

function log(message: string): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  console.log(message);
}

/**
 * Sanitized, development-only representation of the Actor input. The Apify API
 * token lives in the client configuration and is NEVER part of this payload, but
 * this helper is deliberately explicit about which fields are logged so a future
 * change cannot accidentally dump secrets.
 */
export function describeDiscoveryActorInput(input: {
  search: string;
  searchType: string;
  searchLimit: number;
}): string {
  return JSON.stringify({
    search: input.search,
    searchType: input.searchType,
    searchLimit: input.searchLimit,
  });
}

export class ApifyDiscoveryProvider implements DiscoveryProvider {
  readonly name = "apify";

  async discover(input: DiscoveryInput): Promise<DiscoveryResult> {
    const actorId = getServerEnv("APIFY_DISCOVERY_ACTOR_ID") ?? DISCOVERY_ACTOR_ID;

    const executedQueries =
      input.queries && input.queries.length > 0 ? input.queries : [input.query];
    const searchTerm = executedQueries.join(", ");

    const envSearchLimit = process.env.APIFY_DISCOVERY_SEARCH_LIMIT
      ? Number.parseInt(process.env.APIFY_DISCOVERY_SEARCH_LIMIT, 10)
      : 500;
    const actorInput = {
      search: searchTerm,
      searchType: SEARCH_TYPE_PROFILE,
      searchLimit: Math.min(input.limit, envSearchLimit > 0 ? envSearchLimit : 500),
    };

    log(
      `[DISCOVERY] actor=${actorId} input=${describeDiscoveryActorInput(actorInput)}`,
    );

    const safeResult = await runActorSafely(actorId, actorInput, {
      maxItems: actorInput.searchLimit,
      campaignId: input.campaignId ?? undefined,
      userId: input.userId ?? undefined,
      operationName: "instagram_search",
    });

    return {
      candidates: extractCandidates(safeResult.items),
      runId: safeResult.run.id,
      datasetId: safeResult.run.defaultDatasetId ?? "none",
      actor: actorId,
      executedQueries,
      usageTotalUsd: safeResult.usageTotalUsd,
      computeUnits: safeResult.computeUnits,
    };
  }
}

/**
 * Discovery returns profile identifiers plus lightweight search-stage data
 * (bio snippet, category, follower count, business address, posts) used by the
 * pre-enrichment relevance filter to reject obvious mismatches before spending
 * expensive enrichment calls.
 */
function extractCandidates(items: unknown[]): DiscoveredProfile[] {
  const seen = new Set<string>();
  const candidates: DiscoveredProfile[] = [];

  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const rawUsername =
      typeof record.username === "string" ? record.username : null;
    const rawUrl = typeof record.url === "string" ? record.url : null;

    const username =
      rawUsername !== null && rawUsername.trim().length > 0
        ? rawUsername.trim().toLowerCase()
        : rawUrl === null
          ? null
          : normalizeInstagramUsername(rawUrl);

    if (username === null || username.length === 0 || seen.has(username)) {
      continue;
    }

    seen.add(username);

    const fullName = typeof record.fullName === "string" ? record.fullName : null;
    const biography =
      typeof record.biography === "string"
        ? record.biography
        : typeof record.bio === "string"
          ? record.bio
          : null;
    const category = typeof record.category === "string" ? record.category : null;
    const businessCategoryName =
      typeof record.businessCategoryName === "string"
        ? record.businessCategoryName
        : null;
    const location = typeof record.location === "string" ? record.location : null;
    const followers =
      typeof record.followersCount === "number"
        ? record.followersCount
        : typeof record.followers === "number"
          ? record.followers
          : null;
    const externalUrl =
      typeof record.externalUrl === "string"
        ? record.externalUrl
        : typeof record.website === "string"
          ? record.website
          : null;
    const businessAddress =
      record.businessAddress && typeof record.businessAddress === "object"
        ? (record.businessAddress as {
            city_name?: string;
            street_address?: string;
            zip_code?: string;
          })
        : null;
    const latestPosts = Array.isArray(record.latestPosts)
      ? (record.latestPosts as Array<{ caption?: string; locationName?: string }>)
      : null;

    candidates.push({
      username,
      profileUrl: rawUrl ?? `https://www.instagram.com/${username}`,
      fullName,
      biography,
      category,
      businessCategoryName,
      location,
      followers,
      followersCount: followers,
      externalUrl,
      website: externalUrl,
      businessAddress,
      latestPosts,
    });
  }

  return candidates;
}
