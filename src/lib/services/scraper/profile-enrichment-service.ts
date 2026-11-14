import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { LeadStatus, Prisma } from "@/generated/prisma/client";
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
import { resolveCountryCode } from "../discovery/country-cities";
import {
  evaluateEnrichmentCriteria,
  DEFAULT_ENRICHMENT_CRITERIA,
  type EnrichmentCriteria,
  type EnrichmentRuleResult,
} from "../discovery/enrichment-criteria";
import {
  scrapeLeadWebsite,
  applyWebsiteEnrichmentToLead,
} from "../enrichment/website-lead-enricher";
import type { LeadProfile } from "@/lib/types";

async function loadCampaignEnrichmentCriteria(
  prisma: ReturnType<typeof getPrismaClient>,
  campaignId: string,
  cache: Map<string, EnrichmentCriteria>,
): Promise<EnrichmentCriteria> {
  const cached = cache.get(campaignId);
  if (cached) return cached;

  const latestJob = await prisma.scrapeJob.findFirst({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
    select: { usage: true },
  });
  const usage =
    latestJob?.usage && typeof latestJob.usage === "object"
      ? (latestJob.usage as Record<string, unknown>)
      : {};
  const stored = usage.criteria;
  const criteria =
    stored && typeof stored === "object"
      ? ({
          ...DEFAULT_ENRICHMENT_CRITERIA,
          ...(stored as EnrichmentCriteria),
          ruleModes: {
            ...DEFAULT_ENRICHMENT_CRITERIA.ruleModes,
            ...(stored as EnrichmentCriteria).ruleModes,
          },
        } satisfies EnrichmentCriteria)
      : DEFAULT_ENRICHMENT_CRITERIA;
  cache.set(campaignId, criteria);
  return criteria;
}

