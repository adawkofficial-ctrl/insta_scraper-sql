/**
 * Stage 3: freeRules
 * Applies zero-cost filtering rules: closed places, rating/reviews thresholds,
 * duplicate handle checks, and negative keyword/category matching.
 */

import type { DiscoveredCandidate } from "../../discovery-provider";
import { normalizeInstagramUsername } from "../../../scraper/instagram-profile";
import {
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  type DiscoveryRelevancePolicy,
  prefilterCandidate,
  type RelevanceCampaignContext,
} from "../../lead-relevance";
import type { DiscoveryDependencies, PipelineStageContext, RejectionDetail, StageResult } from "../types";

export interface FreeRulesInput {
  candidates: DiscoveredCandidate[];
  relevancePolicy?: DiscoveryRelevancePolicy;
}

export async function freeRulesStage(
  input: FreeRulesInput,
  context: PipelineStageContext,
  deps: DiscoveryDependencies = {},
): Promise<StageResult<DiscoveredCandidate>> {
  const start = deps.now ? deps.now() : Date.now();
  const survivors: DiscoveredCandidate[] = [];
  const rejected: RejectionDetail[] = [];
  const counters: Record<string, number> = {
    closed: 0,
    lowRating: 0,
    lowReviews: 0,
    duplicate: 0,
    prefilterRejected: 0,
  };

  const prefilterContext: RelevanceCampaignContext = {
    intent: context.campaign.intent ?? "",
    location: context.campaign.location ?? null,
    category: context.campaign.category ?? null,
  };

  const policy: DiscoveryRelevancePolicy = input.relevancePolicy ?? {
    ...DEFAULT_DISCOVERY_RELEVANCE_POLICY,
    requireLocationMatch: false,
    allowUnknownLocation: true,
    useAiRelevanceCheck: process.env.DISCOVERY_USE_AI_RELEVANCE === "true",
  };

  for (const candidate of input.candidates) {
    // 1. Closed places
    if (candidate.permanentlyClosed || candidate.temporarilyClosed) {
      counters.closed++;
      rejected.push({
        id: candidate.username ?? candidate.gmapsPlaceId ?? candidate.fullName ?? "unknown",
        reason: "CLOSED_BUSINESS",
        detail: "Place is permanently or temporarily closed",
        gate: "freeRules",
      });
      continue;
    }

    // 2. Minimum rating threshold
    if (
      context.campaign.minRating !== null &&
      context.campaign.minRating !== undefined &&
      candidate.rating !== null &&
      candidate.rating !== undefined &&
      candidate.rating < context.campaign.minRating
    ) {
      counters.lowRating++;
      rejected.push({
        id: candidate.username ?? candidate.gmapsPlaceId ?? candidate.fullName ?? "unknown",
        reason: "LOW_RATING",
        detail: `Rating ${candidate.rating} is below campaign minimum ${context.campaign.minRating}`,
        gate: "freeRules",
      });
      continue;
    }

    // 3. Minimum review count threshold
    if (
      context.campaign.minReviews !== null &&
      context.campaign.minReviews !== undefined &&
      candidate.reviewCount !== null &&
      candidate.reviewCount !== undefined &&
      candidate.reviewCount < context.campaign.minReviews
    ) {
      counters.lowReviews++;
      rejected.push({
        id: candidate.username ?? candidate.gmapsPlaceId ?? candidate.fullName ?? "unknown",
        reason: "LOW_REVIEWS",
        detail: `Review count ${candidate.reviewCount} is below campaign minimum ${context.campaign.minReviews}`,
        gate: "freeRules",
      });
      continue;
    }

    // 4. Duplicate handle check
    if (candidate.username) {
      const normalized = normalizeInstagramUsername(candidate.username);
      if (
        normalized &&
        (context.caches.seenCandidates.has(normalized) ||
          context.caches.existingUsernames.has(normalized))
      ) {
        counters.duplicate++;
        rejected.push({
          id: normalized,
          reason: "DUPLICATE",
          detail: "Handle already discovered or existing in campaign",
          gate: "freeRules",
        });
        continue;
      }
    }

    // 5. Negative keywords & category prefilter
    const preResult = prefilterCandidate(candidate, prefilterContext, policy);
    if (preResult.action === "REJECT") {
      counters.prefilterRejected++;
      const reasonKey = preResult.underlyingReason ?? preResult.reason;
      rejected.push({
        id: candidate.username ?? candidate.gmapsPlaceId ?? candidate.fullName ?? "unknown",
        reason: reasonKey,
        detail: preResult.detail,
        gate: "freeRules",
        matchedTerm: preResult.detail,
      });
      continue;
    }

    survivors.push(candidate);
  }

  const durationMs = (deps.now ? deps.now() : Date.now()) - start;

  return {
    survivors,
    rejected,
    spendUsd: 0,
    counters,
    durationMs,
  };
}
