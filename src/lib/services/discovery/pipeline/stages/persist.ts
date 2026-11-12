/**
 * Stage 10: persist
 * Normalizes multi-channel leads, performs DNC suppression, extracts contact signals,
 * and persists qualified leads into the database with multi-attribute deduplication.
 */

import type { LeadProfile } from "@/lib/types";
import type { DiscoveredCandidate } from "../../discovery-provider";
import { checkManySuppression } from "../../../compliance/dnc-service";
import { enrichProfilesWithContacts } from "../../../enrichment/website-contact-extractor";
import { computeLeadScore } from "../../lead-quality-score";
import { persistCampaignLeads } from "../../../campaign/campaign-service";
import type { DiscoveryDependencies, PipelineStageContext, RejectionDetail, StageResult } from "../types";

export interface PersistInput {
  igProfiles: LeadProfile[];
  multiChannelCandidates: DiscoveredCandidate[];
  countryCode?: string;
  maxLeads: number;
}

/**
 * Source stored on Lead.source. Instagram-only runs are labelled
 * `instagram_scraper`; every other provider keeps the legacy `discovery` label.
 */
export function resolveDiscoveryPersistSource(
  profiles: Array<Pick<LeadProfile, "source" | "sourceProvider">>,
): string {
  return profiles.some(
    (profile) =>
      profile.source === "instagram_scraper" ||
      profile.sourceProvider === "instagram_scraper",
  )
    ? "instagram_scraper"
    : "discovery";
}

