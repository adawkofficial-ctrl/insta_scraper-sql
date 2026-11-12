import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { getCampaignOutcomeAnalytics } from "./outcome-analytics-service";
import { logger } from "@/lib/logger";

export type RecommendationType =
  | "SCALE_SEGMENT"
  | "STOP_SEGMENT"
  | "ADJUST_SCORE_THRESHOLD";

export type CampaignRecommendation = {
  id: string;
  type: RecommendationType;
  title: string;
  rationale: string;
  impact: string;
  segmentType: "keyword" | "city" | "tier";
  segmentValue: string;
  positiveRate?: number;
  costPerPositiveReply?: number | null;
  sampleSize: number;
  actionPayload: {
    customPositiveKeywords?: string[];
    customNegativeKeywords?: string[];
    minLeadScore?: number;
    preferredCities?: string[];
  };
};

/**
 * Derives data-driven recommendations for a campaign based on actual outcome metrics.
 *
 * Rules:
 * - Only segments with n >= 30 sends are considered for scaling winners.
 * - Segments to stop require n >= 50 sends with 0 positive replies.
 * - Tier score threshold comparison analyzes Tier A vs Tier C/D conversion.
 */
export async function getCampaignRecommendations(
  campaignId: string,
): Promise<{
  campaignId: string;
  autoOptimize: boolean;
  explorationBudgetShare: number;
  recommendations: CampaignRecommendation[];
}> {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      minLeadScore: true,
      autoOptimize: true,
      explorationBudgetShare: true,
      customPositiveKeywords: true,
      customNegativeKeywords: true,
    },
  });

  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found.`);
  }

  const analytics = await getCampaignOutcomeAnalytics({ campaignId });
  const recommendations: CampaignRecommendation[] = [];

  // 1. Scale Top Keywords (n >= 30 and positiveRate >= 3% or low cost per positive)
  const qualifiedKeywords = analytics.segments.byKeyword.filter(
    (s) => s.sent >= 30 && s.segmentKey !== "General" && s.segmentKey !== "Unknown",
  );

  const topKeyword = qualifiedKeywords
    .filter((s) => s.positiveReplies > 0)
    .sort((a, b) => b.positiveRate - a.positiveRate)[0];

  if (topKeyword && topKeyword.positiveRate >= 3) {
    recommendations.push({
      id: `rec-scale-kw-${encodeURIComponent(topKeyword.segmentKey)}`,
      type: "SCALE_SEGMENT",
      title: `Double down on keyword "${topKeyword.segmentKey}"`,
      rationale: `Keyword "${topKeyword.segmentKey}" has achieved a ${topKeyword.positiveRate}% positive reply rate (${topKeyword.positiveReplies} positive replies across n=${topKeyword.sent} sends)${topKeyword.costPerPositiveReply ? ` at $${topKeyword.costPerPositiveReply}/reply` : ""}.`,
      impact: "High ROI: prioritizes discovery queries on your highest-converting keyword niche.",
      segmentType: "keyword",
      segmentValue: topKeyword.segmentKey,
      positiveRate: topKeyword.positiveRate,
      costPerPositiveReply: topKeyword.costPerPositiveReply,
      sampleSize: topKeyword.sent,
      actionPayload: {
        customPositiveKeywords: [topKeyword.segmentKey],
      },
    });
  }

  // 2. Stop Underperforming Keywords (n >= 50 with 0 replies or 0 positive replies)
  const deadKeyword = qualifiedKeywords
    .filter((s) => s.sent >= 50 && s.positiveReplies === 0)
    .sort((a, b) => b.sent - a.sent)[0];

  if (deadKeyword) {
    recommendations.push({
      id: `rec-stop-kw-${encodeURIComponent(deadKeyword.segmentKey)}`,
      type: "STOP_SEGMENT",
      title: `Stop wasting spend on keyword "${deadKeyword.segmentKey}"`,
      rationale: `Sent ${deadKeyword.sent} messages for "${deadKeyword.segmentKey}" without a single positive reply (spent $${deadKeyword.totalCostUsd}).`,
      impact: "Eliminates wasted discovery and outreach spend on dead segments.",
      segmentType: "keyword",
      segmentValue: deadKeyword.segmentKey,
      positiveRate: 0,
      costPerPositiveReply: null,
      sampleSize: deadKeyword.sent,
      actionPayload: {
        customNegativeKeywords: [deadKeyword.segmentKey],
      },
    });
  }

  // 3. Top City (n >= 30)
  const qualifiedCities = analytics.segments.byCity.filter(
    (s) => s.sent >= 30 && s.segmentKey !== "Unknown",
  );

  const topCity = qualifiedCities
    .filter((s) => s.positiveReplies > 0)
    .sort((a, b) => b.positiveRate - a.positiveRate)[0];

  if (topCity && topCity.positiveRate >= 2.5) {
    recommendations.push({
      id: `rec-scale-city-${encodeURIComponent(topCity.segmentKey)}`,
      type: "SCALE_SEGMENT",
      title: `Prioritize city "${topCity.segmentKey}"`,
      rationale: `City "${topCity.segmentKey}" generated ${topCity.positiveReplies} positive replies (${topCity.positiveRate}% rate, n=${topCity.sent}).`,
      impact: "Focuses regional discovery on proven responsive geographic hubs.",
      segmentType: "city",
      segmentValue: topCity.segmentKey,
      positiveRate: topCity.positiveRate,
      costPerPositiveReply: topCity.costPerPositiveReply,
      sampleSize: topCity.sent,
      actionPayload: {
        preferredCities: [topCity.segmentKey],
      },
    });
  }

  // 4. Score Threshold Recommendation (Compare Tier A vs Tier C/D)
  const tierA = analytics.segments.byTier.find((t) => t.segmentKey === "Tier A");
  const tierC = analytics.segments.byTier.find((t) => t.segmentKey === "Tier C");
  const tierD = analytics.segments.byTier.find((t) => t.segmentKey === "Tier D");

  const lowTierSent = (tierC?.sent || 0) + (tierD?.sent || 0);
  const lowTierPositive = (tierC?.positiveReplies || 0) + (tierD?.positiveReplies || 0);
  const lowTierRate = lowTierSent > 0 ? Number(((lowTierPositive / lowTierSent) * 100).toFixed(1)) : 0;

  if (tierA && tierA.sent >= 30 && lowTierSent >= 30) {
    if (tierA.positiveRate > lowTierRate * 2) {
      recommendations.push({
        id: "rec-raise-score-threshold",
        type: "ADJUST_SCORE_THRESHOLD",
        title: "Raise Lead Quality Score threshold to 75+",
        rationale: `Tier A leads convert at ${tierA.positiveRate}% positive replies (n=${tierA.sent}) compared to only ${lowTierRate}% for Tier C/D (n=${lowTierSent}).`,
        impact: "Reduces wasted outreach by cutting out low-converting C/D tier leads.",
        segmentType: "tier",
        segmentValue: "Tier A vs C/D",
        positiveRate: tierA.positiveRate,
        sampleSize: tierA.sent + lowTierSent,
        actionPayload: {
          minLeadScore: 75,
        },
      });
    }
  }

  return {
    campaignId,
    autoOptimize: campaign.autoOptimize,
    explorationBudgetShare: campaign.explorationBudgetShare,
    recommendations,
  };
}

/**
 * 1-Click apply recommendation to a campaign.
 * Never raises budgets or caps; only updates keyword lists or score threshold.
 */
export async function applyCampaignRecommendation(
  campaignId: string,
  recommendationId: string,
): Promise<{
  success: boolean;
  appliedRecommendationId: string;
  updatedFields: string[];
}> {
  const prisma = getPrismaClient();

  const { recommendations } = await getCampaignRecommendations(campaignId);
  const rec = recommendations.find((r) => r.id === recommendationId);

  if (!rec) {
    throw new Error(
      `Recommendation "${recommendationId}" not found or no longer eligible for campaign "${campaignId}".`,
    );
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
  });
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found.`);
  }

  const data: {
    customPositiveKeywords?: string[];
    customNegativeKeywords?: string[];
    minLeadScore?: number;
  } = {};
  const updatedFields: string[] = [];

  if (rec.actionPayload.customPositiveKeywords?.length) {
    const existing = new Set(campaign.customPositiveKeywords || []);
    for (const kw of rec.actionPayload.customPositiveKeywords) {
      existing.add(kw);
    }
    data.customPositiveKeywords = Array.from(existing);
    updatedFields.push("customPositiveKeywords");
  }

  if (rec.actionPayload.customNegativeKeywords?.length) {
    const existing = new Set(campaign.customNegativeKeywords || []);
    for (const kw of rec.actionPayload.customNegativeKeywords) {
      existing.add(kw);
    }
    data.customNegativeKeywords = Array.from(existing);
    updatedFields.push("customNegativeKeywords");
  }

  if (rec.actionPayload.minLeadScore !== undefined) {
    data.minLeadScore = rec.actionPayload.minLeadScore;
    updatedFields.push("minLeadScore");
  }

  if (Object.keys(data).length > 0) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data,
    });
  }

  logger.info("[RECOMMENDATIONS] 1-Click Applied recommendation to campaign", {
    campaignId,
    recommendationId,
    updatedFields,
  });

  return {
    success: true,
    appliedRecommendationId: recommendationId,
    updatedFields,
  };
}

