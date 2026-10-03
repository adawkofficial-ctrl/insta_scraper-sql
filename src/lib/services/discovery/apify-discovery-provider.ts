import "server-only";

import { type ActorRun } from "apify-client";

import { getServerEnv } from "@/lib/env";
import { getApifyClient } from "../scraper/apify-client";
import { classifyApifyProviderError } from "../scraper/apify-error-classifier";
import { normalizeInstagramUsername } from "../scraper/instagram-profile";
import { ProviderError, toProviderError } from "../provider-error";
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
const RUN_WAIT_SECS = 180;
const RUN_TIMEOUT_SECS = 300;

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
    const client = getApifyClient();
    const actorId = getServerEnv("APIFY_DISCOVERY_ACTOR_ID") ?? DISCOVERY_ACTOR_ID;

    const executedQueries =
      input.queries && input.queries.length > 0 ? input.queries : [input.query];
    const searchTerm = executedQueries.join(", ");

    const actorInput = {
      search: searchTerm,
      searchType: SEARCH_TYPE_PROFILE,
      searchLimit: Math.min(input.limit, 250),
    };

    log(
      `[DISCOVERY] actor=${actorId} input=${describeDiscoveryActorInput(actorInput)}`,
    );

    let run: ActorRun;
    try {
      run = await client.actor(actorId).call(actorInput, {
        waitSecs: RUN_WAIT_SECS,
        timeout: RUN_TIMEOUT_SECS,
        log: null,
      });
    } catch (error) {
      throw toProviderError(
        this.name,
        "discover",
        error,
        classifyApifyProviderError(error) ?? "actor_start_failed",
      );
    }

    if (run.status === "READY" || run.status === "RUNNING") {
      try {
        await client.run(run.id).abort();
      } catch {
        // The run may have finished between polling and the abort attempt.
      }
      throw new ProviderError(
        this.name,
        "discover",
        `Discovery run ${run.id} did not finish within ${RUN_WAIT_SECS}s.`,
        { code: "run_timeout" },
      );
    }

    if (run.status !== "SUCCEEDED") {
      throw new ProviderError(
        this.name,
        "discover",
        `Discovery run ${run.id} finished with status ${run.status}${
          run.statusMessage === undefined ? "" : `: ${run.statusMessage}`
        }.`,
        { code: "actor_failed" },
      );
    }

    const datasetId = run.defaultDatasetId ?? null;
    if (datasetId === null) {
      throw new ProviderError(
        this.name,
        "discover",
        `Discovery run ${run.id} did not produce a dataset.`,
        { code: "dataset_failed" },
      );
    }

    let items: unknown[];
    try {
      const { items: datasetItems } = await client
        .dataset(datasetId)
        .listItems();
      items = datasetItems;
    } catch (error) {
      throw toProviderError(
        this.name,
        "discover",
        error,
        classifyApifyProviderError(error) ?? "dataset_failed",
      );
    }

    const usageTotalUsd = (run as unknown as { usageTotalUsd?: number })?.usageTotalUsd;
    const computeUnits = run.stats?.computeUnits;

    return {
      candidates: extractCandidates(items),
      runId: run.id,
      datasetId,
      actor: actorId,
      executedQueries,
      usageTotalUsd,
      computeUnits,
    };
  }
}

/**
 * Discovery only needs profile identifiers. The search Actor's "user" results
 * include `username` + `url` (plus full profile data we deliberately ignore here
 * so enrichment stays in the existing profile scraper).
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
    candidates.push({
      username,
      profileUrl: rawUrl ?? `https://www.instagram.com/${username}`,
    });
  }

  return candidates;
}
