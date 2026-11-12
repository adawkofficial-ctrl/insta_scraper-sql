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
import { isCategoryAllowed } from "./category-synonyms";
import { findMatchedNegativeKeyword } from "./negative-keywords";

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
  | "MALFORMED"
  | "PRE_ENRICHMENT_REJECTED"
  | "ENRICHMENT_CRITERIA_REJECTED"
  | "LOCATION_UNVERIFIED"
  | "AI_UNAVAILABLE";

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
  "PRE_ENRICHMENT_REJECTED",
  "ENRICHMENT_CRITERIA_REJECTED",
  "LOCATION_UNVERIFIED",
  "AI_UNAVAILABLE",
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
  /** Minimum number of core intent terms (bio/name/category/handle) required. */
  minIntentCoreTerms?: number;
  /** Intent matching strictness level: "permissive" | "moderate" | "strict" (default: "moderate"). */
  intentStrictness?: "permissive" | "moderate" | "strict";
  /** Optional AI verification using Gemini for candidates that pass deterministic pre-filtering (default: false). */
  useAiRelevanceCheck?: boolean;
  /** Minimum AI confidence score 0..100 to accept (default: 60). */
  aiRelevanceThreshold?: number;
};

export const DEFAULT_DISCOVERY_RELEVANCE_POLICY: DiscoveryRelevancePolicy = {
  requireIntentMatch: false,
  requireCategoryMatch: false,
  requireLocationMatch: false,
  allowUnknownLocation: true,
  allowUnknownCategory: true,
  nationalScaleFollowerThreshold: DEFAULT_NATIONAL_SCALE_FOLLOWER_THRESHOLD,
  nationalCategories: [...DEFAULT_NATIONAL_CATEGORIES],
  intentStrictness: "moderate",
  useAiRelevanceCheck: true,
  aiRelevanceThreshold: 70,
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
  matchedKeyPhrases?: string[];
  isNationalScale?: boolean;
  isNationalScaleLocationMismatch?: boolean;
  declaredCategory?: string | null;
  negativeKeywordMatched?: string | null;
  aiEvaluated?: boolean;
  aiScore?: number;
  aiReason?: string;
  accountType?: string;
};

export type RelevanceGate =
  | "prefilter"
  | "enrichment_criteria"
  | "category"
  | "negative_keyword"
  | "intent"
  | "location"
  | "ai_relevance";

export type LeadRejectionEntry = {
  username: string;
  gate: RelevanceGate;
  reason: DiscoverySkipReason;
  matchedTerm?: string;
  aiScore?: number;
};

export type RelevanceDecision =
  | { relevant: true }
  | {
      relevant: false;
      reason: DiscoverySkipReason;
      gate?: RelevanceGate;
      matchedTerm?: string;
      detail?: string;
    };

// ---------------------------------------------------------------------------
// Term extraction
// ---------------------------------------------------------------------------

export const RELEVANCE_STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "ever",
  "every",
  "few",
  "find",
  "finding",
  "finds",
  "for",
  "from",
  "further",
  "get",
  "gets",
  "getting",
  "give",
  "gives",
  "giving",
  "go",
  "good",
  "great",
  "grow",
  "growing",
  "grows",
  "had",
  "has",
  "have",
  "having",
  "help",
  "helping",
  "helps",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "improve",
  "improving",
  "in",
  "increase",
  "increasing",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "like",
  "look",
  "looking",
  "looks",
  "make",
  "makes",
  "making",
  "many",
  "me",
  "more",
  "most",
  "much",
  "my",
  "myself",
  "need",
  "needing",
  "needs",
  "new",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "offer",
  "offering",
  "offers",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "presence",
  "provide",
  "providing",
  "provides",
  "real",
  "require",
  "requires",
  "requiring",
  "same",
  "seek",
  "seeking",
  "seeks",
  "service",
  "services",
  "should",
  "so",
  "some",
  "such",
  "take",
  "takes",
  "taking",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "top",
  "under",
  "until",
  "up",
  "very",
  "want",
  "wanting",
  "wants",
  "was",
  "we",
  "well",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  // Common business filler words that carry no topical niche identity:
  "business",
  "businesses",
  "company",
  "companies",
  "firm",
  "firms",
  "agency",
  "agencies",
  "client",
  "clients",
  "customer",
  "customers",
]);

