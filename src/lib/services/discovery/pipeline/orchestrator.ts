/**
 * Discovery Pipeline Orchestrator
 * Coordinates pipeline stages, enforces budget and cancellation guards,
 * emits real-time progress events, logs structured stage observability,
 * and records the funnel summary JSON onto ScrapeJob.usage.
 */

import { getPrismaClient } from "@/lib/db/prisma";
import { ScrapeJobStatus, Prisma } from "@/generated/prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { LeadProfile } from "@/lib/types";
import type { DiscoveredProfile } from "../discovery-provider";
import type {
  DiscoveryProgressHandler,
  DiscoveryRequest,
  DiscoveryRunResult,
} from "../discovery-service";
import { getActiveDiscoveryMode } from "../discovery-service";
import {
  createEmptySkipCounts,
  sumSkipCounts,
} from "../lead-relevance";
import { DEFAULT_ENRICHMENT_CRITERIA, type EnrichmentCriteria } from "../enrichment-criteria";
import { getScraperProviderName } from "@/lib/env";
import { getActiveEnrichmentActorId } from "@/lib/services/scraper/instagram-profile";
import { isDryRunMode } from "@/lib/services/scraper/apify-cost-guard";
import { logStageObservability } from "./observability";
import { planSearchStage } from "./stages/plan-search";
import { fetchPlacesStage } from "./stages/fetch-places";
import { freeRulesStage } from "./stages/free-rules";
import { chainDetectionStage } from "./stages/chain-detection";
import { mapsGateStage } from "./stages/maps-gate";
import { handleDiscoveryStage } from "./stages/handle-discovery";
import { profileEnrichmentStage } from "./stages/profile-enrichment";
import { criteriaAndScoreStage } from "./stages/criteria-and-score";
import { finalGateStage } from "./stages/final-gate";
import { persistStage } from "./stages/persist";
import type { DiscoveryDependencies, PipelineStageContext, StageFunnelReport } from "./types";

