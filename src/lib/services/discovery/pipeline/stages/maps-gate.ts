/**
 * Stage 5: mapsGate
 * Evaluates candidate relevance on Google Maps data only using Gemini Flash.
 * Skipped if AI relevance check is disabled or when heuristics provide clear decisions.
 */

import type { DiscoveredCandidate } from "../../discovery-provider";
import { evaluateMapsCandidateRelevanceWithAI } from "../../ai-relevance";
import type { DiscoveryDependencies, PipelineStageContext, RejectionDetail, StageResult } from "../types";

export interface MapsGateInput {
  candidates: DiscoveredCandidate[];
  useAiRelevanceCheck?: boolean;
  threshold?: number;
}

export async function mapsGateStage(
  input: MapsGateInput,
  context: PipelineStageContext,
  deps: DiscoveryDependencies = {},
): Promise<StageResult<DiscoveredCandidate>> {
  const start = deps.now ? deps.now() : Date.now();
  const survivors: DiscoveredCandidate[] = [];
  const rejected: RejectionDetail[] = [];
  let geminiCalls = 0;
  let spendUsd = 0;

  const shouldRunAi =
    input.useAiRelevanceCheck ?? (process.env.DISCOVERY_USE_AI_RELEVANCE === "true");

  if (!shouldRunAi || input.candidates.length === 0) {
    return {
      survivors: [...input.candidates],
      rejected: [],
      spendUsd: 0,
      counters: { geminiCalls: 0 },
      durationMs: (deps.now ? deps.now() : Date.now()) - start,
    };
  }

  const evalFn = deps.evalMapsGemini ?? evaluateMapsCandidateRelevanceWithAI;

  for (const candidate of input.candidates) {
    geminiCalls++;
    // Gemini 1.5 Flash is ~$0.00015 per evaluation (~$0.075 / 1M input tokens)
    spendUsd += 0.00015;

    const aiCheck = await evalFn(
      {
        businessName: candidate.fullName,
        category: candidate.gmapsCategory ?? candidate.category,
        categories: candidate.gmapsCategories ?? (candidate.category ? [candidate.category] : []),
        address: candidate.gmapsAddress ?? candidate.location,
        city: candidate.city ?? candidate.gmapsCity,
        rating: candidate.rating ?? candidate.gmapsRating,
        reviewCount: candidate.reviewCount ?? candidate.gmapsReviews,
        website: candidate.website ?? candidate.externalUrl,
      },
      {
        intent: context.campaign.intent ?? "",
        location: context.campaign.location ?? null,
        category: context.campaign.category ?? null,
      },
      {
        userId: context.userId,
        campaignId: context.campaign.id,
        threshold: input.threshold ?? 70,
        company: context.campaign.companyProfile
          ? {
              description: context.campaign.companyProfile.description,
              targetIndustries: context.campaign.companyProfile.targetIndustries,
            }
          : null,
      },
    );

    if (!aiCheck.relevant) {
      rejected.push({
        id: candidate.username ?? candidate.gmapsPlaceId ?? candidate.fullName ?? "unknown",
        reason: "IRRELEVANT_INTENT",
        detail: aiCheck.reason ?? "Maps data evaluated as irrelevant by AI gate",
        gate: "mapsGate",
        matchedTerm: aiCheck.reason,
      });
      continue;
    }

    survivors.push(candidate);
  }

  const durationMs = (deps.now ? deps.now() : Date.now()) - start;

  return {
    survivors,
    rejected,
    spendUsd,
    counters: {
      geminiCalls,
      rejectedByMapsGate: rejected.length,
    },
    durationMs,
  };
}
