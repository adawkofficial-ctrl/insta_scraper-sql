/**
 * Query planning and pre-details location verification for the
 * `instagram_all_in_one` provider.
 *
 * Single configuration point: whether the actor exposes a dedicated location
 * input field. Verified against the actor input schema used by this project:
 * `apify/instagram-scraper` search mode accepts `search`, `searchType`,
 * `searchLimit`, `resultsType` — there is NO location/country field, so the
 * city must live in the query text. If a future schema adds one, set
 * IG_SEARCH_LOCATION_FIELD below (and pass it in buildInstagramSearchInput).
 */

import {
  CITY_COORDINATES,
  COUNTRY_CODE_MAP,
  COUNTRY_TOP_CITIES,
  getRecommendedCitiesForCountry,
  isCountryName,
  normalizeCityKey,
  resolveCountryCode,
} from "./country-cities";
import {
  extractDiscoveryKeywords,
  sanitizeSearchTerm,
  tokenizeSearchQuery,
} from "./discovery-query";
import type { DiscoveredProfile } from "./discovery-provider";

/** The actor's search input has no location field today. */
export const IG_SEARCH_LOCATION_FIELD: string | null = null;

export type InstagramQueryPlan = {
  queries: string[];
  keywords: string[];
  cities: string[];
  neighbourhoods: string[];
  blocked: boolean;
  blockedReason: string | null;
  recommendedCities: string[];
  perQuerySearchLimit: number;
  maxQueries: number;
  locationInQueryText: boolean;
};

export type PlanInstagramQueriesInput = {
  query: string;
  category?: string | null;
  location?: string | null;
  /** Explicit cities chosen by the operator (required for country-level campaigns). */
  cities?: string[] | null;
  neighbourhoods?: string[] | null;
  maxQueries?: number;
  searchLimit?: number;
};

export function getConfiguredNeighbourhoods(): string[] {
  const raw = process.env.IG_NEIGHBOURHOODS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function cityTokenList(city: string): string[] {
  const first = city.split(",")[0].trim();
  const tokens = tokenizeSearchQuery(first).filter((token) => token.length >= 3);
  const key = normalizeCityKey(city);
  return Array.from(new Set([key, ...tokens.map((t) => t.toLowerCase())]));
}

export function planInstagramQueries(input: PlanInstagramQueriesInput): InstagramQueryPlan {
  const maxQueries = input.maxQueries ?? 6;
  const perQuerySearchLimit = input.searchLimit ?? 10;
  const keywords = extractDiscoveryKeywords({
    query: input.query,
    category: input.category ?? null,
  });
  const recommendedCities = getRecommendedCitiesForCountry(input.location);
  const neighbourhoods = (input.neighbourhoods ?? getConfiguredNeighbourhoods())
    .map((value) => sanitizeSearchTerm(value))
    .filter((value) => value.length > 0);

  let cities = (input.cities ?? []).map((c) => sanitizeSearchTerm(c)).filter(Boolean);

  if (cities.length === 0) {
    const rawLocation = input.location?.trim() ?? "";
    if (!rawLocation) {
      return {
        queries: [],
        keywords,
        cities: [],
        neighbourhoods,
        blocked: true,
        blockedReason: "A city is required: campaigns without a location cannot build Instagram search queries.",
        recommendedCities,
        perQuerySearchLimit,
        maxQueries,
        locationInQueryText: IG_SEARCH_LOCATION_FIELD === null,
      };
    }
    if (isCountryName(rawLocation)) {
      return {
        queries: [],
        keywords,
        cities: [],
        neighbourhoods,
        blocked: true,
        blockedReason:
          `"${rawLocation}" is a whole country. Choose specific cities before discovery ` +
          `(recommended: ${recommendedCities.slice(0, 5).join(", ") || "none available"}).`,
        recommendedCities,
        perQuerySearchLimit,
        maxQueries,
        locationInQueryText: IG_SEARCH_LOCATION_FIELD === null,
      };
    }
    cities = [rawLocation];
  }

  const queries: string[] = [];
  const seen = new Set<string>();
  const pushQuery = (value: string): boolean => {
    const sanitized = sanitizeSearchTerm(value).slice(0, 200);
    const key = sanitized.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    queries.push(sanitized);
    return queries.length >= maxQueries;
  };

  outer: for (const keyword of keywords) {
    for (const city of cities) {
      const cityText = city.split(",")[0].trim();
      if (pushQuery(`${keyword} ${cityText}`)) break outer;
      if (pushQuery(`${cityText} ${keyword}`)) break outer;
      for (const neighbourhood of neighbourhoods) {
        if (pushQuery(`${keyword} ${neighbourhood} ${cityText}`)) break outer;
        if (pushQuery(`${keyword} ${neighbourhood}`)) break outer;
      }
    }
  }

  return {
    queries,
    keywords,
    cities,
    neighbourhoods,
    blocked: queries.length === 0,
    blockedReason: queries.length === 0 ? "No searchable keyword/city combinations were produced." : null,
    recommendedCities,
    perQuerySearchLimit,
    maxQueries,
    locationInQueryText: IG_SEARCH_LOCATION_FIELD === null,
  };
}

export function buildInstagramSearchInput(
  search: string,
  searchLimit: number,
  resultsType: "search" | "details",
  location?: string | null,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    search,
    searchType: "user",
    searchLimit,
  };
  // The actor only accepts resultsType in details/place modes; user search uses
  // searchType + searchLimit alone.
  if (resultsType === "details") {
    input.resultsType = "details";
  }
  if (IG_SEARCH_LOCATION_FIELD && location) {
    input[IG_SEARCH_LOCATION_FIELD] = location;
  }
  return input;
}