/**
 * Reorders candidate cities/keywords when autoOptimize is enabled.
 * Allots `explorationShare` (default 15%) of capacity to untested segments
 * while never raising total budgets or caps.
 */
export function prioritizeSegmentsForDiscovery(input: {
  cities: string[];
  cityPerformance: Map<string, { sent: number; positiveRate: number }>;
  explorationShare?: number; // e.g. 0.15 = 15%
}): { prioritizedOrder: string[]; explorationSegment: string[] } {
  const { cities, cityPerformance, explorationShare = 0.15 } = input;
  if (cities.length <= 1) {
    return { prioritizedOrder: [...cities], explorationSegment: [] };
  }

  const proven: Array<{ city: string; positiveRate: number; sent: number }> = [];
  const untested: string[] = [];

  for (const city of cities) {
    const norm = city.trim().toLowerCase();
    const perf = cityPerformance.get(norm);
    if (perf && perf.sent >= 30) {
      proven.push({ city, positiveRate: perf.positiveRate, sent: perf.sent });
    } else {
      untested.push(city);
    }
  }

  // Sort proven cities by positive reply rate descending
  proven.sort((a, b) => b.positiveRate - a.positiveRate);

  // If no proven cities yet, preserve original order
  if (proven.length === 0) {
    return { prioritizedOrder: [...cities], explorationSegment: [...cities] };
  }

  // Reserve exploration slice
  const explorationCount = Math.max(
    1,
    Math.round(cities.length * Math.min(0.5, Math.max(0.05, explorationShare))),
  );
  const explorationSelected = untested.slice(0, explorationCount);
  const remainingUntested = untested.slice(explorationCount);

  // Balanced reordered list: proven winners first, interleaved with exploration candidates
  const prioritizedOrder: string[] = [
    ...proven.map((p) => p.city),
    ...explorationSelected,
    ...remainingUntested,
  ];

  return {
    prioritizedOrder,
    explorationSegment: explorationSelected,
  };
}
