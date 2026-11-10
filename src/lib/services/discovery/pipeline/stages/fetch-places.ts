/**
 * Stage 2: fetchPlaces
 * Discovers candidate places using Google Maps or Places discovery provider.
 */

import type { DiscoveredCandidate } from "../../discovery-provider";
import { getDiscoveryProvider } from "../../discovery-service";
import type { DiscoveryDependencies, PipelineStageContext, StageDiscoveryResult, StageResult } from "../types";

export interface FetchPlacesInput {
  query: string;
  queries?: string[];
  limit: number;
  location?: string;
  category?: string;
  providerType: "google_maps" | "instagram_search" | "instagram_places";
}

export async function fetchPlacesStage(
  input: FetchPlacesInput,
  context: PipelineStageContext,
  deps: DiscoveryDependencies = {},
): Promise<StageResult<DiscoveredCandidate>> {
  const start = deps.now ? deps.now() : Date.now();
  const provider = deps.discoveryProvider ?? getDiscoveryProvider(input.providerType);

  const discovery: StageDiscoveryResult = await provider.discover({
    query: input.query,
    queries: input.queries,
    limit: input.limit,
    location: input.location,
    category: input.category,
    campaignId: context.campaign.id,
    userId: context.userId,
  });

  const candidates: DiscoveredCandidate[] = discovery.candidates ?? [];
  const spendUsd: number = discovery.usageTotalUsd ?? 0;
  const durationMs = (deps.now ? deps.now() : Date.now()) - start;

  return {
    survivors: candidates,
    rejected: [],
    spendUsd,
    counters: {
      placesReturned: discovery.placesReturned ?? candidates.length,
      gmapsPlacesFound: discovery.gmapsPlacesFound ?? candidates.length,
      withWebsite: discovery.gmapsWithWebsite ?? 0,
      withInstagram: discovery.withInstagramUsername ?? discovery.placesWithInstagram ?? 0,
      noInstagram: discovery.noInstagramCount ?? 0,
      requestsUsed: discovery.requestsUsed ?? 1,
    },
    durationMs,
  };
}
