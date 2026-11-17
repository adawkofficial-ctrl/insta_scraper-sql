import "server-only";

import type { LeadProfile } from "@/lib/types";
import { getPrismaClient } from "@/lib/db/prisma";
import type { ScrapeJob } from "@/generated/prisma/client";
import {
  CampaignStatus,
  ScrapeJobStatus,
} from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { CONFIRM_RESULTS_ABOVE } from "@/lib/constants/input-limits";
import {
  getActiveEnrichmentActorId,
  ScrapeInputError,
  normalizeInstagramProfileItem,
  normalizeInstagramUsername,
  parseLeadLimit,
  scrapeInstagramProfiles,
} from "../scraper";
import { CAMPAIGN_ID_PATTERN, persistCampaignLeads } from "../campaign";
import { getScraperProviderName, getDiscoveryProviderName, getDiscoveryMaxJobUsd, getIgMaxQueriesPerJob, getIgSearchLimit, areApifyCostLimitsEnabled } from "@/lib/env";
import { isDryRunMode } from "@/lib/services/scraper/apify-cost-guard";
import { ApifyDiscoveryProvider, DISCOVERY_ACTOR_ID } from "./apify-discovery-provider";
import {
  GoogleMapsDiscoveryProvider,
  GMAPS_ACTOR_ID,
} from "./google-maps-discovery-provider";
import {
  InstagramPlacesDiscoveryProvider,
  getIgPlacesActorId,
} from "./instagram-places-discovery-provider";
import {
  InstagramAllInOneDiscoveryProvider,
  IG_ALL_IN_ONE_ACTOR_ID,
} from "./instagram-all-in-one-provider";
import { createInstagramAllInOneCriteria } from "./local-business-criteria";
import { buildYieldStats } from "./google-maps-cost-optimizer";
import { planInstagramQueries } from "./instagram-all-in-one-query";
import { SpariorDiscoveryProvider } from "../scraper/sparior";
import { logRuntimeSpariorEnv } from "../scraper/sparior/sparior-client";
import { checkManySuppression } from "../compliance/dnc-service";
import { UsageProvider } from "@/generated/prisma/client";
import type { DiscoveredProfile, DiscoveryProvider, DiscoveredCandidate, DiscoveryResult } from "./discovery-provider";
import { computeAvailableChannels } from "../contact/contact-parser";
import { parseCompanyTargetIndustries } from "../lead/json-lists";
import {
  buildDiscoverySearchTerm,
  buildPerKeywordSearchQueries,
  sanitizeSearchTerm,
} from "./discovery-query";
import {
  createEmptySkipCounts,
  prefilterCandidate,
  sumSkipCounts,
  evaluateProfileRelevance,
  decideRelevance,
  type DiscoverySkipCounts,
  type DiscoverySkipReason,
  type RelevanceCampaignContext,
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  type DiscoveryRelevancePolicy,
  type LeadRejectionEntry,
  type RelevanceGate,
} from "./lead-relevance";
import {
  evaluateProfileRelevanceWithAI,
  evaluateMapsCandidateRelevanceWithAI,
} from "./ai-relevance";
import { computeLeadScore } from "./lead-quality-score";
import { detectChains } from "./chain-detector";
import {
  type EnrichmentCriteria,
  DEFAULT_ENRICHMENT_CRITERIA,
  evaluateEnrichmentCriteria,
  type RuleMode,
} from "./enrichment-criteria";
import { enrichProfilesWithContacts } from "../enrichment/website-contact-extractor";
import { resolveCountryCode } from "./country-cities";
import { Prisma } from "@/generated/prisma/client";

// Discovery asks for more candidates than leads requested because some are
const MAX_CANDIDATE_POOL = process.env.DISCOVERY_MAX_CANDIDATE_POOL
  ? Math.max(10, Number.parseInt(process.env.DISCOVERY_MAX_CANDIDATE_POOL, 10) || 200)
  : 200;
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
  criteria?: EnrichmentCriteria;
  confirmHighResults?: boolean;
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
  apifyCostUsd?: number | null;
  usageSummary?: Record<string, unknown>;
};

export function getActiveDiscoveryMode():
  | "instagram_all_in_one"
  | "google_maps"
  | "instagram_search"
  | "instagram_places"
  | "hybrid" {
  return getDiscoveryProviderName();
}

let discoveryProvider: DiscoveryProvider | null = null;

export function setDiscoveryProviderForTesting(provider: DiscoveryProvider | null): void {
  discoveryProvider = provider;
}

export function getDiscoveryProvider(
  preferredType?:
    | "google_maps"
    | "instagram_search"
    | "instagram_places"
    | "instagram_all_in_one",
): DiscoveryProvider {
  if (discoveryProvider !== null) {
    return discoveryProvider;
  }

  const providerName = getScraperProviderName();
  if (providerName === "sparior") {
    return new SpariorDiscoveryProvider();
  }

  const mode = getActiveDiscoveryMode();
  const active =
    preferredType ??
    (mode === "google_maps"
      ? "google_maps"
      : mode === "instagram_places"
        ? "instagram_places"
        : mode === "instagram_all_in_one"
          ? "instagram_all_in_one"
          : "instagram_search");

  if (active === "google_maps") {
    return new GoogleMapsDiscoveryProvider();
  }

  if (active === "instagram_places") {
    return new InstagramPlacesDiscoveryProvider();
  }

  if (active === "instagram_all_in_one") {
    return new InstagramAllInOneDiscoveryProvider();
  }

  return new ApifyDiscoveryProvider();
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
  const confirmHighResults = Boolean(record.confirmHighResults);

  if (maxLeads > CONFIRM_RESULTS_ABOVE && !confirmHighResults) {
    throw new ScrapeInputError(
      "CONFIRM_REQUIRED",
      `"maxLeads" above ${CONFIRM_RESULTS_ABOVE} requires explicit confirmation (confirmHighResults=true).`,
    );
  }

  if (process.env.DISCOVERY_STAGE === "pilot_small" && maxLeads > 10) {
    throw new ScrapeInputError(
      "MAX_LEADS_EXCEEDED",
      `"maxLeads" cannot exceed 10 while DISCOVERY_STAGE=pilot_small is set. In pilot_small stage, maxLeads is capped at 10 to ensure safe, controlled discovery.`,
    );
  }

  let criteria: EnrichmentCriteria | undefined;
  if (record.criteria && typeof record.criteria === "object" && !Array.isArray(record.criteria)) {
    const rawCrit = record.criteria as Record<string, unknown>;
    criteria = {
      minFollowers:
        rawCrit.minFollowers === null
          ? null
          : typeof rawCrit.minFollowers === "number"
            ? rawCrit.minFollowers
            : typeof rawCrit.minFollowers === "string" && /^\d+$/.test(rawCrit.minFollowers.trim())
              ? Number.parseInt(rawCrit.minFollowers.trim(), 10)
              : DEFAULT_ENRICHMENT_CRITERIA.minFollowers,
      maxFollowers:
        rawCrit.maxFollowers === null
          ? null
          : typeof rawCrit.maxFollowers === "number"
            ? rawCrit.maxFollowers
            : typeof rawCrit.maxFollowers === "string" && /^\d+$/.test(rawCrit.maxFollowers.trim())
              ? Number.parseInt(rawCrit.maxFollowers.trim(), 10)
              : DEFAULT_ENRICHMENT_CRITERIA.maxFollowers,
      minPosts:
        rawCrit.minPosts === null
          ? null
          : typeof rawCrit.minPosts === "number"
            ? rawCrit.minPosts
            : typeof rawCrit.minPosts === "string" && /^\d+$/.test(rawCrit.minPosts.trim())
              ? Number.parseInt(rawCrit.minPosts.trim(), 10)
              : DEFAULT_ENRICHMENT_CRITERIA.minPosts,
      strictMode: Boolean(rawCrit.strictMode),
      excludePrivate:
        rawCrit.excludePrivate !== undefined
          ? Boolean(rawCrit.excludePrivate)
          : DEFAULT_ENRICHMENT_CRITERIA.excludePrivate,
      allowedCategories: Array.isArray(rawCrit.allowedCategories)
        ? rawCrit.allowedCategories.filter((c): c is string => typeof c === "string")
        : null,
      requireContactSignal: Boolean(rawCrit.requireContactSignal),
      bioIncludeAny: Array.isArray(rawCrit.bioIncludeAny)
        ? rawCrit.bioIncludeAny.filter((b): b is string => typeof b === "string")
        : null,
      bioExclude: Array.isArray(rawCrit.bioExclude)
        ? rawCrit.bioExclude.filter((b): b is string => typeof b === "string")
        : null,
      ruleModes:
        typeof rawCrit.ruleModes === "object" && rawCrit.ruleModes !== null
          ? (rawCrit.ruleModes as Record<string, RuleMode>)
          : DEFAULT_ENRICHMENT_CRITERIA.ruleModes,
    };
  }

  return {
    campaignId: rawCampaignId.trim(),
    query,
    location,
    category,
    maxLeads,
    ...(criteria ? { criteria } : {}),
    ...(confirmHighResults ? { confirmHighResults: true } : {}),
  };
}

/**
 * DISCOVERY -> ENRICHMENT -> PERSISTENCE.
 *
 * 1. Search Actor discovers candidate usernames for the campaign intent.
 * 2. Candidates are normalized/deduplicated and existing campaign leads removed.
 * 3. Surviving candidates are enriched in batches through the active
 *    enrichment provider (default `apify/instagram-scraper` details mode) and persisted with the existing
 *    lead upsert. Enrichment stops once `maxLeads` NEW leads are saved.
 */
export type PreparedDiscoveryRun =
  | {
      kind: "LIMIT_REACHED";
      result: DiscoveryRunResult;
    }
  | {
      kind: "RUNNING";
      job: ScrapeJob;
      execute: (onProgress?: DiscoveryProgressHandler) => Promise<DiscoveryRunResult>;
    };

/**
 * Prepares and initializes the discovery run.
 * Creates the tracked ScrapeJob record in DB before any discovery work begins.
 * Fails loud (throws) if ScrapeJob creation fails so untracked runs are impossible.
 */