export type LocationVerificationStatus = "verified" | "unverified" | "wrong_location";

export type LocationVerification = {
  status: LocationVerificationStatus;
  reason: string | null;
  matchedTerm: string | null;
};

const CC_TLD_TO_COUNTRY: Record<string, string> = {
  ca: "canada",
  us: "united states",
  uk: "united kingdom",
  gb: "united kingdom",
  au: "australia",
  nz: "new zealand",
  ie: "ireland",
  de: "germany",
  fr: "france",
  es: "spain",
  it: "italy",
  nl: "netherlands",
  pk: "pakistan",
  in: "india",
  ae: "united arab emirates",
  sg: "singapore",
  za: "south africa",
};

const KNOWN_CITY_KEYS = new Set(Object.keys(CITY_COORDINATES));
const KNOWN_COUNTRY_NAMES = new Set([
  ...Object.keys(COUNTRY_TOP_CITIES),
  ...Object.keys(COUNTRY_CODE_MAP),
]);

function textContainsToken(text: string, tokens: string[]): string | null {
  const normalized = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (normalized.includes(` ${token} `)) return token;
  }
  return null;
}

function readExternalDomainTld(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * Verifies a search result against the target city BEFORE paying for details.
 * - matching city token in bio/address/place data/external URL TLD => verified
 * - explicit different known city/country => wrong_location (reject)
 * - no evidence => unverified (may proceed only if the Gemini pre-gate passes)
 */
export function verifyCandidateLocation(
  candidate: DiscoveredProfile,
  targetCity: string | null,
  targetCountry: string | null,
  placeSignal?: { city?: string | null; address?: string | null } | null,
): LocationVerification {
  const city = targetCity?.trim() || null;
  const country =
    targetCountry?.trim() ||
    (city ? null : null);

  if (!city && !country) {
    return { status: "unverified", reason: "No target city/country configured", matchedTerm: null };
  }

  const cityTokens = city ? cityTokenList(city) : [];
  const countryTokens = country ? countryTokenList(country) : [];

  const explicitLocationText = [
    candidate.location,
    candidate.city,
    candidate.businessAddress?.city_name,
    candidate.businessAddress?.street_address,
    placeSignal?.city,
    placeSignal?.address,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");

  const bioText = candidate.biography ?? "";
  const tld = readExternalDomainTld(candidate.externalUrl ?? candidate.website);

  const explicitMatch = textContainsToken(explicitLocationText, cityTokens);
  if (explicitMatch) {
    return { status: "verified", reason: null, matchedTerm: explicitMatch };
  }

  const bioMatch = textContainsToken(bioText, cityTokens);
  if (bioMatch) {
    return { status: "verified", reason: null, matchedTerm: bioMatch };
  }

  if (city && tld && CC_TLD_TO_COUNTRY[tld] && countryTokens.length === 0) {
    const targetCountryName = resolveCountryCode(city)
      ? Object.entries(COUNTRY_CODE_MAP).find(
          ([, code]) => code === resolveCountryCode(city),
        )?.[0]
      : null;
    if (targetCountryName && CC_TLD_TO_COUNTRY[tld] === targetCountryName) {
      return { status: "verified", reason: null, matchedTerm: `.${tld}` };
    }
  }

  // Explicit contradiction: a different known city in the explicit location.
  const normalizedExplicit = explicitLocationText.toLowerCase();
  for (const knownCity of KNOWN_CITY_KEYS) {
    if (cityTokens.includes(knownCity)) continue;
    if (new RegExp(`\\b${knownCity}\\b`, "i").test(normalizedExplicit)) {
      return {
        status: "wrong_location",
        reason: `Explicit location names "${knownCity}" instead of "${city ?? country}"`,
        matchedTerm: knownCity,
      };
    }
  }

  for (const knownCountry of KNOWN_COUNTRY_NAMES) {
    if (knownCountry.length < 4) continue;
    if (countryTokens.includes(knownCountry)) continue;
    if (new RegExp(`\\b${knownCountry}\\b`, "i").test(normalizedExplicit)) {
      return {
        status: "wrong_location",
        reason: `Explicit location names country "${knownCountry}" instead of "${city ?? country}"`,
        matchedTerm: knownCountry,
      };
    }
  }

  // Bio may explicitly contradict too, but only if it does not mention the target.
  const normalizedBio = bioText.toLowerCase();
  for (const knownCity of KNOWN_CITY_KEYS) {
    if (cityTokens.includes(knownCity)) continue;
    if (new RegExp(`\\b(?:in|based in|located in|serving)\\s+${knownCity}\\b`, "i").test(normalizedBio)) {
      return {
        status: "wrong_location",
        reason: `Bio explicitly names "${knownCity}" instead of "${city ?? country}"`,
        matchedTerm: knownCity,
      };
    }
  }

  if (country && countryTokens.length > 0) {
    const countryMatch =
      textContainsToken(explicitLocationText, countryTokens) ??
      textContainsToken(bioText, countryTokens) ??
      (tld && CC_TLD_TO_COUNTRY[tld] === country ? `.${tld}` : null);
    if (countryMatch) {
      return { status: "verified", reason: null, matchedTerm: countryMatch };
    }
  }

  return {
    status: "unverified",
    reason: "No location evidence in bio/address/place data",
    matchedTerm: null,
  };
}

function countryTokenList(country: string): string[] {
  const normalized = country.trim().toLowerCase();
  const code = COUNTRY_CODE_MAP[normalized];
  const tokens = [normalized];
  if (code) tokens.push(code);
  return tokens.filter((token) => token.length >= 2);
}

export type PerQuerySearchStat = {
  query: string;
  results: number;
  accepted: number;
  rejectedWrongLocation: number;
  rejectedNonBusiness: number;
  rejectedPrivate: number;
  rejectedDuplicate: number;
  costUsd: number;
  costPerAcceptedLeadUsd: number | null;
};
