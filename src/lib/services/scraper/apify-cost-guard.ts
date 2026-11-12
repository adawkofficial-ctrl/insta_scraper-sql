import "server-only";

import type { ActorRun } from "apify-client";
import { Prisma } from "@/generated/prisma/client";
import { UsageProvider } from "@/generated/prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { ProviderError } from "../provider-error";
import { getApifyClient, hasMockApifyClient } from "./apify-client";
import { classifyApifyProviderError } from "./apify-error-classifier";
import { areApifyCostLimitsEnabled, getIgScraperCostPerResultUsd } from "@/lib/env";

// Apify API platform requirement: minimum allowed value for maxTotalChargeUsd is $0.50 USD
export const APIFY_API_MINIMUM_CHARGE_PER_RUN_USD = 0.50;

// Default cost configurations (can be overridden via environment variables)
export const DEFAULT_MAX_CHARGE_PER_RUN_USD = 1.00;
export const DEFAULT_MAX_CHARGE_PER_JOB_USD = 2.00;
export const DEFAULT_MONTHLY_BUDGET_USD = 10.00;
export const DEFAULT_RUN_TIMEOUT_SECS = 180;
export const DEFAULT_ACTOR_MEMORY_MB = 1024;

// Known Actor Pricing models for pre-run estimation
const GMAPS_ACTOR_START_FEE_USD = 0.007;
const GMAPS_PLACE_SCRAPED_USD = 0.003; // $3.00 per 1,000 scraped places
const GMAPS_FILTER_APPLIED_USD = 0.001;
export const GMAPS_CONTACTS_ENRICHMENT_USD = 0.002;
const GMAPS_REVIEW_USD = 0.0005;
const GMAPS_IMAGE_USD = 0.0005;

const INSTAGRAM_PROFILE_COST_PER_ITEM_USD = 0.0023; // ~$2.30 per 1,000 profiles
const INSTAGRAM_PROFILE_RUN_BASE_USD = 0.005;

const INSTAGRAM_SEARCH_COST_PER_RUN_USD = 0.02;

export type SafeActorCallOptions = {
  maxItems?: number;
  waitSecs?: number;
  timeoutSecs?: number;
  maxTotalChargeUsd?: number;
  memoryMbytes?: number;
  abortSignal?: AbortSignal;
  jobAccumulatedCostUsd?: number;
  campaignId?: string;
  userId?: string;
  operationName?: string;
  allowRetryOnTimeout?: boolean;
};

export type SafeActorRunResult<T = unknown> = {
  run: ActorRun;
  items: T[];
  usageTotalUsd: number;
  computeUnits: number;
  isDryRun: boolean;
  costNotice?: string;
  isTimedOut?: boolean;
  isWasted?: boolean;
};

/**
 * Resolves timeout in seconds by actor and payload size:
 * - Place search searchLimit <= 10 -> 120s; > 10 -> 180s
 * - Profile enrichment (up to 20 profiles) -> 180s
 * - Default -> DEFAULT_RUN_TIMEOUT_SECS (180s)
 */
export function resolveTimeoutSecs(
  actorId: string,
  input: Record<string, unknown>,
  explicitTimeoutSecs?: number,
): number {
  if (typeof explicitTimeoutSecs === "number" && explicitTimeoutSecs > 0) {
    return explicitTimeoutSecs;
  }
  const actorLower = actorId.toLowerCase();
  if (actorLower.includes("instagram-scraper") && input.searchType === "place") {
    const limit = typeof input.searchLimit === "number" ? input.searchLimit : 10;
    return limit <= 10 ? 120 : 180;
  }
  if (
    actorLower.includes("instagram-scraper") &&
    (input.resultsType === "details" || input.directUrls)
  ) {
    return 180;
  }
  if (actorLower.includes("instagram-profile-scraper")) {
    return 180;
  }
  return DEFAULT_RUN_TIMEOUT_SECS;
}

export function getDiscoveryJobBudgetUsd(provider?: string): number {
  if (provider === "instagram_places") {
    const envVal = process.env.IG_PLACES_MAX_JOB_USD?.trim();
    const parsed = envVal ? Number.parseFloat(envVal) : 0.15;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.15;
  }
  const envVal = process.env.DISCOVERY_MAX_JOB_USD?.trim();
  const parsed = envVal ? Number.parseFloat(envVal) : 0.30;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.30;
}

