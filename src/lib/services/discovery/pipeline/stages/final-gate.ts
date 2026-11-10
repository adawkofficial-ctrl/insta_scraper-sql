/**
 * Stage 9: finalGate
 * Final Gemini relevance check evaluated ONLY for borderline profiles (score 30-79)
 * or lower-confidence handle discovery. Clear passes skip this gate entirely.
 */

import type { LeadProfile } from "@/lib/types";
import { evaluateProfileRelevanceWithAI } from "../../ai-relevance";
import type { RelevanceCampaignContext } from "../../lead-relevance";
import type { DiscoveryDependencies, PipelineStageContext, RejectionDetail, StageResult } from "../types";

export interface FinalGateInput {
  clearPassProfiles: LeadProfile[];
  borderlineProfiles: LeadProfile[];
  useAiRelevanceCheck?: boolean;
  baseThreshold?: number;
}

export async function finalGateStage(
  input: FinalGateInput,
  context: PipelineStageContext,
  deps: DiscoveryDependencies = {},
): Promise<StageResult<LeadProfile>> {
  const start = deps.now ? deps.now() : Date.now();
  const survivors: LeadProfile[] = [...input.clearPassProfiles];
  const rejected: RejectionDetail[] = [];
  let geminiCalls = 0;
  let spendUsd = 0;

  const shouldRunAi =
    input.useAiRelevanceCheck ?? (process.env.DISCOVERY_USE_AI_RELEVANCE === "true");

  if (!shouldRunAi || input.borderlineProfiles.length === 0) {
    survivors.push(...input.borderlineProfiles);
    return {
      survivors,
      rejected: [],
      spendUsd: 0,
      counters: { geminiCalls: 0, clearPass: input.clearPassProfiles.length, borderlinePassed: input.borderlineProfiles.length },
      durationMs: (deps.now ? deps.now() : Date.now()) - start,
    };
  }

  const evalFn = deps.evalFinalGemini ?? evaluateProfileRelevanceWithAI;
  const prefilterContext: RelevanceCampaignContext = {
    intent: context.campaign.intent ?? "",
    location: context.campaign.location ?? null,
    category: context.campaign.category ?? null,
  };

  const baseThreshold = input.baseThreshold ?? 70;

  for (const profile of input.borderlineProfiles) {
    geminiCalls++;
    spendUsd += 0.00015;

    const rawData = (profile.rawProfileData ?? {}) as Record<string, unknown>;
    const handleConfidence = profile.handleConfidence ?? rawData.handleConfidence;
    const effectiveThreshold = handleConfidence === "low" ? Math.min(100, baseThreshold + 10) : baseThreshold;

    const aiCheck = await evalFn(
      profile,
      prefilterContext,
      {
        userId: context.userId,
        campaignId: context.campaign.id,
        threshold: effectiveThreshold,
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
        id: profile.username ?? "unknown",
        reason: aiCheck.reason === "AI_UNAVAILABLE" ? "AI_UNAVAILABLE" : "IRRELEVANT_INTENT",
        detail: aiCheck.reason ?? "Final AI gate determined profile is not relevant",
        gate: "finalGate",
        matchedTerm: aiCheck.reason,
      });
      continue;
    }

    profile.rawProfileData = {
      ...(typeof profile.rawProfileData === "object" && profile.rawProfileData !== null
        ? profile.rawProfileData
        : {}),
      aiAnalysis: aiCheck,
    };
    profile.aiAnalysis = aiCheck.analytics ?? null;
    profile.leadScore = aiCheck.score;
    profile.aiScore = aiCheck.score;

    survivors.push(profile);
  }

  const durationMs = (deps.now ? deps.now() : Date.now()) - start;

  return {
    survivors,
    rejected,
    spendUsd,
    counters: {
      geminiCalls,
      clearPass: input.clearPassProfiles.length,
      borderlinePassed: survivors.length - input.clearPassProfiles.length,
      borderlineRejected: rejected.length,
    },
    durationMs,
  };
}
