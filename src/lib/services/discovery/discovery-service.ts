import "server-only";

import type { LeadProfile } from "@/lib/types";
import { getPrismaClient } from "@/lib/db/prisma";
import {
  CampaignStatus,
  ScrapeJobStatus,
} from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  INSTAGRAM_PROFILE_ACTOR_ID,
  ScrapeInputError,
  normalizeInstagramUsername,
  parseLeadLimit,
  scrapeInstagramProfiles,
} from "../scraper";
import { CAMPAIGN_ID_PATTERN, persistCampaignLeads } from "../campaign";
import { getScraperProviderName } from "@/lib/env";
import { ApifyDiscoveryProvider, DISCOVERY_ACTOR_ID } from "./apify-discovery-provider";
import { SpariorDiscoveryProvider } from "../scraper/sparior";
import { logRuntimeSpariorEnv } from "../scraper/sparior/sparior-client";
import { checkManySuppression } from "../compliance/dnc-service";
import { UsageProvider } from "@/generated/prisma/client";
import type { DiscoveryProvider } from "./discovery-provider";
import {
  buildDiscoverySearchTerm,
  buildPerKeywordSearchQueries,
  sanitizeSearchTerm,
} from "./discovery-query";
import {
  collectRelevantLeads,
  createEmptySkipCounts,
  deduplicateCandidates,
  sumSkipCounts,
  type DiscoverySkipCounts,
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  type DiscoveryRelevancePolicy,
} from "./lead-relevance";
import { enrichProfilesWithWebsiteFallback } from "../enrichment/website-contact-extractor";
import { Prisma } from "@/generated/prisma/client";

// Discovery asks for more candidates than leads requested because some are
// irrelevant, duplicates, already in the campaign, private, or fail enrichment.
const MAX_CANDIDATE_POOL = 60;
const ENRICH_BATCH_SIZE = 10;
const MAX_QUERY_LENGTH = 200;
const MAX_LOCATION_LENGTH = 100;
const MAX_CATEGORY_LENGTH = 100;
const MAX_ERROR_MESSAGE_LENGTH = 1000;

export type DiscoveryRequest = {
  campaignId: string;
  query: string;
  location: string | null;
  category: string | null;
  maxLeads: number;
};

export type DiscoveryProgressEvent = {
  stage: "discover" | "discovered" | "enrich" | "persist" | "done";
  message: string;
  candidatesDiscovered?: number;
  candidatesEnriched?: number;
  persisted?: number;
  skipped?: number;
  remainingCapacity?: number;
  existingLeads?: number;
  skipCounts?: DiscoverySkipCounts;
};

export type DiscoveryProgressHandler = (event: DiscoveryProgressEvent) => void;

export type DiscoveryRunResult = {
  campaignId: string;
  scrapeJobId: string;
  discoveryActor: string;
  enrichmentActor: string;
  requestedLimit: number;
  existingLeads: number;
  candidatesDiscovered: number;
  candidatesEnriched: number;
  existingSkipped: number;
  skipped: number;
  persisted: number;
  remainingCapacity: number;
  notice: string | null;
  skipCounts: DiscoverySkipCounts;
  profiles: LeadProfile[];
};

let discoveryProvider: DiscoveryProvider | null = null;

export function getDiscoveryProvider(): DiscoveryProvider {
  const providerName = getScraperProviderName();
  if (providerName === "sparior") {
    return new SpariorDiscoveryProvider();
  }
  if (discoveryProvider === null) {
    discoveryProvider = new ApifyDiscoveryProvider();
  }

  return discoveryProvider;
}

function logDiscovery(message: string): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  console.log(message);
}

