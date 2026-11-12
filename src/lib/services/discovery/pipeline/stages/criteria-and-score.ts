/**
 * Stage 8: criteriaAndScore
 * Evaluates profile criteria (followers, private status, post activity),
 * deterministic bio/category relevance, and computes the 100-point Lead Quality Score.
 */

import type { LeadProfile } from "@/lib/types";
import { evaluateEnrichmentCriteria } from "../../enrichment-criteria";
import { computeLeadScore } from "../../lead-quality-score";
import {
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  decideRelevance,
  evaluateProfileRelevance,
  type RelevanceCampaignContext,
} from "../../lead-relevance";
import type { DiscoveryDependencies, PipelineStageContext, RejectionDetail, StageResult } from "../types";

export interface CriteriaAndScoreOutput {
  clearPassProfiles: LeadProfile[];
  borderlineProfiles: LeadProfile[];
}

export interface CriteriaAndScoreInput {
  profiles: LeadProfile[];
  borderlineMinScore?: number;
  borderlineMaxScore?: number;
}

export async function criteriaAndScoreStage(
  input: CriteriaAndScoreInput,
  context: PipelineStageContext,
  deps: DiscoveryDependencies = {},
): Promise<StageResult<CriteriaAndScoreOutput>> {
  const start = deps.now ? deps.now() : Date.now();
  const clearPassProfiles: LeadProfile[] = [];
  const borderlineProfiles: LeadProfile[] = [];
  const rejected: RejectionDetail[] = [];
  const counters: Record<string, number> = {
    criteriaRejected: 0,
    deterministicRejected: 0,
    lowScoreRejected: 0,
    clearPass: 0,
    borderline: 0,
  };

  const prefilterContext: RelevanceCampaignContext = {
    intent: context.campaign.intent ?? "",
    location: context.campaign.location ?? null,
    category: context.campaign.category ?? null,
  };

  const policy = {
    ...DEFAULT_DISCOVERY_RELEVANCE_POLICY,
    requireLocationMatch: false,
    allowUnknownLocation: true,
  };

  const borderlineMinScore = input.borderlineMinScore ?? Number(process.env.GEMINI_BORDERLINE_MIN_SCORE ?? 30);
  const borderlineMaxScore = input.borderlineMaxScore ?? Number(process.env.GEMINI_BORDERLINE_MAX_SCORE ?? 79);

  for (const profile of input.profiles) {
    // 1. Criteria evaluation (followers, private status, posts)
    const criteriaEval = evaluateEnrichmentCriteria(
      profile,
      context.criteria,
      prefilterContext,
    );

    if (!criteriaEval.passed) {
      counters.criteriaRejected++;
      rejected.push({
        id: profile.username ?? "unknown",
        reason: "ENRICHMENT_CRITERIA_REJECTED",
        detail: criteriaEval.reasons.map((r) => `${r.rule}: ${String(r.value)} (req: ${String(r.required)})`).join("; "),
        gate: "enrichmentCriteria",
      });
      continue;
    }

    // 2. Deterministic relevance evaluation (category, location, bio keywords)
    const evaluation = evaluateProfileRelevance(profile, prefilterContext, policy);
    const decision = decideRelevance(evaluation, policy);

    if (!decision.relevant) {
      counters.deterministicRejected++;
      rejected.push({
        id: profile.username ?? "unknown",
        reason: decision.reason,
        detail: decision.matchedTerm ?? "Deterministic relevance check rejected profile",
        gate: "deterministicRelevance",
        matchedTerm: decision.matchedTerm,
      });
      continue;
    }

    // 3. Compute 100-point 5-pillar Lead Quality Score
    const rawData = (profile.rawProfileData ?? {}) as Record<string, unknown>;
    const scoreInput = {
      rating: profile.rating ?? profile.gmapsRating,
      reviewCount: profile.reviewCount ?? profile.gmapsReviews,
      website: profile.website ?? profile.externalUrl,
      phone: profile.phone,
      isClaimed: profile.isClaimed,
      isChain: profile.isChain,
      hasInstagram: true,
      lastPostAt: profile.lastPostAt ?? (rawData.lastPostAt as string | Date | null | undefined),
      postsCount: profile.postsCount,
      followers: profile.followers,
      isBusinessAccount: profile.isBusiness,
      isPrivate: profile.isPrivate,
      recentLikesAvg: (rawData.recentLikesAvg as number | null | undefined) ?? null,
      recentCommentsAvg: (rawData.recentCommentsAvg as number | null | undefined) ?? null,
      engagementRate: (rawData.engagementRate as number | null | undefined) ?? null,
      email: profile.email,
      availableChannels: profile.availableChannels,
      hasWhatsApp: Boolean(
        profile.availableChannels?.includes("whatsapp") ||
        (rawData.socialLinks as Record<string, unknown> | null)?.whatsapp
      ),
      handleConfidence: (profile.handleConfidence ?? rawData.handleConfidence) as "high" | "medium" | "low" | null | undefined,
      handleSource: profile.handleSource ?? (rawData.handleSource as string | null | undefined),
    };

    const qualityResult = computeLeadScore(scoreInput);
    profile.qualityScore = qualityResult.score;
    profile.qualityTier = qualityResult.tier;
    profile.scoreBreakdown = qualityResult.breakdown;
    profile.scoreFlags = qualityResult.flags;
    profile.isChain = qualityResult.isChain;
    profile.lastPostAt =
      profile.lastPostAt ??
      (scoreInput.lastPostAt ? new Date(scoreInput.lastPostAt).toISOString() : null);

    // 4. Score routing
    // Clear fail (< borderlineMinScore): reject directly
    if (qualityResult.score < borderlineMinScore) {
      counters.lowScoreRejected++;
      rejected.push({
        id: profile.username ?? "unknown",
        reason: "PRE_ENRICHMENT_REJECTED",
        detail: `Score ${qualityResult.score} < ${borderlineMinScore} (Tier ${qualityResult.tier})`,
        gate: "qualityScore",
      });
      continue;
    }

    const isHighConfidenceHandle = (profile.handleConfidence ?? rawData.handleConfidence) === "high";

    // Clear pass (> borderlineMaxScore with high-confidence handle): auto-approve without Gemini
    if (qualityResult.score > borderlineMaxScore && isHighConfidenceHandle) {
      counters.clearPass++;
      clearPassProfiles.push(profile);
      continue;
    }

    // Borderline band: routed to Gemini gate
    counters.borderline++;
    borderlineProfiles.push(profile);
  }

  const durationMs = (deps.now ? deps.now() : Date.now()) - start;

  return {
    survivors: [{ clearPassProfiles, borderlineProfiles }],
    rejected,
    spendUsd: 0,
    counters,
    durationMs,
  };
}
