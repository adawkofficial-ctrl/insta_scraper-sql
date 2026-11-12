import "server-only";

import {
  getDiscoveryMaxJobUsd,
  getIgMaxQueriesPerJob,
  getIgMaxResultsPerJob,
  getIgScraperCostPerResultUsd,
  getIgSearchLimit,
  getServerEnv,
} from "@/lib/env";
import { runActorSafely } from "../scraper/apify-cost-guard";
import { assertDiscoveryActorEnabled } from "../scraper/provider-switch";
import type {
  DiscoveredProfile,
  DiscoveryInput,
  DiscoveryProvider,
  DiscoveryResult,
} from "./discovery-provider";
import {
  buildInstagramSearchInput,
  planInstagramQueries,
  verifyCandidateLocation,
  type PerQuerySearchStat,
} from "./instagram-all-in-one-query";
import {
  mapInstagramPlaceSignal,
  mapInstagramScraperItem,
  summarizeMissingFields,
  type MappedInstagramProfile,
  type MappedPlaceSignal,
} from "./instagram-all-in-one-mapper";
import { normalizeInstagramUsername } from "../scraper/instagram-profile";
import { clusterMultiLocationGroups } from "./group-detector";

export const IG_ALL_IN_ONE_ACTOR_ID = "apify/instagram-scraper";
export const IG_ALL_IN_ONE_PROVIDER_NAME = "instagram_all_in_one";

function getActorId(): string {
  return getServerEnv("APIFY_IG_SCRAPER_ACTOR_ID") ?? IG_ALL_IN_ONE_ACTOR_ID;
}

function log(message: string): void {
  if (process.env.NODE_ENV === "production") return;
  console.log(message);
}

export type InstagramResultUsage = {
  searchResults: number;
  detailsResults: number;
  spendUsd: number;
};

export type InstagramSearchRunOutput = {
  candidates: MappedInstagramProfile[];
  placeSignals: MappedPlaceSignal[];
  perQueryStats: PerQuerySearchStat[];
  executedQueries: string[];
  skippedQueries: string[];
  runIds: string[];
  usage: InstagramResultUsage;
  stopReason: string | undefined;
  estimatedCostUsd: number;
};

/**
 * Search mode only. Calls the actor once per planned query; never mixes search
 * and details input in the same run (the actor does not allow that).
 */
export class InstagramAllInOneDiscoveryProvider implements DiscoveryProvider {
  readonly name = IG_ALL_IN_ONE_PROVIDER_NAME;