export function parseDiscoveryRequest(body: unknown): DiscoveryRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ScrapeInputError(
      "INVALID_BODY",
      "Request body must be a JSON object.",
    );
  }

  const record = body as Record<string, unknown>;

  const rawCampaignId = record.campaignId;
  if (typeof rawCampaignId !== "string" || !CAMPAIGN_ID_PATTERN.test(rawCampaignId.trim())) {
    throw new ScrapeInputError(
      "INVALID_CAMPAIGN_ID",
      '"campaignId" is required and must be 1-64 characters using letters, numbers, "-" or "_".',
    );
  }

  const rawQuery = record.query ?? record.intent;
  if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
    throw new ScrapeInputError(
      "INVALID_QUERY",
      '"query" (campaign intent) is required and must be a non-empty string.',
    );
  }
  const cleanTest = sanitizeSearchTerm(rawQuery);
  if (cleanTest.length === 0) {
    throw new ScrapeInputError(
      "INVALID_QUERY",
      '"query" must contain searchable text (letters or numbers).',
    );
  }
  const query = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);

  const readOptional = (
    value: unknown,
    field: string,
    maxLength: number,
  ): string | null => {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string") {
      throw new ScrapeInputError(
        "INVALID_FIELD",
        `"${field}" must be a string when provided.`,
      );
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed.slice(0, maxLength);
  };

  const location = readOptional(record.location, "location", MAX_LOCATION_LENGTH);
  const category = readOptional(record.category, "category", MAX_CATEGORY_LENGTH);

  const maxLeads = parseLeadLimit(record.maxLeads ?? record.limit);

  return {
    campaignId: rawCampaignId.trim(),
    query,
    location,
    category,
    maxLeads,
  };
}

/**
 * DISCOVERY -> ENRICHMENT -> PERSISTENCE.
 *
 * 1. Search Actor discovers candidate usernames for the campaign intent.
 * 2. Candidates are normalized/deduplicated and existing campaign leads removed.
 * 3. Surviving candidates are enriched in batches through the EXISTING profile
 *    scraper (`apify/instagram-profile-scraper`) and persisted with the existing
 *    lead upsert. Enrichment stops once `maxLeads` NEW leads are saved.
 */
