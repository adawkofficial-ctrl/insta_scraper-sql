/**
 * Deterministic, server-side discovery relevance gate.
 *
 * The discovery Actor (`apify/instagram-search-scraper`) is a generic Instagram
 * user search: it has no notion of "Fitness" or "Rawalpindi". Its results must
 * therefore be validated against the campaign intent/category/location BEFORE
 * they are enriched further and persisted as leads.
 *
 * This module is pure (no DB / provider / server-only imports) so the policy is
 * unit-testable and reusable. It never fabricates a location match: absent
 * evidence yields UNKNOWN, not MATCHED.
 */

import type { LeadProfile } from "@/lib/types";

export type RelevanceMatch = "MATCHED" | "NOT_MATCHED" | "UNKNOWN";

export type DiscoverySkipReason =
  | "IRRELEVANT_CATEGORY"
  | "IRRELEVANT_INTENT"
  | "IRRELEVANT_LOCATION"
  | "IRRELEVANT_LOCATION_NATIONAL_SCALE"
  | "INSUFFICIENT_RELEVANCE_DATA"
  | "DUPLICATE"
  | "CAMPAIGN_CAPACITY_REACHED"
  | "CANDIDATE_BOUND_REACHED"
  | "ACTOR_ERROR"
  | "ENRICHMENT_FAILED"
  | "DNC_SUPPRESSED"
  | "PRIVATE_PROFILE"
  | "MALFORMED";

export const DISCOVERY_SKIP_REASONS: readonly DiscoverySkipReason[] = [
  "IRRELEVANT_CATEGORY",
  "IRRELEVANT_INTENT",
  "IRRELEVANT_LOCATION",
  "IRRELEVANT_LOCATION_NATIONAL_SCALE",
  "INSUFFICIENT_RELEVANCE_DATA",
  "DUPLICATE",
  "CAMPAIGN_CAPACITY_REACHED",
  "CANDIDATE_BOUND_REACHED",
  "ACTOR_ERROR",
  "ENRICHMENT_FAILED",
  "DNC_SUPPRESSED",
  "PRIVATE_PROFILE",
  "MALFORMED",
];

export type DiscoverySkipCounts = Record<DiscoverySkipReason, number>;

export function createEmptySkipCounts(): DiscoverySkipCounts {
  return DISCOVERY_SKIP_REASONS.reduce((acc, reason) => {
    acc[reason] = 0;
    return acc;
  }, {} as DiscoverySkipCounts);
}

export function sumSkipCounts(counts: DiscoverySkipCounts): number {
  return DISCOVERY_SKIP_REASONS.reduce((total, reason) => total + counts[reason], 0);
}

export const DEFAULT_NATIONAL_SCALE_FOLLOWER_THRESHOLD = 500_000;
export const DEFAULT_NATIONAL_CATEGORIES: readonly string[] = [
  "magazine",
  "media",
  "news",
  "entertainment",
  "tv",
  "broadcasting",
  "publisher",
  "journalist",
  "newspaper",
];