function formatEnrichmentCriteriaReasons(
  items: EnrichmentRuleResult[],
): string[] {
  const labelFor = (rule: string): string => {
    if (rule === "minFollowers" || rule === "maxFollowers") return "Followers";
    if (rule === "minPosts" || rule === "minPosts-strict") return "Posts";
    if (rule === "private" || rule === "excludePrivate") return "Private account";
    if (rule === "category" || rule === "allowedCategories") return "Category";
    return rule;
  };
  return items.map(
    (item) =>
      `${labelFor(item.rule)}: ${String(item.value)} (required ${String(item.required)})`,
  );
}

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
    criteriaPassed?: boolean;
    criteriaReasons?: string[];
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
    username?: string | null;
    instagramUsername?: string | null;
    fullName?: string | null;
    website?: string | null;
    lastHandleEnrichmentAt?: Date | string | null;
    rating?: number | null;
    reviewCount?: number | null;
    isClaimed?: boolean | null;
    isChain?: boolean | null;
    email?: string | null;
    phone?: string | null;
    city?: string | null;
    availableChannels?: string[] | null;
    scoreFlags?: string[] | null;
    rawProfileData?: unknown;
    handleSource?: string | null;
    handleConfidence?: string | null;
    status?: LeadStatus;
    campaign?: { location?: string | null; userId?: string } | null;
  },
  prismaClient?: ReturnType<typeof getPrismaClient>,
  options?: { force?: boolean },
): Promise<{
  outcome: "found" | "not_found" | "cooldown" | "no_website";
  handle: string | null;
  handleSource: string | null;
  handleConfidence: string | null;
  message: string;
  pagesTried?: number;
  socialsFound?: string[];
}> {
  void prismaClient;

  if (!lead.website || !lead.website.trim()) {
    return {
      outcome: "no_website",
      handle: null,
      handleSource: null,
      handleConfidence: null,
      message: "Lead has no website to discover Instagram handle.",
    };
  }

  // 7-day cooldown check (explicit per-lead button can force a fresh scrape)
  if (lead.lastHandleEnrichmentAt && !options?.force) {
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

  // Free website scraper: homepage + up to 4 same-domain pages. Extracts
  // Instagram, other socials, emails, and phones. Never overwrites an existing
  // handle; it only fills missing channels.
  const extraction = await scrapeLeadWebsite({
    website: lead.website,
    businessName: lead.fullName,
    countryCode: resolveCountryCodeForLead(lead),
  });
  const applied = await applyWebsiteEnrichmentToLead(
    {
      ...lead,
      campaign: (lead as { campaign?: { location?: string | null } | null }).campaign,
      status: lead.status,
    } as Parameters<typeof applyWebsiteEnrichmentToLead>[0],
    extraction,
  );

  const found = applied.handleStored || Boolean(applied.emailFound) || applied.socialsFound.length > 0;
  if (!found) {
    return {
      outcome: "not_found",
      handle: null,
      handleSource: null,
      handleConfidence: null,
      message: `No Instagram handle, email, or social link found across ${applied.pagesTried} page(s).`,
      pagesTried: applied.pagesTried,
      socialsFound: [],
    };
  }

  const parts = [
    applied.handleStored ? `IG @${applied.handleFound}` : null,
    applied.emailFound ? `email ${applied.emailFound}` : null,
    applied.socialsFound.length > 0 ? `${applied.socialsFound.length} social link(s)` : null,
  ].filter(Boolean);

  return {
    outcome: "found",
    handle: applied.handleStored ? applied.handleFound : lead.username ?? null,
    handleSource: applied.handleStored ? "website" : lead.username ? "existing" : null,
    handleConfidence: extraction.handleConfidence,
    message: `Website enrichment found ${parts.join(", ")} across ${applied.pagesTried} page(s).`,
    pagesTried: applied.pagesTried,
    socialsFound: applied.socialsFound,
  };
}

function resolveCountryCodeForLead(lead: {
  campaign?: { location?: string | null } | null;
}): string | undefined {
  const location = lead.campaign?.location;
  return location ? resolveCountryCode(location) ?? undefined : undefined;
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

    const safetyMaxItems = Math.max(5, 2 * uncachedUsernames.length);

    const safeResult = await runActorSafely<Record<string, unknown>>(
      actorId,
      actorInput,
      {
        maxItems: safetyMaxItems,
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
  const criteriaCache = new Map<string, EnrichmentCriteria>();

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

      const campaignCriteria = await loadCampaignEnrichmentCriteria(
        prisma,
        lead.campaignId,
        criteriaCache,
      );
      const criteriaEval = evaluateEnrichmentCriteria(
        profile,
        campaignCriteria,
        {
          intent: lead.campaign?.intent ?? null,
          category: lead.campaign?.category ?? null,
          location: lead.campaign?.location ?? null,
        },
      );
      const postFlags = criteriaEval.flags.filter(
        (flag) => flag.rule === "minPosts" || flag.rule === "minPosts-strict",
      );
      const criteriaReasons = formatEnrichmentCriteriaReasons([
        ...criteriaEval.reasons,
        ...postFlags,
      ]);
      const criteriaPassed = criteriaEval.passed && postFlags.length === 0;
      const criteriaScoreFlags = criteriaPassed ? [] : ["BELOW_ENRICHMENT_CRITERIA"];

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
        enrichmentCriteria: {
          passed: criteriaPassed,
          reasons: criteriaReasons,
          hardReasons: formatEnrichmentCriteriaReasons(criteriaEval.reasons),
          flags: formatEnrichmentCriteriaReasons(criteriaEval.flags),
          thresholds: {
            minFollowers: campaignCriteria.minFollowers ?? null,
            maxFollowers: campaignCriteria.maxFollowers ?? null,
            minPosts: campaignCriteria.minPosts ?? null,
          },
          evaluatedAt: new Date().toISOString(),
        },
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
          scoreFlags: Array.from(new Set([...(lead.scoreFlags ?? []), ...criteriaScoreFlags])),
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
        criteriaPassed,
        criteriaReasons,
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