export async function runDiscovery(
  request: DiscoveryRequest,
  userId?: string,
  onProgress?: DiscoveryProgressHandler,
): Promise<DiscoveryRunResult> {
  const activeProvider = getScraperProviderName();
  console.log(`[DISCOVERY-REQUEST-START] SCRAPER_PROVIDER=${activeProvider}`);
  if (activeProvider === "sparior") {
    logRuntimeSpariorEnv("[DISCOVERY-REQUEST-START]");
  }
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: request.campaignId,
      ...(userId ? { userId } : {}),
    },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${request.campaignId}" was not found.`,
    );
  }

  // 1. Concurrent discovery protection:
  // Check if any scrape job for this campaign is already running (started within last 5 minutes)
  const runningJob = await prisma.scrapeJob.findFirst({
    where: {
      campaignId: campaign.id,
      status: ScrapeJobStatus.RUNNING,
      startedAt: {
        gte: new Date(Date.now() - 5 * 60 * 1000),
      },
    },
  });

  if (runningJob) {
    throw new ConflictError(
      "CONCURRENT_DISCOVERY",
      "A discovery or scrape job is currently running for this campaign. Please wait for it to complete.",
    );
  }

  // 2. Existing leads and remaining capacity:
  const existingLeadCount = await prisma.lead.count({
    where: { campaignId: campaign.id },
  });

  const remainingCapacity = Math.max(0, request.maxLeads - existingLeadCount);

  // If campaign has already reached the requested limit
  if (remainingCapacity <= 0) {
    const notice = `LIMIT_REACHED: Campaign has reached its limit of ${request.maxLeads} leads (existing: ${existingLeadCount}). No additional leads were added.`;

    const job = await prisma.scrapeJob.create({
      data: {
        campaignId: campaign.id,
        status: ScrapeJobStatus.COMPLETED,
        provider: "apify",
        inputCount: 0,
        processedCount: 0,
        startedAt: new Date(),
        completedAt: new Date(),
        query: request.query,
        location: request.location,
        category: request.category,
        discoveryActor: DISCOVERY_ACTOR_ID,
        enrichmentActor: INSTAGRAM_PROFILE_ACTOR_ID,
        requestedLimit: request.maxLeads,
        candidatesDiscovered: 0,
        candidatesEnriched: 0,
        candidatesSkipped: 0,
        errorMessage: notice,
      },
    });

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        intent: request.query,
        location: request.location,
        category: request.category,
        leadLimit: request.maxLeads,
        status: CampaignStatus.COMPLETED,
      },
    });

    onProgress?.({
      stage: "done",
      message: notice,
      candidatesDiscovered: 0,
      candidatesEnriched: 0,
      persisted: 0,
      skipped: 0,
      remainingCapacity: 0,
      existingLeads: existingLeadCount,
      skipCounts: createEmptySkipCounts(),
    });

    return {
      campaignId: campaign.id,
      scrapeJobId: job.id,
      discoveryActor: DISCOVERY_ACTOR_ID,
      enrichmentActor: INSTAGRAM_PROFILE_ACTOR_ID,
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
    };
  }

  // Remember the campaign intent (Step 8).
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      intent: request.query,
      location: request.location,
      category: request.category,
      leadLimit: request.maxLeads,
      status: CampaignStatus.RUNNING,
    },
  });

  const searchTerm = buildDiscoverySearchTerm({
    query: request.query,
    category: request.category,
    location: request.location,
  });

  const searchQueries = buildPerKeywordSearchQueries({
    query: request.query,
    category: request.category,
    location: request.location,
  });

  // Ask for more raw candidates than the remaining capacity: a large share of
  // them are expected to be irrelevant to the campaign and will be rejected by
  // the relevance gate below.
  const candidateTarget = Math.min(
    MAX_CANDIDATE_POOL,
    Math.max(remainingCapacity * 4, remainingCapacity + 10),
  );

  const providerName = getScraperProviderName();
  const discoveryActor =
    providerName === "sparior" ? "sparior-search" : DISCOVERY_ACTOR_ID;
  const enrichmentActor =
    providerName === "sparior" ? "sparior-profile" : INSTAGRAM_PROFILE_ACTOR_ID;

  const job = await prisma.scrapeJob.create({
    data: {
      campaignId: campaign.id,
      status: ScrapeJobStatus.RUNNING,
      provider: providerName,
      inputCount: 0,
      processedCount: 0,
      startedAt: new Date(),
      query: request.query,
      location: request.location,
      category: request.category,
      discoveryActor,
      enrichmentActor,
      requestedLimit: request.maxLeads,
      candidatesDiscovered: 0,
      candidatesEnriched: 0,
      candidatesSkipped: 0,
    },
  });

  const emit = (event: DiscoveryProgressEvent): void => {
    onProgress?.(event);
  };

  try {
    logDiscovery(
      `[DISCOVERY] starting campaignId=${campaign.id} query="${request.query}" location=${request.location ?? "-"} category=${request.category ?? "-"} requestedLimit=${request.maxLeads} existingLeads=${existingLeadCount} remainingCapacity=${remainingCapacity}`,
    );
    if (providerName === "sparior") {
      for (const q of searchQueries) {
        logDiscovery(
          `[DISCOVERY] actor=${discoveryActor} searchType=user searchLimit=${candidateTarget} search="${q}"`,
        );
      }
    } else {
      logDiscovery(
        `[DISCOVERY] actor=${discoveryActor} searchType=user searchLimit=${candidateTarget} search="${searchTerm}"`,
      );
    }

    emit({
      stage: "discover",
      message: "Discovering Instagram profiles...",
      candidatesDiscovered: 0,
      candidatesEnriched: 0,
      persisted: 0,
      skipped: 0,
      remainingCapacity,
      existingLeads: existingLeadCount,
    });

    const discovery = await getDiscoveryProvider().discover({
      query: searchTerm,
      queries: searchQueries,
      limit: candidateTarget,
      location: request.location,
      category: request.category,
      campaignId: campaign.id,
      userId,
    });

    if (providerName === "apify") {
      try {
        await prisma.usageLog.create({
          data: {
            userId,
            campaignId: campaign.id,
            provider: UsageProvider.APIFY,
            operation: "search",
            requestCount: 1,
            itemsReturned: discovery.candidates.length,
            estimatedCostUsd:
              discovery.usageTotalUsd !== undefined
                ? new Prisma.Decimal(discovery.usageTotalUsd)
                : null,
            metadata: {
              runId: discovery.runId,
              actor: discovery.actor,
              computeUnits: discovery.computeUnits,
              executedQueries: discovery.executedQueries,
            },
          },
        });
      } catch {
        // fire-and-forget
      }
    }

    const discoveredUsernames: string[] = [];
    for (const candidate of discovery.candidates) {
      const normalized = normalizeInstagramUsername(candidate.username);
      if (normalized !== null && !discoveredUsernames.includes(normalized)) {
        discoveredUsernames.push(normalized);
      }
    }

    if (discovery.keywordStats && discovery.keywordStats.length > 0) {
      for (const stat of discovery.keywordStats) {
        logDiscovery(
          `[DISCOVERY] keyword search="${stat.query}" candidates=${stat.candidatesCount} raw=${stat.rawCount}`,
        );
      }
    }
    if (discovery.skippedQueries && discovery.skippedQueries.length > 0) {
      logDiscovery(
        `[DISCOVERY] skipped queries this run (budget cap): ${discovery.skippedQueries.join(", ")}`,
      );
    }

    logDiscovery(
      `[DISCOVERY] run=${discovery.runId} dataset=${discovery.datasetId ?? "-"} candidates=${discoveredUsernames.length}`,
    );
    console.log("[Discovery Service] candidates discovered:", discoveredUsernames.length);

    const existingLeads = await prisma.lead.findMany({
      where: { campaignId: campaign.id },
      select: { username: true },
    });
    const existingUsernames = new Set(
      existingLeads.map((lead) => lead.username.toLowerCase()),
    );

    // Preserve existing campaignId + normalized username deduplication.
    const { unique: newCandidates, duplicates: duplicateCandidates } =
      deduplicateCandidates(discoveredUsernames, existingUsernames);
    const existingSkipped = duplicateCandidates.length;

    const skipCounts = createEmptySkipCounts();
    skipCounts.DUPLICATE = existingSkipped;

    emit({
      stage: "discovered",
      message: `Candidates found: ${discoveredUsernames.length}`,
      candidatesDiscovered: discoveredUsernames.length,
      candidatesEnriched: 0,
      persisted: 0,
      skipped: sumSkipCounts(skipCounts),
      remainingCapacity,
      existingLeads: existingLeadCount,
      skipCounts: { ...skipCounts },
    });

    logDiscovery(
      `[ENRICHMENT] candidates=${newCandidates.length} existingSkipped=${existingSkipped}`,
    );
    console.log("[Discovery Service] candidates skipped (existing):", existingSkipped);

    const relevancePolicy: DiscoveryRelevancePolicy = {
      ...DEFAULT_DISCOVERY_RELEVANCE_POLICY,
      requireLocationMatch: false,
      allowUnknownLocation: true,
    };

    const collected = await collectRelevantLeads({
      candidates: newCandidates,
      capacity: remainingCapacity,
      campaign: {
        intent: request.query,
        location: request.location,
        category: request.category,
      },
      policy: relevancePolicy,
      batchSize: ENRICH_BATCH_SIZE,
      maxCandidates: MAX_CANDIDATE_POOL,
      enrich: async (batch) => {
        // Enrich the WHOLE batch. The enrichment actor's maxItems must not
        // truncate the pool before the relevance gate has run.
        const enrichment = await scrapeInstagramProfiles(batch, batch.length, {
          campaignId: campaign.id,
          userId,
        });
        if (providerName === "apify") {
          try {
            await prisma.usageLog.create({
              data: {
                userId,
                campaignId: campaign.id,
                provider: UsageProvider.APIFY,
                operation: "profile",
                requestCount: 1,
                itemsReturned: enrichment.profiles.length,
                estimatedCostUsd:
                  enrichment.usageTotalUsd !== undefined
                    ? new Prisma.Decimal(enrichment.usageTotalUsd)
                    : null,
                metadata: {
                  runId: enrichment.runId,
                  batchSize: batch.length,
                  computeUnits: enrichment.computeUnits,
                },
              },
            });
          } catch {
            // fire-and-forget
          }
        }
        return {
          profiles: enrichment.profiles,
          skipped: enrichment.skipped.map((entry) => entry.username),
        };
      },
      onBatch: (info) => {
        emit({
          stage: "enrich",
          message: `Enriching and relevance-checking profiles... (${info.relevantCount} relevant)`,
          candidatesDiscovered: discoveredUsernames.length,
          candidatesEnriched: info.candidatesEnriched,
          persisted: 0,
          skipped: sumSkipCounts(info.skipCounts),
          remainingCapacity: Math.max(0, remainingCapacity - info.relevantCount),
          existingLeads: existingLeadCount,
          skipCounts: { ...info.skipCounts },
        });
      },
    });

    const finalSkipCounts: DiscoverySkipCounts = collected.skipCounts;
    finalSkipCounts.DUPLICATE += existingSkipped;

    // DNC suppression check across relevant leads before persisting
    const dncCheckItems = collected.relevant.map((p, idx) => ({
      id: String(idx),
      username: p.username,
      instagramUserId: p.instagramUserId ?? p.instagramId ?? null,
      email: p.email ?? null,
      website: p.website ?? p.externalUrl ?? null,
    }));

    const suppressionMap = await checkManySuppression({
      userId: userId ?? campaign.userId,
      leads: dncCheckItems,
    });

    let dncSkipped = 0;
    const unsuppressedRelevant: LeadProfile[] = [];
    for (let i = 0; i < collected.relevant.length; i++) {
      const profile = collected.relevant[i];
      const sup = suppressionMap.get(String(i));
      if (sup?.suppressed) {
        dncSkipped++;
        continue;
      }
      unsuppressedRelevant.push(profile);
    }

    finalSkipCounts.DNC_SUPPRESSED =
      (finalSkipCounts.DNC_SUPPRESSED ?? 0) + dncSkipped;

    // Persist only relevant, unsuppressed, enriched profiles, never exceeding campaign capacity.
    const toPersist = unsuppressedRelevant.slice(0, remainingCapacity);

    // Enrich candidates having website but no phone & email via website fallback scrape (bounded by cap)
    const fallbackCap = process.env.WEBSITE_FALLBACK_MAX_PER_RUN
      ? Number.parseInt(process.env.WEBSITE_FALLBACK_MAX_PER_RUN, 10)
      : Math.max(10, remainingCapacity + 5);

    await enrichProfilesWithWebsiteFallback(toPersist, {
      maxFetches: fallbackCap,
    });

    const persistResult = await persistCampaignLeads(
      campaign.id,
      toPersist,
      request.maxLeads,
      {
        source: "discovery",
        scrapeJobId: job.id,
        userId: userId ?? campaign.userId,
      },
    );
    // Rows actually created in THIS campaign (soft duplicates are created+flagged).
    const createdInCampaign =
      persistResult.dedupStats.new + persistResult.dedupStats.softDuplicates;
    const persistedProfiles = toPersist.slice(0, createdInCampaign);

    if (createdInCampaign < toPersist.length) {
      finalSkipCounts.CAMPAIGN_CAPACITY_REACHED +=
        toPersist.length - createdInCampaign;
    }

    const persisted = createdInCampaign;
    const candidatesEnriched = collected.candidatesEnriched;
    const skipped = sumSkipCounts(finalSkipCounts);
    const finalRemaining = Math.max(
      0,
      request.maxLeads - (existingLeadCount + persisted),
    );

    console.log(
      "[Discovery Service] candidates enriched:",
      candidatesEnriched,
      "enrichment failures:",
      collected.enrichmentFailures,
    );
    console.log(
      "[Discovery Service] leads persisted:",
      persisted,
      "skip breakdown:",
      JSON.stringify(finalSkipCounts),
    );

    emit({
      stage: "persist",
      message: `Saving leads...`,
      candidatesDiscovered: discoveredUsernames.length,
      candidatesEnriched,
      persisted,
      skipped,
      remainingCapacity: finalRemaining,
      existingLeads: existingLeadCount,
      skipCounts: { ...finalSkipCounts },
    });

    const notice = buildDiscoveryNotice({
      persisted,
      requested: request.maxLeads,
      existingLeads: existingLeadCount,
      discovered: discoveredUsernames.length,
      existingSkipped,
      enrichSkipped: collected.enrichmentFailures,
      remainingCapacity: finalRemaining,
      skipCounts: finalSkipCounts,
    });

    const usageFunnel = {
      requestsUsed:
        (discovery.requestsUsed ?? 1) +
        Math.ceil(newCandidates.length / ENRICH_BATCH_SIZE),
      profilesReturned: discoveredUsernames.length,
      keywordStats: discovery.keywordStats,
      executedQueries: discovery.executedQueries,
      skippedQueries: discovery.skippedQueries,
      nextKeywordIndex: discovery.nextKeywordIndex,
      malformedSkipped: finalSkipCounts.MALFORMED ?? 0,
      duplicatesSkipped:
        existingSkipped + persistResult.dedupStats.hardDuplicates,
      duplicatesByKey: persistResult.dedupStats.byKey,
      softDuplicatesFlagged: persistResult.dedupStats.softDuplicates,
      leadsEnriched: persistResult.dedupStats.enriched,
      filteredOutByRelevance:
        (finalSkipCounts.IRRELEVANT_CATEGORY ?? 0) +
        (finalSkipCounts.IRRELEVANT_INTENT ?? 0) +
        (finalSkipCounts.IRRELEVANT_LOCATION ?? 0) +
        (finalSkipCounts.IRRELEVANT_LOCATION_NATIONAL_SCALE ?? 0) +
        (finalSkipCounts.INSUFFICIENT_RELEVANCE_DATA ?? 0),
      dncSkipped,
      newLeadsCreated: persistResult.dedupStats.new,
      qualifiedLeads: collected.relevant.length,
      errors: collected.enrichmentFailures,
    };

    await prisma.scrapeJob.update({
      where: { id: job.id },
      data: {
        status: ScrapeJobStatus.COMPLETED,
        inputCount: newCandidates.length,
        processedCount: persisted,
        candidatesDiscovered: discoveredUsernames.length,
        candidatesEnriched,
        candidatesSkipped: skipped,
        usage: usageFunnel,
        stopReason: "completed",
        errorMessage: notice,
        completedAt: new Date(),
      },
    });

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: CampaignStatus.COMPLETED },
    });

    emit({
      stage: "done",
      message:
        persisted > 0
          ? `${persisted} new lead${persisted === 1 ? "" : "s"} added`
          : "No relevant profiles were found for this campaign",
      candidatesDiscovered: discoveredUsernames.length,
      candidatesEnriched,
      persisted,
      skipped,
      remainingCapacity: finalRemaining,
      existingLeads: existingLeadCount,
      skipCounts: { ...finalSkipCounts },
    });

    return {
      campaignId: campaign.id,
      scrapeJobId: job.id,
      discoveryActor,
      enrichmentActor,
      requestedLimit: request.maxLeads,
      existingLeads: existingLeadCount,
      candidatesDiscovered: discoveredUsernames.length,
      candidatesEnriched,
      existingSkipped,
      skipped,
      persisted,
      remainingCapacity: finalRemaining,
      notice,
      skipCounts: finalSkipCounts,
      profiles: persistedProfiles,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const safeMessage = errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH);

    logDiscovery(`[DISCOVERY] failed campaignId=${campaign.id} error=${safeMessage}`);

    await prisma.scrapeJob
      .update({
        where: { id: job.id },
        data: {
          status: ScrapeJobStatus.FAILED,
          errorMessage: safeMessage,
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);

    await prisma.campaign
      .update({
        where: { id: campaign.id },
        data: { status: CampaignStatus.FAILED },
      })
      .catch(() => undefined);

    throw error;
  }
}