  async discover(input: DiscoveryInput): Promise<DiscoveryResult> {
    const actorId = getActorId();
    assertDiscoveryActorEnabled(actorId);

    const maxQueries = getIgMaxQueriesPerJob();
    const searchLimit = getIgSearchLimit();
    const maxResults = getIgMaxResultsPerJob();
    const maxJobUsd = getDiscoveryMaxJobUsd();
    const costPerResult = getIgScraperCostPerResultUsd();

    let queries = input.queries && input.queries.length > 0 ? input.queries : [];
    let blockedReason: string | null = null;

    if (queries.length === 0) {
      const plan = planInstagramQueries({
        query: input.query,
        category: input.category ?? null,
        location: input.location ?? null,
        maxQueries,
        searchLimit,
      });
      queries = plan.queries;
      blockedReason = plan.blockedReason;
    }

    if (queries.length === 0) {
      return {
        candidates: [],
        runId: "not_started",
        datasetId: null,
        actor: actorId,
        usageTotalUsd: 0,
        stopReason: blockedReason ? "location_required" : "no_queries",
        error: blockedReason ?? undefined,
        perQueryStats: [],
        executedQueries: [],
        skippedQueries: [],
      };
    }

    const uniqueQueries = Array.from(new Set(queries.map((q) => q.trim()).filter(Boolean))).slice(
      0,
      maxQueries,
    );
    const targetCity = input.location ?? null;
    // City-level verification uses bio/address/place tokens plus the external
    // URL's ccTLD; a country code is not needed and would weaken matching.
    const targetCountry: string | null = null;

    let consumedResults = 0;
    let spendUsd = 0;
    let estimatedCostUsd = 0;
    let stopReason: string | undefined;
    const perQueryStats: PerQuerySearchStat[] = [];
    const executedQueries: string[] = [];
    const skippedQueries: string[] = [];
    const runIds: string[] = [];
    const seenUsernames = new Set<string>();
    const candidates: MappedInstagramProfile[] = [];
    const placeSignals: MappedPlaceSignal[] = [];

    for (const query of uniqueQueries) {
      const remainingResults = maxResults - consumedResults;
      if (remainingResults <= 0) {
        stopReason = "budget_exhausted";
        skippedQueries.push(query);
        continue;
      }

      const runLimit = Math.min(searchLimit, remainingResults);
      const estimate = Number((runLimit * costPerResult).toFixed(4));
      if (spendUsd + estimate > maxJobUsd) {
        stopReason = "budget_exhausted";
        skippedQueries.push(query);
        continue;
      }

      const actorInput = buildInstagramSearchInput(query, runLimit, "search", input.location);
      log(
        `[IG-ALL-IN-ONE] search query="${query}" limit=${runLimit} est=$${estimate} spent=$${spendUsd.toFixed(4)}`,
      );

      const safeResult = await runActorSafely<unknown>(actorId, actorInput, {
        maxItems: runLimit,
        campaignId: input.campaignId ?? undefined,
        userId: input.userId ?? undefined,
        operationName: "instagram_all_in_one_search",
        jobAccumulatedCostUsd: spendUsd,
      });

      executedQueries.push(query);
      runIds.push(safeResult.run.id);
      spendUsd += safeResult.usageTotalUsd ?? 0;
      estimatedCostUsd += estimate;

      const stat: PerQuerySearchStat = {
        query,
        results: 0,
        accepted: 0,
        rejectedWrongLocation: 0,
        rejectedNonBusiness: 0,
        rejectedPrivate: 0,
        rejectedDuplicate: 0,
        costUsd: safeResult.usageTotalUsd ?? 0,
        costPerAcceptedLeadUsd: null,
      };

      for (const item of safeResult.items) {
        stat.results++;
        const mapped = mapInstagramScraperItem(item);
        if (!mapped) {
          const place = mapInstagramPlaceSignal(item);
          if (place) {
            placeSignals.push(place);
          }
          continue;
        }

        consumedResults++;
        const username = mapped.username!;
        if (seenUsernames.has(username)) {
          stat.rejectedDuplicate++;
          continue;
        }
        seenUsernames.add(username);

        if (mapped.isPrivate === true) {
          stat.rejectedPrivate++;
          continue;
        }
        if (mapped.isBusinessAccount === false) {
          stat.rejectedNonBusiness++;
          continue;
        }

        const verification = verifyCandidateLocation(mapped, targetCity, targetCountry);
        if (verification.status === "wrong_location") {
          stat.rejectedWrongLocation++;
          continue;
        }
        mapped.flags = verification.status === "unverified" ? ["location_unverified"] : [];
        mapped.locationVerification = verification.status;

        candidates.push(mapped);
        stat.accepted++;
      }

      stat.costPerAcceptedLeadUsd =
        stat.accepted > 0 ? Number((stat.costUsd / stat.accepted).toFixed(4)) : null;
      perQueryStats.push(stat);

      if (consumedResults >= maxResults) {
        stopReason = "budget_exhausted";
      }
    }

    // Optional place search mode: location signal only, never business listings.
    if (getServerEnv("IG_SEARCH_INCLUDE_PLACES") === "true") {
      const placeQueries = uniqueQueries.slice(0, Math.min(2, uniqueQueries.length));
      for (const query of placeQueries) {
        if (stopReason === "budget_exhausted") break;
        const estimate = Number((searchLimit * costPerResult).toFixed(4));
        if (spendUsd + estimate > maxJobUsd) {
          stopReason = "budget_exhausted";
          break;
        }
        const actorInput = {
          ...buildInstagramSearchInput(query, Math.min(searchLimit, maxResults - consumedResults), "details", input.location),
          searchType: "place",
        };
        const safeResult = await runActorSafely<unknown>(actorId, actorInput, {
          maxItems: searchLimit,
          campaignId: input.campaignId ?? undefined,
          userId: input.userId ?? undefined,
          operationName: "instagram_all_in_one_place_search",
          jobAccumulatedCostUsd: spendUsd,
        });
        runIds.push(safeResult.run.id);
        spendUsd += safeResult.usageTotalUsd ?? 0;
        estimatedCostUsd += estimate;
        for (const item of safeResult.items) {
          const place = mapInstagramPlaceSignal(item);
          if (place) placeSignals.push(place);
        }
      }
    }

    summarizeMissingFields(candidates);

    // Group / multi-location dedup: same externalUrl domain (or location email)
    // across handles => one message per group. Same normalized business name is
    // also treated as a group so messaging dedup works when chains are allowed.
    const groupOutcomes = clusterMultiLocationGroups(candidates);
    for (const candidate of candidates) {
      const outcome = groupOutcomes.get(candidate);
      if (outcome?.groupKey) {
        candidate.groupKey = outcome.groupKey;
        candidate.isGroup = outcome.isGroup;
      }
    }
    const nameCounts = new Map<string, number>();
    for (const candidate of candidates) {
      const name = candidate.fullName?.trim().toLowerCase().replace(/\s+/g, " ");
      if (name && name.length > 3) {
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
    }
    for (const candidate of candidates) {
      const name = candidate.fullName?.trim().toLowerCase().replace(/\s+/g, " ");
      if (name && (nameCounts.get(name) ?? 0) > 1 && !candidate.groupKey) {
        candidate.groupKey = `name:${name}`;
        candidate.isGroup = true;
      }
    }

    return {
      candidates: candidates as DiscoveredProfile[],
      runId: runIds[0] ?? "not_started",
      datasetId: null,
      actor: actorId,
      usageTotalUsd: Number(spendUsd.toFixed(4)),
      stopReason: stopReason ?? "completed",
      executedQueries,
      skippedQueries,
      keywordStats: perQueryStats.map((stat) => ({
        query: stat.query,
        candidatesCount: stat.accepted,
        rawCount: stat.results,
      })),
      perQueryStats,
      searchResultsConsumed: consumedResults,
      detailsResultsConsumed: 0,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
      locationRejectedCount: perQueryStats.reduce((sum, s) => sum + s.rejectedWrongLocation, 0),
      placeSignals,
      sourceProvider: "instagram_scraper",
      leadsWithIg: candidates.length,
    } as DiscoveryResult;
  }
}

export type InstagramDetailsBatchResult = {
  profiles: MappedInstagramProfile[];
  runIds: string[];
  usageTotalUsd: number;
  estimatedCostUsd: number;
  stopReason: string | undefined;
  resultsConsumed: number;
};

/**
 * Details mode. Batches all shortlisted profile URLs into as few runs as the
 * actor allows (one run per call), never mixed with search input.
 */
export async function runInstagramDetailsBatch(
  usernames: string[],
  options?: {
    campaignId?: string;
    userId?: string;
    maxResults?: number;
    maxJobUsd?: number;
    jobAccumulatedCostUsd?: number;
  },
): Promise<InstagramDetailsBatchResult> {
  const actorId = getActorId();
  assertDiscoveryActorEnabled(actorId);

  const unique = Array.from(
    new Set(
      usernames
        .map((u) => normalizeInstagramUsername(u))
        .filter((u): u is string => Boolean(u)),
    ),
  );

  const maxResults = options?.maxResults ?? getIgMaxResultsPerJob();
  const target = unique.slice(0, Math.max(0, maxResults));
  if (target.length === 0) {
    return {
      profiles: [],
      runIds: [],
      usageTotalUsd: 0,
      estimatedCostUsd: 0,
      stopReason: "no_profiles",
      resultsConsumed: 0,
    };
  }

  const costPerResult = getIgScraperCostPerResultUsd();
  const maxJobUsd = options?.maxJobUsd ?? getDiscoveryMaxJobUsd();
  const spent = options?.jobAccumulatedCostUsd ?? 0;
  const estimate = Number((target.length * costPerResult).toFixed(4));
  if (spent + estimate > maxJobUsd) {
    return {
      profiles: [],
      runIds: [],
      usageTotalUsd: 0,
      estimatedCostUsd: estimate,
      stopReason: "budget_exhausted",
      resultsConsumed: 0,
    };
  }

  const directUrls = target.map((username) => `https://www.instagram.com/${username}/`);
  const actorInput = {
    directUrls,
    resultsType: "details",
    resultsLimit: directUrls.length,
  };

  const safeResult = await runActorSafely<unknown>(actorId, actorInput, {
    maxItems: directUrls.length,
    campaignId: options?.campaignId,
    userId: options?.userId,
    operationName: "instagram_all_in_one_details",
    jobAccumulatedCostUsd: spent,
  });

  const profiles: MappedInstagramProfile[] = [];
  for (const item of safeResult.items) {
    const mapped = mapInstagramScraperItem(item);
    if (mapped) profiles.push(mapped);
  }

  summarizeMissingFields(profiles);

  return {
    profiles,
    runIds: [safeResult.run.id],
    usageTotalUsd: safeResult.usageTotalUsd ?? 0,
    estimatedCostUsd: estimate,
    stopReason: undefined,
    resultsConsumed: profiles.length,
  };
}

/**
 * Pre-run estimate for the discovery form: searches + details + Gemini.
 */
export function estimateInstagramAllInOneCost(input: {
  plannedQueries: number;
  searchLimit: number;
  expectedDetailProfiles: number;
  geminiCalls: number;
}): {
  searchCostUsd: number;
  detailsCostUsd: number;
  geminiCostUsd: number;
  totalCostUsd: number;
  maxJobUsd: number;
  overBudget: boolean;
} {
  const unit = getIgScraperCostPerResultUsd();
  const searchCostUsd = Number((input.plannedQueries * input.searchLimit * unit).toFixed(4));
  const detailsCostUsd = Number((input.expectedDetailProfiles * unit).toFixed(4));
  const geminiCostUsd = Number((input.geminiCalls * 0.00015).toFixed(4));
  const totalCostUsd = Number((searchCostUsd + detailsCostUsd + geminiCostUsd).toFixed(4));
  const maxJobUsd = getDiscoveryMaxJobUsd();
  return {
    searchCostUsd,
    detailsCostUsd,
    geminiCostUsd,
    totalCostUsd,
    maxJobUsd,
    overBudget: totalCostUsd > maxJobUsd,
  };
}
