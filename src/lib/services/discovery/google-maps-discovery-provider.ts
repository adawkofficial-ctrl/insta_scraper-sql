import "server-only";

import { areApifyCostLimitsEnabled, getServerEnv } from "@/lib/env";
import { runActorSafely, isDryRunMode } from "../scraper/apify-cost-guard";
import { getPrismaClient } from "@/lib/db/prisma";
import type {
  DiscoveredProfile,
  DiscoveryInput,
  DiscoveryProvider,
  DiscoveryResult,
  KeywordSearchStat,
} from "./discovery-provider";
import { resolveCountryCode, resolveTargetCities } from "./country-cities";
import { extractDiscoveryKeywords } from "./discovery-query";
import {
  computeIgYieldPercent,
  getAreaCooldownDays,
  getMinIgYieldPercent,
  isFirstBatchMostlySeen,
  parseChargedBreakdown,
  pickNextArea,
  placeOverlapRatio,
  shouldDropKeyword,
  shouldStopForLowYield,
  type ChargedBreakdown,
  type CoverageRow,
  type PlaceOutcomeRow,
} from "./google-maps-cost-optimizer";
import {
  getKnownPlaceOutcomes,
  getCoverageRows,
  recordCoverage,
  recordPlaceOutcomes,
} from "./discovery-coverage-service";
import { normalizeWebsite } from "../dedup/identity";
import { normalizePhone } from "../contact/contact-parser";
import {
  runHandleDiscoveryWaterfall,
  safeFetchHtml,
  type HandleSource,
  type HandleConfidence,
} from "./handle-discovery-waterfall";
import { checkNameWebsiteMismatch } from "./name-website-matcher";
import { clusterMultiLocationGroups } from "./group-detector";

export const GMAPS_ACTOR_ID = "compass/crawler-google-places";

const DEFAULT_MAX_PLACES_PER_SEARCH = 15;
const DEFAULT_MAX_TOTAL_PLACES = 30;
const MAX_KEYWORDS_PER_RUN = 2;
function log(message: string): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  console.log(message);
}

/**
 * Normalizes an Instagram profile handle or URL into a clean username.
 *
 * Rules:
 * - Strips protocol, domain, query parameters (e.g. ?hl=en), hash, and trailing slashes.
 * - Strips leading '@' characters.
 * - Lowercases the result.
 * - Rejects non-profile paths: /p/, /reel/, /reels/, /explore/, /stories/, /tv/, /share/, /channel/, etc.
 * - Rejects handles not matching valid Instagram username rules (1-30 chars, alphanumeric + dots + underscores).
 * - Rejects leading/trailing dots and consecutive dots.
 */
export function normalizeInstagramHandle(
  raw: string | null | undefined,
): string | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  let text = raw.trim();
  if (text.length === 0) {
    return null;
  }

  // Handle URL forms
  if (
    text.includes("instagram.com") ||
    text.includes("instagr.am") ||
    text.startsWith("http://") ||
    text.startsWith("https://")
  ) {
    const urlString =
      text.startsWith("http://") || text.startsWith("https://")
        ? text
        : `https://${text.replace(/^\/+/, "")}`;

    try {
      const parsed = new URL(urlString);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      if (!pathname) {
        return null;
      }

      const segments = pathname.split("/").filter((s) => s.length > 0);
      if (segments.length === 0) {
        return null;
      }

      const first = segments[0].toLowerCase();
      const disallowedPaths = new Set([
        "p",
        "reel",
        "reels",
        "explore",
        "stories",
        "tv",
        "share",
        "channel",
        "accounts",
        "direct",
        "directory",
        "legal",
        "about",
        "developer",
        "privacy",
        "static",
      ]);

      if (disallowedPaths.has(first)) {
        return null;
      }

      text = first;
    } catch {
      const match = text.match(
        /(?:instagram\.com\/)(?:#!\/)?@?([a-zA-Z0-9._]+)/i,
      );
      if (match) {
        text = match[1];
      } else {
        return null;
      }
    }
  }

  // Strip leading @, trailing slashes, query params
  text = text.replace(/^@+/, "").trim().toLowerCase();
  text = text.split("?")[0].split("#")[0].split("/")[0].trim();

  // Validate Instagram username format: 1..30 chars, alphanumeric, dots, underscores
  if (!/^[a-z0-9._]{1,30}$/.test(text)) {
    return null;
  }

  // Cannot start or end with a dot, or have consecutive dots
  if (text.startsWith(".") || text.endsWith(".") || text.includes("..")) {
    return null;
  }

  const reserved = new Set([
    "p",
    "reel",
    "reels",
    "explore",
    "stories",
    "tv",
    "share",
    "channel",
    "accounts",
  ]);
  if (reserved.has(text)) {
    return null;
  }

  return text;
}

/** Alias for normalizeInstagramHandle */
export const normalizeInstagramHandleFromUrl = normalizeInstagramHandle;

export type ExtractedSocialLinks = {
  instagram: string | null;
  facebook?: string | null;
  tiktok?: string | null;
  linkedin?: string | null;
  youtube?: string | null;
  whatsapp?: string | null;
};

/**
 * Fast regex-based extractor for social profile links from raw website HTML.
 * Extracts Instagram, Facebook, TikTok, LinkedIn, YouTube, and WhatsApp.
 */
