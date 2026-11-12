/**
 * Stage 7: profileEnrichment
 * Performs lazy Instagram profile enrichment only on surviving candidates.
 * First checks 30-day cache (Fix 3 cache) to avoid re-paying for previously enriched profiles.
 */

import { getPrismaClient } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { LeadProfile } from "@/lib/types";
import type { DiscoveredProfile } from "../../discovery-provider";
import { normalizeInstagramProfileItem } from "../../../scraper/instagram-profile";
import { scrapeInstagramProfiles } from "../../../scraper/scraper-service";
import type { DiscoveryDependencies, PipelineStageContext, RejectionDetail, StageResult } from "../types";

export interface ProfileEnrichmentInput {
  usernames: string[];
  candidateMetaByUsername: Map<string, DiscoveredProfile>;
  maxBatchSize?: number;
  providerName?: string;
  enrichmentActor?: string;
}

export async function profileEnrichmentStage(
  input: ProfileEnrichmentInput,
  context: PipelineStageContext,
  deps: DiscoveryDependencies = {},
): Promise<StageResult<LeadProfile>> {
  const start = deps.now ? deps.now() : Date.now();
  const prisma = getPrismaClient();
  const enrichedProfiles: LeadProfile[] = [];
  const rejected: RejectionDetail[] = [];
  let spendUsd = 0;
  const counters: Record<string, number> = {
    requested: input.usernames.length,
    cached: 0,
    liveEnriched: 0,
    failed: 0,
  };

  if (input.usernames.length === 0) {
    return {
      survivors: [],
      rejected: [],
      spendUsd: 0,
      counters,
      durationMs: (deps.now ? deps.now() : Date.now()) - start,
    };
  }

  const batchCap = input.maxBatchSize ?? Math.min(context.remainingCapacity * 2, 20);
  const targetUsernames = Array.from(new Set(input.usernames)).slice(0, batchCap);

  // 1. Check 30-day cache (Fix 3 cache)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const cachedProfilesMap = new Map<string, LeadProfile>();

  try {
    const cachedLeads = await prisma.lead.findMany({
      where: {
        usernameNormalized: { in: targetUsernames.map((u) => u.toLowerCase()) },
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

    for (const cl of cachedLeads) {
      if (cl.usernameNormalized && cl.rawProfileData && typeof cl.rawProfileData === "object") {
        const rawObj = cl.rawProfileData as Record<string, unknown>;
        if (
          rawObj.enrichmentStatus === "ENRICHED" ||
          rawObj.followersCount !== undefined ||
          rawObj.biography !== undefined
        ) {
          const normalized = normalizeInstagramProfileItem(
            rawObj,
            cl.scrapedAt?.toISOString() ?? new Date().toISOString(),
          );
          if (normalized) {
            cachedProfilesMap.set(cl.usernameNormalized.toLowerCase(), normalized);
          }
        }
      }
    }
  } catch {
    // Non-fatal cache lookup failure
  }

  const uncachedUsernames: string[] = [];
  for (const username of targetUsernames) {
    const cached = cachedProfilesMap.get(username.toLowerCase());
    if (cached) {
      counters.cached++;
      enrichedProfiles.push(cached);
    } else {
      uncachedUsernames.push(username);
    }
  }

  // 2. Fetch uncached profiles via provider
  if (uncachedUsernames.length > 0) {
    if (deps.profileProvider?.getProfiles) {
      const live = await deps.profileProvider.getProfiles(uncachedUsernames);
      enrichedProfiles.push(...live);
      counters.liveEnriched += live.length;
    } else {
      const enrichment = await scrapeInstagramProfiles(
        uncachedUsernames,
        uncachedUsernames.length,
        {
          campaignId: context.campaign.id,
          userId: context.userId,
        },
      );
      if (enrichment.usageTotalUsd) {
        spendUsd += enrichment.usageTotalUsd;
      }
      enrichedProfiles.push(...enrichment.profiles);
      counters.liveEnriched += enrichment.profiles.length;
      counters.failed += enrichment.skipped.length;

      for (const skipped of enrichment.skipped) {
        const u = typeof skipped === "string" ? skipped : skipped.username;
        const detail = typeof skipped === "object" && skipped.reason ? skipped.reason : "Profile scraper was unable to retrieve profile details";
        rejected.push({
          id: u,
          reason: "ENRICHMENT_FAILED",
          detail,
          gate: "profileEnrichment",
        });
      }
    }
  }

  // 3. Merge Maps metadata onto enriched profiles
  for (const profile of enrichedProfiles) {
    const meta = profile.username ? input.candidateMetaByUsername.get(profile.username.toLowerCase()) : undefined;
    if (meta) {
      const alternate: Record<string, string> = {};
      if (!profile.location && (meta.gmapsCity || meta.gmapsAddress || meta.location)) {
        profile.location = meta.gmapsCity || meta.gmapsAddress || meta.location || null;
      }
      if (meta.phone) {
        if (profile.phone && profile.phone !== meta.phone) {
          alternate.alternatePhone = profile.phone;
        }
        profile.phone = meta.phone;
      }
      if (meta.website) {
        if (profile.website && profile.website !== meta.website) {
          alternate.alternateWebsite = profile.website;
        }
        profile.website = meta.website;
      }
      if (meta.email) {
        if (profile.email && profile.email !== meta.email) {
          alternate.alternateEmail = profile.email;
        }
        profile.email = meta.email;
      }
      profile.gmapsCategory = meta.gmapsCategory ?? null;
      profile.gmapsCategories = meta.gmapsCategories ?? null;
      profile.gmapsCity = meta.gmapsCity ?? null;
      profile.gmapsAddress = meta.gmapsAddress ?? null;
      profile.gmapsRating = meta.gmapsRating ?? null;
      profile.gmapsReviews = meta.gmapsReviews ?? null;
      profile.gmapsPlaceId = meta.gmapsPlaceId ?? null;
      profile.handleSource = meta.handleSource ?? null;
      profile.handleConfidence = meta.handleConfidence ?? null;
      profile.city = meta.city ?? meta.gmapsCity ?? null;
      profile.rating = meta.rating ?? meta.gmapsRating ?? null;
      profile.reviewCount = meta.reviewCount ?? meta.gmapsReviews ?? null;
      profile.isChain = meta.isChain ?? false;
      profile.isClaimed = meta.isClaimed ?? null;
      profile.permanentlyClosed = meta.permanentlyClosed ?? null;
      profile.temporarilyClosed = meta.temporarilyClosed ?? null;
      profile.sourceProvider = meta.sourceProvider ?? profile.sourceProvider ?? "google_maps";

      profile.rawProfileData = {
        ...(typeof profile.rawProfileData === "object" && profile.rawProfileData !== null
          ? profile.rawProfileData
          : {}),
        gmapsCategory: meta.gmapsCategory ?? null,
        gmapsCategories: meta.gmapsCategories ?? null,
        gmapsCity: meta.gmapsCity ?? null,
        gmapsAddress: meta.gmapsAddress ?? null,
        gmapsRating: meta.gmapsRating ?? null,
        gmapsReviews: meta.gmapsReviews ?? null,
        gmapsPlaceId: meta.gmapsPlaceId ?? null,
        handleSource: meta.handleSource ?? null,
        handleConfidence: meta.handleConfidence ?? null,
        phone: meta.phone ?? null,
        website: meta.website ?? null,
        socialLinks: meta.socialLinks ?? {},
        sourceProvider: meta.sourceProvider ?? profile.sourceProvider ?? "google_maps",
        isChain: meta.isChain ?? false,
        isClaimed: meta.isClaimed ?? null,
        ...alternate,
        dataSources: {
          businessName: "maps",
          category: "maps",
          city: "maps",
          rating: "maps",
          reviewCount: "maps",
          phone: meta.phone ? "maps" : profile.phone ? "instagram" : null,
          website: meta.website ? "maps" : profile.website ? "instagram" : null,
          email: meta.email ? "maps" : profile.email ? "instagram" : null,
          followers: "instagram",
          postsCount: "instagram",
          lastPostAt: "instagram",
        },
      };
    }
  }

  const durationMs = (deps.now ? deps.now() : Date.now()) - start;

  return {
    survivors: enrichedProfiles,
    rejected,
    spendUsd,
    counters,
    durationMs,
  };
}
