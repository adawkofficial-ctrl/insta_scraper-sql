import "server-only";

import { generateStructured } from "../ai/gemini/gemini-client";
import type { LeadProfile } from "@/lib/types";
import type { RelevanceCampaignContext } from "./lead-relevance";

export type AiRelevanceOutput = {
  isRelevant: boolean;
  confidenceScore: number;
  reasoning: string;
};

export const AI_RELEVANCE_SCHEMA = {
  type: "object",
  properties: {
    isRelevant: { type: "boolean" },
    confidenceScore: { type: "integer" },
    reasoning: { type: "string" },
  },
  required: ["isRelevant", "confidenceScore", "reasoning"],
};

export async function evaluateProfileRelevanceWithAI(
  profile: LeadProfile,
  campaign: RelevanceCampaignContext,
  options?: {
    userId?: string;
    campaignId?: string;
    threshold?: number;
  },
): Promise<{ relevant: boolean; score: number; reason: string }> {
  const threshold = options?.threshold ?? 60;

  const systemInstruction = `You are an expert sales intelligence assistant. Your task is to evaluate whether a candidate Instagram profile plausibly matches a target marketing campaign's intent and niche.
Output a JSON object with:
- isRelevant: boolean (true if the profile is a plausible match for the campaign's business intent, false otherwise)
- confidenceScore: integer 0-100
- reasoning: concise explanation (1-2 sentences) of why this profile matches or fails the campaign intent.`;

  const prompt = `Campaign Context:
- Stated Intent: "${campaign.intent ?? "Not specified"}"
- Target Category: "${campaign.category ?? "Not specified"}"
- Target Location: "${campaign.location ?? "Not specified"}"

Candidate Instagram Profile:
- Username: @${profile.username}
- Full Name: ${profile.fullName ?? "None"}
- Biography: ${profile.biography ?? "None"}
- Category: ${profile.businessCategoryName || profile.category || "None"}
- Location: ${profile.location ?? "None"}
- External URL / Website: ${profile.website || profile.externalUrl || "None"}
- Recent Post Captions: ${(profile.latestPosts ?? [])
    .slice(0, 3)
    .map((p) => p.caption)
    .filter(Boolean)
    .join(" | ") || "None"}

Does this candidate plausibly match the campaign's target intent and niche?`;

  try {
    const result = await generateStructured<AiRelevanceOutput>({
      operation: "relevance_check",
      promptVersion: "1.0",
      systemInstruction,
      userText: prompt,
      responseSchema: AI_RELEVANCE_SCHEMA,
      userId: options?.userId,
      campaignId: options?.campaignId,
      validate: (raw: unknown) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error("Invalid output format");
        }
        const record = raw as Record<string, unknown>;
        return {
          isRelevant: Boolean(record.isRelevant),
          confidenceScore:
            typeof record.confidenceScore === "number"
              ? record.confidenceScore
              : 50,
          reasoning:
            typeof record.reasoning === "string" ? record.reasoning : "",
        };
      },
    });

    const isScorePassing = result.data.confidenceScore >= threshold;
    const isPassing = result.data.isRelevant && isScorePassing;
    return {
      relevant: isPassing,
      score: result.data.confidenceScore,
      reason: result.data.reasoning,
    };
  } catch (error) {
    // If AI fails (e.g. rate limit, offline, missing key), gracefully fall back
    return {
      relevant: true,
      score: 50,
      reason:
        error instanceof Error ? error.message : "AI evaluation unavailable",
    };
  }
}