export function extractSocialLinksFromHtml(html: string): ExtractedSocialLinks {
  if (!html || typeof html !== "string") {
    return { instagram: null };
  }

  const result: ExtractedSocialLinks = {
    instagram: extractInstagramFromHtml(html),
  };

  // Facebook
  const fbRegex =
    /href=["'](https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com|fb\.me)\/[^"'#\s<>]+)["']/i;
  const fbMatch = fbRegex.exec(html);
  if (fbMatch) {
    const raw = fbMatch[1].trim();
    if (!raw.includes("/sharer") && !raw.includes("/share") && !raw.includes("/dialog")) {
      result.facebook = raw;
    }
  }

  // TikTok
  const ttRegex =
    /href=["'](https?:\/\/(?:www\.)?tiktok\.com\/@[^"'#\s<>]+)["']/i;
  const ttMatch = ttRegex.exec(html);
  if (ttMatch) {
    result.tiktok = ttMatch[1].trim();
  }

  // LinkedIn
  const liRegex =
    /href=["'](https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^"'#\s<>]+)["']/i;
  const liMatch = liRegex.exec(html);
  if (liMatch) {
    result.linkedin = liMatch[1].trim();
  }

  // YouTube
  const ytRegex =
    /href=["'](https?:\/\/(?:www\.)?(?:youtube\.com\/(?:c\/|user\/|@)?|youtu\.be\/)[^"'#\s<>]+)["']/i;
  const ytMatch = ytRegex.exec(html);
  if (ytMatch) {
    const raw = ytMatch[1].trim();
    if (!raw.includes("/watch?") && !raw.includes("/embed/")) {
      result.youtube = raw;
    }
  }

  // WhatsApp
  const waRegex =
    /href=["'](https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)[^"'#\s<>]+)["']/i;
  const waMatch = waRegex.exec(html);
  if (waMatch) {
    result.whatsapp = waMatch[1].trim();
  }

  return result;
}

/**
 * Fast regex-based extractor for Instagram profile links from raw website HTML.
 */
export function extractInstagramFromHtml(html: string): string | null {
  if (!html || typeof html !== "string") {
    return null;
  }

  const regex =
    /href=["'](https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/[^"'#\s]+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const rawUrl = match[1];
    const handle = normalizeInstagramHandle(rawUrl);
    if (handle) {
      return handle;
    }
  }

  return null;
}

/**
 * Checks if a URL points to localhost or private IP ranges (SSRF protection).
 */
