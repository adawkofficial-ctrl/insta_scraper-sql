import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import {
  normalizeInstagramProfileItem,
  getIgEnrichmentActorMode,
  getActiveEnrichmentActorId,
  buildInstagramProfileUrls,
} from "./instagram-profile";
import {
  runActorSafely,
  getMonthlyApifyBudgetRemaining,
} from "./apify-cost-guard";
import { findMatchedNegativeKeyword } from "../discovery/negative-keywords";
import { runHandleDiscoveryWaterfall } from "../discovery/handle-discovery-waterfall";
import { checkNameWebsiteMismatch } from "../discovery/name-website-matcher";
import { computeLeadScore } from "../discovery/lead-quality-score";
import type { LeadProfile } from "@/lib/types";

export type EnrichLeadsInput = {
  leadIds: string[];
  userId: string;
};

export type EnrichLeadsResult = {
  success: boolean;
  totalRequested: number;
  enrichedCount: number;
  cachedCount: number;
  apifyCostUsd: number;
  remainingBudgetUsd: number | null;
  leads: Array<{
    id: string;
    username: string;
    followersCount: number | null;
    biography: string | null;
    enrichmentStatus: "ENRICHED" | "NOT_ENRICHED";
    negativeKeywordMatched?: string | null;
    handleOutcome?: "found" | "not_found" | "cooldown" | "no_website";
    handleSource?: string | null;
    handleConfidence?: string | null;
    message?: string;
  }>;
};

export const MAX_ENRICHMENT_BATCH_SIZE = 20;
export const ENRICHMENT_CACHE_DAYS = 30;
export const HANDLE_ENRICHMENT_COOLDOWN_DAYS = 7;

/**
 * On-demand handle discovery waterfall for leads without an Instagram handle.
 * Enforces at most once per 7 days per lead to avoid repeated fetching cost.
 */
export async function enrichLeadHandleWaterfall(
  lead: {
    id: string;
    fullName?: string | null;
    website?: string | null;
    lastHandleEnrichmentAt?: Date | string | null;
    rating?: number | null;
    reviewCount?: number | null;
    isClaimed?: boolean | null;
    isChain?: boolean | null;
    email?: string | null;
    phone?: string | null;
    availableChannels?: string[] | null;
    scoreFlags?: string[] | null;
  },
  prismaClient?: ReturnType<typeof getPrismaClient>,
): Promise<{
  outcome: "found" | "not_found" | "cooldown" | "no_website";
  handle: string | null;
  handleSource: string | null;
  handleConfidence: string | null;
  message: string;
}> {
  const prisma = prismaClient ?? getPrismaClient();

  if (!lead.website || !lead.website.trim()) {
    return {
      outcome: "no_website",
      handle: null,
      handleSource: null,
      handleConfidence: null,
      message: "Lead has no website to discover Instagram handle.",
    };
  }

  // 7-day cooldown check
  if (lead.lastHandleEnrichmentAt) {
    const lastAt = new Date(lead.lastHandleEnrichmentAt).getTime();
    const elapsedMs = Date.now() - lastAt;
    const cooldownMs = HANDLE_ENRICHMENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    if (elapsedMs < cooldownMs) {
      const daysAgo = Math.max(0, Math.floor(elapsedMs / (24 * 60 * 60 * 1000)));
      return {
        outcome: "cooldown",
        handle: null,
        handleSource: null,
        handleConfidence: null,
        message: `Handle waterfall was already run ${daysAgo} day(s) ago (cooldown: at most once per 7 days).`,
      };
    }
  }

  // Run handle discovery waterfall
  const waterfallRes = await runHandleDiscoveryWaterfall({
    businessName: lead.fullName,
    websiteUrl: lead.website,
  });

  const now = new Date();

  if (waterfallRes.handle) {
    const mismatch = checkNameWebsiteMismatch({
      businessName: lead.fullName,
      websiteUrl: lead.website,
    });
    let confidence = waterfallRes.handleConfidence ?? "medium";
    const flags = [...(lead.scoreFlags ?? [])];
    if (mismatch.isMismatch) {
      if (!flags.includes("NAME_WEBSITE_MISMATCH")) flags.push("NAME_WEBSITE_MISMATCH");
      confidence = "low";
    }

    const channels = Array.from(new Set([...(lead.availableChannels ?? []), "INSTAGRAM"]));
    const newScore = computeLeadScore({
      rating: lead.rating,
      reviewCount: lead.reviewCount,
      website: lead.website,
      phone: lead.phone,
      isClaimed: lead.isClaimed,
      isChain: lead.isChain,
      hasInstagram: true,
      email: lead.email,
      availableChannels: channels,
      handleConfidence: confidence,
      handleSource: waterfallRes.handleSource,
      websiteMismatch: mismatch.isMismatch,
    });

    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        username: waterfallRes.handle,
        usernameNormalized: waterfallRes.handle.toLowerCase(),
        handleSource: waterfallRes.handleSource,
        handleConfidence: confidence,
        availableChannels: channels,
        qualityScore: newScore.score,
        qualityTier: newScore.tier,
        scoreBreakdown: newScore.breakdown,
        scoreFlags: newScore.flags,
        lastHandleEnrichmentAt: now,
      },
    });

    return {
      outcome: "found",
      handle: waterfallRes.handle,
      handleSource: waterfallRes.handleSource,
      handleConfidence: confidence,
      message: `Handle found: @${waterfallRes.handle} (source: ${waterfallRes.handleSource}, confidence: ${confidence})`,
    };
  } else {
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        lastHandleEnrichmentAt: now,
      },
    });

    return {
      outcome: "not_found",
      handle: null,
      handleSource: null,
      handleConfidence: null,
      message: "No Instagram handle found across homepage, /contact, or link hubs.",
    };
  }
}