export type PreRunCostEstimate = {

  actorId: string;
  estimatedCostUsd: number;
  plannedSearches: number;
  maxItems: number;
  originalMaxItems?: number;
  wasReduced: boolean;
};

/**
 * Checks if dry run mode is active.
 *
 * Rules:
 * - If APIFY_DRY_RUN is explicitly set ("true" or "false"), respect it.
 * - Otherwise defaults to TRUE if NODE_ENV === "test" or in development scripts.
 */
export function isDryRunMode(): boolean {
  // In production, dry-run mode is strictly disabled to prevent faked scrapes
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  const envVal = process.env.APIFY_DRY_RUN?.trim().toLowerCase();
  if (envVal === "false" || envVal === "0") {
    return false;
  }
  if (envVal === "true" || envVal === "1") {
    return true;
  }
  // Default to dry run in test mode or if token is not set
  if (process.env.NODE_ENV === "test" || !process.env.APIFY_API_TOKEN) {
    return true;
  }
  // If not explicitly set to false, default to true in development scripts
  return false;
}

/**
 * Master kill switch for Apify integration.
 */
export function isApifyEnabled(): boolean {
  const envVal = process.env.APIFY_ENABLED?.trim().toLowerCase();
  return envVal !== "false" && envVal !== "0";
}

/**
 * Resolves the comma-separated list of allowed Apify actor IDs from APIFY_ALLOWED_ACTORS.
 * If unset or empty, returns null (all actors allowed).
 */
export function getAllowedActors(): string[] | null {
  const envVal = process.env.APIFY_ALLOWED_ACTORS?.trim();
  if (!envVal) {
    return null;
  }
  const list = envVal
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "undefined");
  return list.length > 0 ? list : null;
}

/**
 * Checks if a given actor ID is allowed under the APIFY_ALLOWED_ACTORS allowlist.
 */
export function isActorAllowed(actorId: string): boolean {
  const allowed = getAllowedActors();
  if (!allowed || allowed.length === 0) {
    return true;
  }
  const target = actorId.trim().toLowerCase();
  return allowed.some((a) => a.toLowerCase() === target);
}