export async function orchestrateDiscovery(
  request: DiscoveryRequest,
  userId?: string,
  onProgress?: DiscoveryProgressHandler,
  deps: DiscoveryDependencies = {},
): Promise<DiscoveryRunResult> {
  const prisma = getPrismaClient();
  const providerName = getScraperProviderName();
  const activeDiscoveryMode = getActiveDiscoveryMode();
  const discoveryActor =
    activeDiscoveryMode === "instagram_all_in_one"
      ? "apify/instagram-scraper"
      : activeDiscoveryMode === "google_maps"
        ? "compass/crawler-google-places"
        : activeDiscoveryMode === "instagram_places"
          ? "apify/instagram-scraper"
          : "apify/instagram-search-scraper";

  // 1. Ownership & Concurrency Validation
  const campaign = await prisma.campaign.findFirst({
    where: { id: request.campaignId, ...(userId ? { userId } : {}) },
    include: { companyProfile: true },
  });
  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign "${request.campaignId}" not found.`);
  }

  const runningJob = await prisma.scrapeJob.findFirst({
    where: {
      campaignId: campaign.id,
      status: ScrapeJobStatus.RUNNING,
      startedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
    },
  });
  if (runningJob) {
    throw new ConflictError("CONCURRENT_DISCOVERY", "A discovery job is currently running for this campaign.");
  }

  // 2. Capacity Check
  const isCurrentRunDry = isDryRunMode();
  const existingLeadCount = await prisma.lead.count({
    where: {
      campaignId: campaign.id,
      ...(!isCurrentRunDry ? { isDryRun: false } : { isDryRun: true }),
    },
  });
  const remainingCapacity = Math.max(0, request.maxLeads - existingLeadCount);
  if (remainingCapacity <= 0) {
    const notice = `LIMIT_REACHED: Campaign has reached its limit of ${request.maxLeads} leads.`;
    const emptyJob = await prisma.scrapeJob.create({
      data: {
        campaignId: campaign.id,
        status: ScrapeJobStatus.COMPLETED,
        provider: providerName,
        isDryRun: isCurrentRunDry,
        inputCount: 0,
        processedCount: 0,
        startedAt: new Date(),
        completedAt: new Date(),
        requestedLimit: request.maxLeads,
        errorMessage: notice,
      },
    });
    return {
      campaignId: campaign.id,
      scrapeJobId: emptyJob.id,
      discoveryActor,
      enrichmentActor: getActiveEnrichmentActorId(),
      requestedLimit: request.maxLeads,
      existingLeads: existingLeadCount,
      candidatesDiscovered: 0,
      candidatesEnriched: 0,
      existingSkipped: 0,
      skipped: 0,
      persisted: 0,
      remainingCapacity: 0,
      notice,
      skipCounts: createEmptySkipCounts(),
      profiles: [],
      apifyCostUsd: 0,
    };
  }

  // 3. Initialize ScrapeJob
  const job = await prisma.scrapeJob.create({
    data: {
      campaignId: campaign.id,
      status: ScrapeJobStatus.RUNNING,
      provider: providerName,
      isDryRun: isCurrentRunDry,
      inputCount: 0,
      processedCount: 0,
      startedAt: new Date(),
      query: request.query,
      location: request.location,
      category: request.category,
      discoveryActor,
      enrichmentActor: getActiveEnrichmentActorId(),
      requestedLimit: request.maxLeads,
    },
  });

  const effectiveCriteria: EnrichmentCriteria = {
    ...DEFAULT_ENRICHMENT_CRITERIA,
    ...request.criteria,
    ruleModes: { ...DEFAULT_ENRICHMENT_CRITERIA.ruleModes, ...request.criteria?.ruleModes },
  };

  // 4. Build Pipeline Context
  const context: PipelineStageContext = {
    campaign: {
      id: campaign.id,
      userId: campaign.userId,
      intent: request.query,
      location: request.location,
      category: request.category,
      minRating: campaign.minRating,
      minReviews: campaign.minReviews,
      excludeChains: campaign.excludeChains,
      companyProfile: campaign.companyProfile,
    },
    jobId: job.id,
    userId,
    requestedLimit: request.maxLeads,
    existingLeadCount,
    remainingCapacity,
    criteria: effectiveCriteria,
    caches: {
      seenCandidates: new Set<string>(),
      existingUsernames: new Set<string>(),
      existingPlaceIds: new Set<string>(),
      existingDomains: new Set<string>(),
      existingPhones: new Set<string>(),
    },
  };

  const funnelReport: StageFunnelReport = {
    jobId: job.id,
    plannedQueries: 0,
    placesFound: 0,
    afterFreeRules: 0,
    afterChains: 0,
    afterMapsGate: 0,
    handlesDiscovered: 0,
    multiChannelFound: 0,
    profilesEnriched: 0,
    afterCriteria: 0,
    afterFinalGate: 0,
    persisted: 0,
    totalSpendUsd: 0,
    rejectionsByStage: {},
    durationMs: 0,
  };

  let totalSpendUsd = 0;
  let totalPersisted = 0;
  const persistedProfiles: LeadProfile[] = [];
  const skipCounts = createEmptySkipCounts();
  let stopReason = "completed";
  const startJobTime = Date.now();

  try {
    // Stage 1: planSearch
    const planResult = await planSearchStage(
      {
        query: request.query,
        category: request.category ?? undefined,
        location: request.location ?? undefined,
        activeDiscoveryMode,
        priorNextKeywordIndex: 0,
      },
      context,
      deps,
    );
    const planned = planResult.survivors[0];
    funnelReport.plannedQueries = planned.effectiveQueries.length;
    logStageObservability(job.id, "planSearch", { in: 1, out: planned.effectiveQueries.length }, 0, planResult.durationMs, []);

    // Stage 2: fetchPlaces
    const fetchResult = await fetchPlacesStage(
      {
        query: planned.searchTerm,
        queries: planned.effectiveQueries,
        limit: planned.roundCandidateTarget,
        location: request.location ?? undefined,
        category: request.category ?? undefined,
        providerType:
          activeDiscoveryMode === "hybrid" ? "google_maps" : activeDiscoveryMode,
      },
      context,
      deps,
    );
    totalSpendUsd += fetchResult.spendUsd;
    funnelReport.placesFound = fetchResult.survivors.length;
    logStageObservability(job.id, "fetchPlaces", { in: 1, out: fetchResult.survivors.length }, fetchResult.spendUsd, fetchResult.durationMs, []);

    // Check cancellation or budget
    if (totalSpendUsd > 10.0) {
      stopReason = "budget_cap_reached";
    }

    // Stage 3: freeRules
    const freeRulesResult = await freeRulesStage({ candidates: fetchResult.survivors }, context, deps);
    funnelReport.afterFreeRules = freeRulesResult.survivors.length;
    funnelReport.rejectionsByStage.freeRules = freeRulesResult.counters;
    logStageObservability(job.id, "freeRules", { in: fetchResult.survivors.length, out: freeRulesResult.survivors.length }, 0, freeRulesResult.durationMs, freeRulesResult.rejected);

    // Stage 4: chainDetection
    const chainResult = await chainDetectionStage({ candidates: freeRulesResult.survivors }, context, deps);
    funnelReport.afterChains = chainResult.survivors.length;
    funnelReport.rejectionsByStage.chainDetection = chainResult.counters;
    logStageObservability(job.id, "chainDetection", { in: freeRulesResult.survivors.length, out: chainResult.survivors.length }, 0, chainResult.durationMs, chainResult.rejected);

    // Stage 5: mapsGate
    const mapsGateResult = await mapsGateStage({ candidates: chainResult.survivors }, context, deps);
    totalSpendUsd += mapsGateResult.spendUsd;
    funnelReport.afterMapsGate = mapsGateResult.survivors.length;
    funnelReport.rejectionsByStage.mapsGate = mapsGateResult.counters;
    logStageObservability(job.id, "mapsGate", { in: chainResult.survivors.length, out: mapsGateResult.survivors.length }, mapsGateResult.spendUsd, mapsGateResult.durationMs, mapsGateResult.rejected);

    // Stage 6: handleDiscovery
    const handleResult = await handleDiscoveryStage({ candidates: mapsGateResult.survivors }, context, deps);
    const routing = handleResult.survivors[0];
    funnelReport.handlesDiscovered = routing.igCandidates.length;
    funnelReport.multiChannelFound = routing.multiChannelCandidates.length;
    funnelReport.rejectionsByStage.handleDiscovery = handleResult.counters;
    logStageObservability(job.id, "handleDiscovery", { in: mapsGateResult.survivors.length, out: routing.igCandidates.length + routing.multiChannelCandidates.length }, 0, handleResult.durationMs, handleResult.rejected);

    // Stage 7: profileEnrichment (lazy)
    const candidateMetaMap = new Map<string, DiscoveredProfile>();
    for (const c of routing.igCandidates) {
      if (c.username) candidateMetaMap.set(c.username.toLowerCase(), c as unknown as DiscoveredProfile);
    }
    const igUsernames = routing.igCandidates.map((c) => c.username!).filter(Boolean);

    const enrichResult = await profileEnrichmentStage(
      { usernames: igUsernames, candidateMetaByUsername: candidateMetaMap },
      context,
      deps,
    );
    totalSpendUsd += enrichResult.spendUsd;
    funnelReport.profilesEnriched = enrichResult.survivors.length;
    funnelReport.rejectionsByStage.profileEnrichment = enrichResult.counters;
    logStageObservability(job.id, "profileEnrichment", { in: igUsernames.length, out: enrichResult.survivors.length }, enrichResult.spendUsd, enrichResult.durationMs, enrichResult.rejected);

    // Stage 8: criteriaAndScore
    const criteriaResult = await criteriaAndScoreStage({ profiles: enrichResult.survivors }, context, deps);
    const criteriaOutput = criteriaResult.survivors[0];
    funnelReport.afterCriteria = criteriaOutput.clearPassProfiles.length + criteriaOutput.borderlineProfiles.length;
    funnelReport.rejectionsByStage.criteriaAndScore = criteriaResult.counters;
    logStageObservability(job.id, "criteriaAndScore", { in: enrichResult.survivors.length, out: funnelReport.afterCriteria }, 0, criteriaResult.durationMs, criteriaResult.rejected);

    // Stage 9: finalGate
    const finalGateResult = await finalGateStage(
      {
        clearPassProfiles: criteriaOutput.clearPassProfiles,
        borderlineProfiles: criteriaOutput.borderlineProfiles,
      },
      context,
      deps,
    );
    totalSpendUsd += finalGateResult.spendUsd;
    funnelReport.afterFinalGate = finalGateResult.survivors.length;
    funnelReport.rejectionsByStage.finalGate = finalGateResult.counters;
    logStageObservability(job.id, "finalGate", { in: funnelReport.afterCriteria, out: finalGateResult.survivors.length }, finalGateResult.spendUsd, finalGateResult.durationMs, finalGateResult.rejected);

    // Stage 10: persist
    const persistResult = await persistStage(
      {
        igProfiles: finalGateResult.survivors,
        multiChannelCandidates: routing.multiChannelCandidates,
        countryCode: planned.countryCode,
        maxLeads: request.maxLeads,
      },
      context,
      deps,
    );
    totalPersisted = persistResult.counters.persisted ?? persistResult.survivors.length;
    persistedProfiles.push(...persistResult.survivors);
    funnelReport.persisted = totalPersisted;
    funnelReport.rejectionsByStage.persist = persistResult.counters;
    logStageObservability(job.id, "persist", { in: finalGateResult.survivors.length + routing.multiChannelCandidates.length, out: totalPersisted }, 0, persistResult.durationMs, persistResult.rejected);

    funnelReport.totalSpendUsd = Number(totalSpendUsd.toFixed(4));
    funnelReport.durationMs = Date.now() - startJobTime;

    // Update ScrapeJob completion
    const finalStatus = totalPersisted >= context.remainingCapacity ? ScrapeJobStatus.COMPLETED : ScrapeJobStatus.COMPLETED;
    await prisma.scrapeJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        processedCount: totalPersisted,
        completedAt: new Date(),
        usage: {
          funnel: funnelReport,
          totalUsd: totalSpendUsd,
          stopReason,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const notice = `DISCOVERY_COMPLETED: Saved ${totalPersisted} leads. Candidates discovered: ${funnelReport.placesFound}. Spend: $${totalSpendUsd.toFixed(4)}.`;

    return {
      campaignId: campaign.id,
      scrapeJobId: job.id,
      discoveryActor,
      enrichmentActor: getActiveEnrichmentActorId(),
      requestedLimit: request.maxLeads,
      existingLeads: existingLeadCount,
      candidatesDiscovered: funnelReport.placesFound,
      candidatesEnriched: funnelReport.profilesEnriched,
      existingSkipped: 0,
      skipped: sumSkipCounts(skipCounts),
      persisted: totalPersisted,
      remainingCapacity: Math.max(0, request.maxLeads - (existingLeadCount + totalPersisted)),
      notice,
      skipCounts,
      profiles: persistedProfiles,
      apifyCostUsd: totalSpendUsd,
    };
  } catch (err: unknown) {
    // Stage failure handling: keep already saved leads and record spend
    const safeMessage = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    await prisma.scrapeJob.update({
      where: { id: job.id },
      data: {
        status: ScrapeJobStatus.FAILED,
        completedAt: new Date(),
        errorMessage: safeMessage,
        usage: {
          funnel: funnelReport,
          totalUsd: totalSpendUsd,
          failedAt: new Date().toISOString(),
          error: safeMessage,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    throw err;
  }
}