export function getNationalScaleFollowerThreshold(): number {
  if (typeof process !== "undefined" && process.env?.NATIONAL_SCALE_FOLLOWER_THRESHOLD) {
    const parsed = Number.parseInt(process.env.NATIONAL_SCALE_FOLLOWER_THRESHOLD, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_NATIONAL_SCALE_FOLLOWER_THRESHOLD;
}

export function getNationalCategories(): string[] {
  if (typeof process !== "undefined" && process.env?.NATIONAL_SCALE_CATEGORIES) {
    return process.env.NATIONAL_SCALE_CATEGORIES.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }
  return [...DEFAULT_NATIONAL_CATEGORIES];
}

/**
 * Campaign-level discovery relevance policy.
 *
 * Defaults are intentionally permissive on *missing* metadata: a profile with no
 * location evidence is UNKNOWN (allowed), not rejected — otherwise legitimate
 * fitness businesses without an Instagram location field would be dropped. An
 * explicit location field that contradicts the campaign (e.g. "Dubai" for a
 * Rawalpindi campaign) is NOT_MATCHED and rejected.
 *
 * Accounts exceeding nationalScaleFollowerThreshold (default 500,000) with a
 * broad national category (e.g. Magazine, Media) without explicit matching location
 * are rejected as IRRELEVANT_LOCATION_NATIONAL_SCALE.
 */
export type DiscoveryRelevancePolicy = {
  /** Require a campaign-intent keyword match. */
  requireIntentMatch: boolean;
  /** Require a campaign-category keyword match. */
  requireCategoryMatch: boolean;
  /** Require an explicit location match (UNKNOWN then fails). */
  requireLocationMatch: boolean;
  /** Allow location UNKNOWN to pass (default true). */
  allowUnknownLocation: boolean;
  /** Allow category UNKNOWN to pass (default true). */
  allowUnknownCategory: boolean;
  /** Follower threshold above which national media accounts are flagged (default 500,000). */
  nationalScaleFollowerThreshold?: number;
  /** Categories considered broad/national (e.g. Magazine, Media). */
  nationalCategories?: string[];
};

export const DEFAULT_DISCOVERY_RELEVANCE_POLICY: DiscoveryRelevancePolicy = {
  requireIntentMatch: false,
  requireCategoryMatch: false,
  requireLocationMatch: false,
  allowUnknownLocation: true,
  allowUnknownCategory: true,
  nationalScaleFollowerThreshold: DEFAULT_NATIONAL_SCALE_FOLLOWER_THRESHOLD,
  nationalCategories: [...DEFAULT_NATIONAL_CATEGORIES],
};

export type RelevanceCampaignContext = {
  intent: string | null;
  location: string | null;
  category: string | null;
};

export type ProfileRelevance = {
  categoryMatch: RelevanceMatch;
  locationMatch: RelevanceMatch;
  intentMatch: RelevanceMatch;
  intentTerms: string[];
  categoryTerms: string[];
  locationTerms: string[];
  matchedIntentTerms: string[];
  matchedCategoryTerms: string[];
  matchedLocationTerms: string[];
  isNationalScale?: boolean;
  isNationalScaleLocationMismatch?: boolean;
};

export type RelevanceDecision =
  | { relevant: true }
  | { relevant: false; reason: DiscoverySkipReason };

// ---------------------------------------------------------------------------
// Term extraction
// ---------------------------------------------------------------------------

const RELEVANCE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/**
 * Category keyword lexicons. Matching the campaign category (or a profile's own
 * declared category) against these expansions is deterministic and offline.
 * Unknown categories fall back to their own significant tokens.
 */
const CATEGORY_LEXICON: Record<string, string[]> = {
  fitness: [
    "fitness",
    "gym",
    "gyms",
    "gymnasium",
    "workout",
    "workouts",
    "trainer",
    "trainers",
    "training",
    "coach",
    "coaching",
    "crossfit",
    "bodybuilding",
    "bodybuilder",
    "strength",
    "conditioning",
    "health",
    "wellness",
    "sports",
    "athlete",
    "athletes",
    "athletic",
    "yoga",
    "pilates",
    "cardio",
    "nutrition",
    "diet",
    "dietitian",
    "muscle",
    "exercise",
    "weightlifting",
    "physique",
    "fitnesscenter",
    "personaltrainer",
  ],
  beauty: [
    "beauty",
    "salon",
    "spa",
    "makeup",
    "cosmetics",
    "skincare",
    "hairdresser",
    "hairstylist",
    "barber",
    "nails",
    "aesthetic",
    "beautician",
  ],
  food: [
    "food",
    "restaurant",
    "cafe",
    "coffee",
    "bakery",
    "kitchen",
    "chef",
    "catering",
    "eatery",
    "bistro",
    "diner",
    "dessert",
  ],
  realestate: [
    "realestate",
    "real",
    "estate",
    "realtor",
    "property",
    "properties",
    "broker",
    "housing",
    "homes",
  ],
  travel: [
    "travel",
    "tourism",
    "tour",
    "tours",
    "tourist",
    "vacation",
    "holiday",
    "hotel",
    "resort",
    "trip",
  ],
  fashion: [
    "fashion",
    "clothing",
    "apparel",
    "boutique",
    "style",
    "stylist",
    "designer",
    "wardrobe",
  ],
  music: [
    "music",
    "musician",
    "band",
    "singer",
    "artist",
    "dj",
    "producer",
    "songwriter",
    "rapper",
  ],
  technology: [
    "technology",
    "tech",
    "software",
    "developer",
    "startup",
    "saas",
    "it",
    "digital",
    "agency",
  ],
  marketing: [
    "marketing",
    "advertising",
    "branding",
    "seo",
    "socialmedia",
    "agency",
    "growth",
    "digitalmarketing",
  ],
  education: [
    "education",
    "school",
    "college",
    "university",
    "academy",
    "teacher",
    "tutor",
    "tutoring",
    "learning",
  ],
  healthcare: [
    "healthcare",
    "clinic",
    "doctor",
    "dentist",
    "hospital",
    "medical",
    "pharmacy",
    "therapist",
    "wellness",
  ],
  photography: [
    "photography",
    "photographer",
    "photo",
    "photoshoot",
    "videography",
    "videographer",
    "studio",
  ],
};

export function normalizeRelevanceText(
  value: string | null | undefined,
): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strips simple plural endings so "gyms" matches "gym", "businesses" -> "business". */
function stemVariants(term: string): string[] {
  const variants = new Set<string>([term]);
  if (term.length <= 3 || /^\d+$/.test(term) || term.endsWith("ss")) {
    return [...variants];
  }
  if (term.endsWith("ies") && term.length > 4) {
    variants.add(`${term.slice(0, -3)}y`);
    return [...variants];
  }
  if (term.endsWith("es") && term.length > 4) {
    variants.add(term.slice(0, -2));
    return [...variants];
  }
  if (term.endsWith("s")) {
    variants.add(term.slice(0, -1));
  }
  return [...variants];
}

export function extractSignificantTerms(
  value: string | null | undefined,
): string[] {
  const normalized = normalizeRelevanceText(value);
  if (normalized.length === 0) {
    return [];
  }

  const terms: string[] = [];
  const seen = new Set<string>();

  for (const token of normalized.split(" ")) {
    if (
      token.length < 2 ||
      RELEVANCE_STOPWORDS.has(token) ||
      /^\d+$/.test(token)
    ) {
      continue;
    }
    for (const variant of stemVariants(token)) {
      if (seen.has(variant)) {
        continue;
      }
      seen.add(variant);
      terms.push(variant);
    }
  }

  return terms;
}

export function buildCategoryTerms(category: string | null): string[] {
  if (category === null || category.trim().length === 0) {
    return [];
  }

  const normalized = normalizeRelevanceText(category);
  const terms = new Set<string>();

  for (const [lexiconKey, values] of Object.entries(CATEGORY_LEXICON)) {
    if (normalized.includes(lexiconKey)) {
      for (const value of values) {
        for (const variant of stemVariants(value)) {
          terms.add(variant);
        }
      }
    }
  }

  for (const term of extractSignificantTerms(category)) {
    terms.add(term);
  }

  return [...terms];
}

const LOCATION_ALIASES: Record<string, string[]> = {
  rawalpindi: ["rawalpindi", "rwp", "pindi"],
  islamabad: ["islamabad", "isb"],
  lahore: ["lahore", "lhr"],
  karachi: ["karachi", "khi"],
  peshawar: ["peshawar", "pew"],
  multan: ["multan", "mux"],
  faisalabad: ["faisalabad", "fsd"],
};

export const BROAD_COUNTRY_TOKENS: ReadonlySet<string> = new Set([
  "pakistan",
  "pk",
  "usa",
  "us",
  "uk",
  "uae",
  "india",
  "canada",
  "australia",
  "worldwide",
  "global",
  "international",
]);

export function buildLocationTerms(location: string | null): string[] {
  if (location === null || location.trim().length === 0) {
    return [];
  }

  const normalized = normalizeRelevanceText(location);
  if (normalized.length === 0) {
    return [];
  }

  const tokens = normalized.split(" ").filter((t) => t.length > 0);
  const nonCountryTokens = tokens.filter((t) => !BROAD_COUNTRY_TOKENS.has(t));
  const hasSpecificCityToken = nonCountryTokens.length > 0;

  const terms = new Set<string>();
  if (!hasSpecificCityToken) {
    terms.add(normalized);
  }

  for (const token of tokens) {
    // If a more specific city token exists, ignore broad country tokens (e.g. in "Islamabad, Pakistan", "pakistan" is omitted).
    if (hasSpecificCityToken && BROAD_COUNTRY_TOKENS.has(token)) {
      continue;
    }

    if (token.length >= 3) {
      terms.add(token);
    }
    const aliases = LOCATION_ALIASES[token];
    if (aliases) {
      for (const alias of aliases) {
        terms.add(alias);
      }
    }
  }

  const fullAliases = LOCATION_ALIASES[normalized];
  if (fullAliases) {
    for (const alias of fullAliases) {
      terms.add(alias);
    }
  }

  return [...terms];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function textContainsTerm(haystack: string, term: string): boolean {
  if (haystack.length === 0 || term.length === 0) {
    return false;
  }
  const pattern = new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(term)}(s|es)?([^a-z0-9]|$)`,
  );
  return pattern.test(haystack);
}

export function findMatchedTerms(haystack: string, terms: string[]): string[] {
  return terms.filter((term) => textContainsTerm(haystack, term));
}

// ---------------------------------------------------------------------------
// Profile evaluation
// ---------------------------------------------------------------------------

function collectProfileText(profile: LeadProfile): string[] {
  const parts: Array<string | null | undefined> = [
    profile.username,
    profile.fullName,
    profile.biography,
    profile.businessCategoryName,
    profile.category,
    profile.location,
    profile.externalUrl,
    profile.website,
  ];

  for (const post of profile.latestPosts ?? []) {
    if (post.caption) {
      parts.push(post.caption);
    }
    const loc = (post as unknown as { locationName?: string }).locationName;
    if (loc && typeof loc === "string") {
      parts.push(loc);
    }
  }

  for (const related of profile.relatedProfiles ?? []) {
    parts.push(related.username, related.fullName);
  }

  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => normalizeRelevanceText(part))
    .filter((part) => part.length > 0);
}

export function evaluateProfileRelevance(
  profile: LeadProfile,
  campaign: RelevanceCampaignContext,
  policy: DiscoveryRelevancePolicy = DEFAULT_DISCOVERY_RELEVANCE_POLICY,
): ProfileRelevance {
  const haystack = collectProfileText(profile).join(" \u0001 ");

  const intentTerms = extractSignificantTerms(campaign.intent);
  const categoryTerms = buildCategoryTerms(campaign.category);
  const locationTerms = buildLocationTerms(campaign.location);

  const profileCategoryText = normalizeRelevanceText(
    [profile.businessCategoryName, profile.category]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" "),
  );

  const matchedIntentTerms = findMatchedTerms(haystack, intentTerms);
  // Category is evaluated against the profile's OWN declared category only, so a
  // musician biography that happens to mention "fitness" is not mislabelled.
  const matchedCategoryTerms = findMatchedTerms(
    profileCategoryText,
    categoryTerms,
  );
  const matchedLocationTerms = findMatchedTerms(haystack, locationTerms);

  const categoryMatch: RelevanceMatch =
    categoryTerms.length === 0
      ? "UNKNOWN"
      : matchedCategoryTerms.length > 0
        ? "MATCHED"
        : profileCategoryText.length > 0
          ? "NOT_MATCHED"
          : "UNKNOWN";

  const intentMatch: RelevanceMatch =
    intentTerms.length === 0
      ? "UNKNOWN"
      : matchedIntentTerms.length > 0
        ? "MATCHED"
        : "NOT_MATCHED";

  const profileLocationText = normalizeRelevanceText(profile.location);
  const profileBioText = normalizeRelevanceText(profile.biography);
  const explicitLocationMatched =
    (profileLocationText.length > 0 &&
      findMatchedTerms(profileLocationText, locationTerms).length > 0) ||
    (profileBioText.length > 0 &&
      findMatchedTerms(profileBioText, locationTerms).length > 0);

  const threshold =
    policy.nationalScaleFollowerThreshold ??
    getNationalScaleFollowerThreshold();
  const nationalCategories =
    policy.nationalCategories ?? getNationalCategories();
  const followers = profile.followers ?? profile.followersCount ?? 0;

  const isNationalCategory = nationalCategories.some((cat) =>
    profileCategoryText.includes(cat),
  );
  const isNationalScale = followers >= threshold && isNationalCategory;

  const hasLocationConstraint = locationTerms.length > 0;
  // A national-scale media/magazine account targeting a city is a mismatch UNLESS it has an explicit city match in bio/location.
  const isNationalScaleLocationMismatch =
    hasLocationConstraint && isNationalScale && !explicitLocationMatched;

  const locationMatch: RelevanceMatch =
    locationTerms.length === 0
      ? "UNKNOWN"
      : explicitLocationMatched
        ? "MATCHED"
        : isNationalScaleLocationMismatch
          ? "NOT_MATCHED"
          : matchedLocationTerms.length > 0
            ? "MATCHED"
            : profileLocationText.length > 0
              ? "NOT_MATCHED"
              : "UNKNOWN";

  return {
    categoryMatch,
    locationMatch,
    intentMatch,
    intentTerms,
    categoryTerms,
    locationTerms,
    matchedIntentTerms,
    matchedCategoryTerms,
    matchedLocationTerms,
    isNationalScale,
    isNationalScaleLocationMismatch,
  };
}

export function decideRelevance(
  relevance: ProfileRelevance,
  policy: DiscoveryRelevancePolicy = DEFAULT_DISCOVERY_RELEVANCE_POLICY,
): RelevanceDecision {
  let topicalMatched: boolean;
  if (policy.requireIntentMatch && policy.requireCategoryMatch) {
    topicalMatched =
      relevance.intentMatch === "MATCHED" &&
      relevance.categoryMatch === "MATCHED";
  } else if (policy.requireIntentMatch) {
    topicalMatched = relevance.intentMatch === "MATCHED";
  } else if (policy.requireCategoryMatch) {
    topicalMatched = relevance.categoryMatch === "MATCHED";
  } else {
    // Default: at least one topical signal (intent or category) must match.
    topicalMatched =
      relevance.intentMatch === "MATCHED" ||
      relevance.categoryMatch === "MATCHED";
  }

  if (topicalMatched && !policy.allowUnknownCategory) {
    if (relevance.categoryMatch !== "MATCHED") {
      return { relevant: false, reason: "INSUFFICIENT_RELEVANCE_DATA" };
    }
  }

  if (!topicalMatched) {
    if (relevance.categoryMatch === "NOT_MATCHED") {
      return { relevant: false, reason: "IRRELEVANT_CATEGORY" };
    }
    if (relevance.intentMatch === "NOT_MATCHED") {
      return { relevant: false, reason: "IRRELEVANT_INTENT" };
    }
    return { relevant: false, reason: "INSUFFICIENT_RELEVANCE_DATA" };
  }

  if (relevance.isNationalScaleLocationMismatch) {
    return { relevant: false, reason: "IRRELEVANT_LOCATION_NATIONAL_SCALE" };
  }

  if (relevance.locationMatch === "NOT_MATCHED") {
    return { relevant: false, reason: "IRRELEVANT_LOCATION" };
  }

  if (
    relevance.locationMatch === "UNKNOWN" &&
    (policy.requireLocationMatch || !policy.allowUnknownLocation)
  ) {
    return { relevant: false, reason: "IRRELEVANT_LOCATION" };
  }

  return { relevant: true };
}

// ---------------------------------------------------------------------------
// Candidate de-duplication
// ---------------------------------------------------------------------------

export type DeduplicatedCandidates = {
  unique: string[];
  duplicates: string[];
};

export function deduplicateCandidates(
  usernames: string[],
  existingUsernames: Iterable<string> = [],
): DeduplicatedCandidates {
  const existing = new Set<string>();
  for (const username of existingUsernames) {
    existing.add(username.toLowerCase());
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  const duplicates: string[] = [];

  for (const username of usernames) {
    const normalized = username.trim().toLowerCase();
    if (normalized.length === 0) {
      continue;
    }
    if (existing.has(normalized) || seen.has(normalized)) {
      duplicates.push(normalized);
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return { unique, duplicates };
}

// ---------------------------------------------------------------------------
// Batched relevance-gated collection (pure orchestration)
// ---------------------------------------------------------------------------

export type EnrichmentBatchResult = {
  profiles: LeadProfile[];
  /** Usernames the enrichment provider explicitly failed to fetch. */
  skipped: string[];
};

export type CollectRelevantLeadsInput = {
  candidates: string[];
  capacity: number;
  campaign: RelevanceCampaignContext;
  policy?: DiscoveryRelevancePolicy;
  batchSize?: number;
  /** Safe upper bound on how many candidates may be enriched in one run. */
  maxCandidates?: number;
  enrich: (batch: string[]) => Promise<EnrichmentBatchResult>;
  onBatch?: (info: CollectRelevantLeadsBatchInfo) => void;
};

export type CollectRelevantLeadsBatchInfo = {
  candidatesProcessed: number;
  candidatesEnriched: number;
  enrichmentFailures: number;
  relevantCount: number;
  skipCounts: DiscoverySkipCounts;
};

export type CollectRelevantLeadsResult = {
  relevant: LeadProfile[];
  candidatesProcessed: number;
  candidatesEnriched: number;
  enrichmentFailures: number;
  skipCounts: DiscoverySkipCounts;
};

/**
 * Enriches candidates in batches and keeps only those that pass the relevance
 * policy, continuing until `capacity` relevant leads are collected, candidates
 * are exhausted, or the safe candidate bound is reached.
 *
 * This is what prevents "stop after 5 raw candidates": irrelevant candidates are
 * skipped and the pipeline keeps consuming the pool.
 */
export async function collectRelevantLeads(
  input: CollectRelevantLeadsInput,
): Promise<CollectRelevantLeadsResult> {
  const policy = input.policy ?? DEFAULT_DISCOVERY_RELEVANCE_POLICY;
  const batchSize = Math.max(1, input.batchSize ?? 10);
  const maxCandidates = Math.max(
    0,
    Math.min(input.maxCandidates ?? input.candidates.length, input.candidates.length),
  );

  const skipCounts = createEmptySkipCounts();
  const relevant: LeadProfile[] = [];
  const seenUsernames = new Set<string>();

  let candidatesProcessed = 0;
  let candidatesEnriched = 0;
  let enrichmentFailures = 0;

  for (
    let offset = 0;
    offset < input.candidates.length &&
    relevant.length < input.capacity &&
    candidatesProcessed < maxCandidates;
    offset += batchSize
  ) {
    const remainingBound = maxCandidates - candidatesProcessed;
    const batch = input.candidates.slice(
      offset,
      Math.min(offset + batchSize, offset + remainingBound),
    );
    if (batch.length === 0) {
      break;
    }
    candidatesProcessed += batch.length;

    const enrichment = await input.enrich(batch);
    const returnedUsernames = new Set(
      enrichment.profiles.map((profile) => profile.username.toLowerCase()),
    );
    const missing = batch.filter(
      (username) => !returnedUsernames.has(username.toLowerCase()),
    );
    const failures = Math.max(missing.length, enrichment.skipped.length);
    enrichmentFailures += failures;
    skipCounts.ENRICHMENT_FAILED += failures;
    candidatesEnriched += enrichment.profiles.length;

    for (const profile of enrichment.profiles) {
      const username = profile.username.toLowerCase();
      if (seenUsernames.has(username)) {
        skipCounts.DUPLICATE += 1;
        continue;
      }
      seenUsernames.add(username);

      if (relevant.length >= input.capacity) {
        skipCounts.CAMPAIGN_CAPACITY_REACHED += 1;
        continue;
      }

      const evaluation = evaluateProfileRelevance(profile, input.campaign, policy);
      const decision = decideRelevance(evaluation, policy);
      if (decision.relevant) {
        relevant.push(profile);
      } else {
        skipCounts[decision.reason] += 1;
      }
    }

    input.onBatch?.({
      candidatesProcessed,
      candidatesEnriched,
      enrichmentFailures,
      relevantCount: relevant.length,
      skipCounts: { ...skipCounts },
    });
  }

  const leftover = input.candidates.length - candidatesProcessed;
  if (leftover > 0) {
    skipCounts.CANDIDATE_BOUND_REACHED += leftover;
  }

  return {
    relevant,
    candidatesProcessed,
    candidatesEnriched,
    enrichmentFailures,
    skipCounts,
  };
}