export function isPrivateOrBlockedUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
      return true;
    }

    // IPv4 private & loopback ranges:
    // 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16
    const ipv4Match = hostname.match(
      /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
    );
    if (ipv4Match) {
      const b0 = parseInt(ipv4Match[1], 10);
      const b1 = parseInt(ipv4Match[2], 10);
      if (b0 === 10 || b0 === 127 || b0 === 0) return true;
      if (b0 === 169 && b1 === 254) return true;
      if (b0 === 192 && b1 === 168) return true;
      if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Worker pool helper for bounded concurrency.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await fn(items[currentIndex]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

export const WEBSITE_EXTRACT_TIMEOUT_MS = 6000;
export const WEBSITE_EXTRACT_MAX_BYTES = 1024 * 1024; // 1 MB
export const WEBSITE_EXTRACT_CONCURRENCY = 5;

/**
 * Attempts to fetch a business website homepage to discover social profile links
 * (Instagram, Facebook, TikTok, LinkedIn, YouTube, WhatsApp).
 * Enforces:
 * - 6s timeout
 * - http/https only, blocks private/localhost IPs (SSRF guard)
 * - Max 1 MB body stream
 */
export async function tryExtractSocialLinksFromWebsite(
  websiteUrl: string,
  timeoutMs = WEBSITE_EXTRACT_TIMEOUT_MS,
): Promise<ExtractedSocialLinks> {
  const fetchRes = await safeFetchHtml(websiteUrl, timeoutMs);
  if (!fetchRes.ok || !fetchRes.html) {
    return { instagram: null };
  }
  return extractSocialLinksFromHtml(fetchRes.html);
}



/**
 * Backward-compatible helper for Instagram extraction only.
 */
export async function tryExtractInstagramFromWebsite(
  websiteUrl: string,
  timeoutMs = 6000,
): Promise<string | null> {
  const social = await tryExtractSocialLinksFromWebsite(websiteUrl, timeoutMs);
  return social.instagram;
}

/**
 * Extracts all candidate Instagram handles or URLs from an Apify Google Maps place object.
 * Tolerant to:
 * - `instagrams` (string or array of URL strings)
 * - `instagramProfiles` (array of objects with .username, .profileURL, .profileUrl, .url)
 * - `socialMediaProfiles`, `socialMedia`, `socialLinks`, `contacts`, `additionalInfo`
 * - ANY key containing "instagram" (case-insensitive)
 */
export function extractInstagramHandlesFromPlace(
  place: Record<string, unknown>,
): string[] {
  const candidates: string[] = [];

  const add = (val: unknown) => {
    if (!val) return;
    if (typeof val === "string" && val.trim().length > 0) {
      const normalized = normalizeInstagramHandle(val);
      if (normalized) {
        candidates.push(normalized);
      }
    } else if (Array.isArray(val)) {
      for (const item of val) {
        add(item);
      }
    } else if (typeof val === "object" && val !== null) {
      const obj = val as Record<string, unknown>;
      if (typeof obj.username === "string") add(obj.username);
      if (typeof obj.profileURL === "string") add(obj.profileURL);
      if (typeof obj.profileUrl === "string") add(obj.profileUrl);
      if (typeof obj.url === "string") add(obj.url);
      if (typeof obj.link === "string") add(obj.link);
      if (typeof obj.handle === "string") add(obj.handle);
      if (typeof obj.instagram === "string") add(obj.instagram);
      if (typeof obj.instagramUrl === "string") add(obj.instagramUrl);
      for (const [k, v] of Object.entries(obj)) {
        if (k.toLowerCase().includes("instagram")) {
          add(v);
        }
      }
    }
  };

  // 1. Direct fields
  add(place.instagram);
  add(place.instagrams);
  add(place.instagramProfiles);
  add(place.instagramUrl);
  add(place.instagramProfile);

  // 2. Sub-objects
  add(place.socialMediaProfiles);
  add(place.socialMedia);
  add(place.socialLinks);
  add(place.contacts);
  add(place.additionalInfo);

  // 3. Scan EVERY key on place that contains "instagram" (case-insensitive)
  for (const [k, v] of Object.entries(place)) {
    if (k.toLowerCase().includes("instagram")) {
      add(v);
    }
  }

  return Array.from(new Set(candidates));
}

/**
 * Validates that Google Maps actor output records adhere to the expected schema.
 * Checks the first 3 items contain name (title/name), website (website/url), and category (categoryName/category/categories).
 * Throws a clear descriptive error if required fields are missing.
 */
export function validateMapsActorOutput(items: Record<string, unknown>[]): void {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  const sample = items.slice(0, 3);
  for (let i = 0; i < sample.length; i++) {
    const place = sample[i];
    if (!place || typeof place !== "object") {
      throw new Error(`Maps actor output validation failed: item ${i + 1} is not a valid object.`);
    }

    const hasName = Boolean(
      (typeof place.title === "string" && place.title.trim().length > 0) ||
      (typeof place.name === "string" && place.name.trim().length > 0)
    );

    const hasWebsite = Boolean(
      (typeof place.website === "string" && place.website.trim().length > 0) ||
      (typeof place.url === "string" && place.url.trim().length > 0)
    );

    const hasCategory = Boolean(
      (typeof place.categoryName === "string" && place.categoryName.trim().length > 0) ||
      (typeof place.category === "string" && place.category.trim().length > 0) ||
      (Array.isArray(place.categories) && place.categories.length > 0)
    );

    if (!hasName || !hasWebsite || !hasCategory) {
      const missing: string[] = [];
      if (!hasName) missing.push("name");
      if (!hasWebsite) missing.push("website");
      if (!hasCategory) missing.push("category");
      throw new Error(
        `Maps actor output validation failed on item ${i + 1}: missing required fields (${missing.join(", ")}). Expected name (title/name), website (website/url), and category (categoryName/category/categories).`
      );
    }
  }
}

export class GoogleMapsDiscoveryProvider implements DiscoveryProvider {
  readonly name = "google_maps";

  async discover(input: DiscoveryInput): Promise<DiscoveryResult> {
    const actorId = getServerEnv("APIFY_GMAPS_ACTOR_ID") ?? GMAPS_ACTOR_ID;

    // 1. One keyword per area by default. Merging is opt-in (GMAPS_MERGE_KEYWORDS)
    // because repeated keywords mostly return the same top places and are paid twice.
    const mergeKeywords = process.env.GMAPS_MERGE_KEYWORDS === "true";
    const keywordCap = mergeKeywords ? MAX_KEYWORDS_PER_RUN : 1;
    const rawKeywords =
      input.queries && input.queries.length > 0
        ? input.queries.slice(0, keywordCap)
        : extractDiscoveryKeywords({ query: input.query }).slice(0, keywordCap);

    const effectiveKeywords =
      rawKeywords.length > 0
        ? rawKeywords.map((k) => k.trim())
        : [input.query.trim()];

    // 2. Resolve country code from location
    const resolvedCountryCode = resolveCountryCode(input.location);

    // 3. Resolve target cities (country fallback capped at first city; defaults to 1 city)
    const cityResolution = resolveTargetCities(input.location);
    if (cityResolution.warning) {
      console.warn(cityResolution.warning);
    }
    const maxCities = Number(process.env.GMAPS_MAX_CITIES || 5);
    const resolvedCities = cityResolution.cities
      // Drop province/state abbreviations such as "ON" from "Toronto, ON";
      // they are not searchable cities and waste a paid run.
      .filter((c) => {
        const trimmed = c.trim();
        if (trimmed.length < 3) return false;
        if (/^[A-Z]{2}$/i.test(trimmed)) return false;
        return true;
      });
    const targetCities =
      resolvedCities.length > 0 ? resolvedCities.slice(0, maxCities) : [""];

    const placesPerSearch = process.env.GMAPS_MAX_PLACES_PER_SEARCH
      ? Math.max(
          5,
          Number.parseInt(process.env.GMAPS_MAX_PLACES_PER_SEARCH, 10) ||
            DEFAULT_MAX_PLACES_PER_SEARCH,
        )
      : DEFAULT_MAX_PLACES_PER_SEARCH;

    const maxTotalPlaces = process.env.GMAPS_MAX_TOTAL_PLACES
      ? Math.max(
          10,
          Number.parseInt(process.env.GMAPS_MAX_TOTAL_PLACES, 10) ||
            DEFAULT_MAX_TOTAL_PLACES,
        )
      : DEFAULT_MAX_TOTAL_PLACES;

    log(
      `[GMAPS-DISCOVERY] Starting discovery: actor=${actorId} cities=${targetCities.length} keywords=${effectiveKeywords.length} maxPlacesPerSearch=${placesPerSearch} maxTotalPlaces=${maxTotalPlaces} countryCode=${resolvedCountryCode ?? "none"}`,
    );

    // Trackers
    const candidates: DiscoveredProfile[] = [];
    const seenHandles = new Set<string>();
    const seenWebsiteDomains = new Set<string>();
    const placesByCity: Record<string, number> = {};
    const keywordStats: KeywordSearchStat[] = [];
    const executedQueries: string[] = [];

    let totalPlacesFound = 0;
    let totalNewPlaces = 0;
    let totalWithWebsite = 0;
    let totalWithInstagram = 0;
    let totalNoInstagram = 0;
    let totalDuplicatesSkipped = 0;
    let accumulatedUsd = 0;
    let accumulatedComputeUnits = 0;
    let lastRunId = "unknown";
    let lastDatasetId: string | null = null;
    let lastError: string | null = null;
    let errorsCount = 0;

    // Pre-query existing leads in the DB across user's campaigns to dedupe
    const existingDbUsernames = new Set<string>();
    const existingDbWebsiteKeys = new Set<string>();
    const existingDbWebsiteDomains = new Set<string>();
    const existingDbPlaceIds = new Set<string>();
    const existingDbPhones = new Set<string>();

    const seenPlaceIds = new Set<string>();
    const seenPhones = new Set<string>();
    let leadsWithIg = 0;
    let leadsNoIgButContactable = 0;
    let placesDroppedNoContact = 0;

    if (input.campaignId || input.userId) {
      try {
        const isRunDry = Boolean(input.isDryRun ?? isDryRunMode());
        const prisma = getPrismaClient();
        const existingLeads = await prisma.lead.findMany({
          where: {
            ...(input.userId
              ? { campaign: { userId: input.userId } }
              : input.campaignId
                ? { campaignId: input.campaignId }
                : {}),
            ...(!isRunDry ? { isDryRun: false } : { isDryRun: true }),
          },
          select: {
            usernameNormalized: true,
            websiteKey: true,
            websiteDomain: true,
            gmapsPlaceId: true,
            phoneNormalized: true,
          },
        });

        for (const lead of existingLeads) {
          if (lead.usernameNormalized) {
            existingDbUsernames.add(lead.usernameNormalized.toLowerCase());
          }
          if (lead.websiteKey) {
            existingDbWebsiteKeys.add(lead.websiteKey.toLowerCase());
          }
          if (lead.websiteDomain) {
            existingDbWebsiteDomains.add(lead.websiteDomain.toLowerCase());
          }
          if (lead.gmapsPlaceId) {
            existingDbPlaceIds.add(lead.gmapsPlaceId);
          }
          if (lead.phoneNormalized) {
            existingDbPhones.add(lead.phoneNormalized);
          }
        }
      } catch (dbErr) {
        log(
          `[GMAPS-DISCOVERY] DB dedup check warning: ${String(dbErr)}. Proceeding without DB pre-filter.`,
        );
      }
    }

    // 3b. Coverage ledger + outcome cache + area rotation
    const maxSearchesPerJob = process.env.GMAPS_MAX_SEARCHES_PER_JOB
      ? Math.max(1, Number.parseInt(process.env.GMAPS_MAX_SEARCHES_PER_JOB, 10) || 2)
      : 2;
    const jobBudgetUsd = areApifyCostLimitsEnabled()
      ? process.env.DISCOVERY_MAX_JOB_USD
        ? Number.parseFloat(process.env.DISCOVERY_MAX_JOB_USD) || 0.3
        : 0.3
      : Number.POSITIVE_INFINITY;
    // Price basis note: the crawler bills per returned place, not per category
    // filter. We therefore do NOT send a category filter unless the operator
    // explicitly opts in (GMAPS_CATEGORY_FILTER), and we document that basis here.
    const categoryFilter = process.env.GMAPS_CATEGORY_FILTER?.trim() || null;
    const ledgerEnabled =
      Boolean(input.userId) && !(input.isDryRun ?? isDryRunMode());
    const ledgerUserId = ledgerEnabled ? input.userId! : null;

    let coverageRows: CoverageRow[] = [];
    let outcomeCacheSkipped = 0;
    let coveredAreasSkipped = 0;
    let actualCostUsd = 0;
    const chargedEventsAll: Array<{ runId: string; chargedUsd: number; events: unknown }> = [];
    const areaYield: Record<string, number> = {};
    const keywordYield: Record<string, number> = {};
    let lastOverlapRatio = 0;
    let stopReason: string | undefined;

    if (ledgerUserId) {
      try {
        coverageRows = await getCoverageRows(ledgerUserId);
      } catch (err) {
        log(`[GMAPS-DISCOVERY] Coverage ledger unavailable: ${String(err)}`);
      }
    }

    // The actor accepts ONE locationQuery per run, so areas cannot be batched
    // into a single run. Keywords can be merged only when explicitly enabled.
    const searchPlan: Array<{ city: string; keyword: string }> = [];
    for (const city of targetCities) {
      for (const keyword of effectiveKeywords) {
        const nextArea =
          pickNextArea(city, keyword, coverageRows, getAreaCooldownDays()) ?? city;
        if (!nextArea) {
          coveredAreasSkipped++;
          continue;
        }
        searchPlan.push({ city: nextArea, keyword });
        if (searchPlan.length >= maxSearchesPerJob) break;
      }
      if (searchPlan.length >= maxSearchesPerJob) break;
    }

    if (searchPlan.length === 0) {
      return {
        candidates: [],
        runId: "not_started",
        datasetId: null,
        actor: actorId,
        usageTotalUsd: 0,
        keywordStats: [],
        executedQueries: [],
        placesByCity: {},
        sourceProvider: "google_maps",
        stopReason: "all_areas_covered",
        actualCostUsd: 0,
        chargedEvents: [],
        coverageSkipped: coveredAreasSkipped,
        outcomeCacheSkipped,
      } as DiscoveryResult;
    }

    // 4. Iterate the planned (keyword, area) runs
    for (const plan of searchPlan) {
      const city = plan.city;
      const runKeywords = mergeKeywords ? effectiveKeywords.slice(0, 2) : [plan.keyword];
      const runKeywordKey = plan.keyword;
      if (totalPlacesFound >= maxTotalPlaces) {
        log(
          `[GMAPS-DISCOVERY] Reached maxTotalPlaces cap (${maxTotalPlaces}). Stopping city loop.`,
        );
        break;
      }

      const cityPlacesLimit = Math.min(
        placesPerSearch,
        maxTotalPlaces - totalPlacesFound,
      );

      // Cost cuts: disable expensive add-ons by default unless flag is on
      const socialEnrichmentEnabled = process.env.GMAPS_SOCIAL_ENRICHMENT === "true";
      const scrapeContactsEnabled = process.env.GMAPS_SCRAPE_CONTACTS === "true";

      // Send ONLY fields we consume. Reviews, images, questions, detail pages,
      // directories, competitor analysis and web results are omitted entirely.
      const actorInput: Record<string, unknown> = {
        searchStringsArray: runKeywords,
        locationQuery: city,
        maxCrawledPlacesPerSearch: cityPlacesLimit,
        language: "en",
        skipClosedPlaces: true,
      };

      if (Number.isFinite(jobBudgetUsd)) {
        // Run-level cap so the actor cannot exceed the remaining job budget.
        actorInput.maxTotalChargeUsd = Math.max(
          0.01,
          Number((jobBudgetUsd - accumulatedUsd).toFixed(4)),
        );
      }

      if (resolvedCountryCode) {
        actorInput.countryCode = resolvedCountryCode.toLowerCase();
      }

      if (categoryFilter) {
        actorInput.categoryFilter = categoryFilter;
      }

      if (scrapeContactsEnabled) {
        actorInput.scrapeContacts = true;
      }
      if (socialEnrichmentEnabled || scrapeContactsEnabled) {
        actorInput.scrapeSocialMediaProfiles = { instagrams: true };
      }

      const queryDescription = city
        ? `"${runKeywords.join(", ")}" in "${city}"`
        : `"${runKeywords.join(", ")}"`;
      executedQueries.push(queryDescription);

      let items: Record<string, unknown>[] = [];
      try {
        log(
          `[GMAPS-DISCOVERY] Calling actor via safe cost guard: city="${city}" keywords=${JSON.stringify(runKeywords)} limit=${cityPlacesLimit} maxCharge=$${String(actorInput.maxTotalChargeUsd)}`,
        );

        const safeResult = await runActorSafely<Record<string, unknown>>(
          actorId,
          actorInput,
          {
            maxItems: cityPlacesLimit,
            ...(Number.isFinite(jobBudgetUsd)
              ? {
                  maxTotalChargeUsd: Math.max(
                    0.01,
                    Number((jobBudgetUsd - accumulatedUsd).toFixed(4)),
                  ),
                }
              : {}),
            jobAccumulatedCostUsd: accumulatedUsd,
            campaignId: input.campaignId ?? undefined,
            userId: input.userId ?? undefined,
            operationName: "google_maps_search",
          },
        );

        lastRunId = safeResult.run.id;
        lastDatasetId = safeResult.run.defaultDatasetId ?? null;
        const charged: ChargedBreakdown = parseChargedBreakdown(safeResult.run);
        actualCostUsd += charged.chargedUsd > 0 ? charged.chargedUsd : safeResult.usageTotalUsd;
        chargedEventsAll.push({
          runId: safeResult.run.id,
          chargedUsd: Number(charged.chargedUsd.toFixed(4)),
          events: charged.events,
        });
        accumulatedUsd += safeResult.usageTotalUsd;
        accumulatedComputeUnits += safeResult.computeUnits;
        items = safeResult.items;
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[GMAPS-DISCOVERY] Actor call failed for city "${city}": ${errMessage}.`,
        );
        lastError = errMessage;
        errorsCount++;

        // Fatal/quota/allowlist error detection: fail fast if actor is disallowed or account limit failed
        const errLower = errMessage.toLowerCase();
        if (
          errLower.includes("not allowed") ||
          (err as { code?: string })?.code === "actor_not_allowed"
        ) {
          throw err;
        }
        if (
          errLower.includes("401") ||
          errLower.includes("403") ||
          errLower.includes("monthly usage") ||
          errLower.includes("hard limit") ||
          errLower.includes("usage limit") ||
          errLower.includes("quota_exceeded") ||
          errLower.includes("budget guard") ||
          errLower.includes("platform-feature-disabled")
        ) {
          console.warn(
            `[GMAPS-DISCOVERY] Fatal guard/quota limit reached (${errMessage}). Aborting further queries.`,
          );
          break;
        }
        continue;
      }

      // Location match validation on first results:
      // Verify first results roughly match the requested location/country
      if (items.length > 0) {
        const samplePlaces = items.slice(0, 3);
        const targetCityLower = city ? city.split(",")[0].trim().toLowerCase() : "";
        const targetCountry = resolvedCountryCode?.toLowerCase();

        const hasMatch = samplePlaces.some((item) => {
          const placeCity = typeof item.city === "string" ? item.city.toLowerCase() : "";
          const placeAddress = typeof item.address === "string" ? item.address.toLowerCase() : "";
          const placeCountry = typeof item.countryCode === "string" ? item.countryCode.toLowerCase() : "";

          if (targetCountry && placeCountry && placeCountry === targetCountry) {
            return true;
          }
          if (targetCityLower && (placeCity.includes(targetCityLower) || placeAddress.includes(targetCityLower))) {
            return true;
          }
          return false;
        });

        if (!hasMatch && (targetCityLower || targetCountry)) {
          const mismatchWarning = "Maps results do not match requested location";
          console.warn(
            `[GMAPS-DISCOVERY] ${mismatchWarning}: requested "${city || input.location}" but got places outside target. Stopping search.`,
          );
          lastError = mismatchWarning;
          break;
        }
      }

      totalPlacesFound += items.length;
      placesByCity[city || "Default"] = items.length;

      keywordStats.push({
        query: queryDescription,
        candidatesCount: 0,
        rawCount: items.length,
      });
      const currentStat = keywordStats[keywordStats.length - 1];

      // Measure overlap against prior coverage and skip 90-day cached place outcomes.
      const runPlaceIds = items
        .map((place) => (typeof place.placeId === "string" ? place.placeId : null))
        .filter((v): v is string => Boolean(v));
      const priorCoverageIds = new Set(
        coverageRows
          .filter(
            (row) =>
              row.keyword.toLowerCase() === runKeywordKey.toLowerCase() &&
              row.area.toLowerCase() === city.toLowerCase(),
          )
          .flatMap((row) => row.placeIds ?? []),
      );
      lastOverlapRatio = placeOverlapRatio(priorCoverageIds, runPlaceIds);
      const newPlaceIds = runPlaceIds.filter((id) => !priorCoverageIds.has(id));
      const newPlacesThisRun = newPlaceIds.length;
      totalNewPlaces += newPlacesThisRun;

      let knownOutcomes: Map<string, PlaceOutcomeRow> = new Map();
      if (ledgerUserId && runPlaceIds.length > 0) {
        try {
          knownOutcomes = await getKnownPlaceOutcomes(ledgerUserId, runPlaceIds);
        } catch (err) {
          log(`[GMAPS-DISCOVERY] Outcome cache unavailable: ${String(err)}`);
        }
      }
      if (knownOutcomes.size > 0) {
        outcomeCacheSkipped += knownOutcomes.size;
      }

      const firstBatchMostlySeen = isFirstBatchMostlySeen(
        newPlacesThisRun,
        runPlaceIds.length,
      );


      // 4. Process places: parse metadata and direct handles
      let parsedItems = items
        .filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === "object" && !Array.isArray(item),
        )
        .map((place) => {
          const businessName =
            typeof place.title === "string"
              ? place.title
              : typeof place.name === "string"
                ? place.name
                : null;
          const address =
            typeof place.address === "string"
              ? place.address
              : typeof place.street === "string"
                ? place.street
                : null;
          const placeCity =
            typeof place.city === "string" ? place.city : city || null;
          const placeCountry =
            typeof place.countryCode === "string" ? place.countryCode : null;
          const phone =
            typeof place.phone === "string"
              ? place.phone
              : typeof place.phoneUnformatted === "string"
                ? place.phoneUnformatted
                : null;
          const rawWebsite =
            typeof place.website === "string" && place.website.trim().length > 0
              ? place.website.trim()
              : null;
          const rating =
            typeof place.totalScore === "number"
              ? place.totalScore
              : typeof place.rating === "number"
                ? place.rating
                : null;
          const reviewsCount =
            typeof place.reviewsCount === "number" ? place.reviewsCount : null;
          const categories = Array.isArray(place.categories)
            ? (place.categories.filter((c) => typeof c === "string") as string[])
            : [];
          const gmapsCategory =
            typeof place.categoryName === "string"
              ? place.categoryName
              : categories[0] || null;
          const placeId =
            typeof place.placeId === "string" ? place.placeId : null;

          const email =
            typeof place.email === "string" && place.email.includes("@")
              ? place.email.trim()
              : Array.isArray(place.emails) && typeof place.emails[0] === "string" && place.emails[0].includes("@")
                ? place.emails[0].trim()
                : null;

          const permanentlyClosed = Boolean(place.permanentlyClosed || place.isPermanentlyClosed);
          const temporarilyClosed = Boolean(place.temporarilyClosed || place.isTemporarilyClosed);
          if (permanentlyClosed || temporarilyClosed) {
            return null;
          }

          const isClaimed =
            typeof place.isClaimed === "boolean"
              ? place.isClaimed
              : typeof place.claimThisBusiness === "boolean"
                ? !place.claimThisBusiness
                : null;

          const handles = extractInstagramHandlesFromPlace(place);
          const handleSource = (handles.length > 0 ? "maps" : null) as HandleSource | null;
          const handleConfidence = (handles.length > 0 ? "high" : null) as HandleConfidence | null;

          return {
            place,
            businessName,
            address,
            placeCity,
            placeCountry,
            phone,
            email,
            rawWebsite,
            rating,
            reviewsCount,
            categories,
            gmapsCategory,
            placeId,
            handles,
            handleSource,
            handleConfidence,
            isClaimed,
            socialLinks: {
              facebook: null,
              tiktok: null,
              linkedin: null,
              youtube: null,
              whatsapp: null,
            } as {
              facebook: string | null;
              tiktok: string | null;
              linkedin: string | null;
              youtube: string | null;
              whatsapp: string | null;
            },
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      // Pre-dedup against DB BEFORE the website waterfall: duplicates cost no
      // website fetch, no handle search, no Gemini, no profile enrichment.
      parsedItems = parsedItems.filter((p) => {
        if (p.placeId && existingDbPlaceIds.has(p.placeId)) {
          totalDuplicatesSkipped++;
          return false;
        }
        const domain = p.rawWebsite ? normalizeWebsite(p.rawWebsite)?.domain ?? null : null;
        if (domain && existingDbWebsiteDomains.has(domain)) {
          totalDuplicatesSkipped++;
          return false;
        }
        const phone = p.phone ? normalizePhone(p.phone) : null;
        if (phone && existingDbPhones.has(phone)) {
          totalDuplicatesSkipped++;
          return false;
        }
        const handle = p.handles[0];
        if (handle && existingDbUsernames.has(handle.toLowerCase())) {
          totalDuplicatesSkipped++;
          return false;
        }
        return true;
      });

      // Concurrently run handle discovery waterfall (concurrency 5) for places
      // with a website to discover Instagram handles and other social links
      const placesWithWebsite = parsedItems.filter((p) => p.rawWebsite);
      if (placesWithWebsite.length > 0) {
        await runWithConcurrency(placesWithWebsite, 5, async (p) => {
          try {
            const waterfallRes = await runHandleDiscoveryWaterfall({
              businessName: p.businessName,
              websiteUrl: p.rawWebsite,
              mapsHandles: p.handles,
              mapsSocial: p.socialLinks,
            });
            if (waterfallRes.handle) {
              p.handles = [waterfallRes.handle];
              p.handleSource = waterfallRes.handleSource;
              p.handleConfidence = waterfallRes.handleConfidence;
            }
            if (waterfallRes.socialLinks) {
              p.socialLinks = {
                facebook: waterfallRes.socialLinks.facebook ?? p.socialLinks.facebook,
                tiktok: waterfallRes.socialLinks.tiktok ?? p.socialLinks.tiktok,
                linkedin: waterfallRes.socialLinks.linkedin ?? p.socialLinks.linkedin,
                youtube: waterfallRes.socialLinks.youtube ?? p.socialLinks.youtube,
                whatsapp: waterfallRes.socialLinks.whatsapp ?? p.socialLinks.whatsapp,
              };
            }

            // Step 2: Name / Website mismatch check
            const matchRes = checkNameWebsiteMismatch({
              businessName: p.businessName,
              websiteUrl: p.rawWebsite,
            });
            if (matchRes.isMismatch) {
              (p as { flags?: string[] }).flags = [...((p as { flags?: string[] }).flags ?? []), "NAME_WEBSITE_MISMATCH"];
              (p as { nameWebsiteMismatch?: boolean }).nameWebsiteMismatch = true;
              // Downgrade handle confidence to low when handle came from a mismatching website
              if (p.handleSource && ["homepage", "contact_page", "linkhub", "website"].includes(p.handleSource)) {
                p.handleConfidence = "low";
              }
            }
          } catch {
            // Ignore website fetch errors
          }
          return null;
        });
      }

      // Step 3: Cluster multi-location groups across parsedItems
      const groupClusters = clusterMultiLocationGroups(
        parsedItems.map((p) => ({
          website: p.rawWebsite,
          username: p.handles[0] ?? null,
          email: p.email,
          fullName: p.businessName,
          ref: p,
        })),
      );
      for (const [item, outcome] of groupClusters.entries()) {
        const p = (item as unknown as { ref: (typeof parsedItems)[0] }).ref;
        if (outcome.isGroup) {
          (p as { isGroup?: boolean }).isGroup = true;
          (p as { groupKey?: string | null }).groupKey = outcome.groupKey;
        }
      }

      // Filter and aggregate surviving candidates
      let runLeadsWithIg = 0;
      const outcomesToRecord: Array<{
        placeId: string;
        outcome: "accepted" | "rejected" | "no_contact";
        reason?: string | null;
      }> = [];
      for (const p of parsedItems) {
        if (p.placeId && knownOutcomes.has(p.placeId)) {
          totalDuplicatesSkipped++;
          continue;
        }
        if (p.rawWebsite) {
          totalWithWebsite++;
        }

        const websiteDomain = p.rawWebsite
          ? normalizeWebsite(p.rawWebsite)?.domain ?? null
          : null;
        const websiteKey = p.rawWebsite
          ? normalizeWebsite(p.rawWebsite)?.key ?? null
          : null;
        const normPhone = p.phone ? normalizePhone(p.phone) : null;

        // Compute available channels
        const channels: string[] = [];
        if (p.handles.length > 0) channels.push("INSTAGRAM");
        if (p.email) channels.push("EMAIL");
        if (p.phone) channels.push("PHONE");
        if (p.phone && (p.socialLinks.whatsapp || p.phone.startsWith("+"))) channels.push("WHATSAPP");
        if (p.rawWebsite) channels.push("WEBSITE");

        if (p.handles.length === 0) {
          totalNoInstagram++;
          // Step 1: If place has NO IG handle and NO other channels, drop it
          if (channels.length === 0) {
            placesDroppedNoContact++;
            if (p.placeId) {
              outcomesToRecord.push({ placeId: p.placeId, outcome: "no_contact" });
            }
            continue;
          }

          // Dedup multi-channel lead by:
          // 1. placeId
          // 2. websiteDomain
          // 3. normalizedPhone
          if (p.placeId && (seenPlaceIds.has(p.placeId) || existingDbPlaceIds.has(p.placeId))) {
            totalDuplicatesSkipped++;
            outcomesToRecord.push({ placeId: p.placeId, outcome: "rejected", reason: "duplicate" });
            continue;
          }
          if (websiteDomain && (seenWebsiteDomains.has(websiteDomain) || existingDbWebsiteDomains.has(websiteDomain))) {
            totalDuplicatesSkipped++;
            if (p.placeId) outcomesToRecord.push({ placeId: p.placeId, outcome: "rejected", reason: "duplicate" });
            continue;
          }
          if (websiteKey && existingDbWebsiteKeys.has(websiteKey)) {
            totalDuplicatesSkipped++;
            continue;
          }
          if (normPhone && (seenPhones.has(normPhone) || existingDbPhones.has(normPhone))) {
            totalDuplicatesSkipped++;
            continue;
          }

          if (p.placeId) {
            seenPlaceIds.add(p.placeId);
            outcomesToRecord.push({ placeId: p.placeId, outcome: "accepted" });
          }
          if (websiteDomain) seenWebsiteDomains.add(websiteDomain);
          if (normPhone) seenPhones.add(normPhone);

          leadsNoIgButContactable++;
          currentStat.candidatesCount++;

          candidates.push({
            username: null,
            instagramUsername: null,
            profileUrl: null,
            fullName: p.businessName,
            category: p.gmapsCategory,
            businessCategoryName: p.gmapsCategory,
            location: p.placeCity || p.address || null,
            externalUrl: p.rawWebsite,
            website: p.rawWebsite,
            phone: p.phone,
            email: p.email,
            availableChannels: channels,
            businessAddress: {
              city_name: p.placeCity ?? undefined,
              street_address: p.address ?? undefined,
            },
            gmapsCategory: p.gmapsCategory,
            gmapsCategories: p.categories,
            gmapsCity: p.placeCity,
            gmapsAddress: p.address,
            gmapsCountry: p.placeCountry,
            gmapsRating: p.rating,
            gmapsReviews: p.reviewsCount,
            gmapsPlaceId: p.placeId,
            isClaimed: p.isClaimed,
            socialLinks: p.socialLinks,
            sourceProvider: "google_maps",
            handleSource: p.handleSource ?? null,
            handleConfidence: p.handleConfidence ?? null,
            isGroup: (p as { isGroup?: boolean }).isGroup ?? false,
            groupKey: (p as { groupKey?: string | null }).groupKey ?? null,
            flags: (p as { flags?: string[] }).flags ?? [],
            nameWebsiteMismatch: (p as { nameWebsiteMismatch?: boolean }).nameWebsiteMismatch ?? false,
          });
          continue;
        }

        // Place has Instagram handle
        totalWithInstagram++;
        leadsWithIg++;
        const username = p.handles[0];

        // Deduplication
        if (seenHandles.has(username) || existingDbUsernames.has(username)) {
          totalDuplicatesSkipped++;
          if (p.placeId) outcomesToRecord.push({ placeId: p.placeId, outcome: "rejected", reason: "duplicate" });
          continue;
        }
        if (p.placeId && (seenPlaceIds.has(p.placeId) || existingDbPlaceIds.has(p.placeId))) {
          totalDuplicatesSkipped++;
          outcomesToRecord.push({ placeId: p.placeId, outcome: "rejected", reason: "duplicate" });
          continue;
        }
        if (websiteDomain && (seenWebsiteDomains.has(websiteDomain) || existingDbWebsiteDomains.has(websiteDomain))) {
          totalDuplicatesSkipped++;
          if (p.placeId) outcomesToRecord.push({ placeId: p.placeId, outcome: "rejected", reason: "duplicate" });
          continue;
        }
        if (websiteKey && existingDbWebsiteKeys.has(websiteKey)) {
          totalDuplicatesSkipped++;
          continue;
        }
        if (normPhone && (seenPhones.has(normPhone) || existingDbPhones.has(normPhone))) {
          totalDuplicatesSkipped++;
          continue;
        }

        seenHandles.add(username);
        if (p.placeId) {
          seenPlaceIds.add(p.placeId);
          outcomesToRecord.push({ placeId: p.placeId, outcome: "accepted" });
        }
        if (websiteDomain) seenWebsiteDomains.add(websiteDomain);
        if (normPhone) seenPhones.add(normPhone);

        runLeadsWithIg++;

        currentStat.candidatesCount++;

        candidates.push({
          username,
          instagramUsername: username,
          profileUrl: `https://www.instagram.com/${username}/`,
          fullName: p.businessName,
          category: p.gmapsCategory,
          businessCategoryName: p.gmapsCategory,
          location: p.placeCity || p.address || null,
          externalUrl: p.rawWebsite,
          website: p.rawWebsite,
          phone: p.phone,
          email: p.email,
          availableChannels: channels,
          businessAddress: {
            city_name: p.placeCity ?? undefined,
            street_address: p.address ?? undefined,
          },
          gmapsCategory: p.gmapsCategory,
          gmapsCategories: p.categories,
          gmapsCity: p.placeCity,
          gmapsAddress: p.address,
          gmapsCountry: p.placeCountry,
          gmapsRating: p.rating,
          gmapsReviews: p.reviewsCount,
          gmapsPlaceId: p.placeId,
          isClaimed: p.isClaimed,
          socialLinks: p.socialLinks,
          sourceProvider: "google_maps",
          handleSource: p.handleSource ?? "maps",
          handleConfidence: p.handleConfidence ?? "high",
          isGroup: (p as { isGroup?: boolean }).isGroup ?? false,
          groupKey: (p as { groupKey?: string | null }).groupKey ?? null,
          flags: (p as { flags?: string[] }).flags ?? [],
          nameWebsiteMismatch: (p as { nameWebsiteMismatch?: boolean }).nameWebsiteMismatch ?? false,
        });
      }

      // Persist coverage ledger + place outcomes (best-effort; never blocks discovery).
      if (ledgerUserId) {
        try {
          await recordCoverage({
            userId: ledgerUserId,
            campaignId: input.campaignId ?? null,
            keyword: runKeywordKey,
            area: city,
            placeIds: runPlaceIds,
            newPlaces: newPlacesThisRun,
            acceptedLeads: runLeadsWithIg,
          });
          coverageRows.push({
            keyword: runKeywordKey,
            area: city,
            runDate: new Date(),
            placeIds: runPlaceIds,
            newPlaces: newPlacesThisRun,
            acceptedLeads: runLeadsWithIg,
          });
        } catch (err) {
          log(`[GMAPS-DISCOVERY] Failed to record coverage: ${String(err)}`);
        }
        if (outcomesToRecord.length > 0) {
          try {
            await recordPlaceOutcomes(
              ledgerUserId,
              outcomesToRecord.map((o) => ({
                ...o,
                keyword: runKeywordKey,
                area: city,
              })),
            );
          } catch (err) {
            log(`[GMAPS-DISCOVERY] Failed to record place outcomes: ${String(err)}`);
          }
        }
      }

      areaYield[city] = runLeadsWithIg;
      keywordYield[runKeywordKey] = (keywordYield[runKeywordKey] ?? 0) + runLeadsWithIg;

      // >70% overlap: drop this keyword/area variant and rotate to the next area.
      if (shouldDropKeyword(lastOverlapRatio)) {
        log(
          `[GMAPS-DISCOVERY] Keyword overlap ${(lastOverlapRatio * 100).toFixed(0)}% > 70% for "${runKeywordKey}" in "${city}". Rotating area.`,
        );
        stopReason = "keyword_overlap";
        continue;
      }

      // Auto-stop when a paid batch cannot produce enough IG-ready leads.
      if (
        areApifyCostLimitsEnabled() &&
        shouldStopForLowYield(
          items.length,
          runLeadsWithIg,
          getMinIgYieldPercent(),
        )
      ) {
        stopReason = "low_ig_yield";
        log(
          `[GMAPS-DISCOVERY] Low IG yield ${computeIgYieldPercent(items.length, runLeadsWithIg).toFixed(1)}% < ${getMinIgYieldPercent()}%. Stopping and recommending another keyword/area.`,
        );
        break;
      }

      if (firstBatchMostlySeen) {
        log(
          `[GMAPS-DISCOVERY] First batch >60% already seen in "${city}". Moving to the next planned area instead of paging deeper.`,
        );
      }
    }

    log(
      `[GMAPS-DISCOVERY] Finished. Places found=${totalPlacesFound}, withWebsite=${totalWithWebsite}, withInstagram=${totalWithInstagram}, noInstagram=${totalNoInstagram}, leadsWithIg=${leadsWithIg}, leadsNoIgButContactable=${leadsNoIgButContactable}, placesDroppedNoContact=${placesDroppedNoContact}, duplicatesSkipped=${totalDuplicatesSkipped}, acceptedCandidates=${candidates.length}`,
    );

    return {
      candidates,
      runId: lastRunId,
      datasetId: lastDatasetId,
      actor: actorId,
      usageTotalUsd: accumulatedUsd,
      computeUnits: accumulatedComputeUnits,
      keywordStats,
      executedQueries,
      gmapsPlacesFound: totalPlacesFound,
      newPlaces: totalNewPlaces,
      gmapsWithWebsite: totalWithWebsite,
      gmapsWithInstagram: totalWithInstagram,
      noInstagramCount: totalNoInstagram,
      leadsWithIg,
      leadsNoIgButContactable,
      placesDroppedNoContact,
      duplicatesSkipped: totalDuplicatesSkipped,
      placesByCity,
      sourceProvider: "google_maps",
      actualCostUsd: Number(actualCostUsd.toFixed(4)),
      chargedEvents: chargedEventsAll,
      coverageSkipped: coveredAreasSkipped,
      outcomeCacheSkipped,
      placeOverlapRatio: Number(lastOverlapRatio.toFixed(4)),
      areaYield,
      keywordYield,
      stopReason,
      error: lastError ?? undefined,
      errorsCount,
    };
  }
}