export async function prepareDiscoveryRun(
  request: DiscoveryRequest,
  userId?: string,
): Promise<PreparedDiscoveryRun> {
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
    include: {
      companyProfile: true,
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

  const isCurrentRunDry = isDryRunMode();

  // 2. Existing leads and remaining capacity (dry-run rows must never block or count in real runs; real rows never block in dry-run):
  const existingLeadCount = await prisma.lead.count({
    where: {
      campaignId: campaign.id,
      ...(!isCurrentRunDry ? { isDryRun: false } : { isDryRun: true }),
    },
  });

  const remainingCapacity = Math.max(0, request.maxLeads - existingLeadCount);

  // If campaign has already reached the requested limit
  if (remainingCapacity <= 0) {
    const notice = `LIMIT_REACHED: Campaign has reached its limit of ${request.maxLeads} leads (existing: ${existingLeadCount}). No additional leads were added.`;

    let job: ScrapeJob;
    try {
      job = await prisma.scrapeJob.create({
        data: {
          campaignId: campaign.id,
          status: ScrapeJobStatus.COMPLETED,
          provider: "apify",
          isDryRun: isCurrentRunDry,
          inputCount: 0,
          processedCount: 0,
          startedAt: new Date(),
          completedAt: new Date(),
          query: request.query,
          location: request.location,
          category: request.category,
          discoveryActor:
            getActiveDiscoveryMode() === "instagram_all_in_one"
              ? (process.env.APIFY_IG_SCRAPER_ACTOR_ID ?? IG_ALL_IN_ONE_ACTOR_ID)
              : getActiveDiscoveryMode() === "google_maps"
                ? GMAPS_ACTOR_ID
                : DISCOVERY_ACTOR_ID,
          enrichmentActor: getActiveEnrichmentActorId(),
          requestedLimit: request.maxLeads,
          candidatesDiscovered: 0,
          candidatesEnriched: 0,
          candidatesSkipped: 0,
          errorMessage: notice,
        },
      });
    } catch (createErr) {
      console.error("[DISCOVERY-SCRAPEJOB-CREATE-FAILED] Failed to create ScrapeJob:", createErr);
      throw createErr;
    }

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

    return {
      kind: "LIMIT_REACHED",
      result: {
        campaignId: campaign.id,
        scrapeJobId: job.id,
        discoveryActor:
          getActiveDiscoveryMode() === "instagram_all_in_one"
            ? (process.env.APIFY_IG_SCRAPER_ACTOR_ID ?? IG_ALL_IN_ONE_ACTOR_ID)
            : getActiveDiscoveryMode() === "google_maps"
              ? GMAPS_ACTOR_ID
              : DISCOVERY_ACTOR_ID,
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
      },
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

  const providerName = getScraperProviderName();
  const activeDiscoveryMode = getActiveDiscoveryMode();
  const isInstagramAllInOneMode =
    activeDiscoveryMode === "instagram_all_in_one" && providerName !== "sparior";
  const igPlacesActorId = getIgPlacesActorId();
  const discoveryActor =
    providerName === "sparior"
      ? "sparior-search"
      : activeDiscoveryMode === "google_maps"
        ? GMAPS_ACTOR_ID
        : activeDiscoveryMode === "instagram_places"
          ? igPlacesActorId
          : activeDiscoveryMode === "instagram_all_in_one"
            ? (process.env.APIFY_IG_SCRAPER_ACTOR_ID ?? IG_ALL_IN_ONE_ACTOR_ID)
            : activeDiscoveryMode === "hybrid"
              ? `${GMAPS_ACTOR_ID} + ${igPlacesActorId}`
              : DISCOVERY_ACTOR_ID;
  const enrichmentActor =
    providerName === "sparior" ? "sparior-profile" : getActiveEnrichmentActorId();

  console.log(
    `[ACTOR CHOICE] discoveryProvider="${activeDiscoveryMode}" discoveryActor="${discoveryActor}" enrichmentActor="${enrichmentActor}"`,
  );

  const searchTerm = buildDiscoverySearchTerm({
    query: request.query,
    category: request.category,
    location: request.location,
  });

  const shouldAppendLocation =
    activeDiscoveryMode === "instagram_search" ||
    isInstagramAllInOneMode ||
    providerName === "sparior";
  const instagramQueryPlan =
    isInstagramAllInOneMode
      ? planInstagramQueries({
          query: request.query,
          category: request.category,
          location: request.location,
          maxQueries: getIgMaxQueriesPerJob(),
          searchLimit: getIgSearchLimit(),
        })
      : null;
  if (instagramQueryPlan?.blocked) {
    throw new ScrapeInputError(
      "LOCATION_REQUIRED",
      instagramQueryPlan.blockedReason ?? "Choose at least one city before discovery.",
    );
  }
  const searchQueries =
    instagramQueryPlan !== null
      ? instagramQueryPlan.queries
      : buildPerKeywordSearchQueries({
          query: request.query,
          category: request.category,
          location: shouldAppendLocation ? request.location : undefined,
          appendLocation: shouldAppendLocation,
        });

  let job: ScrapeJob;
  try {
    job = await prisma.scrapeJob.create({
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
        enrichmentActor,
        requestedLimit: request.maxLeads,
        candidatesDiscovered: 0,
        candidatesEnriched: 0,
        candidatesSkipped: 0,
      },
    });
  } catch (createErr) {
    console.error("[DISCOVERY-SCRAPEJOB-CREATE-FAILED] Failed to create ScrapeJob:", createErr);
    throw createErr;
  }

  return {
    kind: "RUNNING",
    job,
    execute: (onProgress?: DiscoveryProgressHandler) =>
      executeDiscoveryRun({
        request,
        userId,
        campaign,
        job,
        existingLeadCount,
        remainingCapacity,
        isCurrentRunDry,
        providerName,
        activeDiscoveryMode,
        discoveryActor,
        enrichmentActor,
        searchTerm,
        searchQueries,
        onProgress,
      }),
  };
}

export async function runDiscovery(
  request: DiscoveryRequest,
  userId?: string,
  onProgress?: DiscoveryProgressHandler,
): Promise<DiscoveryRunResult> {
  const prepared = await prepareDiscoveryRun(request, userId);
  if (prepared.kind === "LIMIT_REACHED") {
    onProgress?.({
      stage: "done",
      message: prepared.result.notice ?? "",
      candidatesDiscovered: 0,
      candidatesEnriched: 0,
      persisted: 0,
      skipped: 0,
      remainingCapacity: 0,
      existingLeads: prepared.result.existingLeads ?? 0,
      skipCounts: createEmptySkipCounts(),
    });
    return prepared.result;
  }
  return prepared.execute(onProgress);
}

interface ExecuteDiscoveryRunParams {
  request: DiscoveryRequest;
  userId?: string;
  campaign: Prisma.CampaignGetPayload<{ include: { companyProfile: true } }>;
  job: ScrapeJob;
  existingLeadCount: number;
  remainingCapacity: number;
  isCurrentRunDry: boolean;
  providerName: string;
  activeDiscoveryMode: string;
  discoveryActor: string;
  enrichmentActor: string;
  searchTerm: string;
  searchQueries: string[];
  onProgress?: DiscoveryProgressHandler;
}

async function executeDiscoveryRun(params: ExecuteDiscoveryRunParams): Promise<DiscoveryRunResult> {
  const {
    request,
    userId,
    campaign,
    job,
    existingLeadCount,
    remainingCapacity,
    isCurrentRunDry,
    providerName,
    activeDiscoveryMode,
    discoveryActor,
    enrichmentActor,
    searchTerm,
    searchQueries,
    onProgress,
  } = params;
  const isInstagramAllInOneMode =
    activeDiscoveryMode === "instagram_all_in_one" && providerName !== "sparior";

  const prisma = getPrismaClient();
  const emit = (event: DiscoveryProgressEvent): void => {
    onProgress?.(event);
  };

  let totalPersisted = 0;

  try {

    const effectiveUserId = userId ?? campaign.userId;
    const existingLeads = await prisma.lead.findMany({
      where: {
        OR: [
          { campaignId: campaign.id },
          ...(effectiveUserId ? [{ campaign: { userId: effectiveUserId } }] : []),
        ],
        ...(!isCurrentRunDry ? { isDryRun: false } : { isDryRun: true }),
      },
      select: {
        id: true,
        username: true,
        usernameNormalized: true,
        gmapsPlaceId: true,
        websiteDomain: true,
        phoneNormalized: true,
      },
    });
    const existingUsernames = new Set(
      existingLeads
        .map((lead) => (lead.usernameNormalized ?? lead.username)?.toLowerCase())
        .filter((u): u is string => Boolean(u)),
    );
    const existingLeadByPlaceId = new Map<string, string>();
    const existingLeadByDomain = new Map<string, string>();
    const existingLeadByPhone = new Map<string, string>();
    for (const lead of existingLeads) {
      if (lead.gmapsPlaceId) existingLeadByPlaceId.set(lead.gmapsPlaceId, lead.id);
      if (lead.websiteDomain) existingLeadByDomain.set(lead.websiteDomain.toLowerCase(), lead.id);
      if (lead.phoneNormalized) existingLeadByPhone.set(lead.phoneNormalized, lead.id);
    }

    // Re-run protection: load candidates seen in past scrape jobs for this campaign in the last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const past30DaysSeenOrRejected = new Set<string>();
    let skippedAlreadySeenCount = 0;

    const recentJobs = await prisma.scrapeJob.findMany({
      where: {
        campaignId: campaign.id,
        createdAt: { gte: thirtyDaysAgo },
        ...(!isCurrentRunDry ? { isDryRun: false } : { isDryRun: true }),
      },
      orderBy: { createdAt: "desc" },
      select: { usage: true },
    });

    let priorNextKeywordIndex = 0;
    for (const rj of recentJobs) {
      const u = rj.usage as Record<string, unknown> | null;
      if (Array.isArray(u?.seenCandidates)) {
        for (const c of u.seenCandidates) {
          if (typeof c === "string" && c.trim().length > 0) {
            past30DaysSeenOrRejected.add(c.trim().toLowerCase());
          }
        }
      }
      if (Array.isArray(u?.rejectionLog)) {
        for (const r of u.rejectionLog) {
          if (r && typeof r === "object" && typeof (r as { username?: unknown }).username === "string") {
            const rUser = (r as { username: string }).username.trim().toLowerCase();
            if (rUser.length > 0) {
              past30DaysSeenOrRejected.add(rUser);
            }
          }
        }
      }
      if (typeof u?.nextKeywordIndex === "number" && priorNextKeywordIndex === 0) {
        priorNextKeywordIndex = u.nextKeywordIndex;
      }
    }

    for (const u of existingUsernames) {
      past30DaysSeenOrRejected.add(u);
    }

    const effectiveQueries =
      activeDiscoveryMode === "instagram_places"
        ? (searchQueries.length > 0 ? searchQueries.slice(0, 2) : [request.query])
        : (searchQueries.length > 0 ? searchQueries : [request.query]);
    logDiscovery(
      `[DISCOVERY] starting campaignId=${campaign.id} query="${request.query}" location=${request.location ?? "-"} category=${request.category ?? "-"} requestedLimit=${request.maxLeads} existingLeads=${existingLeadCount} remainingCapacity=${remainingCapacity}`,
    );

    totalPersisted = 0;
    const persistedProfiles: LeadProfile[] = [];
    const discoveredUsernamesAll: string[] = [];
    const allSeenCandidatesThisRun = new Set<string>();
    const batchPlaceIds = new Set<string>();
    const batchDomains = new Set<string>();
    const batchPhones = new Set<string>();
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
    const perQueryStatsAll: NonNullable<DiscoveryResult["perQueryStats"]> = [];
    let totalSearchResultsConsumed = 0;
    let totalLocationRejected = 0;
    let totalEstimatedCostUsd = 0;
    const currentKeywordIndex = priorNextKeywordIndex % effectiveQueries.length;
    let stopReason = "completed";
    let providerNotice: string | null = null;

    let totalGmapsPlacesFound = 0;
    let totalGmapsWithWebsite = 0;
    let totalGmapsWithInstagram = 0;
    let totalGmapsDuplicatesSkipped = 0;
    let totalPlacesReturned = 0;
    let totalPlacesWithInstagram = 0;
    let totalItemsReturnedRaw = 0;
    let totalItemsParsedAsPlaces = 0;
    let totalWithInstagramUsername = 0;
    let totalNoInstagramCount = 0;
    let totalOutOfAreaCount = 0;
    const placesByCityAll: Record<string, number> = {};
    const discoveryRunIds: string[] = [];
    const enrichmentRunIds: string[] = [];
    let totalDiscoveryCostUsd = 0;
    let totalApifyCostUsd = 0;
    let totalCoverageSkipped = 0;
    let totalOutcomeCacheSkipped = 0;
    let maxPlaceOverlapRatio = 0;
    const chargedEventsAll: Array<{ runId: string; chargedUsd: number; events: unknown }> = [];
    const areaYieldAll: Record<string, number> = {};
    const keywordYieldAll: Record<string, number> = {};
    let completedRounds = 0;
    let lastProviderError: string | undefined;

    const effectiveCriteria: EnrichmentCriteria =
      isInstagramAllInOneMode
        ? createInstagramAllInOneCriteria(request.criteria)
        : {
            ...DEFAULT_ENRICHMENT_CRITERIA,
            ...request.criteria,
            ruleModes: {
              ...DEFAULT_ENRICHMENT_CRITERIA.ruleModes,
              ...request.criteria?.ruleModes,
            },
          };

    let totalEnrichmentCostUsd = 0;
    const rejectedByCriteriaCounts: Record<string, number> = {
      minFollowers: 0,
      maxFollowers: 0,
      private: 0,
      category: 0,
      "minPosts-strict": 0,
    };
    const flaggedCounts: Record<string, number> = {
      low_activity: 0,
      no_contact_signal: 0,
    };
    let totalAiRejected = 0;
    let totalAiAccepted = 0;
    let totalCriteriaRejected = 0;

    const totalContactsExtracted = {
      email: 0,
      phone: 0,
      whatsapp: 0,
      other: 0,
    };
    let totalLeadsWithAnyContact = 0;
    const campaignCountry = resolveCountryCode(campaign.location) ?? "CA";

    const allRejections: LeadRejectionEntry[] = [];
    const gateRejectionCounts: Record<string, number> = {
      prefilter: 0,
      enrichment_criteria: 0,
      category: 0,
      negative_keyword: 0,
      intent: 0,
      location: 0,
      ai_relevance: 0,
      duplicate: 0,
      other: 0,
    };

    const maxIgRounds = process.env.DISCOVERY_MAX_INSTAGRAM_SEARCH_ROUNDS
      ? Math.max(1, Number.parseInt(process.env.DISCOVERY_MAX_INSTAGRAM_SEARCH_ROUNDS, 10))
      : 1;

    const baseMaxRounds = process.env.DISCOVERY_MAX_ROUNDS
      ? Math.max(1, Number.parseInt(process.env.DISCOVERY_MAX_ROUNDS, 10))
      : 5;

    // Scale the run/round/budget caps with the requested campaign capacity.
    // Fixed low caps (4 runs / 5 rounds / $0.30) stop a 1000-lead campaign
    // after ~60 places. Larger campaigns must be allowed to keep going until
    // the lead target, the monthly budget, or real query exhaustion stops them.
    const remainingLeadTarget = Math.max(1, remainingCapacity);
    const runsNeededForTarget = Math.ceil(remainingLeadTarget / 3) + 10;
    // Large campaigns need enough zero-result rounds to rotate through all
    // planned cities/keywords before concluding the query is exhausted.
    const zeroCandidateStopThreshold = Math.max(
      2,
      Math.min(10, Math.ceil(remainingLeadTarget / 100)),
    );
    // Zero-lead guard: small jobs stop after ~$0.10, large campaigns need more
    // runs to rotate cities/keywords before we conclude they are unproductive.
    const costPerLeadGuardUsd = Math.max(
      0.10,
      Math.min(5.00, Number((remainingLeadTarget * 0.01).toFixed(2))),
    );
    const isInstagramBudgetMode =
      activeDiscoveryMode === "instagram_places" ||
      activeDiscoveryMode === "instagram_search" ||
      isInstagramAllInOneMode;
    const targetRounds = isInstagramBudgetMode ? baseMaxRounds : runsNeededForTarget;

    const maxRounds =
      activeDiscoveryMode === "instagram_places"
        ? 1
        : isInstagramAllInOneMode
          ? 1
          : activeDiscoveryMode === "instagram_search"
            ? Math.min(baseMaxRounds, maxIgRounds)
            : Math.max(baseMaxRounds, targetRounds);

    const configuredMaxRuns = process.env.APIFY_MAX_RUNS_PER_JOB
      ? Math.max(1, Number.parseInt(process.env.APIFY_MAX_RUNS_PER_JOB, 10))
      : 4;
    const APIFY_MAX_RUNS_PER_JOB = isInstagramBudgetMode
      ? configuredMaxRuns
      : Math.max(configuredMaxRuns, runsNeededForTarget);

    const IG_PLACES_MAX_JOB_USD = process.env.IG_PLACES_MAX_JOB_USD
      ? Number.parseFloat(process.env.IG_PLACES_MAX_JOB_USD)
      : 0.15;

    const configuredJobBudgetUsd = process.env.DISCOVERY_MAX_JOB_USD
      ? Number.parseFloat(process.env.DISCOVERY_MAX_JOB_USD)
      : 0.30;
    const DISCOVERY_MAX_JOB_USD = isInstagramBudgetMode
      ? configuredJobBudgetUsd
      : Math.max(configuredJobBudgetUsd, Number((remainingLeadTarget * 0.02).toFixed(2)));

    const jobBudgetUsd = areApifyCostLimitsEnabled()
      ? activeDiscoveryMode === "instagram_places"
        ? IG_PLACES_MAX_JOB_USD
        : isInstagramAllInOneMode
          ? getDiscoveryMaxJobUsd()
          : DISCOVERY_MAX_JOB_USD
      : Number.POSITIVE_INFINITY;

    let apifyRunsCount = 0;
    const runsByActor: Record<string, number> = {};
    let wastedRunsCost = 0;

    if (
      activeDiscoveryMode === "instagram_search" ||
      activeDiscoveryMode === "hybrid" ||
      activeDiscoveryMode === "instagram_places"
    ) {
      console.warn(
        `[DISCOVERY-COST-WARNING] Active discovery mode is "${activeDiscoveryMode}". Using Apify Instagram search/places burns credits compared to Google Maps. google_maps provider is recommended.`,
      );
    }

    const configuredMaxSearchRequests = process.env.APIFY_MAX_REQUESTS_PER_RUN
      ? Math.max(1, Number.parseInt(process.env.APIFY_MAX_REQUESTS_PER_RUN, 10))
      : 5;
    const maxSearchRequests = isInstagramBudgetMode
      ? configuredMaxSearchRequests
      : Math.max(configuredMaxSearchRequests, runsNeededForTarget);

    let consecutiveZeroCandidatesRounds = 0;
    const candidateMetaByUsername = new Map<string, DiscoveredProfile>();
    const allSurvivorsToEnrich: string[] = [];
    const allMultiChannelCandidates: DiscoveredCandidate[] = [];
    let totalLeadsWithIg = 0;
    let totalLeadsNoIgButContactable = 0;
    let totalPlacesDroppedNoContact = 0;
    let totalDuplicatesPaid = 0;

    // Pipeline Stage Counters & Cost Tracking (Step 1 & Step 3)
    let stageCountPlacesIn = 0;
    let stageCountAfterFreeRules = 0;
    let stageCountAfterChainFilter = 0;
    let stageCountAfterMapsGemini = 0;
    let stageCountEnriched = 0;
    let stageCountAfterCriteria = 0;
    let stageCountAfterFinalGate = 0;
    let stageCountSaved = 0;

    let mapsGeminiCallsCount = 0;
    let finalGeminiCallsCount = 0;
    const stageRejections: Record<string, Record<string, number>> = {
      freeRules: {},
      chainFilter: {},
      mapsGemini: {},
      criteria: {},
      finalGate: {},
    };

    const relevancePolicy: DiscoveryRelevancePolicy = {
      ...DEFAULT_DISCOVERY_RELEVANCE_POLICY,
      requireLocationMatch: false,
      allowUnknownLocation: true,
      useAiRelevanceCheck:
        activeDiscoveryMode === "instagram_all_in_one" && providerName !== "sparior"
          ? process.env.DISCOVERY_USE_AI_RELEVANCE !== "false"
          : process.env.DISCOVERY_USE_AI_RELEVANCE === "true",
    };

    const prefilterCampaignContext: RelevanceCampaignContext = {
      intent: request.query,
      location: request.location,
      category: request.category,
    };

    let currentDiscoveryRuns = 0;
    const MAX_DISCOVERY_RUNS = 1000;

    for (let round = 0; round < maxRounds; round++) {
      completedRounds = round + 1;
      const remainingNeeded = remainingCapacity - totalPersisted;
      if (remainingNeeded <= 0) {
        stopReason = "completed";
        break;
      }

      // Check max Apify runs limit
      if (apifyRunsCount >= APIFY_MAX_RUNS_PER_JOB) {
        logDiscovery(
          `[DISCOVERY] Maximum Apify runs reached (${apifyRunsCount}/${APIFY_MAX_RUNS_PER_JOB}). Stopping discovery.`,
        );
        stopReason = "max_runs_per_job_reached";
        break;
      }

      if (
        currentDiscoveryRuns >= MAX_DISCOVERY_RUNS &&
        (activeDiscoveryMode === "instagram_places" ||
          activeDiscoveryMode === "instagram_search" ||
          providerName === "apify")
      ) {
        logDiscovery(
          `[DISCOVERY] Maximum discovery searches reached (${currentDiscoveryRuns}/${MAX_DISCOVERY_RUNS}). Stopping discovery searches.`,
        );
        break;
      }

      // Cost-per-lead guard: scaled with the target; stop only after the
      // zero-lead allowance is spent.
      if (totalApifyCostUsd > costPerLeadGuardUsd && totalPersisted === 0) {
        logDiscovery(
          `[DISCOVERY] Cost per lead guard triggered: totalApifyCostUsd=$${totalApifyCostUsd.toFixed(2)} with 0 leads (threshold $${costPerLeadGuardUsd.toFixed(2)}). Stopping discovery.`,
        );
        stopReason = "cost_per_lead_exceeded";
        break;
      }

      // Check per-job budget cap
      if (totalApifyCostUsd >= jobBudgetUsd) {
        logDiscovery(
          `[DISCOVERY] Job budget cap reached ($${totalApifyCostUsd.toFixed(2)} >= $${jobBudgetUsd.toFixed(2)}). Stopping discovery.`,
        );
        stopReason = "budget_cap_reached";
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
      } else if (isInstagramAllInOneMode) {
        roundQuery = effectiveQueries[0] ?? request.query;
        roundQueries = effectiveQueries;
      } else if (activeDiscoveryMode === "instagram_places") {
        roundQuery = effectiveQueries[0];
        roundQueries = [roundQuery];
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

      const currentProviderType:
        | "google_maps"
        | "instagram_search"
        | "instagram_places"
        | "instagram_all_in_one" =
        activeDiscoveryMode === "hybrid"
          ? round === 0
            ? "google_maps"
            : "instagram_places"
          : activeDiscoveryMode === "instagram_places"
            ? "instagram_places"
            : activeDiscoveryMode === "google_maps"
              ? "google_maps"
              : isInstagramAllInOneMode
                ? "instagram_all_in_one"
                : "instagram_search";

      const discovery = await getDiscoveryProvider(currentProviderType).discover({
        query: roundQuery,
        queries: roundQueries,
        limit: roundCandidateTarget,
        location: request.location,
        category: request.category,
        campaignId: campaign.id,
        userId,
        isDryRun: isCurrentRunDry,
      });

      currentDiscoveryRuns++;
      if (
        currentProviderType === "instagram_places" ||
        currentProviderType === "instagram_search" ||
        discovery.actor?.includes("apify")
      ) {
        apifyRunsCount++;
        const actorKey = discovery.actor ?? discoveryActor;
        runsByActor[actorKey] = (runsByActor[actorKey] ?? 0) + 1;
        if (discovery.isWasted) {
          wastedRunsCost += discovery.usageTotalUsd ?? 0;
        }
      }

      totalRequestsUsed += discovery.requestsUsed ?? 1;
      if (discovery.runId && !discoveryRunIds.includes(discovery.runId)) {
        discoveryRunIds.push(discovery.runId);
      }
      const discoveryActualCost = discovery.actualCostUsd ?? discovery.usageTotalUsd;
      if (discoveryActualCost) {
        totalDiscoveryCostUsd += discoveryActualCost;
        totalApifyCostUsd += discoveryActualCost;
      }
      if (discovery.chargedEvents) {
        chargedEventsAll.push(...discovery.chargedEvents);
      }
      if (discovery.coverageSkipped) totalCoverageSkipped += discovery.coverageSkipped;      if (discovery.outcomeCacheSkipped) totalOutcomeCacheSkipped += discovery.outcomeCacheSkipped;
      if (discovery.duplicatesSkipped) totalDuplicatesPaid += discovery.duplicatesSkipped;
      if (discovery.placeOverlapRatio !== undefined) {
        maxPlaceOverlapRatio = Math.max(maxPlaceOverlapRatio, discovery.placeOverlapRatio);
      }
      if (discovery.areaYield) {
        for (const [area, yieldCount] of Object.entries(discovery.areaYield)) {
          areaYieldAll[area] = (areaYieldAll[area] ?? 0) + yieldCount;
        }
      }
      if (discovery.keywordYield) {
        for (const [keyword, yieldCount] of Object.entries(discovery.keywordYield)) {
          keywordYieldAll[keyword] = (keywordYieldAll[keyword] ?? 0) + yieldCount;
        }
      }
      if (discovery.gmapsPlacesFound !== undefined) {
        totalGmapsPlacesFound += discovery.gmapsPlacesFound;
      }
      if (discovery.gmapsWithWebsite !== undefined) {
        totalGmapsWithWebsite += discovery.gmapsWithWebsite;
      }
      if (discovery.gmapsWithInstagram !== undefined) {
        totalGmapsWithInstagram += discovery.gmapsWithInstagram;
      }
      if (discovery.leadsWithIg !== undefined) {
        totalLeadsWithIg += discovery.leadsWithIg;
      }
      if (discovery.leadsNoIgButContactable !== undefined) {
        totalLeadsNoIgButContactable += discovery.leadsNoIgButContactable;
      }
      if (discovery.placesDroppedNoContact !== undefined) {
        totalPlacesDroppedNoContact += discovery.placesDroppedNoContact;
      }
      if (discovery.duplicatesSkipped !== undefined) {
        totalGmapsDuplicatesSkipped += discovery.duplicatesSkipped;
      }
      if (discovery.itemsReturnedRaw !== undefined) {
        totalItemsReturnedRaw += discovery.itemsReturnedRaw;
        totalPlacesReturned += discovery.itemsReturnedRaw;
      } else if (discovery.placesReturned !== undefined) {
        totalItemsReturnedRaw += discovery.placesReturned;
        totalPlacesReturned += discovery.placesReturned;
      } else if (discovery.gmapsPlacesFound !== undefined) {
        totalItemsReturnedRaw += discovery.gmapsPlacesFound;
        totalPlacesReturned += discovery.gmapsPlacesFound;
      }

      if (discovery.itemsParsedAsPlaces !== undefined) {
        totalItemsParsedAsPlaces += discovery.itemsParsedAsPlaces;
      } else if (discovery.placesReturned !== undefined) {
        totalItemsParsedAsPlaces += discovery.placesReturned;
      } else if (discovery.gmapsPlacesFound !== undefined) {
        totalItemsParsedAsPlaces += discovery.gmapsPlacesFound;
      }

      if (discovery.withInstagramUsername !== undefined) {
        totalWithInstagramUsername += discovery.withInstagramUsername;
        totalPlacesWithInstagram += discovery.withInstagramUsername;
      } else if (discovery.placesWithInstagram !== undefined) {
        totalWithInstagramUsername += discovery.placesWithInstagram;
        totalPlacesWithInstagram += discovery.placesWithInstagram;
      } else if (discovery.gmapsWithInstagram !== undefined) {
        totalWithInstagramUsername += discovery.gmapsWithInstagram;
        totalPlacesWithInstagram += discovery.gmapsWithInstagram;
      }
      if (discovery.noInstagramCount !== undefined) {
        totalNoInstagramCount += discovery.noInstagramCount;
      }
      if (discovery.outOfAreaCount !== undefined) {
        totalOutOfAreaCount += discovery.outOfAreaCount;
      }
      if (discovery.placesByCity) {
        for (const [c, cnt] of Object.entries(discovery.placesByCity)) {
          placesByCityAll[c] = (placesByCityAll[c] ?? 0) + cnt;
        }
      }

      if (discovery.error) {
        lastProviderError = discovery.error;
      }
      if (discovery.stopReason && discovery.stopReason !== "completed") {
        stopReason = discovery.stopReason;
      }
      if (discovery.notice) {
        providerNotice = discovery.notice;
      }

      logDiscovery(
        `[DISCOVERY] round=${round + 1} provider=${currentProviderType} run=${discovery.runId} dataset=${discovery.datasetId ?? "-"} actor=${discovery.actor} cost=${discovery.usageTotalUsd ?? 0}`,
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
      if (discovery.perQueryStats) {
        for (const stat of discovery.perQueryStats) {
          perQueryStatsAll.push({ ...stat });
        }
      }
      totalSearchResultsConsumed += discovery.searchResultsConsumed ?? 0;
      totalLocationRejected += discovery.locationRejectedCount ?? 0;
      totalEstimatedCostUsd += discovery.estimatedCostUsd ?? 0;

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

      stageCountPlacesIn += discovery.candidates.length;

      // -------------------------------------------------------------
      // STAGE 1: Free rules on Maps data (Step 1.1)
      // -------------------------------------------------------------
      const stage1Survivors: DiscoveredCandidate[] = [];
      let roundPreFilterRejected = 0;

      for (const candidate of discovery.candidates) {
        // 1. Closed places
        if (candidate.permanentlyClosed || candidate.temporarilyClosed) {
          stageRejections.freeRules.CLOSED_BUSINESS =
            (stageRejections.freeRules.CLOSED_BUSINESS ?? 0) + 1;
          gateRejectionCounts.prefilter = (gateRejectionCounts.prefilter ?? 0) + 1;
          allRejections.push({
            username: candidate.username?.toLowerCase() ?? "",
            gate: "prefilter",
            reason: "PRE_ENRICHMENT_REJECTED",
            matchedTerm: "permanentlyClosed/temporarilyClosed",
          });
          continue;
        }

        // 2. Min rating (configurable per campaign)
        if (
          campaign.minRating !== null &&
          campaign.minRating !== undefined &&
          candidate.rating !== null &&
          candidate.rating !== undefined &&
          candidate.rating < campaign.minRating
        ) {
          stageRejections.freeRules.LOW_RATING =
            (stageRejections.freeRules.LOW_RATING ?? 0) + 1;
          gateRejectionCounts.prefilter = (gateRejectionCounts.prefilter ?? 0) + 1;
          allRejections.push({
            username: candidate.username?.toLowerCase() ?? "",
            gate: "prefilter",
            reason: "PRE_ENRICHMENT_REJECTED",
            matchedTerm: `Rating ${candidate.rating} < min ${campaign.minRating}`,
          });
          continue;
        }

        // 3. Min reviews (configurable per campaign)
        if (
          campaign.minReviews !== null &&
          campaign.minReviews !== undefined &&
          candidate.reviewCount !== null &&
          candidate.reviewCount !== undefined &&
          candidate.reviewCount < campaign.minReviews
        ) {
          stageRejections.freeRules.LOW_REVIEWS =
            (stageRejections.freeRules.LOW_REVIEWS ?? 0) + 1;
          gateRejectionCounts.prefilter = (gateRejectionCounts.prefilter ?? 0) + 1;
          allRejections.push({
            username: candidate.username?.toLowerCase() ?? "",
            gate: "prefilter",
            reason: "PRE_ENRICHMENT_REJECTED",
            matchedTerm: `Reviews ${candidate.reviewCount} < min ${campaign.minReviews}`,
          });
          continue;
        }

        // 4. Dedup FIRST, before any website fetch/Gemini/enrichment.
        const placeId = candidate.gmapsPlaceId ?? null;
        if (placeId && (existingLeadByPlaceId.has(placeId) || batchPlaceIds.has(placeId))) {
          totalExistingSkipped++;
          dedupByKeyCounts.gmapsPlaceId = (dedupByKeyCounts.gmapsPlaceId ?? 0) + 1;
          continue;
        }
        let candidateDomain: string | null = null;
        if (candidate.website) {
          try {
            const host = new URL(
              /^https?:\/\//i.test(candidate.website)
                ? candidate.website
                : `https://${candidate.website}`,
            ).hostname.toLowerCase();
            candidateDomain = host.replace(/^www\./, "");
          } catch {
            candidateDomain = null;
          }
        }
        if (
          candidateDomain &&
          (existingLeadByDomain.has(candidateDomain) || batchDomains.has(candidateDomain))
        ) {
          totalExistingSkipped++;
          dedupByKeyCounts.websiteDomain = (dedupByKeyCounts.websiteDomain ?? 0) + 1;
          continue;
        }
        const phoneDigits = candidate.phone?.replace(/\D/g, "") ?? "";
        const candidatePhone = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : null;
        if (
          candidatePhone &&
          (existingLeadByPhone.has(candidatePhone) || batchPhones.has(candidatePhone))
        ) {
          totalExistingSkipped++;
          dedupByKeyCounts.phone = (dedupByKeyCounts.phone ?? 0) + 1;
          continue;
        }

        // 5. Duplicate check on handle
        if (candidate.username) {
          const normalized = normalizeInstagramUsername(candidate.username);
          if (!normalized || past30DaysSeenOrRejected.has(normalized) || existingUsernames.has(normalized)) {
            skippedAlreadySeenCount++;
            totalExistingSkipped++;
            finalSkipCounts.DUPLICATE = (finalSkipCounts.DUPLICATE ?? 0) + 1;
            dedupByKeyCounts.username = (dedupByKeyCounts.username ?? 0) + 1;
            continue;
          }
        }

        if (placeId) batchPlaceIds.add(placeId);
        if (candidateDomain) batchDomains.add(candidateDomain);
        if (candidatePhone) batchPhones.add(candidatePhone);

        // 5. Negative keywords & category prefilter
        const preResult = prefilterCandidate(
          candidate,
          prefilterCampaignContext,
          relevancePolicy,
        );
        if (preResult.action === "REJECT") {
          roundPreFilterRejected++;
          const reasonKey = preResult.underlyingReason ?? preResult.reason;
          stageRejections.freeRules[reasonKey] =
            (stageRejections.freeRules[reasonKey] ?? 0) + 1;
          gateRejectionCounts.prefilter = (gateRejectionCounts.prefilter ?? 0) + 1;
          finalSkipCounts.PRE_ENRICHMENT_REJECTED =
            (finalSkipCounts.PRE_ENRICHMENT_REJECTED ?? 0) + 1;
          allRejections.push({
            username: candidate.username?.toLowerCase() ?? "",
            gate: "prefilter",
            reason: reasonKey,
            matchedTerm: preResult.detail,
          });
          continue;
        }

        stage1Survivors.push(candidate);
      }
      stageCountAfterFreeRules += stage1Survivors.length;

      // -------------------------------------------------------------
      // STAGE 2: Chain / Franchise / National-Account Detection (Step 1.2)
      // -------------------------------------------------------------
      const chainResults = detectChains(stage1Survivors);
      const stage2Survivors: DiscoveredCandidate[] = [];

      for (const candidate of stage1Survivors) {
        const chainRes = chainResults.get(candidate);
        candidate.isChain = chainRes?.isChain ?? false;

        if (campaign.excludeChains !== false && candidate.isChain) {
          stageRejections.chainFilter.CHAIN_EXCLUDED =
            (stageRejections.chainFilter.CHAIN_EXCLUDED ?? 0) + 1;
          gateRejectionCounts.prefilter = (gateRejectionCounts.prefilter ?? 0) + 1;
          allRejections.push({
            username: candidate.username?.toLowerCase() ?? "",
            gate: "prefilter",
            reason: "PRE_ENRICHMENT_REJECTED",
            matchedTerm: chainRes?.reason ?? "Corporate chain / franchise",
          });
          continue;
        }

        stage2Survivors.push(candidate);
      }
      stageCountAfterChainFilter += stage2Survivors.length;

      // -------------------------------------------------------------
      // STAGE 3: Gemini Relevance Gate on MAPS DATA ONLY (Step 1.3)
      // -------------------------------------------------------------
      const stage3Survivors: DiscoveredCandidate[] = [];
      const stage2WithHandle = stage2Survivors.filter((c) => Boolean(c.username));
      const stage2NoHandle = stage2Survivors.filter((c) => !c.username);

      // Contact-only places never get a paid Gemini call; their free rules
      // already decided eligibility and they carry only Maps/website data.
      stage3Survivors.push(...stage2NoHandle);

      if (relevancePolicy.useAiRelevanceCheck && stage2WithHandle.length > 0) {
        for (const candidate of stage2WithHandle) {
          mapsGeminiCallsCount++;
          const aiCheck = await evaluateMapsCandidateRelevanceWithAI(
            {
              businessName: candidate.fullName,
              category: candidate.gmapsCategory ?? candidate.category,
              categories: candidate.gmapsCategories ?? (candidate.category ? [candidate.category] : []),
              address: candidate.gmapsAddress ?? candidate.location,
              city: candidate.city ?? candidate.gmapsCity,
              rating: candidate.rating ?? candidate.gmapsRating,
              reviewCount: candidate.reviewCount ?? candidate.gmapsReviews,
              website: candidate.website ?? candidate.externalUrl,
              biography: candidate.biography,
              followersCount: candidate.followersCount ?? candidate.followers,
              postsCount: candidate.postsCount,
              lastPostAt: candidate.lastPostAt,
              sourceProvider: candidate.sourceProvider,
            },
            prefilterCampaignContext,
            {
              userId,
              campaignId: campaign.id,
              threshold: relevancePolicy.aiRelevanceThreshold ?? 70,
              company: campaign.companyProfile
                ? {
                    description: campaign.companyProfile.description,
                    targetIndustries: parseCompanyTargetIndustries(campaign.companyProfile.targetIndustries),
                  }
                : null,
            },
          );

          if (!aiCheck.relevant) {
            const reasonKey = aiCheck.reason || "MAPS_AI_REJECTED";
            stageRejections.mapsGemini[reasonKey] =
              (stageRejections.mapsGemini[reasonKey] ?? 0) + 1;
            gateRejectionCounts.ai_relevance = (gateRejectionCounts.ai_relevance ?? 0) + 1;
            allRejections.push({
              username: candidate.username?.toLowerCase() ?? "",
              gate: "ai_relevance",
              reason: "IRRELEVANT_INTENT",
              matchedTerm: aiCheck.reason,
            });
            continue;
          }

          stage3Survivors.push(candidate);
        }
      } else {
        stage3Survivors.push(...stage2WithHandle);
      }
      stageCountAfterMapsGemini += stage3Survivors.length;

      // -------------------------------------------------------------
      // ROUTING SURVIVORS: Handle vs Multi-Channel
      // -------------------------------------------------------------
      const roundUsernames: string[] = [];
      const candidatesToEnrichThisRound: string[] = [];

      for (const candidate of stage3Survivors) {
        if (
          isInstagramAllInOneMode &&
          candidate.locationVerification === "unverified" &&
          !relevancePolicy.useAiRelevanceCheck
        ) {
          stageRejections.freeRules.LOCATION_UNVERIFIED =
            (stageRejections.freeRules.LOCATION_UNVERIFIED ?? 0) + 1;
          gateRejectionCounts.location = (gateRejectionCounts.location ?? 0) + 1;
          allRejections.push({
            username: candidate.username?.toLowerCase() ?? "",
            gate: "location",
            reason: "LOCATION_UNVERIFIED",
            matchedTerm: "Unverified location with no Gemini pre-gate",
          });
          continue;
        }
        if (!candidate.username) {
          const hasAnyChannel =
            (candidate.availableChannels && candidate.availableChannels.length > 0) ||
            Boolean(candidate.email || candidate.phone || candidate.website);
          if (hasAnyChannel) {
            const alreadyInMulti = allMultiChannelCandidates.some((c) =>
              (candidate.gmapsPlaceId && c.gmapsPlaceId === candidate.gmapsPlaceId) ||
              (candidate.website && c.website === candidate.website) ||
              (candidate.phone && c.phone === candidate.phone),
            );
            if (!alreadyInMulti) {
              allMultiChannelCandidates.push(candidate);
            }
          }
          continue;
        }

        const handleConfidence = candidate.handleConfidence ?? "high";
        const lowConfidenceMismatch =
          candidate.nameWebsiteMismatch === true && handleConfidence === "low";
        if (handleConfidence === "low" || lowConfidenceMismatch) {
          // Low-confidence handles wait for manual selection; never call the
          // paid profile scraper for them.
          const hasAnyChannel =
            (candidate.availableChannels && candidate.availableChannels.length > 0) ||
            Boolean(candidate.email || candidate.phone || candidate.website);
          if (hasAnyChannel) {
            const alreadyInMulti = allMultiChannelCandidates.some(
              (c) => candidate.gmapsPlaceId && c.gmapsPlaceId === candidate.gmapsPlaceId,
            );
            if (!alreadyInMulti) allMultiChannelCandidates.push(candidate);
          }
          continue;
        }

        const normalized = normalizeInstagramUsername(candidate.username);
        if (normalized) {
          if (!roundUsernames.includes(normalized)) {
            roundUsernames.push(normalized);
            candidateMetaByUsername.set(normalized, candidate);
            if (!discoveredUsernamesAll.includes(normalized)) {
              discoveredUsernamesAll.push(normalized);
            }
            allSeenCandidatesThisRun.add(normalized);
            existingUsernames.add(normalized);
            candidatesToEnrichThisRound.push(normalized);
            allSurvivorsToEnrich.push(normalized);
          }
        }
      }

      const newCandidates = candidatesToEnrichThisRound;

      // Stop rule: if 2 consecutive rounds yield 0 new candidates, stop
      if (newCandidates.length === 0 && stage3Survivors.length === 0) {
        consecutiveZeroCandidatesRounds++;
      } else {
        consecutiveZeroCandidatesRounds = 0;
      }

      if (consecutiveZeroCandidatesRounds >= zeroCandidateStopThreshold) {
        logDiscovery(
          `[DISCOVERY] ${zeroCandidateStopThreshold} consecutive rounds yielded 0 new candidates. Stopping discovery.`,
        );
        stopReason = "all_keywords_exhausted";
        break;
      }

      if (roundPreFilterRejected > 0) {
        finalSkipCounts.PRE_ENRICHMENT_REJECTED =
          (finalSkipCounts.PRE_ENRICHMENT_REJECTED ?? 0) + roundPreFilterRejected;
      }

      emit({
        stage: "discovered",
        message: `Candidates found: ${discoveredUsernamesAll.length} (${newCandidates.length} new, ${candidatesToEnrichThisRound.length} passed pre-filter)`,
        candidatesDiscovered: discoveredUsernamesAll.length,
        candidatesEnriched: totalEnrichedCount,
        persisted: totalPersisted,
        skipped: sumSkipCounts(finalSkipCounts),
        remainingCapacity: remainingCapacity - totalPersisted,
        existingLeads: existingLeadCount,
        skipCounts: { ...finalSkipCounts },
      });

      // Early stop on low yield: after first discovery search, if contactable yield < threshold (Apify discovery providers only)
      const minYieldThreshold = process.env.DISCOVERY_MIN_YIELD_THRESHOLD
        ? Number.parseFloat(process.env.DISCOVERY_MIN_YIELD_THRESHOLD)
        : 0.20;

      if (
        areApifyCostLimitsEnabled() &&
        round === 0 &&
        providerName !== "sparior"
      ) {
        const rawCount = totalItemsReturnedRaw;
        const withIgCount = totalWithInstagramUsername;
        const contactableCount =
          (discovery.leadsWithIg ?? withIgCount) +
          (discovery.leadsNoIgButContactable ?? allMultiChannelCandidates.length);
        const contactableYield = rawCount > 0 ? contactableCount / rawCount : 0;
        if (
          rawCount > 0 &&
          (contactableCount < 3 || contactableYield < minYieldThreshold)
        ) {
          logDiscovery(
            `[DISCOVERY] Low contactable yield early stop: raw=${rawCount}, contactable=${contactableCount} (withIg=${withIgCount}, multiChannel=${allMultiChannelCandidates.length}), yield=${(contactableYield * 100).toFixed(1)}% < ${(minYieldThreshold * 100).toFixed(1)}%. Stopping further discovery rounds.`,
          );
          stopReason = "low_yield_early_stop";
          break;
        }
      }

      // Check cost-per-lead guard only when spend limits are enabled.
      if (
        areApifyCostLimitsEnabled() &&
        totalApifyCostUsd > costPerLeadGuardUsd &&
        totalPersisted === 0
      ) {
        logDiscovery(
          `[DISCOVERY] Cost per lead guard: cost=$${totalApifyCostUsd.toFixed(2)} with 0 leads (threshold $${costPerLeadGuardUsd.toFixed(2)}). Stopping discovery.`,
        );
        stopReason = "cost_per_lead_exceeded";
        break;
      }

      // Check if we already have plenty of survivors to satisfy remainingNeeded
      if (allSurvivorsToEnrich.length >= remainingNeeded * 2) {
        break;
      }

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
          // Preserve provider-specific blocking reasons (budget, country/city
          // requirements, low yield, etc.) instead of misreporting them as
          // "all keywords exhausted".
          if (!stopReason || stopReason === "completed") {
            stopReason = "all_keywords_exhausted";
          }
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
          if (!stopReason || stopReason === "completed") {
            stopReason = "all_keywords_exhausted";
          }
          break;
        }
      }
    }

    // -------------------------------------------------------------
    // ENRICHMENT STAGE: Exactly ONE batch for survivors (max 20)
    // -------------------------------------------------------------
    const currentRemainingNeeded = remainingCapacity - totalPersisted;
    const canEnrich =
      stopReason !== "cancelled" &&
      currentRemainingNeeded > 0 &&
      allSurvivorsToEnrich.length > 0;

    const passedAiProfiles: LeadProfile[] = [];

    if (canEnrich && totalApifyCostUsd > costPerLeadGuardUsd && totalPersisted === 0) {
      stopReason = "cost_per_lead_exceeded";
    } else if (canEnrich && apifyRunsCount >= APIFY_MAX_RUNS_PER_JOB) {
      stopReason = "max_runs_per_job_reached";
    } else if (canEnrich && totalApifyCostUsd >= jobBudgetUsd) {
      stopReason = "budget_cap_reached";
    } else if (canEnrich) {
      const batchCap = Math.max(1, Math.min(currentRemainingNeeded * 2, 20));
      const survivorBatch = Array.from(new Set(allSurvivorsToEnrich)).slice(0, batchCap);

      const cachedProfilesMap = new Map<string, LeadProfile>();
      try {
        const cachedLeads = await prisma.lead.findMany({
          where: {
            usernameNormalized: { in: survivorBatch.map((u) => u.toLowerCase()) },
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
      } catch (cacheErr) {
        logDiscovery(`[DISCOVERY] Cache lookup warning: ${String(cacheErr)}`);
      }

      const uncachedUsernames: string[] = [];
      const enrichedProfiles: LeadProfile[] = [];

      for (const username of survivorBatch) {
        const cached = cachedProfilesMap.get(username.toLowerCase());
        if (cached) {
          logDiscovery(`[DISCOVERY] Enrichment cache HIT for @${username}. Skipping Apify profile scrape.`);
          enrichedProfiles.push(cached);
        } else {
          uncachedUsernames.push(username);
        }
      }

      if (uncachedUsernames.length > 0) {
        if (apifyRunsCount >= APIFY_MAX_RUNS_PER_JOB) {
          logDiscovery(
            `[DISCOVERY] Cannot run enrichment: maximum Apify runs reached (${apifyRunsCount}/${APIFY_MAX_RUNS_PER_JOB}).`,
          );
          stopReason = "max_runs_per_job_reached";
        } else if (totalApifyCostUsd >= jobBudgetUsd) {
          logDiscovery(
            `[DISCOVERY] Cannot run enrichment: job budget cap reached ($${totalApifyCostUsd.toFixed(2)}).`,
          );
          stopReason = "budget_cap_reached";
        } else {
          emit({
            stage: "enrich",
            message: `Enriching ${uncachedUsernames.length} profiles via Instagram Profile Scraper...`,
            candidatesDiscovered: discoveredUsernamesAll.length,
            candidatesEnriched: totalEnrichedCount,
            persisted: totalPersisted,
            skipped: sumSkipCounts(finalSkipCounts),
            remainingCapacity: currentRemainingNeeded,
            existingLeads: existingLeadCount,
            skipCounts: { ...finalSkipCounts },
          });

          apifyRunsCount++;
          runsByActor[enrichmentActor] = (runsByActor[enrichmentActor] ?? 0) + 1;

          const enrichment = await scrapeInstagramProfiles(
            uncachedUsernames,
            uncachedUsernames.length,
            {
              campaignId: campaign.id,
              userId,
            },
          );

          if (enrichment.isWasted) {
            wastedRunsCost += enrichment.usageTotalUsd ?? 0;
          }

          if (enrichment.runId && !enrichmentRunIds.includes(enrichment.runId)) {
            enrichmentRunIds.push(enrichment.runId);
          }
          if (enrichment.usageTotalUsd) {
            totalEnrichmentCostUsd += enrichment.usageTotalUsd;
            totalApifyCostUsd += enrichment.usageTotalUsd;
          }

          enrichedProfiles.push(...enrichment.profiles);
          totalEnrichmentFailures += enrichment.skipped.length;
          finalSkipCounts.ENRICHMENT_FAILED =
            (finalSkipCounts.ENRICHMENT_FAILED ?? 0) + enrichment.skipped.length;
        }
      }

      totalEnrichedCount += enrichedProfiles.length;
      stageCountEnriched += enrichedProfiles.length;

      // Merge Maps metadata onto enriched profiles
      for (const profile of enrichedProfiles) {
        const meta = profile.username ? candidateMetaByUsername.get(profile.username.toLowerCase()) : undefined;
        if (meta) {
          if (!profile.location && (meta.gmapsCity || meta.gmapsAddress || meta.location)) {
            profile.location = meta.gmapsCity || meta.gmapsAddress || meta.location || null;
          }
          const alternateContact: Record<string, string> = {};
          if (meta.phone) {
            if (profile.phone && profile.phone !== meta.phone) alternateContact.alternatePhone = profile.phone;
            profile.phone = meta.phone;
          }
          if (meta.website) {
            if (profile.website && profile.website !== meta.website) alternateContact.alternateWebsite = profile.website;
            profile.website = meta.website;
          }
          if (meta.email) {
            if (profile.email && profile.email !== meta.email) alternateContact.alternateEmail = profile.email;
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
          profile.isGroup = meta.isGroup ?? false;
          profile.groupKey = meta.groupKey ?? null;
          if (meta.flags && meta.flags.length > 0) {
            profile.scoreFlags = Array.from(new Set([...(profile.scoreFlags ?? []), ...meta.flags]));
          }
          profile.city = meta.city ?? meta.gmapsCity ?? null;
          profile.rating = meta.rating ?? meta.gmapsRating ?? null;
          profile.reviewCount = meta.reviewCount ?? meta.gmapsReviews ?? null;
          profile.isChain = meta.isChain ?? false;
          profile.isClaimed = meta.isClaimed ?? null;
          profile.permanentlyClosed = meta.permanentlyClosed ?? null;
          profile.temporarilyClosed = meta.temporarilyClosed ?? null;
          profile.sourceProvider = meta.sourceProvider ?? profile.sourceProvider ?? "google_maps";
          if (meta.sourceProvider === "instagram_scraper") {
            profile.source = "instagram_scraper";
            profile.handleSource = profile.handleSource ?? "instagram_search";
            profile.handleConfidence = meta.handleConfidence ?? "high";
            profile.postsCount = profile.postsCount ?? meta.postsCount ?? null;
            profile.lastPostAt =
              profile.lastPostAt ??
              meta.lastPostAt ??
              null;
          }

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
            ...alternateContact,
            sourceProvider: meta.sourceProvider ?? profile.sourceProvider ?? "google_maps",
            isChain: meta.isChain ?? false,
            isClaimed: meta.isClaimed ?? null,
          };
        }
      }

      // -------------------------------------------------------------
      // STAGE 5: Profile criteria + recency check
      // -------------------------------------------------------------
      const passedCriteriaProfiles: LeadProfile[] = [];
      for (const profile of enrichedProfiles) {
        const criteriaEval = evaluateEnrichmentCriteria(
          profile,
          effectiveCriteria,
          prefilterCampaignContext,
        );

        for (const flag of criteriaEval.flags) {
          const flagKey = flag.message ?? flag.rule;
          flaggedCounts[flagKey] = (flaggedCounts[flagKey] ?? 0) + 1;
        }

        if (!criteriaEval.passed) {
          totalCriteriaRejected++;
          gateRejectionCounts.enrichment_criteria =
            (gateRejectionCounts.enrichment_criteria ?? 0) + 1;
          finalSkipCounts.PRE_ENRICHMENT_REJECTED =
            (finalSkipCounts.PRE_ENRICHMENT_REJECTED ?? 0) + 1;
          for (const reason of criteriaEval.reasons) {
            const ruleKey =
              reason.rule === "minPosts-strict"
                ? "minPosts-strict"
                : reason.rule === "private" || reason.rule === "excludePrivate"
                  ? "private"
                  : reason.rule === "category" || reason.rule === "allowedCategories"
                    ? "category"
                    : reason.rule;
            rejectedByCriteriaCounts[ruleKey] =
              (rejectedByCriteriaCounts[ruleKey] ?? 0) + 1;
            stageRejections.criteria[ruleKey] =
              (stageRejections.criteria[ruleKey] ?? 0) + 1;
            allRejections.push({
              username: profile.username?.toLowerCase() ?? "",
              gate: "enrichment_criteria",
              reason: "ENRICHMENT_CRITERIA_REJECTED",
              matchedTerm: `${reason.rule}: value=${String(reason.value)}, required=${String(reason.required)}`,
            });
          }
          logDiscovery(
            `[DISCOVERY] criteria gate reject: @${profile.username ?? "unknown"} reasons=${criteriaEval.reasons.map((r) => r.rule).join(", ")}`,
          );
          continue;
        }
        passedCriteriaProfiles.push(profile);
      }
      stageCountAfterCriteria = passedCriteriaProfiles.length;

      // Deterministic relevance gates (bio keywords, location, intent)
      const passedDeterministicProfiles: LeadProfile[] = [];
      for (const profile of passedCriteriaProfiles) {
        const evaluation = evaluateProfileRelevance(
          profile,
          prefilterCampaignContext,
          relevancePolicy,
        );
        const decision = decideRelevance(evaluation, relevancePolicy);
        if (!decision.relevant) {
          finalSkipCounts[decision.reason] =
            (finalSkipCounts[decision.reason] ?? 0) + 1;
          const gate: RelevanceGate =
            decision.gate ??
            (decision.reason === "IRRELEVANT_CATEGORY"
              ? "category"
              : decision.reason === "IRRELEVANT_LOCATION"
                ? "location"
                : "intent");
          gateRejectionCounts[gate] = (gateRejectionCounts[gate] ?? 0) + 1;
          stageRejections.criteria[decision.reason] =
            (stageRejections.criteria[decision.reason] ?? 0) + 1;
          allRejections.push({
            username: profile.username?.toLowerCase() ?? "",
            gate,
            reason: decision.reason,
            matchedTerm: decision.matchedTerm,
          });
          continue;
        }
        passedDeterministicProfiles.push(profile);
      }

      // -------------------------------------------------------------
      // STAGE 6: Quality Score & Gemini Gate (only for borderline band)
      // -------------------------------------------------------------
      const borderlineMinScore = Number(process.env.GEMINI_BORDERLINE_MIN_SCORE ?? 30);
      const borderlineMaxScore = Number(process.env.GEMINI_BORDERLINE_MAX_SCORE ?? 79);

      for (const profile of passedDeterministicProfiles) {
        const candidateMeta = profile.username
          ? candidateMetaByUsername.get(profile.username.toLowerCase())
          : undefined;

        const scoreInput = {
          rating: profile.rating ?? profile.gmapsRating ?? candidateMeta?.rating,
          reviewCount: profile.reviewCount ?? profile.gmapsReviews ?? candidateMeta?.reviewCount,
          website: profile.website ?? profile.externalUrl ?? candidateMeta?.website,
          phone: profile.phone ?? candidateMeta?.phone,
          isClaimed: profile.isClaimed ?? candidateMeta?.isClaimed,
          isChain: profile.isChain ?? candidateMeta?.isChain,
          hasInstagram: true,
          lastPostAt: profile.lastPostAt ?? (profile.rawProfileData as Record<string, unknown> | null)?.lastPostAt as (string | Date | null | undefined),
          postsCount: profile.postsCount,
          followers: profile.followers,
          isBusinessAccount: profile.isBusiness,
          isPrivate: profile.isPrivate,
          email: profile.email ?? candidateMeta?.email,
          availableChannels: profile.availableChannels ?? candidateMeta?.availableChannels,
          hasWhatsApp: Boolean(
            profile.availableChannels?.includes("whatsapp") ||
            (candidateMeta?.socialLinks as Record<string, unknown> | null)?.whatsapp
          ),
          handleConfidence: (profile.handleConfidence ?? candidateMeta?.handleConfidence) as "high" | "medium" | "low" | null | undefined,
          handleSource: profile.handleSource ?? candidateMeta?.handleSource,
          websiteMismatch: Boolean(candidateMeta?.nameWebsiteMismatch || candidateMeta?.flags?.includes("NAME_WEBSITE_MISMATCH")),
        };

        const qualityScoreResult = computeLeadScore(scoreInput);

        // 1. Clear fail (< borderlineMinScore): reject without calling Gemini
        if (qualityScoreResult.score < borderlineMinScore) {
          stageRejections.finalGate.LOW_QUALITY_SCORE =
            (stageRejections.finalGate.LOW_QUALITY_SCORE ?? 0) + 1;
          gateRejectionCounts.enrichment_criteria =
            (gateRejectionCounts.enrichment_criteria ?? 0) + 1;
          finalSkipCounts.PRE_ENRICHMENT_REJECTED =
            (finalSkipCounts.PRE_ENRICHMENT_REJECTED ?? 0) + 1;
          allRejections.push({
            username: profile.username?.toLowerCase() ?? "",
            gate: "enrichment_criteria",
            reason: "PRE_ENRICHMENT_REJECTED",
            matchedTerm: `Score ${qualityScoreResult.score} < ${borderlineMinScore} (Tier ${qualityScoreResult.tier})`,
          });
          logDiscovery(
            `[DISCOVERY] Final gate clear-fail skip: @${profile.username ?? "unknown"} score=${qualityScoreResult.score} < ${borderlineMinScore}. Skipping Gemini.`,
          );
          continue;
        }

        const isHighConfidenceHandle =
          (profile.handleConfidence ?? candidateMeta?.handleConfidence) === "high";

        // 2. Clear pass (score > borderlineMaxScore with high-confidence handle): skip Gemini gate
        if (qualityScoreResult.score > borderlineMaxScore && isHighConfidenceHandle) {
          logDiscovery(
            `[DISCOVERY] Final gate clear-pass skip: @${profile.username ?? "unknown"} score=${qualityScoreResult.score} > ${borderlineMaxScore} with high-confidence handle. Skipping Gemini.`,
          );
          profile.qualityScore = qualityScoreResult.score;
          profile.qualityTier = qualityScoreResult.tier;
          profile.scoreBreakdown = qualityScoreResult.breakdown;
          profile.scoreFlags = qualityScoreResult.flags;
          profile.isChain = qualityScoreResult.isChain;
          profile.lastPostAt =
            profile.lastPostAt ??
            (scoreInput.lastPostAt ? new Date(scoreInput.lastPostAt).toISOString() : null);
          passedAiProfiles.push(profile);
          continue;
        }

        // 3. Borderline band (30-79) or lower confidence handle: run Gemini gate if enabled
        if (relevancePolicy.useAiRelevanceCheck) {
          finalGeminiCallsCount++;
          const baseThreshold = relevancePolicy.aiRelevanceThreshold ?? 70;
          const handleConfidence =
            profile.handleConfidence ?? candidateMeta?.handleConfidence;
          // Stricter threshold (+10) for low-confidence handle discovery
          const effectiveThreshold =
            handleConfidence === "low"
              ? Math.min(100, baseThreshold + 10)
              : baseThreshold;

          const aiCheck = await evaluateProfileRelevanceWithAI(
            profile,
            prefilterCampaignContext,
            {
              userId,
              campaignId: campaign.id,
              threshold: effectiveThreshold,
              company: campaign.companyProfile
                ? {
                    description: campaign.companyProfile.description,
                    targetIndustries: parseCompanyTargetIndustries(campaign.companyProfile.targetIndustries),
                  }
                : null,
            },
          );

          if (!aiCheck.relevant) {
            totalAiRejected++;
            const skipReason: DiscoverySkipReason =
              aiCheck.reason === "AI_UNAVAILABLE" ? "AI_UNAVAILABLE" : "IRRELEVANT_INTENT";
            finalSkipCounts[skipReason] = (finalSkipCounts[skipReason] ?? 0) + 1;
            gateRejectionCounts.ai_relevance =
              (gateRejectionCounts.ai_relevance ?? 0) + 1;
            const reasonKey = aiCheck.reason || "AI_REJECTED";
            stageRejections.finalGate[reasonKey] =
              (stageRejections.finalGate[reasonKey] ?? 0) + 1;
            allRejections.push({
              username: profile.username?.toLowerCase() ?? "",
              gate: "ai_relevance",
              reason: skipReason,
              matchedTerm: aiCheck.reason,
              aiScore: aiCheck.score,
            });
            logDiscovery(
              `[DISCOVERY] AI analytics gate rejected @${profile.username ?? "unknown"}: score=${aiCheck.score}, type=${aiCheck.accountType}, reason=${aiCheck.reason}`,
            );
            continue;
          }

          totalAiAccepted++;
          profile.rawProfileData = {
            ...(typeof profile.rawProfileData === "object" && profile.rawProfileData !== null
              ? profile.rawProfileData
              : {}),
            aiAnalysis: aiCheck,
          };
          profile.aiAnalysis = aiCheck.analytics;
          profile.leadScore = aiCheck.score;
          profile.aiScore = aiCheck.score;
        }

        profile.qualityScore = qualityScoreResult.score;
        profile.qualityTier = qualityScoreResult.tier;
        profile.scoreBreakdown = qualityScoreResult.breakdown;
        profile.scoreFlags = qualityScoreResult.flags;
        profile.isChain = qualityScoreResult.isChain;
        profile.lastPostAt =
          profile.lastPostAt ??
          (scoreInput.lastPostAt ? new Date(scoreInput.lastPostAt).toISOString() : null);
        passedAiProfiles.push(profile);
      }
    }

    // -------------------------------------------------------------
    // PERSISTENCE STAGE: Instagram survivors + Multi-channel leads
    // -------------------------------------------------------------
    if (stopReason !== "cancelled") {
      const borderlineMinScore = Number(process.env.GEMINI_BORDERLINE_MIN_SCORE ?? 30);
      const multiChannelProfiles: LeadProfile[] = [];

      for (const c of allMultiChannelCandidates) {
        const scoreInput = {
          rating: c.rating ?? c.gmapsRating,
          reviewCount: c.reviewCount ?? c.gmapsReviews,
          website: c.website,
          phone: c.phone,
          isClaimed: c.isClaimed,
          isChain: c.isChain,
          hasInstagram: false,
          email: c.email,
          availableChannels:
            c.availableChannels && c.availableChannels.length > 0
              ? c.availableChannels
              : computeAvailableChannels({
                  hasInstagram: false,
                  email: c.email,
                  phone: c.phone,
                  whatsapp: c.socialLinks?.whatsapp ?? c.phone,
                  website: c.website,
                }),
          hasWhatsApp: Boolean(c.socialLinks?.whatsapp),
          handleConfidence: c.handleConfidence,
          handleSource: c.handleSource,
          isInstagramCampaign: true,
          websiteMismatch: Boolean(c.nameWebsiteMismatch || c.flags?.includes("NAME_WEBSITE_MISMATCH")),
        };

        const qualityScoreResult = computeLeadScore(scoreInput);

        // Auto-reject clear fails / tier D
        if (qualityScoreResult.score < borderlineMinScore || qualityScoreResult.tier === "D") {
          stageRejections.finalGate.LOW_QUALITY_SCORE =
            (stageRejections.finalGate.LOW_QUALITY_SCORE ?? 0) + 1;
          finalSkipCounts.PRE_ENRICHMENT_REJECTED =
            (finalSkipCounts.PRE_ENRICHMENT_REJECTED ?? 0) + 1;
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
          isGroup: c.isGroup ?? false,
          groupKey: c.groupKey ?? null,
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
          rawProfileData: c.socialLinks ? { socialLinks: c.socialLinks } : null,
        });
      }

      stageCountAfterFinalGate = passedAiProfiles.length + multiChannelProfiles.length;
      const allCandidateProfiles = [...passedAiProfiles, ...multiChannelProfiles];

      if (allCandidateProfiles.length > 0) {
        // DNC check covering email, phone, website, and instagram
        const dncCheckItems = allCandidateProfiles.map((p, idx) => ({
          id: String(idx),
          username: p.username ?? null,
          instagramUserId: p.instagramUserId ?? p.instagramId ?? null,
          email: p.email ?? null,
          website: p.website ?? p.externalUrl ?? null,
          phone: p.phone ?? null,
        }));

        const suppressionMap = await checkManySuppression({
          userId: userId ?? campaign.userId,
          leads: dncCheckItems,
        });

        let roundDncSkipped = 0;
        const unsuppressed: LeadProfile[] = [];
        for (let i = 0; i < allCandidateProfiles.length; i++) {
          const profile = allCandidateProfiles[i];
          const sup = suppressionMap.get(String(i));
          if (sup?.suppressed) {
            roundDncSkipped++;
            continue;
          }
          unsuppressed.push(profile);
        }

        totalDncSkipped += roundDncSkipped;
        finalSkipCounts.DNC_SUPPRESSED =
          (finalSkipCounts.DNC_SUPPRESSED ?? 0) + roundDncSkipped;

        const toPersist = unsuppressed.slice(0, Math.max(0, remainingCapacity - totalPersisted));

        if (toPersist.length > 0) {
          emit({
            stage: "persist",
            message: `Saving ${toPersist.length} qualified leads to campaign...`,
            candidatesDiscovered: discoveredUsernamesAll.length + allMultiChannelCandidates.length,
            candidatesEnriched: totalEnrichedCount,
            persisted: totalPersisted,
            skipped: sumSkipCounts(finalSkipCounts),
            remainingCapacity: remainingCapacity - totalPersisted,
            existingLeads: existingLeadCount,
            skipCounts: { ...finalSkipCounts },
          });

          // Stage 3 Contact Extraction (free) for profiles with username
          const needContactEnrichment = toPersist.filter((p) => Boolean(p.username));
          if (needContactEnrichment.length > 0) {
            const contactResult = await enrichProfilesWithContacts(needContactEnrichment, {
              countryCode: campaignCountry,
              timeoutMs: 6000,
            });

            totalContactsExtracted.email += contactResult.contactsExtracted.email;
            totalContactsExtracted.phone += contactResult.contactsExtracted.phone;
            totalContactsExtracted.whatsapp += contactResult.contactsExtracted.whatsapp;
            totalContactsExtracted.other += contactResult.contactsExtracted.other;
            totalLeadsWithAnyContact += contactResult.leadsWithAnyContact;
          }

          const persistResult = await persistCampaignLeads(
            campaign.id,
            toPersist,
            request.maxLeads,
            {
              source:
                isInstagramAllInOneMode
                  ? "instagram_scraper"
                  : "discovery",
              scrapeJobId: job.id,
              userId: userId ?? campaign.userId,
              isDryRun: isCurrentRunDry,
            },
          );

          const createdInCampaign =
            persistResult.dedupStats.new + persistResult.dedupStats.softDuplicates;
          totalPersisted += createdInCampaign;
          stageCountSaved = totalPersisted;
          persistedProfiles.push(...toPersist.slice(0, createdInCampaign));
          newLeadsCount += persistResult.dedupStats.new;
          qualifiedLeadsCount += createdInCampaign;
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
    }

    // Check cost-per-lead guard after enrichment & persistence
    if (totalApifyCostUsd > costPerLeadGuardUsd && totalPersisted === 0) {
      stopReason = "cost_per_lead_exceeded";
    }

    const persisted = totalPersisted;
    const candidatesEnriched = totalEnrichedCount;
    const skipped = sumSkipCounts(finalSkipCounts);
    const finalRemaining = Math.max(
      0,
      request.maxLeads - (existingLeadCount + persisted),
    );

    if (persisted >= remainingCapacity && (stopReason === "all_keywords_exhausted" || !stopReason)) {
      stopReason = "completed";
    } else if (persisted < remainingCapacity && stopReason === "completed") {
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

    const costPerLead =
      persisted > 0 ? Number((totalApifyCostUsd / persisted).toFixed(4)) : 0;

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
      providerNotice,
      gmapsPlacesFound: totalGmapsPlacesFound,
      gmapsWithWebsite: totalGmapsWithWebsite,
      gmapsWithInstagram: totalGmapsWithInstagram,
      gmapsDuplicatesSkipped: totalGmapsDuplicatesSkipped,
      itemsReturnedRaw: totalItemsReturnedRaw,
      itemsParsedAsPlaces: totalItemsParsedAsPlaces,
      withInstagramUsername: totalWithInstagramUsername,
      noInstagramCount: totalNoInstagramCount,
      outOfAreaCount: totalOutOfAreaCount,
      candidatesKept: discoveredUsernamesAll.length,
      providerError: lastProviderError,
      discoveryProvider: activeDiscoveryMode,
      discoveryActor,
      enrichmentActor,
      apifyCostUsd: totalApifyCostUsd,
      handlesFound: discoveredUsernamesAll.length,
      enrichedCount: totalEnrichedCount,
      criteriaRejectedCount: totalCriteriaRejected,
      aiAccepted: totalAiAccepted,
      enrichmentCostUsd: totalEnrichmentCostUsd,
      apifyRunsCount,
      costPerLead,
      skippedAlreadySeenCount,
      leadsWithIg: totalLeadsWithIg,
      leadsNoIgButContactable: totalLeadsNoIgButContactable,
      placesDroppedNoContact: totalPlacesDroppedNoContact,
    });

    const tierCounts = { A: 0, B: 0, C: 0, D: 0 };
    let nameMismatchCount = 0;
    let groupDedupedCount = 0;
    for (const p of persistedProfiles) {
      if (p.qualityTier === "A") tierCounts.A++;
      else if (p.qualityTier === "B") tierCounts.B++;
      else if (p.qualityTier === "C") tierCounts.C++;
      else if (p.qualityTier === "D") tierCounts.D++;

      if (p.scoreFlags?.includes("NAME_WEBSITE_MISMATCH")) nameMismatchCount++;
      if (p.isGroup) groupDedupedCount++;
    }

    const placesFetchedTotal = stageCountPlacesIn || totalGmapsPlacesFound || discoveredUsernamesAll.length;
    const handleYieldPct = placesFetchedTotal > 0 ? Math.round((totalLeadsWithIg / placesFetchedTotal) * 100) : 0;

    const usageFunnel = {
      campaignId: campaign.id,
      discoveryProvider: activeDiscoveryMode,
      discoveryActorId: discoveryActor,
      enrichmentActorId: enrichmentActor,
      providerError: lastProviderError,
      isDryRun: isDryRunMode(),
      placesFetched: placesFetchedTotal,
      handleYieldPct,
      leadsWithIg: totalLeadsWithIg,
      leadsWithInstagram: totalLeadsWithIg,
      leadsNoIgButContactable: totalLeadsNoIgButContactable,
      leadsWithoutInstagramContactable: totalLeadsNoIgButContactable,
      noIgButContactableCount: totalLeadsNoIgButContactable,
      nameMismatchCount,
      groupDedupedCount,
      placesDroppedNoContact: totalPlacesDroppedNoContact,
      tierCounts,
      droppedByReason: {
        closed: stageRejections.freeRules?.CLOSED_PLACE ?? 0,
        wrongCity: stageRejections.freeRules?.WRONG_CITY ?? 0,
        chain: stageRejections.chainFilter?.CHAIN_DETECTED ?? 0,
        negativeKeyword: stageRejections.freeRules?.NEGATIVE_KEYWORD ?? 0,
        noContact: totalPlacesDroppedNoContact,
      },
      spendByStage: {
        maps: Number(Math.max(0, totalApifyCostUsd - totalEnrichmentCostUsd).toFixed(4)),
        profiles: Number(totalEnrichmentCostUsd.toFixed(4)),
        gemini: Number(((mapsGeminiCallsCount + finalGeminiCallsCount) * 0.00015).toFixed(4)),
        total: Number((totalApifyCostUsd + (mapsGeminiCallsCount + finalGeminiCallsCount) * 0.00015).toFixed(4)),
      },
      discoveryRunIds,
      enrichmentRunIds,
      runIds: [...discoveryRunIds, ...enrichmentRunIds],
      costPerActor: {
        discovery: {
          actorId: discoveryActor,
          costUsd: Number(totalDiscoveryCostUsd.toFixed(4)),
        },
        enrichment: {
          actorId: enrichmentActor,
          costUsd: Number(totalEnrichmentCostUsd.toFixed(4)),
        },
        totalUsd: Number(totalApifyCostUsd.toFixed(4)),
      },
      discoveryCostUsd: Number(totalDiscoveryCostUsd.toFixed(4)),
      roundsExecuted: completedRounds || 1,
      requestsUsed:
        totalRequestsUsed + Math.ceil(candidatesEnriched / ENRICH_BATCH_SIZE),
      apifyRunsCount,
      runsByActor,
      wastedRunsCost: Number(wastedRunsCost.toFixed(4)),
      costPerLead,
      skippedAlreadySeenCount,
      profilesReturned: discoveredUsernamesAll.length,
      handlesFound: discoveredUsernamesAll.length,
      enrichedCount: totalEnrichedCount,
      enrichmentCostUsd: Number(totalEnrichmentCostUsd.toFixed(4)),
      rejectedByCriteria: {
        minFollowers: rejectedByCriteriaCounts.minFollowers ?? 0,
        maxFollowers: rejectedByCriteriaCounts.maxFollowers ?? 0,
        private: rejectedByCriteriaCounts.private ?? 0,
        category: rejectedByCriteriaCounts.category ?? 0,
        "minPosts-strict": rejectedByCriteriaCounts["minPosts-strict"] ?? 0,
      },
      flaggedCounts: {
        low_activity: flaggedCounts.low_activity ?? 0,
        no_contact_signal: flaggedCounts.no_contact_signal ?? 0,
      },
      aiRejected: totalAiRejected,
      aiAccepted: totalAiAccepted,
      criteria: effectiveCriteria,
      gmapsPlacesFound: totalGmapsPlacesFound,
      gmapsWithWebsite: totalGmapsWithWebsite,
      gmapsWithInstagram: totalGmapsWithInstagram,
      itemsReturnedRaw: totalItemsReturnedRaw,
      itemsParsedAsPlaces: totalItemsParsedAsPlaces,
      withInstagramUsername: totalWithInstagramUsername,
      placesReturned: totalPlacesReturned,
      placesWithInstagram: totalPlacesWithInstagram,
      noInstagramCount: totalNoInstagramCount,
      outOfAreaCount: totalOutOfAreaCount,
      candidatesKept: discoveredUsernamesAll.length,
      perCityCounts: placesByCityAll,
      estimatedApifyCost: Number(totalApifyCostUsd.toFixed(4)),
      keywordStats: keywordStatsAll,
      perQueryStats: perQueryStatsAll,
      resultsConsumed: {
        search: totalSearchResultsConsumed,
        details: candidatesEnriched,
        total: totalSearchResultsConsumed + candidatesEnriched,
      },
      spendUsd: {
        estimated: Number(totalEstimatedCostUsd.toFixed(4)),
        actual: Number(totalApifyCostUsd.toFixed(4)),
        perSavedLead:
          totalPersisted > 0 ? Number((totalApifyCostUsd / totalPersisted).toFixed(4)) : null,
      },
      conversionFunnel: {
        found: stageCountPlacesIn,
        afterFreeRules: stageCountAfterFreeRules,
        afterLocationVerification:
          Math.max(0, totalSearchResultsConsumed - totalLocationRejected),
        afterGeminiPreGate: stageCountAfterMapsGemini,
        detailed: stageCountEnriched,
        afterCriteria: stageCountAfterCriteria,
        saved: stageCountSaved,
      },
      locationRejectedCount: totalLocationRejected,
      executedQueries: executedQueriesAll,
      skippedQueries: skippedQueriesAll,
      nextKeywordIndex:
        (currentKeywordIndex + executedQueriesAll.length) % effectiveQueries.length,
      seenCandidates: isCurrentRunDry ? [] : Array.from(allSeenCandidatesThisRun),
      dryRunCandidates: isCurrentRunDry ? Array.from(allSeenCandidatesThisRun) : [],
      malformedSkipped: finalSkipCounts.MALFORMED ?? 0,
      duplicatesSkipped:
        totalExistingSkipped + hardDuplicatesCount + totalGmapsDuplicatesSkipped,
      duplicatesByKey: dedupByKeyCounts,
      softDuplicatesFlagged: softDuplicatesCount,
      preEnrichmentRejected: finalSkipCounts.PRE_ENRICHMENT_REJECTED ?? 0,
      leadsEnriched: candidatesEnriched,
      filteredOutByRelevance:
        (finalSkipCounts.IRRELEVANT_CATEGORY ?? 0) +
        (finalSkipCounts.IRRELEVANT_INTENT ?? 0) +
        (finalSkipCounts.IRRELEVANT_LOCATION ?? 0) +
        (finalSkipCounts.IRRELEVANT_LOCATION_NATIONAL_SCALE ?? 0) +
        (finalSkipCounts.INSUFFICIENT_RELEVANCE_DATA ?? 0) +
        (finalSkipCounts.AI_UNAVAILABLE ?? 0),
      dncSkipped: totalDncSkipped,
      newLeadsCreated: newLeadsCount,
      qualifiedLeads: qualifiedLeadsCount,
      errors: totalEnrichmentFailures,
      gateRejections: gateRejectionCounts,
      rejectionLog: allRejections.slice(0, 500),
      contactsExtracted: totalContactsExtracted,
      leadsWithAnyContact: totalLeadsWithAnyContact,
      stopReason,
      pipelineStageStats: {
        placesIn: stageCountPlacesIn,
        afterFreeRules: stageCountAfterFreeRules,
        afterChainFilter: stageCountAfterChainFilter,
        afterMapsGemini: stageCountAfterMapsGemini,
        enriched: stageCountEnriched,
        afterCriteria: stageCountAfterCriteria,
        afterFinalGate: stageCountAfterFinalGate,
        saved: stageCountSaved,
        rejectionsByStage: stageRejections,
        costUsdByStage: {
          freeRules: 0,
          chainFilter: 0,
          mapsGemini: Number((mapsGeminiCallsCount * 0.00015).toFixed(4)),
          paidIgEnrichment: Number(totalEnrichmentCostUsd.toFixed(4)),
          criteria: 0,
          finalGate: Number((finalGeminiCallsCount * 0.00015).toFixed(4)),
          persistence: 0,
          totalUsd: Number((totalApifyCostUsd + (mapsGeminiCallsCount + finalGeminiCallsCount) * 0.00015).toFixed(4)),
        },
        callCounts: {
          mapsGeminiCalls: mapsGeminiCallsCount,
          paidIgEnrichmentProfiles: stageCountEnriched,
          finalGeminiCalls: finalGeminiCallsCount,
        },
      },
    };

    logDiscovery(
      `[DISCOVERY STAGE SUMMARY] ` +
      `placesIn=${stageCountPlacesIn} -> ` +
      `afterFreeRules=${stageCountAfterFreeRules} -> ` +
      `afterChainFilter=${stageCountAfterChainFilter} -> ` +
      `afterMapsGemini=${stageCountAfterMapsGemini} -> ` +
      `enriched=${stageCountEnriched} ($${totalEnrichmentCostUsd.toFixed(4)}) -> ` +
      `afterCriteria=${stageCountAfterCriteria} -> ` +
      `afterFinalGate=${stageCountAfterFinalGate} -> ` +
      `saved=${stageCountSaved}. ` +
      `Maps Gemini calls: ${mapsGeminiCallsCount}, Final Gemini calls: ${finalGeminiCallsCount}. ` +
      `Rejections: freeRules=${JSON.stringify(stageRejections.freeRules)}, chainFilter=${JSON.stringify(stageRejections.chainFilter)}, mapsGemini=${JSON.stringify(stageRejections.mapsGemini)}, criteria=${JSON.stringify(stageRejections.criteria)}, finalGate=${JSON.stringify(stageRejections.finalGate)}`
    );

    await prisma.scrapeJob.update({
      where: { id: job.id },
      data: {
        status: ScrapeJobStatus.COMPLETED,
        isDryRun: isCurrentRunDry,
        inputCount: discoveredUsernamesAll.length,
        processedCount: persisted,
        candidatesDiscovered: discoveredUsernamesAll.length,
        candidatesEnriched,
        candidatesSkipped: skipped,
        usage: usageFunnel as unknown as Prisma.InputJsonValue,
        stopReason:
          stopReason === "budget_cap_reached" ||
          stopReason === "BUDGET_CEILING_REACHED" ||
          stopReason === "cancelled" ||
          stopReason === "max_runs_per_job_reached" ||
          stopReason === "cost_per_lead_exceeded" ||
          stopReason === "country_level_requires_cities"
            ? stopReason
            : "completed",
        costUsd: Number((totalApifyCostUsd + (mapsGeminiCallsCount + finalGeminiCallsCount) * 0.00015).toFixed(4)),
        costBreakdown: {
          ...(usageFunnel.spendByStage as Record<string, unknown>),
          actualChargedEvents: chargedEventsAll,
          mapsYield: (usageFunnel as { mapsCost?: unknown }).mapsCost ?? null,
        } as unknown as Prisma.InputJsonValue,
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
          : notice?.startsWith("NO_RESULTS: ")
            ? notice.replace(/^NO_RESULTS:\s*/, "")
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
      apifyCostUsd: totalApifyCostUsd > 0 ? Number(totalApifyCostUsd.toFixed(4)) : 0,
      usageSummary: {
        perQueryStats: perQueryStatsAll,
        resultsConsumed: {
          search: totalSearchResultsConsumed,
          details: candidatesEnriched,
          total: totalSearchResultsConsumed + candidatesEnriched,
        },
        spendUsd: {
          estimated: Number(totalEstimatedCostUsd.toFixed(4)),
          actual: Number(totalApifyCostUsd.toFixed(4)),
          perSavedLead:
            persisted > 0 ? Number((totalApifyCostUsd / persisted).toFixed(4)) : null,
        },
        conversionFunnel: {
          found: stageCountPlacesIn,
          afterFreeRules: stageCountAfterFreeRules,
          afterLocationVerification: Math.max(
            0,
            totalSearchResultsConsumed - totalLocationRejected,
          ),
          afterGeminiPreGate: stageCountAfterMapsGemini,
          detailed: stageCountEnriched,
          afterCriteria: stageCountAfterCriteria,
          saved: stageCountSaved,
        },
        mapsCost:
          activeDiscoveryMode === "google_maps" || activeDiscoveryMode === "hybrid"
            ? (() => {
          const costPerPlace =
            totalGmapsPlacesFound > 0
              ? totalDiscoveryCostUsd / totalGmapsPlacesFound
              : 0;
          const handleYieldBySource: Record<string, number> = {};
          for (const profile of persistedProfiles) {
            const username = (profile.username ?? "").toLowerCase();
            const meta = candidateMetaByUsername.get(username);
            const source =
              (meta?.handleSource as string | undefined) ??
              (profile as { handleSource?: string | null }).handleSource ??
              (profile.website ? "homepage" : "unknown");
            handleYieldBySource[source] = (handleYieldBySource[source] ?? 0) + 1;
          }
          const yieldStats = buildYieldStats({
            placesReturned: totalGmapsPlacesFound,
            costUsd: totalDiscoveryCostUsd,
            leadsWithIg: totalLeadsWithIg,
            contactableLeads: persisted,            wastedByReason: {
              duplicates: Number((costPerPlace * totalDuplicatesPaid).toFixed(4)),
              no_contact: Number((costPerPlace * totalPlacesDroppedNoContact).toFixed(4)),
              rejected_after_payment: Number((costPerPlace * totalCriteriaRejected).toFixed(4)),
            },
            handleYieldByArea: areaYieldAll,
            handleYieldByKeyword: keywordYieldAll,
            handleYieldBySource,
          });
          return {
            ...yieldStats,
            paidPlaces: totalGmapsPlacesFound,
            duplicatePlaces: totalGmapsDuplicatesSkipped,
            newPlaces: Math.max(0, totalGmapsPlacesFound - totalGmapsDuplicatesSkipped),
            costPerNewPlaceUsd:
              totalGmapsPlacesFound - totalGmapsDuplicatesSkipped > 0
                ? Number(
                    (
                      totalDiscoveryCostUsd /
                      (totalGmapsPlacesFound - totalGmapsDuplicatesSkipped)
                    ).toFixed(4),
                  )
                : null,
            contactOnlySaved: persistedProfiles.filter((p) => !p.username).length,
            igReadySaved: persistedProfiles.filter((p) => Boolean(p.username)).length,
            costPerContactOnlyLeadUsd:
              persistedProfiles.filter((p) => !p.username).length > 0
                ? Number(
                    (
                      totalDiscoveryCostUsd /
                      persistedProfiles.filter((p) => !p.username).length
                    ).toFixed(4),
                  )
                : null,
            chargedEvents: chargedEventsAll,
            coverageSkipped: totalCoverageSkipped,
            outcomeCacheSkipped: totalOutcomeCacheSkipped,
            placeOverlapRatio: Number(maxPlaceOverlapRatio.toFixed(4)),
          };
        })()
            : undefined,
        stopReason,
      },
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
          status: totalPersisted > 0 ? ScrapeJobStatus.COMPLETED_WITH_WARNINGS : ScrapeJobStatus.FAILED,
          errorMessage: safeMessage,
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);

    await prisma.campaign
      .update({
        where: { id: campaign.id },
        data: { status: totalPersisted > 0 ? CampaignStatus.PARTIAL : CampaignStatus.FAILED },
      })
      .catch(() => undefined);

    throw error;
  }
}

export function buildDiscoveryNotice(input: {
  persisted: number;
  requested: number;
  existingLeads: number;
  discovered: number;
  existingSkipped: number;
  enrichSkipped: number;
  remainingCapacity: number;
  skipCounts?: DiscoverySkipCounts;
  stopReason?: string;
  providerNotice?: string | null;
  gmapsPlacesFound?: number;
  gmapsWithWebsite?: number;
  gmapsWithInstagram?: number;
  gmapsDuplicatesSkipped?: number;
  itemsReturnedRaw?: number;
  itemsParsedAsPlaces?: number;
  withInstagramUsername?: number;
  noInstagramCount?: number;
  outOfAreaCount?: number;
  candidatesKept?: number;
  placesReturned?: number;
  placesWithInstagram?: number;
  providerError?: string;
  apifyCostUsd?: number | null;
  handlesFound?: number;
  enrichedCount?: number;
  criteriaRejectedCount?: number;
  aiAccepted?: number;
  enrichmentCostUsd?: number | null;
  discoveryProvider?: string;
  discoveryActor?: string;
  enrichmentActor?: string;
  apifyRunsCount?: number;
  costPerLead?: number | null;
  skippedAlreadySeenCount?: number;
  leadsWithIg?: number;
  leadsNoIgButContactable?: number;
  placesDroppedNoContact?: number;
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
    providerNotice,
    gmapsPlacesFound = 0,
    gmapsWithWebsite = 0,
    gmapsWithInstagram = 0,
    gmapsDuplicatesSkipped = 0,
    itemsReturnedRaw,
    itemsParsedAsPlaces,
    withInstagramUsername,
    noInstagramCount,
    outOfAreaCount,
    candidatesKept,
    placesReturned,
    placesWithInstagram,
    providerError,
    apifyCostUsd,
    handlesFound,
    enrichedCount,
    criteriaRejectedCount,
    aiAccepted,
    enrichmentCostUsd,
    discoveryProvider,
    discoveryActor,
    enrichmentActor,
    apifyRunsCount,
    costPerLead,
    skippedAlreadySeenCount,
    leadsWithIg,
    leadsNoIgButContactable,
    placesDroppedNoContact,
  } = input;

  const actorSuffix =
    discoveryProvider && discoveryActor && enrichmentActor
      ? ` Discovery: ${discoveryProvider} (${discoveryActor}) | Enrichment: ${enrichmentActor} |`
      : "";

  const costSuffix =
    typeof apifyCostUsd === "number" && apifyCostUsd >= 0
      ? `${actorSuffix} Apify cost: $${apifyCostUsd.toFixed(2)}.`
      : actorSuffix
        ? `${actorSuffix.replace(/\s*\|\s*$/, "")}.`
        : "";

  const funnelSummary =
    typeof handlesFound === "number" || typeof enrichedCount === "number"
      ? ` Funnel: Handles ${handlesFound ?? discovered} -> Enriched ${enrichedCount ?? 0} -> Criteria Rejected ${criteriaRejectedCount ?? 0} -> AI Accepted ${aiAccepted ?? 0} -> Saved ${persisted} (Enrichment: $${(enrichmentCostUsd ?? 0).toFixed(2)}).`
      : "";

  const breakdown = formatSkipBreakdown(input.skipCounts);

  const runsCount = typeof apifyRunsCount === "number" ? apifyRunsCount : (discoveryProvider ? 1 : 0);
  const costVal = typeof apifyCostUsd === "number" ? apifyCostUsd : 0;
  const cplVal =
    typeof costPerLead === "number"
      ? costPerLead
      : persisted > 0
        ? costVal / persisted
        : 0;
  const seenSuffix =
    typeof skippedAlreadySeenCount === "number" && skippedAlreadySeenCount > 0
      ? ` | skipped as already seen: ${skippedAlreadySeenCount}`
      : "";
  const contactStatsSuffix =
    typeof leadsWithIg === "number" || typeof leadsNoIgButContactable === "number"
      ? ` | with IG: ${leadsWithIg ?? 0} | multi-channel: ${leadsNoIgButContactable ?? 0} | dropped (no contact): ${placesDroppedNoContact ?? 0}`
      : "";
  const statsSegment = `Runs: ${runsCount} | Cost: $${costVal.toFixed(2)} | Leads: ${persisted} | Cost per lead: $${cplVal.toFixed(2)} | Stop reason: ${stopReason ?? "completed"}${seenSuffix}${contactStatsSuffix}`;

  if (stopReason === "low_yield_early_stop") {
    const rawCount = itemsReturnedRaw ?? placesReturned ?? 0;
    const withIgCount = withInstagramUsername ?? placesWithInstagram ?? 0;
    const keptCount = candidatesKept ?? discovered;
    if (persisted > 0) {
      return `LOW_YIELD_STOP: Low yield: stopped early after discovering ${persisted} contactable leads (raw items ${rawCount}, with Instagram ${withIgCount}, kept ${keptCount}). Try google_maps for higher yield. ${statsSegment}.${costSuffix}${funnelSummary}`;
    }
    return `NO_RESULTS: Low yield: raw items ${rawCount}, with Instagram ${withIgCount}, kept ${keptCount}. Try google_maps. ${statsSegment}.${costSuffix}${funnelSummary}`;
  }

  if (discovered === 0) {
    if (discoveryProvider === "instagram_places") {
      const rawCount = itemsReturnedRaw ?? placesReturned ?? 0;
      const parsedCount = itemsParsedAsPlaces ?? rawCount;
      const withIgCount = withInstagramUsername ?? placesWithInstagram ?? 0;
      const noIgCount = noInstagramCount ?? Math.max(0, parsedCount - withIgCount);
      const outAreaCount = outOfAreaCount ?? 0;
      const keptCount = candidatesKept ?? discovered;

      const igFunnelStr = `Instagram places: raw items ${rawCount}, parsed ${parsedCount}, with Instagram ${withIgCount}, out of area ${outAreaCount}, kept ${keptCount}`;

      if (providerError) {
        return `NO_RESULTS: Discovery provider failed: ${providerError}. (${igFunnelStr}). ${statsSegment}.${costSuffix}${funnelSummary}`;
      }

      let mainReason = "no matching places returned by Instagram for this query and location";
      if (rawCount === 0) {
        mainReason = "no matching places returned by Instagram for this query and location";
      } else if (parsedCount === 0) {
        mainReason = "items returned could not be parsed as valid Instagram places";
      } else if (withIgCount === 0) {
        mainReason = "places were found, but none have a linked Instagram username (suggest google_maps)";
      } else if (noIgCount > withIgCount) {
        mainReason = "most places have no linked Instagram username (suggest google_maps)";
      } else if (outAreaCount >= withIgCount) {
        mainReason = "places with Instagram accounts were found, but all were outside the target city radius (suggest google_maps for local geo-accuracy)";
      } else if (gmapsDuplicatesSkipped >= withIgCount || existingSkipped >= withIgCount) {
        mainReason = "all discovered Instagram handles are already in your campaign leads";
      } else {
        mainReason = "no matching places within area could be kept (suggest google_maps)";
      }

      return `NO_RESULTS: ${igFunnelStr}. Reason: ${mainReason}. ${statsSegment}.${costSuffix}${funnelSummary}`;
    }

    if (providerError) {
      return `NO_RESULTS: Discovery provider failed: ${providerError}. (Places found ${gmapsPlacesFound}, with website ${gmapsWithWebsite}, with Instagram ${gmapsWithInstagram}, skipped duplicates ${gmapsDuplicatesSkipped}). ${statsSegment}.${costSuffix}${funnelSummary}`;
    }

    const funnelStr = `Places found ${gmapsPlacesFound}, with website ${gmapsWithWebsite}, with Instagram ${gmapsWithInstagram}, skipped duplicates ${gmapsDuplicatesSkipped}`;
    let prefix = "NO_RESULTS";
    let mainReason = "no matching places found in Google Maps for this query and location";

    const isBudgetStop =
      stopReason === "budget_cap_reached" ||
      stopReason === "BUDGET_CEILING_REACHED" ||
      stopReason === "monthly_budget_exhausted" ||
      stopReason === "monthly_budget_exceeded";

    const totalSeenOrDup = (skippedAlreadySeenCount ?? 0) + (gmapsDuplicatesSkipped ?? 0) + (existingSkipped ?? 0);
    const withContacts = gmapsWithInstagram > 0 ? gmapsWithInstagram : (gmapsWithWebsite > 0 ? gmapsWithWebsite : gmapsPlacesFound);

    if (stopReason === "country_level_requires_cities" && providerNotice) {
      return `NO_RESULTS: ${providerNotice} No paid Google Maps calls were made. ${statsSegment}.${costSuffix}${funnelSummary}`;
    }

    if (isBudgetStop) {
      prefix = "BUDGET_BLOCKED";
      mainReason = "run was stopped because budget limit or per-job ceiling was reached";
    } else if (gmapsPlacesFound > 0 && gmapsWithWebsite === 0) {
      prefix = "NO_RESULTS";
      mainReason = "places were found, but none had a website or Instagram link listed";
    } else if (gmapsPlacesFound > 0 && gmapsWithInstagram === 0) {
      prefix = "NO_RESULTS";
      mainReason = "places were found with websites, but no Instagram handles could be discovered";
    } else if (
      gmapsPlacesFound > 0 &&
      (gmapsDuplicatesSkipped >= gmapsWithInstagram || totalSeenOrDup >= withContacts)
    ) {
      prefix = "ALL_DUPLICATES";
      mainReason = `all discovered Instagram handles are already in your campaign leads (${gmapsDuplicatesSkipped || existingSkipped || 0} in campaign leads, ${skippedAlreadySeenCount ?? 0} from past 30-day runs)`;
    } else if (gmapsPlacesFound > 0 && breakdown && breakdown !== "0") {
      prefix = "ALL_FILTERED";
      mainReason = `places were found, but all candidates were filtered out by quality criteria (${breakdown})`;
    } else if (providerNotice && gmapsPlacesFound === 0) {
      mainReason = providerNotice;
    } else if (gmapsPlacesFound > 0) {
      prefix = "ALL_FILTERED";
      mainReason = "places were found, but none passed contact and quality criteria";
    }

    return `${prefix}: ${funnelStr}. Reason: ${mainReason}. ${statsSegment}.${costSuffix}${funnelSummary}`;
  }

  if (persisted === 0) {
    const isBudgetStop =
      stopReason === "budget_cap_reached" ||
      stopReason === "BUDGET_CEILING_REACHED" ||
      stopReason === "monthly_budget_exhausted" ||
      stopReason === "monthly_budget_exceeded";

    if (isBudgetStop) {
      return `BUDGET_BLOCKED: Discovery stopped because budget ceiling was reached ($${costVal.toFixed(2)} spent). Candidates discovered: ${discovered}, skipped: ${breakdown}. ${statsSegment}.${costSuffix}${funnelSummary}`;
    }

    const totalSeenOrDup = (skippedAlreadySeenCount ?? 0) + (existingSkipped ?? 0);
    if (totalSeenOrDup >= discovered && discovered > 0) {
      return `ALL_DUPLICATES: Found ${discovered} candidates, but all were already seen/saved (${existingSkipped} in campaign leads, ${skippedAlreadySeenCount ?? 0} from past 30-day runs). Skipped: ${breakdown}. ${statsSegment}.${costSuffix}${funnelSummary}`;
    }

    return `ALL_FILTERED: No relevant Instagram profiles passed the discovery filter. Candidates discovered: ${discovered}, already in campaign: ${existingSkipped}, enrichment failures: ${enrichSkipped}. Skipped: ${breakdown}. Remaining capacity: ${remainingCapacity}. ${statsSegment}.${costSuffix}${funnelSummary}`;
  }

  const allowedNew = Math.max(0, requested - existingLeads);
  if (persisted < allowedNew) {
    const reasonDetail =
      stopReason === "budget_cap_reached"
        ? " Reason: budget cap reached."
        : stopReason === "cancelled"
          ? " Reason: job cancelled."
          : stopReason === "max_runs_per_job_reached"
            ? " Reason: maximum Apify runs reached."
            : stopReason === "cost_per_lead_exceeded"
              ? " Reason: cost-per-lead guard triggered after the allowed zero-lead discovery spend was reached."
              : " Reason: all search options exhausted for this query/location.";
    return `PARTIAL_RESULTS: Saved ${persisted} of ${allowedNew} available slots (campaign limit: ${requested}, existing: ${existingLeads}, remaining capacity: ${remainingCapacity}). Candidates discovered: ${discovered}, already in campaign: ${existingSkipped}, enrichment failures: ${enrichSkipped}, skipped: ${breakdown}.${reasonDetail} ${statsSegment}.${costSuffix}${funnelSummary}`;
  }

  return `DISCOVERY_COMPLETED: Saved ${persisted} new lead${persisted === 1 ? "" : "s"} (limit: ${requested}, existing: ${existingLeads}, remaining capacity: ${remainingCapacity}). Candidates discovered: ${discovered}, skipped: ${breakdown}. ${statsSegment}.${costSuffix}${funnelSummary}`;
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