export function getMaxChargePerRunUsd(): number {
  if (!areApifyCostLimitsEnabled()) return Number.POSITIVE_INFINITY;
  const val = process.env.APIFY_MAX_CHARGE_PER_RUN_USD;
  if (val) {
    const parsed = Number.parseFloat(val);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_CHARGE_PER_RUN_USD;
}

export function getMaxChargePerJobUsd(): number {
  if (!areApifyCostLimitsEnabled()) return Number.POSITIVE_INFINITY;
  const val = process.env.APIFY_MAX_CHARGE_PER_JOB_USD;
  if (val) {
    const parsed = Number.parseFloat(val);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_CHARGE_PER_JOB_USD;
}

export function getMonthlyBudgetUsd(): number | null {
  if (!areApifyCostLimitsEnabled()) return null;
  const val = process.env.APIFY_MONTHLY_BUDGET_USD ?? process.env.MONTHLY_SPEND_LIMIT_USD;
  if (!val || val.trim() === "" || val.trim() === "0") {
    return null;
  }
  const parsed = Number.parseFloat(val.trim());
  if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  return null;
}

export function getRunTimeoutSecs(): number {
  const val = process.env.APIFY_RUN_TIMEOUT_SECS;
  if (val) {
    const parsed = Number.parseInt(val, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RUN_TIMEOUT_SECS;
}

export function getActorMemoryMb(): number {
  const val = process.env.APIFY_ACTOR_MEMORY_MB;
  if (val) {
    const parsed = Number.parseInt(val, 10);
    if (!Number.isNaN(parsed) && parsed >= 128) return parsed;
  }
  return DEFAULT_ACTOR_MEMORY_MB;
}

/**
 * Computes total Apify spend for the current calendar month across all usage logs.
 */
export async function getMonthlyApifySpend(prismaClient?: ReturnType<typeof getPrismaClient>): Promise<number> {
  try {
    const prisma = prismaClient ?? getPrismaClient();
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

    let sinceDate = startOfMonth;
    const resetDateEnv = process.env.APIFY_BUDGET_RESET_DATE?.trim();
    if (resetDateEnv) {
      const parsed = new Date(resetDateEnv);
      if (!Number.isNaN(parsed.getTime())) {
        // Honor reset date if it is in the current calendar month;
        // if it's older than startOfMonth, reset to startOfMonth so past months don't accumulate.
        sinceDate = parsed > startOfMonth ? parsed : startOfMonth;
      }
    }

    const logs = await prisma.usageLog.findMany({
      where: {
        provider: UsageProvider.APIFY,
        createdAt: { gte: sinceDate },
      },
      select: { estimatedCostUsd: true },
    });

    let total = 0;
    for (const log of logs) {
      if (log.estimatedCostUsd) {
        total += Number(log.estimatedCostUsd);
      }
    }
    return Number(total.toFixed(4));
  } catch (err) {
    console.warn(`[APIFY-COST-GUARD] Failed to read monthly spend from DB: ${String(err)}`);
    return 0;
  }
}

/**
 * Computes remaining monthly budget for Apify. Returns null if monthly budget is not configured.
 */
export async function getMonthlyApifyBudgetRemaining(prismaClient?: ReturnType<typeof getPrismaClient>): Promise<number | null> {
  const budget = getMonthlyBudgetUsd();
  if (budget === null || budget <= 0) {
    return null;
  }
  const spent = await getMonthlyApifySpend(prismaClient);
  return Number(Math.max(0, budget - spent).toFixed(4));
}

/**
 * Pre-run cost estimator for an actor call.
 * If the estimated cost exceeds the per-run cap, automatically reduces maxItems.
 */
export function estimateActorCost(
  actorId: string,
  input: Record<string, unknown>,
  requestedMaxItems?: number,
): PreRunCostEstimate {
  const perRunCap = getMaxChargePerRunUsd();

  if (actorId.includes("crawler-google-places")) {
    const searches = Array.isArray(input.searchStringsArray)
      ? Math.max(1, input.searchStringsArray.length)
      : 1;

    let placesPerSearch = typeof input.maxCrawledPlacesPerSearch === "number"
      ? input.maxCrawledPlacesPerSearch
      : requestedMaxItems ?? 15;

    const originalPlaces = placesPerSearch;
    let wasReduced = false;

    // Check add-ons
    const socialEnrichment = !!(input.scrapeSocialMediaProfiles as { instagrams?: boolean } | undefined)?.instagrams;
    const contactsEnrichment = !!input.scrapeContacts || socialEnrichment;
    const maxReviews = typeof input.maxReviews === "number" ? input.maxReviews : 0;
    const maxImages = typeof input.maxImages === "number" ? input.maxImages : 0;
    const skipClosedPlaces = !!input.skipClosedPlaces;

    const costPerPlace =
      GMAPS_PLACE_SCRAPED_USD +
      (skipClosedPlaces ? GMAPS_FILTER_APPLIED_USD : 0) +
      (contactsEnrichment ? GMAPS_CONTACTS_ENRICHMENT_USD : 0) +
      maxReviews * GMAPS_REVIEW_USD +
      maxImages * GMAPS_IMAGE_USD;

    const calculateCost = (count: number) =>
      GMAPS_ACTOR_START_FEE_USD + searches * count * costPerPlace;

    let estimate = calculateCost(placesPerSearch);

    // Auto-reduce if estimate > per-run cap
    if (estimate > perRunCap && costPerPlace > 0) {
      const allowedPlacesTotal = Math.max(1, Math.floor((perRunCap - GMAPS_ACTOR_START_FEE_USD) / costPerPlace));
      const reducedPerSearch = Math.max(1, Math.floor(allowedPlacesTotal / searches));
      if (reducedPerSearch < placesPerSearch) {
        placesPerSearch = reducedPerSearch;
        estimate = calculateCost(placesPerSearch);
        wasReduced = true;
      }
    }

    return {
      actorId,
      estimatedCostUsd: Number(estimate.toFixed(4)),
      plannedSearches: searches,
      maxItems: placesPerSearch,
      originalMaxItems: wasReduced ? originalPlaces : undefined,
      wasReduced,
    };
  }

  if (actorId.includes("instagram-profile-scraper")) {
    const usernames = Array.isArray(input.usernames) ? input.usernames.length : (requestedMaxItems ?? 10);
    const originalCount = usernames;
    let count = usernames;
    let wasReduced = false;

    const calculateCost = (items: number) =>
      INSTAGRAM_PROFILE_RUN_BASE_USD + items * INSTAGRAM_PROFILE_COST_PER_ITEM_USD;

    let estimate = calculateCost(count);

    if (estimate > perRunCap) {
      const maxAllowed = Math.max(1, Math.floor((perRunCap - INSTAGRAM_PROFILE_RUN_BASE_USD) / INSTAGRAM_PROFILE_COST_PER_ITEM_USD));
      if (maxAllowed < count) {
        count = maxAllowed;
        estimate = calculateCost(count);
        wasReduced = true;
      }
    }

    return {
      actorId,
      estimatedCostUsd: Number(estimate.toFixed(4)),
      plannedSearches: 1,
      maxItems: count,
      originalMaxItems: wasReduced ? originalCount : undefined,
      wasReduced,
    };
  }

  if (actorId.includes("instagram-scraper")) {
    const isPlaceSearch = input.searchType === "place";
    const costPerItem = getIgScraperCostPerResultUsd() * (isPlaceSearch ? 1 : 1.1);
    const baseRunFee = 0.005;
    const limit = typeof input.searchLimit === "number" ? input.searchLimit : (requestedMaxItems ?? 10);
    const originalLimit = limit;
    let count = limit;
    let wasReduced = false;

    const calculateCost = (items: number) => baseRunFee + items * costPerItem;
    let estimate = calculateCost(count);

    if (estimate > perRunCap) {
      const maxAllowed = Math.max(1, Math.floor((perRunCap - baseRunFee) / costPerItem));
      if (maxAllowed < count) {
        count = maxAllowed;
        estimate = calculateCost(count);
        wasReduced = true;
      }
    }

    return {
      actorId,
      estimatedCostUsd: Number(estimate.toFixed(4)),
      plannedSearches: 1,
      maxItems: count,
      originalMaxItems: wasReduced ? originalLimit : undefined,
      wasReduced,
    };
  }

  // Generic actor fallback (search scraper or others)
  return {
    actorId,
    estimatedCostUsd: Number(INSTAGRAM_SEARCH_COST_PER_RUN_USD.toFixed(4)),
    plannedSearches: 1,
    maxItems: requestedMaxItems ?? 20,
    wasReduced: false,
  };
}

/**
 * Mock generator for dry runs. Produces realistic simulated responses without any network call.
 */
function createMockActorRun<T>(actorId: string, input: Record<string, unknown>, maxItems: number): { run: ActorRun; items: T[] } {
  const timestamp = Date.now();
  const runId = `dry_run_${timestamp}`;
  const datasetId = `dry_dataset_${timestamp}`;

  const mockRun: ActorRun = {
    id: runId,
    actId: actorId,
    userId: "mock_user",
    status: "SUCCEEDED",
    statusMessage: "Dry run completed successfully (no real Apify calls).",
    defaultDatasetId: datasetId,
    defaultKeyValueStoreId: `dry_kvs_${timestamp}`,
    defaultRequestQueueId: `dry_rq_${timestamp}`,
    startedAt: new Date(),
    finishedAt: new Date(),
    buildId: "dry_build",
    exitCode: 0,
    stats: {
      computeUnits: 0,
    },
    usageTotalUsd: 0,
  } as unknown as ActorRun;

  let items: unknown[] = [];

  if (actorId.includes("crawler-google-places")) {
    const city = (typeof input.locationQuery === "string" ? input.locationQuery : "Toronto, ON");
    const count = Math.min(maxItems, 5);
    items = Array.from({ length: count }, (_, i) => ({
      title: `Sample Business ${i + 1} (${city})`,
      name: `Sample Business ${i + 1}`,
      address: `10${i} Main St, ${city}`,
      city: city.split(",")[0].trim(),
      countryCode: "ca",
      phone: `+1-416-555-010${i}`,
      website: `https://samplebusiness${i + 1}.example.com`,
      instagram: `https://www.instagram.com/sample_business_${i + 1}`,
      instagramUrl: `https://www.instagram.com/sample_business_${i + 1}`,
      categoryName: "Dentist",
      categories: ["Dentist", "Dental Clinic"],
      totalScore: 4.8,
      reviewsCount: 42,
      placeId: `ChIJmockPlace${i + 1}`,
    }));
  } else if (actorId.includes("instagram-search-scraper")) {
    items = [
      {
        username: "dryrun_dentist_to",
        fullName: "Toronto Dental Care",
        biography: "Full service cosmetic dentistry in Toronto #dental #smile",
        category: "Dentist",
        businessCategoryName: "Dentist",
        externalUrl: "https://torontodentalcare.example.com",
        followersCount: 1540,
        followers: 1540,
      },
    ];
  } else if (actorId.includes("instagram-profile-scraper")) {
    const usernames = Array.isArray(input.usernames) ? (input.usernames as string[]) : ["mock_user"];
    items = usernames.map((u) => ({
      username: u.replace(/^@/, ""),
      fullName: `${u} Dental Practice`,
      biography: `Official Instagram for ${u}. Family and cosmetic dentistry practice.`,
      categoryName: "Dentist",
      businessCategoryName: "Dentist",
      externalUrl: `https://${u.replace(/^@/, "")}.example.com`,
      followersCount: 2200,
      followsCount: 310,
      postsCount: 145,
      isBusinessAccount: true,
      verified: false,
      scrapedAt: new Date().toISOString(),
    }));
  } else if (actorId.includes("instagram-scraper")) {
    const count = Math.min(maxItems, 5);
    items = Array.from({ length: count }, (_, i) => ({
      name: `Sample IG Place ${i + 1}`,
      title: `Sample IG Place ${i + 1}`,
      category: "Dentist",
      categoryName: "Dentist",
      phone: `+1-416-555-019${i}`,
      location_address: `20${i} Queen St, Toronto, ON`,
      location_zip: "M5V 2A8",
      lat: 43.6532 + i * 0.005,
      lng: -79.3832 + i * 0.005,
      location_id: `ig_loc_${i + 1}`,
      ig_business: {
        profile: {
          username: `sample_ig_place_${i + 1}`,
          id: `ig_bus_${i + 1}`,
          full_name: `Sample IG Place ${i + 1}`,
        },
      },
      media_count: 120 + i * 10,
    }));
  }

  return { run: mockRun, items: items as T[] };
}

// In-memory registry for mocking during unit testing
export type MockActorRunner = (
  actorId: string,
  input: Record<string, unknown>,
  options?: SafeActorCallOptions,
) => Promise<SafeActorRunResult<unknown>>;

let mockActorRunner: MockActorRunner | null = null;

export function setMockActorRunnerForTesting(runner: MockActorRunner | null): void {
  mockActorRunner = runner;
}

/**
 * SINGLE CHOKE POINT for all Apify Actor executions.
 *
 * Enforces:
 * - APIFY_ENABLED kill-switch
 * - APIFY_DRY_RUN (returns zero-cost mocks with zero network calls)
 * - maxTotalChargeUsd cap per run
 * - Timeout enforcement
 * - Pre-run cost estimation and automatic item reduction
 * - Per-job budget limit ($0.60 default)
 * - Monthly account-level budget limit ($4.00 default)
 * - Strict refusal on quota/billing/auth errors (never retries 401/403/monthly limit)
 * - Abort signal propagation (aborts running actor on cancel)
 */
export async function runActorSafely<T = unknown>(
  actorId: string,
  input: Record<string, unknown>,
  options?: SafeActorCallOptions,
  prismaClient?: ReturnType<typeof getPrismaClient>,
): Promise<SafeActorRunResult<T>> {
  // 0. Hard Allowlist Enforcement (APIFY_ALLOWED_ACTORS)
  const allowed = getAllowedActors();
  if (allowed && allowed.length > 0) {
    const isAllowed = allowed.some((a) => a.toLowerCase() === actorId.trim().toLowerCase());
    if (!isAllowed) {
      throw new ProviderError(
        "apify",
        "runActorSafely",
        `Actor ${actorId} is not allowed (allowed: ${allowed.join(", ")})`,
        { code: "actor_not_allowed" },
      );
    }
  }

  if (mockActorRunner) {
    return (await mockActorRunner(actorId, input, options)) as SafeActorRunResult<T>;
  }

  // 1. Check Kill Switch
  if (!isApifyEnabled()) {
    throw new ProviderError(
      "apify",
      "runActorSafely",
      "Apify is disabled by kill switch (APIFY_ENABLED=false). Refusing all actor calls to prevent cost.",
      { code: "apify_disabled" },
    );
  }

  // 2. Dry Run Execution (ZERO network calls, $0.00 cost)
  if (isDryRunMode()) {
    console.log(`[APIFY-COST-GUARD] DRY RUN: actor=${actorId} (Zero network calls, cost: $0.00)`);
    const mockData = createMockActorRun<T>(actorId, input, options?.maxItems ?? 10);
    return {
      run: mockData.run,
      items: mockData.items,
      usageTotalUsd: 0,
      computeUnits: 0,
      isDryRun: true,
      costNotice: "Apify cost: $0.00 (dry run)",
    };
  }

  // 3. Resolve Budget Caps
  const perRunCap = options?.maxTotalChargeUsd ?? getMaxChargePerRunUsd();
  const perJobCap = getMaxChargePerJobUsd();
  const monthlyCap = getMonthlyBudgetUsd();
  const timeoutSecs = resolveTimeoutSecs(actorId, input, options?.timeoutSecs);
  const memoryMbytes = options?.memoryMbytes ?? getActorMemoryMb();

  // 4. Pre-run estimate
  const estimate = estimateActorCost(actorId, input, options?.maxItems);
  if (estimate.wasReduced) {
    console.log(
      `[APIFY-COST-GUARD] Reduced maxItems from ${estimate.originalMaxItems} to ${estimate.maxItems} to stay under per-run cap ($${perRunCap.toFixed(2)}).`,
    );
    if ("maxCrawledPlacesPerSearch" in input) {
      input.maxCrawledPlacesPerSearch = estimate.maxItems;
    }
  }

  console.log(
    `[APIFY-COST-GUARD] Planned run: actor=${actorId} items=${estimate.maxItems} estCost=$${estimate.estimatedCostUsd.toFixed(4)} perRunCap=$${perRunCap.toFixed(2)}`,
  );

  // Per-run budget check
  if (estimate.estimatedCostUsd > perRunCap) {
    throw new ProviderError(
      "apify",
      "runActorSafely",
      `Budget guard: would exceed per-run budget cap ($${perRunCap.toFixed(2)}). Estimated cost: $${estimate.estimatedCostUsd.toFixed(2)}.`,
      { code: "budget_exceeded" },
    );
  }

  // Per-job budget check
  const currentJobSpend = options?.jobAccumulatedCostUsd ?? 0;
  if (currentJobSpend + estimate.estimatedCostUsd > perJobCap) {
    throw new ProviderError(
      "apify",
      "runActorSafely",
      `Budget guard: would exceed per-job budget cap ($${perJobCap.toFixed(2)}). Current job spend: $${currentJobSpend.toFixed(2)}, estimated next run: $${estimate.estimatedCostUsd.toFixed(2)}.`,
      { code: "job_budget_exceeded" },
    );
  }

  // Monthly budget check
  if (monthlyCap !== null && monthlyCap > 0) {
    if (!hasMockApifyClient() || prismaClient) {
      const monthlySpend = await getMonthlyApifySpend(prismaClient);
      if (monthlySpend + estimate.estimatedCostUsd > monthlyCap) {
        throw new ProviderError(
          "apify",
          "runActorSafely",
          `Budget guard: would exceed monthly budget cap ($${monthlyCap.toFixed(2)}). Spent this month: $${monthlySpend.toFixed(2)}, estimated run: $${estimate.estimatedCostUsd.toFixed(2)}.`,
          { code: "monthly_budget_exceeded" },
        );
      }
    }
  }

  // 5. Live Execution (guarded)
  const client = getApifyClient();

  // Apify API requirement: if maxTotalChargeUsd is passed, it must be at least $0.50 USD.
  // We clamp callOptions.maxTotalChargeUsd to at least $0.50 so Apify never rejects the call.
  // Our internal pre-run check above already guarded the spend.
  const apifyMaxTotalCharge = Number.isFinite(perRunCap)
    ? Math.max(APIFY_API_MINIMUM_CHARGE_PER_RUN_USD, perRunCap)
    : null;

  const callOptions = {
    ...(apifyMaxTotalCharge !== null
      ? { maxTotalChargeUsd: apifyMaxTotalCharge }
      : {}),
    timeout: timeoutSecs,
    waitSecs: timeoutSecs,
    memory: memoryMbytes,
    maxItems: estimate.maxItems,
    restartOnError: false, // Prevent infinite billable restarts
  };

  if (options?.abortSignal?.aborted) {
    throw new ProviderError(
      "apify",
      "runActorSafely",
      "Request was cancelled before execution. Actor call skipped.",
      { code: "cancelled" },
    );
  }

  let run: ActorRun;
  const onAbort = () => {
    if (run?.id && typeof client.run === "function") {
      console.warn(`[APIFY-COST-GUARD] Aborting Apify run ${run.id} due to cancellation.`);
      client.run(run.id).abort().catch((abortErr) => {
        console.warn(`[APIFY-COST-GUARD] Failed to abort run ${run.id}: ${String(abortErr)}`);
      });
    }
  };
  options?.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    console.log(
      `[APIFY-COST-GUARD] Executing LIVE actor call: actor=${actorId} maxChargeUsd=${apifyMaxTotalCharge} timeout=${timeoutSecs}s`,
    );

    run = await client.actor(actorId).call(input, callOptions);
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    const statusCode = (error as { statusCode?: number })?.statusCode;

    // Check fatal quota/auth/billing errors: NEVER RETRY
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      errMessage.toLowerCase().includes("monthly usage") ||
      errMessage.toLowerCase().includes("hard limit") ||
      errMessage.toLowerCase().includes("usage limit") ||
      errMessage.toLowerCase().includes("platform-feature-disabled") ||
      errMessage.toLowerCase().includes("out of credit") ||
      errMessage.toLowerCase().includes("insufficient credit")
    ) {
      console.error(`[APIFY-COST-GUARD] Fatal billing/quota error: ${errMessage}`);
      throw new ProviderError(
        "apify",
        "runActorSafely",
        `Apify quota/billing limit reached: ${errMessage}`,
        { code: "quota_exceeded" },
      );
    }

    // Stop rules: NEVER retry on timeout
    throw new ProviderError(
      "apify",
      "runActorSafely",
      `Apify actor execution failed: ${errMessage}`,
      { code: classifyApifyProviderError(error) ?? "actor_failed" },
    );
  }

  // 7. Polling and Abort Handling
  const startedAt = Date.now();
  const maxPollMs = timeoutSecs * 1000;

  while (run.status === "READY" || run.status === "RUNNING") {
    // Check if client/user aborted
    if (options?.abortSignal?.aborted) {
      console.warn(`[APIFY-COST-GUARD] Abort signal triggered. Terminating Apify run ${run.id} to stop charges...`);
      try {
        await client.run(run.id).abort();
      } catch (abortErr) {
        console.warn(`[APIFY-COST-GUARD] Failed to abort run ${run.id}: ${String(abortErr)}`);
      }
      throw new ProviderError(
        "apify",
        "runActorSafely",
        "Operation was cancelled by user or timeout. Apify run aborted.",
        { code: "cancelled" },
      );
    }

    // Check timeout - do NOT discard partial items. Abort run, mark TIMED-OUT and break to read partial dataset.
    if (Date.now() - startedAt > maxPollMs) {
      console.warn(`[APIFY-COST-GUARD] Run ${run.id} exceeded timeout of ${timeoutSecs}s. Aborting and salvaging partial dataset...`);
      try {
        await client.run(run.id).abort();
      } catch {
        // ignore
      }
      run.status = "TIMED-OUT";
      break;
    }

    try {
      run = await client.run(run.id).waitForFinish({ waitSecs: 5 });
    } catch (pollErr) {
      console.warn(`[APIFY-COST-GUARD] Polling run ${run.id}: ${String(pollErr)}`);
    }

    if (run.status === "READY" || run.status === "RUNNING") {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // 8. Read Usage Total USD
  let usageTotalUsd = (run as unknown as { usageTotalUsd?: number })?.usageTotalUsd ?? 0;
  let computeUnits = (run as unknown as { computeUnits?: number; stats?: { computeUnits?: number } })?.stats?.computeUnits ?? (run as unknown as { computeUnits?: number })?.computeUnits ?? 0;

  if (typeof client.run === "function") {
    try {
      const runDetails = await client.run(run.id).get();
      if (runDetails) {
        if ((runDetails as unknown as { usageTotalUsd?: number })?.usageTotalUsd !== undefined) {
          usageTotalUsd = (runDetails as unknown as { usageTotalUsd?: number }).usageTotalUsd!;
        }
        if (runDetails.stats?.computeUnits !== undefined) {
          computeUnits = runDetails.stats.computeUnits;
        }
      }
    } catch {
      // keep usage from run
    }
  }

  // 9. Fetch Dataset Items (partial items salvaged if run timed out)
  let items: T[] = [];
  if (run.defaultDatasetId) {
    try {
      const { items: datasetItems } = await client.dataset(run.defaultDatasetId).listItems();
      items = datasetItems as T[];
    } catch (dataErr) {
      console.error(`[APIFY-COST-GUARD] Failed to fetch dataset items: ${String(dataErr)}`);
    }
  }

  // 10. Record in UsageLog
  if (options?.userId || options?.campaignId) {
    try {
      const prisma = getPrismaClient();
      await prisma.usageLog.create({
        data: {
          userId: options?.userId,
          campaignId: options?.campaignId,
          provider: UsageProvider.APIFY,
          operation: options?.operationName ?? "actor_call",
          requestCount: 1,
          itemsReturned: items.length,
          estimatedCostUsd: usageTotalUsd > 0 ? new Prisma.Decimal(usageTotalUsd) : null,
          metadata: {
            actor: actorId,
            runId: run.id,
            computeUnits,
            status: run.status,
          },
        },
      });
    } catch (logErr) {
      console.warn(`[APIFY-COST-GUARD] Failed to log usage: ${String(logErr)}`);
    }
  }

  const isTimedOut = run.status === "TIMED-OUT";
  const isWasted = isTimedOut || items.length === 0;

  if (isWasted) {
    console.warn(
      `[APIFY-COST-GUARD] Charged-but-wasted run detected: runId=${run.id} actor=${actorId} status=${run.status} items=${items.length} cost=$${usageTotalUsd.toFixed(4)}`,
    );
  }

  if (run.status !== "SUCCEEDED" && !isTimedOut) {
    throw new ProviderError(
      "apify",
      "runActorSafely",
      `Apify run ${run.id} finished with status ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ""}.`,
      { code: "actor_failed" },
    );
  }

  options?.abortSignal?.removeEventListener("abort", onAbort);

  const costNotice = `Apify cost: $${usageTotalUsd.toFixed(2)}`;

  return {
    run,
    items,
    usageTotalUsd,
    computeUnits,
    isDryRun: false,
    costNotice,
    isTimedOut,
    isWasted,
  };

}

/**
 * Ensures script execution does not accidentally burn live Apify credits.
 * All scripts default to dry run. Live execution requires BOTH:
 * 1) CLI argument: --live
 * 2) Environment variable: APIFY_ALLOW_LIVE_SCRIPTS=true
 */
export function assertScriptSafeForApify(): { isLive: boolean } {
  const isLiveFlag = process.argv.includes("--live");
  const allowLiveEnv =
    process.env.APIFY_ALLOW_LIVE_SCRIPTS === "true" ||
    process.env.APIFY_ALLOW_LIVE_SCRIPTS === "1";

  if (!isLiveFlag || !allowLiveEnv) {
    process.env.APIFY_DRY_RUN = "true";
    return { isLive: false };
  }

  return { isLive: true };
}

