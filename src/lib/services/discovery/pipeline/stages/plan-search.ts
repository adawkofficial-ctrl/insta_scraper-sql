/**
 * Stage 1: planSearch
 * Plans queries, handles keyword rotation, resolves country, sets batch target.
 */

import { resolveCountryCode } from "../../country-cities";
import { buildDiscoverySearchTerm, buildPerKeywordSearchQueries } from "../../discovery-query";
import type { DiscoveryDependencies, PipelineStageContext, PlannedSearch, StageResult } from "../types";

export interface PlanSearchInput {
  query: string;
  category?: string;
  location?: string;
  activeDiscoveryMode: string;
  priorNextKeywordIndex: number;
}

export async function planSearchStage(
  input: PlanSearchInput,
  context: PipelineStageContext,
  deps: DiscoveryDependencies = {},
): Promise<StageResult<PlannedSearch>> {
  const start = deps.now ? deps.now() : Date.now();

  const searchTerm = buildDiscoverySearchTerm({
    query: input.query,
    category: input.category,
    location: input.location,
  });

  const searchQueries = buildPerKeywordSearchQueries({
    query: input.query,
    category: input.category,
    location: input.location,
  });

  const effectiveQueries =
    input.activeDiscoveryMode === "instagram_places"
      ? searchQueries.length > 0 ? searchQueries.slice(0, 2) : [input.query]
      : searchQueries.length > 0 ? searchQueries : [input.query];

  const currentKeywordIndex = input.priorNextKeywordIndex % effectiveQueries.length;
  const countryCode = resolveCountryCode(input.location ?? context.campaign.location) ?? "US";

  const maxIgRounds = process.env.DISCOVERY_MAX_INSTAGRAM_SEARCH_ROUNDS
    ? Math.max(1, Number.parseInt(process.env.DISCOVERY_MAX_INSTAGRAM_SEARCH_ROUNDS, 10))
    : 1;

  const baseMaxRounds = process.env.DISCOVERY_MAX_ROUNDS
    ? Math.max(1, Number.parseInt(process.env.DISCOVERY_MAX_ROUNDS, 10))
    : 5;

  const maxRounds =
    input.activeDiscoveryMode === "instagram_places"
      ? 1
      : input.activeDiscoveryMode === "instagram_search"
        ? Math.min(baseMaxRounds, maxIgRounds)
        : baseMaxRounds;

  const roundCandidateTarget = Math.min(
    100,
    Math.max(context.remainingCapacity * 4, context.remainingCapacity + 10),
  );

  const planned: PlannedSearch = {
    searchTerm,
    searchQueries,
    effectiveQueries,
    currentKeywordIndex,
    countryCode,
    maxRounds,
    roundCandidateTarget,
  };

  const durationMs = (deps.now ? deps.now() : Date.now()) - start;

  return {
    survivors: [planned],
    rejected: [],
    spendUsd: 0,
    counters: {
      plannedQueries: effectiveQueries.length,
      maxRounds,
    },
    durationMs,
  };
}
