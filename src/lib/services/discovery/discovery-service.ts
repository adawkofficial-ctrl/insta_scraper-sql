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

    const existingLeads = await prisma.lead.findMany({
      where: { campaignId: campaign.id },
      select: { username: true },
    });
    const existingUsernames = new Set(
      existingLeads.map((lead) => lead.username.toLowerCase()),
    );

    // Re-run protection: load candidates seen in past scrape jobs for this campaign
    // to prevent re-enriching previously seen/rejected candidates on repeat clicks.
    const recentJobs = await prisma.scrapeJob.findMany({
      where: { campaignId: campaign.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { usage: true },
    });

    let priorNextKeywordIndex = 0;
    for (const rj of recentJobs) {
      const u = rj.usage as Record<string, unknown> | null;
      if (Array.isArray(u?.seenCandidates)) {
        for (const c of u.seenCandidates) {
          if (typeof c === "string" && c.trim().length > 0) {
            existingUsernames.add(c.trim().toLowerCase());
          }
        }
      }
      if (typeof u?.nextKeywordIndex === "number" && priorNextKeywordIndex === 0) {
        priorNextKeywordIndex = u.nextKeywordIndex;
      }
    }

    const effectiveQueries =
      searchQueries.length > 0 ? searchQueries : [request.query];

    logDiscovery(
      `[DISCOVERY] starting campaignId=${campaign.id} query="${request.query}" location=${request.location ?? "-"} category=${request.category ?? "-"} requestedLimit=${request.maxLeads} existingLeads=${existingLeadCount} remainingCapacity=${remainingCapacity}`,
    );

    let totalPersisted = 0;
    const persistedProfiles: LeadProfile[] = [];
    const discoveredUsernamesAll: string[] = [];
    const allSeenCandidatesThisRun = new Set<string>();
    const finalSkipCounts: DiscoverySkipCounts = createEmptySkipCounts();
    let totalExistingSkipped = 0;
    let totalEnrichedCount = 0;
    let totalEnrichmentFailures = 0;
    let totalDncSkipped = 0;
    let totalRequestsUsed = 0;
    let qualifiedLeadsCount = 0;
    let newLeadsCount = 0;
    let softDuplicatesCount = 0;
    let hardDuplicatesCount = 0;
    const dedupByKeyCounts: Record<string, number> = {};
    const executedQueriesAll: string[] = [];
    const skippedQueriesAll: string[] = [];
    const keywordStatsAll: Array<{
      query: string;
      candidatesCount: number;
      rawCount: number;
    }> = [];
    const currentKeywordIndex = priorNextKeywordIndex % effectiveQueries.length;
    let stopReason = "completed";

    const maxRounds = process.env.DISCOVERY_MAX_ROUNDS
      ? Math.max(1, Number.parseInt(process.env.DISCOVERY_MAX_ROUNDS, 10))
      : 5;
    const maxSearchRequests = process.env.APIFY_MAX_REQUESTS_PER_RUN
      ? Math.max(1, Number.parseInt(process.env.APIFY_MAX_REQUESTS_PER_RUN, 10))
      : 5;

    for (let round = 0; round < maxRounds; round++) {
      const remainingNeeded = remainingCapacity - totalPersisted;
      if (remainingNeeded <= 0) {
        stopReason = "completed";
        break;
      }

      // Check if campaign was paused or cancelled by user
      const currentCampaign = await prisma.campaign.findUnique({
        where: { id: campaign.id },
        select: { status: true },
      });
      if (
        currentCampaign &&
        (currentCampaign.status === CampaignStatus.PAUSED ||
          currentCampaign.status === CampaignStatus.CANCELLED)
      ) {
        stopReason = "cancelled";
        break;
      }

      const roundCandidateTarget = Math.min(
        MAX_CANDIDATE_POOL,
        Math.max(remainingNeeded * 4, remainingNeeded + 10),
      );

      let roundQuery: string;
      let roundQueries: string[] | undefined;

      if (providerName === "sparior") {
        roundQuery = searchTerm;
        roundQueries = effectiveQueries;
      } else {
        const kwIdx = (currentKeywordIndex + round) % effectiveQueries.length;
        roundQuery = effectiveQueries[kwIdx];
        roundQueries = [roundQuery];
      }

      emit({
        stage: "discover",
        message:
          round === 0
            ? "Discovering Instagram profiles..."
            : `Discovering additional profiles (round ${round + 1})...`,
        candidatesDiscovered: discoveredUsernamesAll.length,
        candidatesEnriched: totalEnrichedCount,
        persisted: totalPersisted,
        skipped: sumSkipCounts(finalSkipCounts),
        remainingCapacity: remainingNeeded,
        existingLeads: existingLeadCount,
        skipCounts: { ...finalSkipCounts },
      });

      const discovery = await getDiscoveryProvider().discover({
        query: roundQuery,
        queries: roundQueries,
        limit: roundCandidateTarget,
        location: request.location,
        category: request.category,
        campaignId: campaign.id,
        userId,
      });

      totalRequestsUsed += discovery.requestsUsed ?? 1;
      logDiscovery(
        `[DISCOVERY] round=${round + 1} run=${discovery.runId} dataset=${discovery.datasetId ?? "-"} actor=${discovery.actor} cost=${discovery.usageTotalUsd ?? 0}`,
      );

      if (discovery.executedQueries) {
        for (const eq of discovery.executedQueries) {
          if (!executedQueriesAll.includes(eq)) executedQueriesAll.push(eq);
        }
      }
      if (discovery.skippedQueries) {
        for (const sq of discovery.skippedQueries) {
          if (!skippedQueriesAll.includes(sq)) skippedQueriesAll.push(sq);
        }
      }
      if (discovery.keywordStats) {
        for (const ks of discovery.keywordStats) {
          const existingStat = keywordStatsAll.find((s) => s.query === ks.query);
          if (existingStat) {
            existingStat.candidatesCount += ks.candidatesCount;
            existingStat.rawCount += ks.rawCount;
          } else {
            keywordStatsAll.push({ ...ks });
          }
        }
      }

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
                round: round + 1,
              },
            },
          });
        } catch {
          // fire-and-forget
        }
      }

      const roundUsernames: string[] = [];
      for (const candidate of discovery.candidates) {
        const normalized = normalizeInstagramUsername(candidate.username);
        if (normalized !== null && !roundUsernames.includes(normalized)) {
          roundUsernames.push(normalized);
          if (!discoveredUsernamesAll.includes(normalized)) {
            discoveredUsernamesAll.push(normalized);
          }
          allSeenCandidatesThisRun.add(normalized);
        }
      }

      const { unique: newCandidates, duplicates: duplicateCandidates } =
        deduplicateCandidates(roundUsernames, existingUsernames);

      for (const u of roundUsernames) {
        existingUsernames.add(u);
      }

      totalExistingSkipped += duplicateCandidates.length;
      finalSkipCounts.DUPLICATE =
        (finalSkipCounts.DUPLICATE ?? 0) + duplicateCandidates.length;

      emit({
        stage: "discovered",
        message: `Candidates found: ${discoveredUsernamesAll.length} (${newCandidates.length} new)`,
        candidatesDiscovered: discoveredUsernamesAll.length,
        candidatesEnriched: totalEnrichedCount,
        persisted: totalPersisted,
        skipped: sumSkipCounts(finalSkipCounts),
        remainingCapacity: remainingCapacity - totalPersisted,
        existingLeads: existingLeadCount,
        skipCounts: { ...finalSkipCounts },
      });

      if (newCandidates.length > 0) {
        const relevancePolicy: DiscoveryRelevancePolicy = {
          ...DEFAULT_DISCOVERY_RELEVANCE_POLICY,
          requireLocationMatch: false,
          allowUnknownLocation: true,
        };

        const collected = await collectRelevantLeads({
          candidates: newCandidates,
          capacity: remainingNeeded,
          campaign: {
            intent: request.query,
            location: request.location,
            category: request.category,
          },
          policy: relevancePolicy,
          batchSize: ENRICH_BATCH_SIZE,
          maxCandidates: MAX_CANDIDATE_POOL,
          enrich: async (batch) => {
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
              message: `Enriching and relevance-checking profiles... (${totalPersisted + info.relevantCount} relevant)`,
              candidatesDiscovered: discoveredUsernamesAll.length,
              candidatesEnriched: totalEnrichedCount + info.candidatesEnriched,
              persisted: totalPersisted,
              skipped: sumSkipCounts(finalSkipCounts) + sumSkipCounts(info.skipCounts),
              remainingCapacity: Math.max(
                0,
                remainingCapacity - (totalPersisted + info.relevantCount),
              ),
              existingLeads: existingLeadCount,
              skipCounts: { ...finalSkipCounts },
            });
          },
        });

        for (const [key, count] of Object.entries(collected.skipCounts) as Array<
          [keyof DiscoverySkipCounts, number]
        >) {
          if (count > 0) {
            finalSkipCounts[key] = (finalSkipCounts[key] ?? 0) + count;
          }
        }
        totalEnrichedCount += collected.candidatesEnriched;
        totalEnrichmentFailures += collected.enrichmentFailures;
        qualifiedLeadsCount += collected.relevant.length;

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

        let roundDncSkipped = 0;
        const unsuppressedRelevant: LeadProfile[] = [];
        for (let i = 0; i < collected.relevant.length; i++) {
          const profile = collected.relevant[i];
          const sup = suppressionMap.get(String(i));
          if (sup?.suppressed) {
            roundDncSkipped++;
            continue;
          }
          unsuppressedRelevant.push(profile);
        }

        totalDncSkipped += roundDncSkipped;
        finalSkipCounts.DNC_SUPPRESSED =
          (finalSkipCounts.DNC_SUPPRESSED ?? 0) + roundDncSkipped;

        const toPersist = unsuppressedRelevant.slice(0, remainingNeeded);

        if (toPersist.length > 0) {
          const fallbackCap = process.env.WEBSITE_FALLBACK_MAX_PER_RUN
            ? Number.parseInt(process.env.WEBSITE_FALLBACK_MAX_PER_RUN, 10)
            : Math.max(10, remainingNeeded + 5);

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

          const createdInCampaign =
            persistResult.dedupStats.new + persistResult.dedupStats.softDuplicates;
          totalPersisted += createdInCampaign;
          persistedProfiles.push(...toPersist.slice(0, createdInCampaign));

          newLeadsCount += persistResult.dedupStats.new;
          softDuplicatesCount += persistResult.dedupStats.softDuplicates;
          hardDuplicatesCount += persistResult.dedupStats.hardDuplicates;
          for (const [k, v] of Object.entries(persistResult.dedupStats.byKey)) {
            dedupByKeyCounts[k] = (dedupByKeyCounts[k] ?? 0) + v;
          }

          if (createdInCampaign < toPersist.length) {
            finalSkipCounts.CAMPAIGN_CAPACITY_REACHED =
              (finalSkipCounts.CAMPAIGN_CAPACITY_REACHED ?? 0) +
              (toPersist.length - createdInCampaign);
          }
        }
      }

      if (totalPersisted >= remainingCapacity) {
        stopReason = "completed";
        break;
      }

      // Check continuation stopping criteria
      if (providerName === "sparior") {
        if (
          discovery.stopReason === "max_requests" ||
          discovery.stopReason === "quota"
        ) {
          stopReason = "budget_cap_reached";
          break;
        }
        if (
          discovery.stopReason === "completed" ||
          discovery.candidates.length === 0
        ) {
          stopReason = "all_keywords_exhausted";
          break;
        }
      } else {
        if (totalRequestsUsed >= maxSearchRequests) {
          stopReason = "budget_cap_reached";
          break;
        }
        if (
          round + 1 >= effectiveQueries.length &&
          (roundUsernames.length === 0 || newCandidates.length === 0)
        ) {
          stopReason = "all_keywords_exhausted";
          break;
        }
      }
    }

    const persisted = totalPersisted;
    const candidatesEnriched = totalEnrichedCount;
    const skipped = sumSkipCounts(finalSkipCounts);
    const finalRemaining = Math.max(
      0,
      request.maxLeads - (existingLeadCount + persisted),
    );

    if (persisted < remainingCapacity && stopReason === "completed") {
      stopReason = "all_keywords_exhausted";
    }

    console.log(
      "[Discovery Service] candidates enriched:",
      candidatesEnriched,
      "enrichment failures:",
      totalEnrichmentFailures,
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
      candidatesDiscovered: discoveredUsernamesAll.length,
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
      discovered: discoveredUsernamesAll.length,
      existingSkipped: totalExistingSkipped,
      enrichSkipped: totalEnrichmentFailures,
      remainingCapacity: finalRemaining,
      skipCounts: finalSkipCounts,
      stopReason,
    });

    const usageFunnel = {
      requestsUsed:
        totalRequestsUsed + Math.ceil(candidatesEnriched / ENRICH_BATCH_SIZE),
      profilesReturned: discoveredUsernamesAll.length,
      keywordStats: keywordStatsAll,
      executedQueries: executedQueriesAll,
      skippedQueries: skippedQueriesAll,
      nextKeywordIndex:
        (currentKeywordIndex + executedQueriesAll.length) % effectiveQueries.length,
      seenCandidates: Array.from(allSeenCandidatesThisRun),
      malformedSkipped: finalSkipCounts.MALFORMED ?? 0,
      duplicatesSkipped: totalExistingSkipped + hardDuplicatesCount,
      duplicatesByKey: dedupByKeyCounts,
      softDuplicatesFlagged: softDuplicatesCount,
      leadsEnriched: candidatesEnriched,
      filteredOutByRelevance:
        (finalSkipCounts.IRRELEVANT_CATEGORY ?? 0) +
        (finalSkipCounts.IRRELEVANT_INTENT ?? 0) +
        (finalSkipCounts.IRRELEVANT_LOCATION ?? 0) +
        (finalSkipCounts.IRRELEVANT_LOCATION_NATIONAL_SCALE ?? 0) +
        (finalSkipCounts.INSUFFICIENT_RELEVANCE_DATA ?? 0),
      dncSkipped: totalDncSkipped,
      newLeadsCreated: newLeadsCount,
      qualifiedLeads: qualifiedLeadsCount,
      errors: totalEnrichmentFailures,
      stopReason,
    };

    await prisma.scrapeJob.update({
      where: { id: job.id },
      data: {
        status: ScrapeJobStatus.COMPLETED,
        inputCount: discoveredUsernamesAll.length,
        processedCount: persisted,
        candidatesDiscovered: discoveredUsernamesAll.length,
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
      candidatesDiscovered: discoveredUsernamesAll.length,
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
      candidatesDiscovered: discoveredUsernamesAll.length,
      candidatesEnriched,
      existingSkipped: totalExistingSkipped,
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
  stopReason?: string;
}): string | null {
  const {
    persisted,
    requested,
    existingLeads,
    discovered,
    existingSkipped,
    enrichSkipped,
    remainingCapacity,
    stopReason,
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
    const reasonDetail =
      stopReason === "budget_cap_reached"
        ? " Reason: budget cap reached."
        : stopReason === "cancelled"
          ? " Reason: job cancelled."
          : " Reason: all search options exhausted for this query/location.";
    return `PARTIAL_RESULTS: Saved ${persisted} of ${allowedNew} available slots (campaign limit: ${requested}, existing: ${existingLeads}, remaining capacity: ${remainingCapacity}). Candidates discovered: ${discovered}, already in campaign: ${existingSkipped}, enrichment failures: ${enrichSkipped}, skipped: ${breakdown}.${reasonDetail}`;
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