function buildDiscoveryNotice(input: {
  persisted: number;
  requested: number;
  existingLeads: number;
  discovered: number;
  existingSkipped: number;
  enrichSkipped: number;
  remainingCapacity: number;
  skipCounts?: DiscoverySkipCounts;
}): string | null {
  const {
    persisted,
    requested,
    existingLeads,
    discovered,
    existingSkipped,
    enrichSkipped,
    remainingCapacity,
  } = input;

  const breakdown = formatSkipBreakdown(input.skipCounts);

  if (discovered === 0) {
    return "NO_RESULTS: No usable Instagram profiles were found for this campaign.";
  }

  if (persisted === 0) {
    return `NO_RESULTS: No relevant Instagram profiles passed the discovery filter. Candidates discovered: ${discovered}, already in campaign: ${existingSkipped}, enrichment failures: ${enrichSkipped}. Skipped: ${breakdown}. Remaining capacity: ${remainingCapacity}.`;
  }

  const allowedNew = Math.max(0, requested - existingLeads);
  if (persisted < allowedNew) {
    return `PARTIAL_RESULTS: Saved ${persisted} of ${allowedNew} available slots (campaign limit: ${requested}, existing: ${existingLeads}, remaining capacity: ${remainingCapacity}). Candidates discovered: ${discovered}, already in campaign: ${existingSkipped}, enrichment failures: ${enrichSkipped}, skipped: ${breakdown}.`;
  }

  return `DISCOVERY_COMPLETED: Saved ${persisted} new lead${persisted === 1 ? "" : "s"} (limit: ${requested}, existing: ${existingLeads}, remaining capacity: ${remainingCapacity}). Candidates discovered: ${discovered}, skipped: ${breakdown}.`;
}

function formatSkipBreakdown(
  skipCounts: DiscoverySkipCounts | undefined,
): string {
  if (skipCounts === undefined) {
    return "0";
  }

  const parts = (Object.entries(skipCounts) as Array<
    [keyof DiscoverySkipCounts, number]
  >)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`);

  return parts.length > 0 ? parts.join(", ") : "0";
}