export async function persistStage(
  input: PersistInput,
  context: PipelineStageContext,
  deps: DiscoveryDependencies = {},
): Promise<StageResult<LeadProfile>> {
  const start = deps.now ? deps.now() : Date.now();
  const rejected: RejectionDetail[] = [];
  const counters: Record<string, number> = {
    dncSuppressed: 0,
    newLeads: 0,
    softDuplicates: 0,
    hardDuplicates: 0,
    persisted: 0,
    capacityReached: 0,
  };

  const borderlineMinScore = Number(process.env.GEMINI_BORDERLINE_MIN_SCORE ?? 30);
  const multiChannelProfiles: LeadProfile[] = [];

  // 1. Process multi-channel candidates
  for (const c of input.multiChannelCandidates) {
    const scoreInput = {
      rating: c.rating ?? c.gmapsRating,
      reviewCount: c.reviewCount ?? c.gmapsReviews,
      website: c.website,
      phone: c.phone,
      isClaimed: c.isClaimed,
      isChain: c.isChain,
      hasInstagram: false,
      email: c.email,
      availableChannels: c.availableChannels && c.availableChannels.length > 0 ? c.availableChannels : ["WEBSITE"],
      hasWhatsApp: Boolean(c.socialLinks?.whatsapp),
      handleConfidence: c.handleConfidence,
      handleSource: c.handleSource,
    };

    const qualityScoreResult = computeLeadScore(scoreInput);

    // Auto-reject clear fails / tier D
    if (qualityScoreResult.score < borderlineMinScore || qualityScoreResult.tier === "D") {
      rejected.push({
        id: c.gmapsPlaceId ?? c.fullName ?? "unknown",
        reason: "LOW_QUALITY_SCORE",
        detail: `Multi-channel score ${qualityScoreResult.score} < ${borderlineMinScore} (Tier ${qualityScoreResult.tier})`,
        gate: "persist",
      });
      continue;
    }

    multiChannelProfiles.push({
      username: null,
      instagramUsername: null,
      profileUrl: null,
      instagramId: null,
      instagramUserId: null,
      fullName: c.fullName ?? null,
      biography: c.biography ?? null,
      followers: null,
      following: null,
      postsCount: null,
      profilePictureUrl: null,
      isVerified: null,
      isBusiness: true,
      category: c.category ?? c.gmapsCategory ?? null,
      externalUrl: c.website ?? null,
      location: c.location ?? c.city ?? c.gmapsCity ?? null,
      city: c.city ?? c.gmapsCity ?? null,
      email: c.email ?? null,
      phone: c.phone ?? null,
      website: c.website ?? null,
      gmapsPlaceId: c.gmapsPlaceId ?? null,
      rating: c.rating ?? c.gmapsRating ?? null,
      reviewCount: c.reviewCount ?? c.gmapsReviews ?? null,
      handleSource: c.handleSource ?? null,
      handleConfidence: c.handleConfidence ?? null,
      locationConfidence: c.locationConfidence ?? "medium",
      fieldSources: c.fieldSources ?? null,
      mapsUrl: c.gmapsUrl ?? c.url ?? null,
      relatedProfiles: null,
      latestPosts: null,
      source: "apify",
      scrapedAt: new Date().toISOString(),
      isClaimed: c.isClaimed ?? null,
      isChain: qualityScoreResult.isChain,
      qualityScore: qualityScoreResult.score,
      qualityTier: qualityScoreResult.tier,
      scoreBreakdown: qualityScoreResult.breakdown,
      scoreFlags: qualityScoreResult.flags,
      availableChannels: scoreInput.availableChannels,
      rawProfileData: {
        ...(c.socialLinks ? { socialLinks: c.socialLinks } : {}),
        locationConfidence: c.locationConfidence ?? "medium",
        fieldSources: c.fieldSources ?? null,
        mapsUrl: c.gmapsUrl ?? c.url ?? null,
        source: "google_maps",
      },
    });
  }

  const allCandidateProfiles = [...input.igProfiles, ...multiChannelProfiles];
  if (allCandidateProfiles.length === 0) {
    return {
      survivors: [],
      rejected,
      spendUsd: 0,
      counters,
      durationMs: (deps.now ? deps.now() : Date.now()) - start,
    };
  }

  // 2. DNC suppression check across all contact channels
  const dncCheckItems = allCandidateProfiles.map((p, idx) => ({
    id: String(idx),
    username: p.username ?? null,
    instagramUserId: p.instagramUserId ?? p.instagramId ?? null,
    email: p.email ?? null,
    website: p.website ?? p.externalUrl ?? null,
    phone: p.phone ?? null,
  }));

  const suppressionMap = await checkManySuppression({
    userId: context.userId ?? context.campaign.userId,
    leads: dncCheckItems,
  });

  const unsuppressed: LeadProfile[] = [];
  for (let i = 0; i < allCandidateProfiles.length; i++) {
    const profile = allCandidateProfiles[i];
    const sup = suppressionMap.get(String(i));
    if (sup?.suppressed) {
      counters.dncSuppressed++;
      rejected.push({
        id: profile.username ?? profile.email ?? profile.phone ?? String(i),
        reason: "DNC_SUPPRESSED",
        detail: "Lead matched global or campaign Do-Not-Contact registry",
        gate: "persist",
      });
      continue;
    }
    unsuppressed.push(profile);
  }

  const toPersist = unsuppressed.slice(0, Math.max(0, context.remainingCapacity));
  if (toPersist.length === 0) {
    return {
      survivors: [],
      rejected,
      spendUsd: 0,
      counters,
      durationMs: (deps.now ? deps.now() : Date.now()) - start,
    };
  }

  // 3. Contact extraction for Instagram profiles
  const needContactEnrichment = toPersist.filter((p) => Boolean(p.username));
  if (needContactEnrichment.length > 0) {
    try {
      await enrichProfilesWithContacts(needContactEnrichment, {
        countryCode: input.countryCode ?? "US",
        timeoutMs: 6000,
      });
    } catch {
      // Non-fatal contact extraction failure
    }
  }

  // 4. Upsert leads into database with multi-attribute deduplication
  const persistSource = resolveDiscoveryPersistSource(toPersist);
  const persistResult = await persistCampaignLeads(
    context.campaign.id,
    toPersist,
    input.maxLeads,
    {
      source: persistSource,
      scrapeJobId: context.jobId,
      userId: context.userId ?? context.campaign.userId,
      isDryRun: context.isDryRun ?? false,
    },
  );

  const createdInCampaign = persistResult.dedupStats.new + persistResult.dedupStats.softDuplicates;
  counters.newLeads = persistResult.dedupStats.new;
  counters.softDuplicates = persistResult.dedupStats.softDuplicates;
  counters.hardDuplicates = persistResult.dedupStats.hardDuplicates;
  counters.persisted = createdInCampaign;

  if (createdInCampaign < toPersist.length) {
    counters.capacityReached = toPersist.length - createdInCampaign;
  }

  const survivors = toPersist.slice(0, createdInCampaign);
  const durationMs = (deps.now ? deps.now() : Date.now()) - start;

  return {
    survivors,
    rejected,
    spendUsd: 0,
    counters,
    durationMs,
  };
}