export const GENERIC_INTENT_WORDS = new Set([
  "digital",
  "online",
  "presence",
  "media",
  "content",
  "services",
  "service",
  "solutions",
  "solution",
  "business",
  "businesses",
  "company",
  "agency",
  "center",
  "centre",
  "centers",
  "management",
  "group",
  "official",
  "page",
  "product",
  "products",
  "practice",
  "practices",
  "patient",
  "patients",
  "client",
  "clients",
  "customer",
  "customers",
  "recommend",
  "recommended",
  "sell",
  "selling",
  "offer",
  "offering",
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

const ACRONYM_EXCEPTIONS = new Set([
  "saas",
  "paas",
  "iaas",
  "b2b",
  "b2c",
  "seo",
  "sem",
  "crm",
  "cms",
  "erp",
  "api",
  "ai",
  "ml",
  "ui",
  "ux",
  "gym",
  "gyms",
  "spa",
  "spas",
  "news",
  "lens",
  "bass",
  "boss",
]);

/** Strips simple plural endings so "gyms" matches "gym", "businesses" -> "business". */
function stemVariants(term: string): string[] {
  const variants = new Set<string>([term]);
  if (ACRONYM_EXCEPTIONS.has(term)) {
    if (term === "gyms") variants.add("gym");
    if (term === "spas") variants.add("spa");
    return [...variants];
  }
  if (term.length <= 3 || /^\d+$/.test(term) || term.endsWith("ss")) {
    return [...variants];
  }
  if (term.endsWith("ies") && term.length > 4) {
    variants.add(`${term.slice(0, -3)}y`);
    return [...variants];
  }
  if (term.endsWith("es") && term.length > 4) {
    variants.add(term.slice(0, -1)); // e.g. "magazines" -> "magazine", "websites" -> "website"
    variants.add(term.slice(0, -2)); // e.g. "businesses" -> "business", "coaches" -> "coach"
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

export function extractIntentKeyPhrases(
  intent: string | null | undefined,
): string[] {
  if (!intent || typeof intent !== "string") {
    return [];
  }
  const phrases: string[] = [];
  const parts = intent.split(/[,;\n\r|/]+|\s+(?:and|&|or)\s+/i);

  for (const part of parts) {
    const tokens = normalizeRelevanceText(part)
      .split(" ")
      .filter((t) => t.length > 0 && !RELEVANCE_STOPWORDS.has(t));
    if (tokens.length >= 2) {
      phrases.push(tokens.join(" "));
      for (let i = 0; i < tokens.length - 1; i++) {
        const sub = `${tokens[i]} ${tokens[i + 1]}`;
        if (!phrases.includes(sub)) {
          phrases.push(sub);
        }
      }
    } else if (tokens.length === 1 && tokens[0].length >= 3) {
      phrases.push(tokens[0]);
    }
  }
  return phrases;
}

export function buildCategoryTerms(category: string | null | undefined): string[] {
  if (!category || category.trim().length === 0) {
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

export function buildLocationTerms(location: string | null | undefined): string[] {
  if (!location || location.trim().length === 0) {
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

export function findMatchedPhrases(haystack: string, phrases: string[]): string[] {
  return phrases.filter((phrase) => {
    if (phrase.length === 0) return false;
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}([^a-z0-9]|$)`);
    return pattern.test(haystack);
  });
}

// ---------------------------------------------------------------------------
// Profile evaluation
// ---------------------------------------------------------------------------

export function collectCoreProfileText(profile: LeadProfile): string[] {
  const parts: Array<string | null | undefined> = [
    profile.username,
    profile.fullName,
    profile.biography,
    profile.businessCategoryName,
    profile.category,
    profile.externalUrl,
    profile.website,
  ];

  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => normalizeRelevanceText(part))
    .filter((part) => part.length > 0);
}

export function collectSecondaryProfileText(profile: LeadProfile): string[] {
  const parts: Array<string | null | undefined> = [];

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

export function collectProfileText(profile: LeadProfile): string[] {
  return [
    ...collectCoreProfileText(profile),
    ...collectSecondaryProfileText(profile),
    normalizeRelevanceText(profile.location),
  ].filter((p) => p.length > 0);
}

export type IntentConcept = {
  phrase: string;
  terms: string[];
};

export function extractIntentConcepts(
  intent: string | null | undefined,
): IntentConcept[] {
  if (!intent || typeof intent !== "string") {
    return [];
  }
  const concepts: IntentConcept[] = [];
  const rawParts = intent.split(/[,;\n\r|/]+|\s+(?:and|&|or)\s+/i);

  for (const raw of rawParts) {
    const tokens = normalizeRelevanceText(raw)
      .split(" ")
      .filter((t) => t.length > 0 && !RELEVANCE_STOPWORDS.has(t));

    if (tokens.length === 0) continue;
    concepts.push({
      phrase: tokens.join(" "),
      terms: tokens,
    });
  }
  return concepts;
}

export function evaluateProfileRelevance(
  profile: LeadProfile,
  campaign: RelevanceCampaignContext,
  policy: DiscoveryRelevancePolicy = DEFAULT_DISCOVERY_RELEVANCE_POLICY,
): ProfileRelevance {
  const coreHaystack = collectCoreProfileText(profile).join(" ");
  const secondaryHaystack = collectSecondaryProfileText(profile).join(" ");
  const locationText = normalizeRelevanceText(profile.location);
  const fullHaystack = `${coreHaystack} ${secondaryHaystack} ${locationText}`;

  const intentTerms = extractSignificantTerms(campaign.intent);
  const intentPhrases = extractIntentKeyPhrases(campaign.intent);
  const intentConcepts = extractIntentConcepts(campaign.intent);
  const categoryTerms = buildCategoryTerms(campaign.category);
  const locationTerms = buildLocationTerms(campaign.location);

  const profileCategoryText = normalizeRelevanceText(
    [profile.businessCategoryName, profile.category]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" "),
  );

  const matchedCoreIntentTerms = findMatchedTerms(coreHaystack, intentTerms);
  const matchedSecondaryIntentTerms = findMatchedTerms(secondaryHaystack, intentTerms);
  const matchedIntentTerms = Array.from(
    new Set([...matchedCoreIntentTerms, ...matchedSecondaryIntentTerms]),
  );

  const matchedPhrases = findMatchedPhrases(coreHaystack, intentPhrases);
  const multiWordPhraseMatch = matchedPhrases.some((p) => p.includes(" "));

  const matchedDomainCoreTerms = matchedCoreIntentTerms.filter(
    (t) => !GENERIC_INTENT_WORDS.has(t),
  );

  let matchedConceptCount = 0;
  for (const concept of intentConcepts) {
    if (concept.terms.length >= 2) {
      if (
        findMatchedPhrases(coreHaystack, [concept.phrase]).length > 0 ||
        concept.terms.filter((t) => textContainsTerm(coreHaystack, t)).length >= 2
      ) {
        matchedConceptCount++;
      }
    } else if (concept.terms.length === 1) {
      const term = concept.terms[0];
      if (!GENERIC_INTENT_WORDS.has(term) && textContainsTerm(coreHaystack, term)) {
        matchedConceptCount++;
      }
    }
  }

  const strictness =
    policy.intentStrictness ??
    (typeof process !== "undefined" && process.env?.DISCOVERY_INTENT_STRICTNESS
      ? (process.env.DISCOVERY_INTENT_STRICTNESS as "permissive" | "moderate" | "strict")
      : "moderate");

  let minDomainTerms: number;
  if (policy.minIntentCoreTerms !== undefined) {
    minDomainTerms = policy.minIntentCoreTerms;
  } else if (strictness === "permissive") {
    minDomainTerms = 1;
  } else if (strictness === "strict") {
    minDomainTerms = Math.min(3, Math.max(2, Math.ceil(intentTerms.length * 0.4)));
  } else {
    // moderate: 1 domain-specific term (or 2 generic/multi terms)
    minDomainTerms = 1;
  }

  let intentMatch: RelevanceMatch;
  if (intentTerms.length === 0) {
    intentMatch = "UNKNOWN";
  } else if (matchedConceptCount > 0 || multiWordPhraseMatch) {
    intentMatch = "MATCHED";
  } else if (matchedDomainCoreTerms.length >= minDomainTerms) {
    intentMatch = "MATCHED";
  } else if (
    strictness !== "strict" &&
    matchedCoreIntentTerms.length >= 2
  ) {
    intentMatch = "MATCHED";
  } else if (
    strictness !== "strict" &&
    matchedDomainCoreTerms.length >= 1 &&
    matchedSecondaryIntentTerms.length >= 1
  ) {
    intentMatch = "MATCHED";
  } else {
    intentMatch = "NOT_MATCHED";
  }

  // 1. Check negative keywords across username, full name, bio, and category
  const rawDeclaredCategory = profile.businessCategoryName || profile.category || null;
  const gmapsCategory =
    profile.gmapsCategory ||
    (Array.isArray(profile.gmapsCategories) && profile.gmapsCategories.length > 0
      ? profile.gmapsCategories[0]
      : null);

  const allowedCampaignTerms = new Set<string>([
    ...intentTerms,
    ...categoryTerms,
  ]);
  const negativeKeywordMatched = findMatchedNegativeKeyword(
    [
      profile.username,
      profile.fullName,
      profile.biography,
      rawDeclaredCategory,
      gmapsCategory,
    ],
    null,
    allowedCampaignTerms,
  );

  // 2. Category is evaluated with isCategoryAllowed against the campaign's category
  let categoryMatch: RelevanceMatch;
  let effectiveDeclaredCategory = rawDeclaredCategory;

  if (!campaign.category || campaign.category.trim().length === 0) {
    categoryMatch = "UNKNOWN";
  } else if (gmapsCategory && gmapsCategory.trim().length > 0) {
    // If Google Maps provides a category, use it as a verified signal
    const gmapsAllowed = isCategoryAllowed(gmapsCategory, campaign.category);
    if (!gmapsAllowed) {
      categoryMatch = "NOT_MATCHED";
      effectiveDeclaredCategory = gmapsCategory;
    } else {
      categoryMatch = "MATCHED";
      effectiveDeclaredCategory = gmapsCategory;
    }
  } else if (!rawDeclaredCategory || rawDeclaredCategory.trim().length === 0) {
    // If profile category is null/empty, do NOT auto-reject on category; defer to negative keywords + AI gate.
    categoryMatch = "UNKNOWN";
  } else {
    const allowed = isCategoryAllowed(rawDeclaredCategory, campaign.category);
    categoryMatch = allowed ? "MATCHED" : "NOT_MATCHED";
  }

  const matchedCategoryTerms = findMatchedTerms(
    profileCategoryText,
    categoryTerms,
  );
  const matchedLocationTerms = findMatchedTerms(fullHaystack, locationTerms);

  // Set location from Maps if not present on profile
  if (!profile.location && (profile.gmapsCity || profile.gmapsAddress)) {
    profile.location = profile.gmapsCity || profile.gmapsAddress || null;
  }

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

  const isFromGoogleMaps = Boolean(
    profile.gmapsCity ||
    profile.gmapsAddress ||
    profile.sourceProvider === "google_maps" ||
    (profile.rawProfileData &&
      (profile.rawProfileData as Record<string, unknown>).sourceProvider === "google_maps")
  );

  const locationMatch: RelevanceMatch = isFromGoogleMaps
    ? "MATCHED"
    : locationTerms.length === 0
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
    matchedKeyPhrases: matchedPhrases,
    isNationalScale,
    isNationalScaleLocationMismatch,
    declaredCategory: effectiveDeclaredCategory,
    negativeKeywordMatched,
  };
}

export function decideRelevance(
  relevance: ProfileRelevance,
  policy: DiscoveryRelevancePolicy = DEFAULT_DISCOVERY_RELEVANCE_POLICY,
): RelevanceDecision {
  // Gate 1: Negative keywords check
  if (relevance.negativeKeywordMatched) {
    return {
      relevant: false,
      reason: "IRRELEVANT_INTENT",
      gate: "negative_keyword",
      matchedTerm: relevance.negativeKeywordMatched,
      detail: `Matched negative keyword "${relevance.negativeKeywordMatched}"`,
    };
  }

  // Gate 2: HARD Category Gate
  // If profile category is present and NOT in the allowed set, reject immediately, even if intent terms match.
  // If profile category was null/empty, categoryMatch is UNKNOWN and passes to subsequent gates.
  if (relevance.categoryMatch === "NOT_MATCHED") {
    return {
      relevant: false,
      reason: "IRRELEVANT_CATEGORY",
      gate: "category",
      matchedTerm: relevance.declaredCategory ?? undefined,
      detail: `Declared category "${relevance.declaredCategory ?? "unknown"}" is not in the allowed category set`,
    };
  }

  // Gate 3: Location checks
  if (relevance.isNationalScaleLocationMismatch) {
    return {
      relevant: false,
      reason: "IRRELEVANT_LOCATION_NATIONAL_SCALE",
      gate: "location",
      detail: "National scale media account without local presence",
    };
  }

  if (relevance.locationMatch === "NOT_MATCHED") {
    return {
      relevant: false,
      reason: "IRRELEVANT_LOCATION",
      gate: "location",
      detail: "Declared location conflicts with campaign location",
    };
  }

  if (
    relevance.locationMatch === "UNKNOWN" &&
    (policy.requireLocationMatch || !policy.allowUnknownLocation)
  ) {
    return {
      relevant: false,
      reason: "IRRELEVANT_LOCATION",
      gate: "location",
      detail: "Location unknown and policy does not permit unknown location",
    };
  }

  // Gate 4: Topical matching
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
    // Default policy:
    if (relevance.intentTerms.length > 0) {
      topicalMatched = relevance.intentMatch === "MATCHED";
    } else {
      topicalMatched = relevance.categoryMatch === "MATCHED";
    }
  }

  if (topicalMatched && !policy.allowUnknownCategory) {
    if (relevance.categoryMatch !== "MATCHED") {
      return { relevant: false, reason: "INSUFFICIENT_RELEVANCE_DATA", gate: "category" };
    }
  }

  if (!topicalMatched) {
    if (relevance.intentMatch === "NOT_MATCHED") {
      return { relevant: false, reason: "IRRELEVANT_INTENT", gate: "intent" };
    }
    return { relevant: false, reason: "INSUFFICIENT_RELEVANCE_DATA", gate: "intent" };
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
  /** Optional AI verification hook called only on candidates passing deterministic gates. */
  checkAiRelevance?: (
    profile: LeadProfile,
    campaign: RelevanceCampaignContext,
  ) => Promise<{
    relevant: boolean;
    score?: number;
    reason?: string;
    accountType?: string;
  }>;
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
  rejectionLog: LeadRejectionEntry[];
  gateRejections: Record<string, number>;
};

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const i = index++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

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
  const rejectionLog: LeadRejectionEntry[] = [];
  const gateRejections: Record<string, number> = {
    prefilter: 0,
    category: 0,
    negative_keyword: 0,
    intent: 0,
    location: 0,
    ai_relevance: 0,
    duplicate: 0,
    other: 0,
  };

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
      enrichment.profiles
        .map((profile) => profile.username?.toLowerCase())
        .filter((u): u is string => Boolean(u)),
    );
    const missing = batch.filter(
      (username) => !returnedUsernames.has(username.toLowerCase()),
    );
    const failures = Math.max(missing.length, enrichment.skipped.length);
    enrichmentFailures += failures;
    skipCounts.ENRICHMENT_FAILED += failures;
    candidatesEnriched += enrichment.profiles.length;

    const passingCheapProfiles: LeadProfile[] = [];

    for (const profile of enrichment.profiles) {
      const username = (profile.username ?? "").toLowerCase();
      if (!username) continue;
      if (seenUsernames.has(username)) {
        skipCounts.DUPLICATE += 1;
        gateRejections.duplicate = (gateRejections.duplicate ?? 0) + 1;
        rejectionLog.push({ username, gate: "intent", reason: "DUPLICATE" });
        continue;
      }
      seenUsernames.add(username);

      if (relevant.length + passingCheapProfiles.length >= input.capacity) {
        skipCounts.CAMPAIGN_CAPACITY_REACHED += 1;
        continue;
      }

      const evaluation = evaluateProfileRelevance(profile, input.campaign, policy);
      const decision = decideRelevance(evaluation, policy);
      if (decision.relevant) {
        passingCheapProfiles.push(profile);
      } else {
        skipCounts[decision.reason] += 1;
        const gate: RelevanceGate =
          decision.gate ??
          (decision.reason === "IRRELEVANT_CATEGORY"
            ? "category"
            : decision.reason === "IRRELEVANT_LOCATION"
              ? "location"
              : "intent");
        gateRejections[gate] = (gateRejections[gate] ?? 0) + 1;
        rejectionLog.push({
          username,
          gate,
          reason: decision.reason,
          matchedTerm: decision.matchedTerm,
        });
      }
    }

    if (passingCheapProfiles.length > 0) {
      if (policy.useAiRelevanceCheck && input.checkAiRelevance) {
        // Limited concurrency (5) for AI relevance verification
        const aiResults = await mapConcurrent(passingCheapProfiles, 5, async (p) => {
          try {
            return await input.checkAiRelevance!(p, input.campaign);
          } catch {
            return {
              relevant: false,
              score: 0,
              reason: "AI_UNAVAILABLE",
              accountType: "other",
            };
          }
        });

        for (let i = 0; i < passingCheapProfiles.length; i++) {
          const profile = passingCheapProfiles[i];
          const aiCheck = aiResults[i];
          if (relevant.length >= input.capacity) {
            skipCounts.CAMPAIGN_CAPACITY_REACHED += 1;
            continue;
          }
          if (aiCheck.relevant) {
            relevant.push(profile);
          } else {
            const skipReason: DiscoverySkipReason =
              aiCheck.reason === "AI_UNAVAILABLE" ? "AI_UNAVAILABLE" : "IRRELEVANT_INTENT";
            skipCounts[skipReason] = (skipCounts[skipReason] ?? 0) + 1;
            gateRejections.ai_relevance = (gateRejections.ai_relevance ?? 0) + 1;
            rejectionLog.push({
              username: profile.username?.toLowerCase() ?? "",
              gate: "ai_relevance",
              reason: skipReason,
              matchedTerm: aiCheck.accountType ?? aiCheck.reason,
              aiScore: aiCheck.score,
            });
          }
        }
      } else {
        for (const profile of passingCheapProfiles) {
          if (relevant.length >= input.capacity) {
            skipCounts.CAMPAIGN_CAPACITY_REACHED += 1;
            continue;
          }
          relevant.push(profile);
        }
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
    rejectionLog,
    gateRejections,
  };
}

export type PreFilterResult =
  | { action: "PROCEED" }
  | {
      action: "REJECT";
      reason: DiscoverySkipReason;
      underlyingReason?: DiscoverySkipReason;
      detail?: string;
    };

/**
 * Lightweight, conservative pre-enrichment relevance filter.
 *
 * Runs BEFORE expensive profile enrichment (the active enrichment actor),
 * inspecting ONLY data already returned by the cheap search stage (e.g. bio,
 * category, location, follower count).
 *
 * REJECT-ONLY DESIGN:
 * - Can ONLY skip an obvious mismatch (saving an enrichment call).
 * - Never declares a candidate "definitely relevant" — any candidate that passes
 *   still undergoes authoritative post-enrichment validation in collectRelevantLeads.
 * - Conservative by design: if data is missing, ambiguous, or bio < 15 chars,
 *   it lets the candidate through (PROCEED) rather than risking a false rejection.
 */
export function prefilterCandidate(
  candidate: {
    username?: string | null;
    profileUrl?: string | null;
    fullName?: string | null;
    biography?: string | null;
    bio?: string | null;
    category?: string | null;
    businessCategoryName?: string | null;
    location?: string | null;
    followers?: number | null;
    followersCount?: number | null;
    externalUrl?: string | null;
    website?: string | null;
    businessAddress?: { city_name?: string } | null;
    latestPosts?: Array<{ caption?: string | null; locationName?: string | null }> | LeadProfile["latestPosts"];
    gmapsCategory?: string | null;
    gmapsCategories?: string[] | null;
    gmapsCity?: string | null;
    gmapsAddress?: string | null;
    sourceProvider?: string | null;
  },
  campaign: RelevanceCampaignContext,
  policy: DiscoveryRelevancePolicy = DEFAULT_DISCOVERY_RELEVANCE_POLICY,
): PreFilterResult {
  const bio = candidate.biography?.trim() || candidate.bio?.trim() || "";
  const cat =
    candidate.gmapsCategory?.trim() ||
    candidate.businessCategoryName?.trim() ||
    candidate.category?.trim() ||
    "";
  const loc =
    candidate.gmapsCity?.trim() ||
    candidate.location?.trim() ||
    candidate.businessAddress?.city_name?.trim() ||
    "";
  const followers = candidate.followers ?? candidate.followersCount ?? 0;

  // 0. NEGATIVE KEYWORDS CHECK:
  // Reject non-clinic accounts (staffing, consultant, student, car wash, etc.) before enrichment
  const prefilterAllowedTerms = new Set<string>();
  if (campaign.intent) {
    for (const t of extractSignificantTerms(campaign.intent)) {
      prefilterAllowedTerms.add(t);
    }
  }
  if (campaign.category) {
    for (const t of buildCategoryTerms(campaign.category)) {
      prefilterAllowedTerms.add(t);
    }
  }

  const negKw = findMatchedNegativeKeyword(
    [candidate.username, candidate.fullName, bio, cat],
    null,
    prefilterAllowedTerms,
  );
  if (negKw) {
    return {
      action: "REJECT",
      reason: "PRE_ENRICHMENT_REJECTED",
      underlyingReason: "IRRELEVANT_INTENT",
      detail: `Matched negative keyword "${negKw}"`,
    };
  }

  // If candidate has NO metadata at all (e.g. only username), let through to enrichment
  if (!bio && !cat && !loc && followers === 0) {
    return { action: "PROCEED" };
  }

  // Pre-filter policy is strictly conservative:
  // - Never requires location to match (absent location is UNKNOWN -> allowed).
  // - Never requires category to match (absent category is UNKNOWN -> allowed).
  const prefilterPolicy: DiscoveryRelevancePolicy = {
    ...policy,
    requireLocationMatch: false,
    requireCategoryMatch: false,
    allowUnknownLocation: true,
    allowUnknownCategory: true,
  };

  const mockProfile: LeadProfile = {
    username: candidate.username,
    instagramId: null,
    profileUrl:
      candidate.profileUrl ?? `https://www.instagram.com/${candidate.username}/`,
    fullName: candidate.fullName ?? null,
    biography: bio || null,
    bio: bio || null,
    category: cat || null,
    businessCategoryName: cat || null,
    location: loc || null,
    followers: followers || null,
    followersCount: followers || null,
    following: null,
    followsCount: null,
    postsCount: null,
    profilePictureUrl: null,
    profilePicUrl: null,
    profilePicUrlHD: null,
    isVerified: false,
    verified: false,
    isBusiness: false,
    isBusinessAccount: false,
    isPrivate: false,
    externalUrl: candidate.externalUrl ?? null,
    website: candidate.website ?? candidate.externalUrl ?? null,
    socialLink: null,
    socialPlatform: null,
    email: null,
    phone: null,
    relatedProfiles: null,
    gmapsCategory: candidate.gmapsCategory ?? null,
    gmapsCategories: candidate.gmapsCategories ?? null,
    gmapsCity: candidate.gmapsCity ?? null,
    gmapsAddress: candidate.gmapsAddress ?? null,
    sourceProvider: candidate.sourceProvider ?? null,
    latestPosts: candidate.latestPosts
      ? candidate.latestPosts.map((p) => ({
          id: null,
          shortCode: null,
          url: null,
          type: null,
          caption: p?.caption ?? null,
          likesCount: null,
          commentsCount: null,
          displayUrl: null,
          timestamp: null,
        }))
      : null,
    rawProfileData: null,
    raw: null,
    source: "apify",
    scrapedAt: new Date().toISOString(),
  };

  const evaluation = evaluateProfileRelevance(
    mockProfile,
    campaign,
    prefilterPolicy,
  );

  // 2. CLEAR LOCATION MISMATCH:
  // If campaign has location constraint and candidate provided explicit location text
  // that contradicts the target location, or is a national media account mismatch
  if (campaign.location && evaluation.locationTerms.length > 0) {
    if (evaluation.isNationalScaleLocationMismatch) {
      return {
        action: "REJECT",
        reason: "PRE_ENRICHMENT_REJECTED",
        underlyingReason: "IRRELEVANT_LOCATION_NATIONAL_SCALE",
        detail: "National scale media/magazine account without local presence",
      };
    }
    if (loc.length > 0 && evaluation.locationMatch === "NOT_MATCHED") {
      return {
        action: "REJECT",
        reason: "PRE_ENRICHMENT_REJECTED",
        underlyingReason: "IRRELEVANT_LOCATION",
        detail: `Declared location "${loc}" conflicts with campaign location "${campaign.location}"`,
      };
    }
  }

  // 2. HARD CATEGORY CHECK:
  // If campaign specified category and candidate declared category, check allowed category set
  if (campaign.category && cat.length > 0) {
    if (!isCategoryAllowed(cat, campaign.category)) {
      return {
        action: "REJECT",
        reason: "PRE_ENRICHMENT_REJECTED",
        underlyingReason: "IRRELEVANT_CATEGORY",
        detail: `Declared category "${cat}" is not in the allowed category set for "${campaign.category}"`,
      };
    }
  }

  // 3. CLEAR INTENT MISMATCH:
  // Only reject for intent when candidate has a meaningful bio (>= 15 chars) AND
  // intentMatch is NOT_MATCHED (0 domain terms, 0 phrases, 0 concepts)
  if (campaign.intent && evaluation.intentTerms.length > 0) {
    if (bio.length >= 15 && evaluation.intentMatch === "NOT_MATCHED") {
      return {
        action: "REJECT",
        reason: "PRE_ENRICHMENT_REJECTED",
        underlyingReason: "IRRELEVANT_INTENT",
        detail: `Bio (${bio.length} chars) has zero overlap with campaign intent`,
      };
    }
  }

  return { action: "PROCEED" };
}