/**
 * On-demand lazy enrichment for selected leads.
 * - Enforces max 20 leads per click.
 * - Reuses 30-day cache (Lead.rawProfileData) per handle to avoid re-scraping.
 * - Calls the active enrichment provider (default apify/instagram-scraper details mode) safely via runActorSafely for uncached handles.
 * - Whitelists saved fields and drops posts/related profiles.
 * - Re-runs post-enrichment relevance checks.
 */
export async function enrichLeadsOnDemand(
  input: EnrichLeadsInput,
): Promise<EnrichLeadsResult> {
  const { leadIds, userId } = input;
  const prisma = getPrismaClient();

  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    throw new BadRequestError("INVALID_LEAD_IDS", "At least one lead ID is required.");
  }

  if (leadIds.length > MAX_ENRICHMENT_BATCH_SIZE) {
    throw new BadRequestError(
      "BATCH_LIMIT_EXCEEDED",
      `Cannot enrich more than ${MAX_ENRICHMENT_BATCH_SIZE} leads per click to protect budget.`,
    );
  }

  // Fetch target leads verifying ownership via campaign.userId or lead.userId
  const leads = await prisma.lead.findMany({
    where: {
      id: { in: leadIds },
      OR: [{ userId }, { campaign: { userId } }],
    },
    include: {
      campaign: {
        select: { id: true, userId: true, intent: true, category: true, location: true },
      },
    },
  });

  if (leads.length === 0) {
    throw new NotFoundError("LEADS_NOT_FOUND", "No matching leads found for current user.");
  }

  const thirtyDaysAgo = new Date(Date.now() - ENRICHMENT_CACHE_DAYS * 24 * 60 * 60 * 1000);
  const cachedProfiles = new Map<string, LeadProfile>();

  // 1. Check local DB 30-day cache across all leads in the database
  const leadsWithUsername = leads.filter(
    (l): l is typeof l & { username: string } => typeof l.username === "string" && l.username.length > 0,
  );
  const usernamesNormalized = leadsWithUsername.map((l) => l.username.toLowerCase());
  try {
    const historicalLeads = await prisma.lead.findMany({
      where: {
        usernameNormalized: { in: usernamesNormalized },
        rawProfileData: { not: Prisma.DbNull },
        OR: [
          { scrapedAt: { gte: thirtyDaysAgo } },
          { updatedAt: { gte: thirtyDaysAgo } },
        ],
      },
      select: {
        usernameNormalized: true,
        rawProfileData: true,
        scrapedAt: true,
      },
    });

    for (const hl of historicalLeads) {
      if (
        hl.usernameNormalized &&
        hl.rawProfileData &&
        typeof hl.rawProfileData === "object"
      ) {
        const raw = hl.rawProfileData as Record<string, unknown>;
        if (raw.enrichmentStatus === "ENRICHED" || raw.followersCount !== undefined) {
          const normalized = normalizeInstagramProfileItem(
            raw,
            hl.scrapedAt?.toISOString() ?? new Date().toISOString(),
          );
          if (normalized) {
            cachedProfiles.set(hl.usernameNormalized.toLowerCase(), normalized);
          }
        }
      }
    }
  } catch (cacheErr) {
    console.warn(`[ENRICHMENT] Cache check warning: ${String(cacheErr)}`);
  }

  const uncachedUsernames: string[] = [];
  const uncachedLeadsMap = new Map<string, typeof leads[0]>();

  for (const lead of leadsWithUsername) {
    const u = lead.username.toLowerCase();
    if (cachedProfiles.has(u)) {
      continue;
    }
    if (!uncachedUsernames.includes(u)) {
      uncachedUsernames.push(u);
      uncachedLeadsMap.set(u, lead);
    }
  }

  let apifyCostUsd = 0;
  const enrichedProfilesByUsername = new Map<string, LeadProfile>();

  // 2. Fetch uncached profiles via Apify Cost Guard
  if (uncachedUsernames.length > 0) {
    const actorMode = getIgEnrichmentActorMode();
    const actorId = getActiveEnrichmentActorId();
    let actorInput: Record<string, unknown>;
    if (actorMode === "instagram_scraper_details") {
      const directUrls = buildInstagramProfileUrls(uncachedUsernames);
      actorInput = {
        directUrls,
        resultsType: "details",
        resultsLimit: directUrls.length,
      };
    } else {
      actorInput = {
        usernames: uncachedUsernames,
        includeAboutSection: false,
      };
    }

    const safeResult = await runActorSafely<Record<string, unknown>>(
      actorId,
      actorInput,
      {
        maxItems: uncachedUsernames.length,
        userId,
        campaignId: leads[0]?.campaignId,
        operationName:
          actorMode === "instagram_scraper_details"
            ? "on_demand_enrichment_details"
            : "on_demand_enrichment",
      },
    );

    apifyCostUsd = safeResult.usageTotalUsd;

    for (const item of safeResult.items) {
      const normalized = normalizeInstagramProfileItem(
        item,
        new Date().toISOString(),
      );
      if (normalized && normalized.username) {
        enrichedProfilesByUsername.set(normalized.username.toLowerCase(), normalized);
      }
    }
  }

  let enrichedCount = 0;
  let cachedCount = 0;
  const resultLeads: EnrichLeadsResult["leads"] = [];

  // 3. Update leads in DB and run post-enrichment checks
  for (const lead of leads) {
    if (!lead.username) {
      resultLeads.push({
        id: lead.id,
        username: "",
        followersCount: lead.followers,
        biography: lead.biography,
        enrichmentStatus: "NOT_ENRICHED",
      });
      continue;
    }
    const u = lead.username.toLowerCase();
    const isCached = cachedProfiles.has(u);
    const profile = cachedProfiles.get(u) ?? enrichedProfilesByUsername.get(u);

    if (profile) {
      if (isCached) {
        cachedCount++;
      } else {
        enrichedCount++;
      }

      // Check post-enrichment bio negative keywords (niche-aware)
      const allowedTerms = [
        ...(lead.campaign?.intent ? lead.campaign.intent.split(/[\s,]+/) : []),
        ...(lead.campaign?.category ? lead.campaign.category.split(/[\s,]+/) : []),
      ];
      const bioNegativeMatch = profile.biography
        ? findMatchedNegativeKeyword([profile.biography], null, allowedTerms)
        : null;

      const existingRaw =
        typeof lead.rawProfileData === "object" && lead.rawProfileData !== null
          ? (lead.rawProfileData as Record<string, unknown>)
          : {};

      const updatedRawData: Record<string, unknown> = {
        ...existingRaw,
        ...(profile.rawProfileData ?? {}),
        enrichmentStatus: "ENRICHED",
        enrichedAt: new Date().toISOString(),
        bioNegativeKeywordMatched: bioNegativeMatch ?? null,
      };

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          followers: profile.followersCount ?? profile.followers,
          followersCount: profile.followersCount ?? profile.followers,
          following: profile.followsCount ?? profile.following,
          postsCount: profile.postsCount,
          biography: profile.biography,
          isBusinessAccount: profile.isBusinessAccount ?? profile.isBusiness,
          isBusiness: profile.isBusinessAccount ?? profile.isBusiness,
          verified: profile.verified ?? profile.isVerified,
          isVerified: profile.verified ?? profile.isVerified,
          externalUrl: profile.externalUrl || lead.externalUrl,
          category: profile.businessCategoryName || profile.category || lead.category,
          businessCategoryName: profile.businessCategoryName || lead.businessCategoryName,
          rawProfileData: updatedRawData as Prisma.InputJsonValue,
          scrapedAt: new Date(),
        },
      });

      resultLeads.push({
        id: lead.id,
        username: lead.username ?? "",
        followersCount: profile.followersCount ?? profile.followers,
        biography: profile.biography,
        enrichmentStatus: "ENRICHED",
        negativeKeywordMatched: bioNegativeMatch ?? undefined,
      });
    } else {
      if (!lead.username || lead.username.trim() === "") {
        const handleRes = await enrichLeadHandleWaterfall(lead, prisma);
        resultLeads.push({
          id: lead.id,
          username: handleRes.handle ?? "",
          followersCount: null,
          biography: null,
          enrichmentStatus: handleRes.outcome === "found" ? "ENRICHED" : "NOT_ENRICHED",
          handleOutcome: handleRes.outcome,
          handleSource: handleRes.handleSource,
          handleConfidence: handleRes.handleConfidence,
          message: handleRes.message,
        });
      } else {
        resultLeads.push({
          id: lead.id,
          username: lead.username ?? "",
          followersCount: lead.followersCount ?? lead.followers,
          biography: lead.biography,
          enrichmentStatus: "NOT_ENRICHED",
        });
      }
    }
  }

  const remainingBudgetUsd = await getMonthlyApifyBudgetRemaining();

  return {
    success: true,
    totalRequested: leads.length,
    enrichedCount,
    cachedCount,
    apifyCostUsd,
    remainingBudgetUsd,
    leads: resultLeads,
  };
}
