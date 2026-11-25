import type { LeadProfile } from "@/lib/types";
import type { AiRelevanceOutput } from "./ai-relevance";
import {
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  evaluateProfileRelevance,
  type RelevanceCampaignContext,
  type RelevanceMatch,
} from "./lead-relevance";

/**
 * Free, deterministic replacement for the Gemini relevance gates, used while
 * automatic AI enrichment is switched off (AI_AUTO_ENRICHMENT=false).
 *
 * Scores a lead on the two things that matter for local outreach:
 *   - CONTENT  (60 pts): campaign intent/category terms found in the name,
 *                        bio, category, website, post captions
 *   - LOCATION (40 pts): campaign city/area found in the address, bio,
 *                        post locations or website
 * A lead is rejected when it explicitly does NOT match the location or the
 * content. Unknowns pass with a lower score so they can be reviewed manually.
 */

const POINTS: Record<RelevanceMatch, number> = { MATCHED: 1, UNKNOWN: 0.5, NOT_MATCHED: 0 };

export function isAutoAiEnrichmentEnabled(): boolean {
  const flag = process.env.AI_AUTO_ENRICHMENT?.trim().toLowerCase();
  return !(flag === "false" || flag === "0" || flag === "off");
}

export function ruleBasedProfileRelevance(
  profile: LeadProfile,
  campaign: RelevanceCampaignContext,
  threshold: number,
): AiRelevanceOutput {
  const rel = evaluateProfileRelevance(profile, campaign, DEFAULT_DISCOVERY_RELEVANCE_POLICY);

  // Content = best of intent and category match.
  const signals: RelevanceMatch[] = [rel.intentMatch, rel.categoryMatch];
  const content: RelevanceMatch = signals.includes("MATCHED")
    ? "MATCHED"
    : signals.includes("NOT_MATCHED")
      ? "NOT_MATCHED"
      : "UNKNOWN";
  const location = rel.locationMatch;

  const score = Math.round(POINTS[content] * 60 + POINTS[location] * 40);
  const relevant = content !== "NOT_MATCHED" && location !== "NOT_MATCHED" && score >= Math.min(threshold, 50);

  const matched = [...rel.matchedIntentTerms, ...rel.matchedCategoryTerms];
  const fitReasons: string[] = [];
  if (content === "MATCHED") fitReasons.push(`Content matches: ${Array.from(new Set(matched)).slice(0, 5).join(", ")}`);
  if (location === "MATCHED") fitReasons.push(`Located in ${campaign.location ?? "target area"}`);
  const riskFlags: string[] = [];
  if (content === "NOT_MATCHED") riskFlags.push("CONTENT_MISMATCH");
  if (location === "NOT_MATCHED") riskFlags.push("LOCATION_MISMATCH");
  if (content === "UNKNOWN") riskFlags.push("CONTENT_UNVERIFIED");
  if (location === "UNKNOWN") riskFlags.push("LOCATION_UNVERIFIED");

  const followers = typeof profile.followers === "number" ? profile.followers : 0;
  const hasContact = profile.email ? "email" : profile.phone ? "phone" : profile.website ? "website" : "none";

  return {
    relevant,
    score,
    reason: `Rule-based (AI off): content ${content.toLowerCase()}, location ${location.toLowerCase()}`,
    accountType: profile.isBusinessAccount === false ? "individual" : "business_clinic",
    analytics: {
      audienceSizeTier: followers > 100_000 ? "large" : followers > 10_000 ? "medium" : followers > 1_000 ? "small" : "micro",
      activityLevel: "medium",
      contactReadiness: hasContact,
      fitReasons,
      riskFlags,
    },
  };
}

/** Same scoring for a Maps / search-result candidate before paying for details. */
export function ruleBasedCandidateRelevance(
  candidate: {
    businessName?: string | null;
    category?: string | null;
    categories?: string[] | null;
    address?: string | null;
    city?: string | null;
    website?: string | null;
    websiteSnippet?: string | null;
    biography?: string | null;
    followersCount?: number | null;
  },
  campaign: RelevanceCampaignContext,
  threshold: number,
): AiRelevanceOutput {
  const pseudo = {
    username: "",
    fullName: candidate.businessName ?? null,
    biography: [candidate.biography, candidate.websiteSnippet].filter(Boolean).join(" ") || null,
    category: [candidate.category, ...(candidate.categories ?? [])].filter(Boolean).join(" ") || null,
    website: candidate.website ?? null,
    location: [candidate.address, candidate.city].filter(Boolean).join(", ") || null,
    followers: candidate.followersCount ?? null,
  } as unknown as LeadProfile;
  return ruleBasedProfileRelevance(pseudo, campaign, threshold);
}
