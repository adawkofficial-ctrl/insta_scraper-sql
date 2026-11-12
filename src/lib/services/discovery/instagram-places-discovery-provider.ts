import "server-only";

import {
  type DiscoveredProfile,
  type DiscoveryInput,
  type DiscoveryProvider,
  type DiscoveryResult,
} from "./discovery-provider";
import { normalizeInstagramHandle } from "./google-maps-discovery-provider";
import { extractDiscoveryKeywords } from "./discovery-query";
import { isPlausiblyInCity, getIgPlacesRadiusKm, resolveTargetCities } from "./country-cities";
export { isPlausiblyInCity, getIgPlacesRadiusKm, resolveTargetCities } from "./country-cities";
import {
  runActorSafely,
  getMaxChargePerRunUsd,
} from "../scraper/apify-cost-guard";

export const DEFAULT_IG_SCRAPER_ACTOR_ID = "apify/instagram-scraper";
export const DEFAULT_IG_PLACES_SEARCH_LIMIT = 10;
export const HARD_MAX_IG_PLACES_SEARCH_LIMIT = 25;
export const COST_PER_PLACE_ITEM_USD = 0.0027;

export function getIgPlacesActorId(): string {
  const envVal = process.env.APIFY_IG_SCRAPER_ACTOR_ID?.trim();
  return envVal && envVal.length > 0 && envVal !== "undefined"
    ? envVal
    : DEFAULT_IG_SCRAPER_ACTOR_ID;
}

export function getIgPlacesSearchLimit(requestedLimit?: number): number {
  const envVal = process.env.IG_PLACES_SEARCH_LIMIT?.trim();
  const configured = envVal ? Number.parseInt(envVal, 10) : DEFAULT_IG_PLACES_SEARCH_LIMIT;
  const effectiveConfigured = !Number.isNaN(configured) && configured > 0 ? configured : DEFAULT_IG_PLACES_SEARCH_LIMIT;

  const target = requestedLimit !== undefined && requestedLimit > 0
    ? requestedLimit
    : effectiveConfigured;

  return Math.min(HARD_MAX_IG_PLACES_SEARCH_LIMIT, Math.max(1, target));
}

/**
 * Builds the search string for apify/instagram-scraper in place search mode.
 * - Extracts up to 2 cleaned intent keywords.
 * - Resolves country/region aliases to target city (e.g. "canada" -> "Toronto, ON").
 * - Appends the city name to each keyword (e.g. "dental clinic toronto").
 * - Joins keywords with comma.
 */
export function buildPlaceSearchQuery(intent: string, location?: string | null): string {
  const keywords = extractDiscoveryKeywords({ query: intent });
  const primaryKeywords = keywords.slice(0, 2);

  const resolved = resolveTargetCities(location);
  const targetCity = resolved.cities[0] || (location ?? "").split(",")[0].trim();
  const city = targetCity.split(",")[0].trim().toLowerCase();

  const formattedKeywords = (primaryKeywords.length > 0 ? primaryKeywords : [intent.trim()]).map(
    (kw) => {
      const lowerKw = kw.toLowerCase();
      if (city && !lowerKw.includes(city)) {
        return `${kw.trim()} ${city}`;
      }
      return kw.trim();
    },
  );

  return formattedKeywords.join(", ");
}

export type RawIgPlaceItem = {
  name?: string | null;
  title?: string | null;
  locationName?: string | null;
  location_name?: string | null;
  slug?: string | null;
  category?: string | null;
  categoryName?: string | null;
  category_name?: string | null;
  primaryCategory?: string | null;
  location_category?: string | null;
  phone?: string | null;
  phone_number?: string | null;
  contact_phone_number?: string | null;
  location_address?: string | null;
  address?: string | null;
  street_address?: string | null;
  formatted_address?: string | null;
  location_city?: string | null;
  city?: string | null;
  city_name?: string | null;
  location_zip?: string | null;
  zip?: string | null;
  zip_code?: string | null;
  postal_code?: string | null;
  lat?: number | string | null;
  latitude?: number | string | null;
  lng?: number | string | null;
  longitude?: number | string | null;
  location_id?: string | number | null;
  id?: string | number | null;
  pk?: string | number | null;
  place_id?: string | number | null;
  ig_business?: {
    profile?: {
      username?: string | null;
      id?: string | null;
      full_name?: string | null;
    } | null;
    username?: string | null;
  } | null;
  profile?: {
    username?: string | null;
    id?: string | null;
  } | null;
  username?: string | null;
  inputUrl?: string | null;
  instagram_url?: string | null;
  instagramUrl?: string | null;
  ig_url?: string | null;
  url?: string | null;
  website?: string | null;
  externalUrl?: string | null;
  media_count?: number | null;
  error?: string | null;
  errorMessage?: string | null;
  place?: unknown;
  location?: unknown;
  node?: unknown;
  data?: unknown;
};

export type IgPlaceParseResult = {
  isPlace: boolean;
  candidate: DiscoveredProfile | null;
  rawUsername: string | null;
  hasInstagram: boolean;
  isOutOfArea: boolean;
  name: string | null;
  category: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  skipReason: "NOT_A_PLACE" | "NO_INSTAGRAM" | "OUT_OF_AREA" | null;
};

/**
 * Tolerant parser for Instagram place items returned by apify/instagram-scraper.
 *
 * Handles:
 * - Nested wrappers: { place: ... }, { location: ... }, { node: ... }, { data: ... }, array items
 * - Alternate property names for name/title, category/categoryName, address, lat/lng, zip, phone
 * - Coordinate strings (e.g. "43.6532") converted safely to floats
 * - Empty string sanitization: empty or whitespace-only strings treated as null
 * - Instagram handle extraction from ig_business.profile.username, ig_business.username, profile.username, username, or profile URLs
 * - Plausibility geo-check against target city radius
 */
export function parseIgPlaceItem(
  rawItem: unknown,
  targetCity?: string | null,
  radiusKm?: number,
): IgPlaceParseResult {
  const emptyResult: IgPlaceParseResult = {
    isPlace: false,
    candidate: null,
    rawUsername: null,
    hasInstagram: false,
    isOutOfArea: false,
    name: null,
    category: null,
    lat: null,
    lng: null,
    address: null,
    skipReason: "NOT_A_PLACE",
  };

  if (!rawItem || typeof rawItem !== "object") {
    return emptyResult;
  }

  // Handle potential array wrapping
  let itemObj: Record<string, unknown> = Array.isArray(rawItem)
    ? (rawItem[0] as Record<string, unknown>)
    : (rawItem as Record<string, unknown>);

  if (!itemObj || typeof itemObj !== "object") {
    return emptyResult;
  }

  // Unwrap potential wrapper objects
  if (itemObj.place && typeof itemObj.place === "object" && !Array.isArray(itemObj.place)) {
    itemObj = itemObj.place as Record<string, unknown>;
  } else if (itemObj.location && typeof itemObj.location === "object" && !Array.isArray(itemObj.location)) {
    itemObj = itemObj.location as Record<string, unknown>;
  } else if (itemObj.node && typeof itemObj.node === "object" && !Array.isArray(itemObj.node)) {
    itemObj = itemObj.node as Record<string, unknown>;
  } else if (itemObj.data && typeof itemObj.data === "object" && !Array.isArray(itemObj.data)) {
    itemObj = itemObj.data as Record<string, unknown>;
  }

  const cleanString = (val: unknown): string | null => {
    if (typeof val === "string") {
      const trimmed = val.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof val === "number" && !Number.isNaN(val)) {
      return String(val);
    }
    return null;
  };

  const parseCoord = (val: unknown): number | null => {
    if (typeof val === "number" && !Number.isNaN(val)) {
      return val;
    }
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) {
        const num = Number.parseFloat(trimmed);
        return !Number.isNaN(num) ? num : null;
      }
    }
    return null;
  };

  // Reject error markers or empty marker items
  if (itemObj.error || itemObj.errorMessage) {
    return emptyResult;
  }

  const name = cleanString(
    itemObj.name ?? itemObj.title ?? itemObj.locationName ?? itemObj.location_name ?? itemObj.slug,
  );
  const category = cleanString(
    itemObj.category ??
      itemObj.categoryName ??
      itemObj.category_name ??
      itemObj.primaryCategory ??
      itemObj.location_category,
  );
  const locationId = cleanString(itemObj.location_id ?? itemObj.id ?? itemObj.pk ?? itemObj.place_id);
  const lat = parseCoord(itemObj.lat ?? itemObj.latitude);
  const lng = parseCoord(itemObj.lng ?? itemObj.longitude);
  const address = cleanString(
    itemObj.location_address ??
      itemObj.address ??
      itemObj.street_address ??
      itemObj.formatted_address,
  );
  const city = cleanString(itemObj.location_city ?? itemObj.city ?? itemObj.city_name);
  const zip = cleanString(
    itemObj.location_zip ?? itemObj.zip ?? itemObj.zip_code ?? itemObj.postal_code,
  );
  const phone = cleanString(
    itemObj.phone ?? itemObj.phone_number ?? itemObj.contact_phone_number,
  );

  // Distinguish real place records from unparseable/marker items
  const hasPlaceSignal = Boolean(
    name ||
      locationId ||
      category ||
      (lat !== null && lng !== null) ||
      address ||
      itemObj.slug ||
      itemObj.inputUrl ||
      itemObj.ig_business,
  );

  if (!hasPlaceSignal) {
    return emptyResult;
  }

  // Extract Instagram handle from nested business profile, user, owner, or username fields
  const igBusiness = itemObj.ig_business as Record<string, unknown> | undefined;
  const igBusinessProfile = igBusiness?.profile as Record<string, unknown> | undefined;
  const rawProfile = itemObj.profile as Record<string, unknown> | undefined;
  const rawUser = itemObj.user as Record<string, unknown> | undefined;
  const rawOwner = itemObj.owner as Record<string, unknown> | undefined;

  let candidateHandleString =
    cleanString(igBusinessProfile?.username) ??
    cleanString(igBusiness?.username) ??
    cleanString(rawProfile?.username) ??
    cleanString(rawUser?.username) ??
    cleanString(rawOwner?.username) ??
    cleanString(itemObj.username);

  // If no direct handle string, check potential URL fields
  if (!candidateHandleString) {
    const candidateUrls = [
      itemObj.instagram_url,
      itemObj.instagramUrl,
      itemObj.ig_url,
      itemObj.url,
      itemObj.externalUrl,
      itemObj.website,
      itemObj.inputUrl,
    ];
    for (const u of candidateUrls) {
      const str = cleanString(u);
      if (str) {
        const handleFromUrl = normalizeInstagramHandle(str);
        if (handleFromUrl) {
          candidateHandleString = handleFromUrl;
          break;
        }
      }
    }
  }

  const normalizedHandle = candidateHandleString
    ? normalizeInstagramHandle(candidateHandleString)
    : null;

  if (!normalizedHandle) {
    return {
      isPlace: true,
      candidate: null,
      rawUsername: null,
      hasInstagram: false,
      isOutOfArea: false,
      name,
      category,
      lat,
      lng,
      address,
      skipReason: "NO_INSTAGRAM",
    };
  }

  const effectiveCity = targetCity?.trim() || "";
  const isInCity = isPlausiblyInCity({
    address,
    zip,
    lat,
    lng,
    targetCity: effectiveCity,
    radiusKm,
  });

  if (!isInCity) {
    return {
      isPlace: true,
      candidate: null,
      rawUsername: normalizedHandle,
      hasInstagram: true,
      isOutOfArea: true,
      name,
      category,
      lat,
      lng,
      address,
      skipReason: "OUT_OF_AREA",
    };
  }

  const candidate: DiscoveredProfile = {
    username: normalizedHandle,
    profileUrl: `https://www.instagram.com/${normalizedHandle}`,
    fullName: name,
    category,
    businessCategoryName: category,
    gmapsCategory: category,
    gmapsCategories: category ? [category] : null,
    gmapsAddress: address,
    gmapsCity: city ?? (effectiveCity || null),
    location: address ?? (city ?? (effectiveCity || null)),
    phone: phone ?? null,
    businessAddress: {
      street_address: address ?? undefined,
      zip_code: zip ?? undefined,
      city_name: city ?? (effectiveCity || undefined),
    },
    gmapsPlaceId: locationId ? String(locationId) : null,
    sourceProvider: "instagram_places",
  };

  return {
    isPlace: true,
    candidate,
    rawUsername: normalizedHandle,
    hasInstagram: true,
    isOutOfArea: false,
    name,
    category,
    lat,
    lng,
    address,
    skipReason: null,
  };
}

/**
 * Discovery provider using apify/instagram-scraper in PLACE SEARCH mode.
 *
 * Constraints:
 * - NO live Apify calls ($0 credit): every call must go through the central cost guard `runActorSafely`.
 * - Search type must be "place" (never profile/hashtag/details mode which charge per row/post).
 * - resultsLimit is set to 1 (minimal) to avoid collecting posts.
 * - searchLimit is capped at hard max 25 (default 10).
 * - Drops places with no Instagram handle (counted as NO_INSTAGRAM).
 * - Drops places outside the requested city radius (counted as OUT_OF_AREA).
 * - Maps surviving places to Maps-style candidates for unchanged downstream gate processing.
 */
export class InstagramPlacesDiscoveryProvider implements DiscoveryProvider {
  readonly name = "instagram_places";

  async discover(input: DiscoveryInput): Promise<DiscoveryResult> {
    const actorId = getIgPlacesActorId();
    const searchLimit = getIgPlacesSearchLimit(input.limit);
    const resolved = resolveTargetCities(input.location);
    const targetCity = resolved.cities[0] || (input.location ?? "").split(",")[0].trim();
    const searchQuery = buildPlaceSearchQuery(input.query, targetCity);
    const radiusKm = getIgPlacesRadiusKm();

    const actorInput = {
      search: searchQuery,
      searchType: "place",
      searchLimit,
      resultsLimit: 1,
      resultsType: "details",
    };

    const estimatedCostUsd = searchLimit * COST_PER_PLACE_ITEM_USD;

    console.log(
      `[IG-PLACES-DISCOVERY] Running actor=${actorId} searchLimit=${searchLimit} city="${targetCity || "-"}"`,
    );
    console.log(
      `[IG-PLACES-DISCOVERY] Final input JSON: ${JSON.stringify(actorInput, null, 2)}`,
    );
    console.log(
      `[IG-PLACES-DISCOVERY] Estimated Apify cost: $${estimatedCostUsd.toFixed(4)} (${searchLimit} items @ ~$${COST_PER_PLACE_ITEM_USD}/item)`,
    );

    const safeResult = await runActorSafely<unknown>(
      actorId,
      actorInput,
      {
        maxItems: searchLimit,
        maxTotalChargeUsd: getMaxChargePerRunUsd(),
        timeoutSecs: searchLimit <= 10 ? 120 : 180,
        campaignId: input.campaignId ?? undefined,
        userId: input.userId ?? undefined,
        operationName: "instagram_places_search",
      },
    );

    const rawItems = safeResult.items ?? [];
    const itemsReturnedRaw = rawItems.length;
    let itemsParsedAsPlaces = 0;
    let withInstagramUsername = 0;
    let noInstagramCount = 0;
    let outOfAreaCount = 0;
    let duplicatesSkipped = 0;

    const candidates: DiscoveredProfile[] = [];
    const seenUsernames = new Set<string>();

    for (const item of rawItems) {
      const parsed = parseIgPlaceItem(item, targetCity, radiusKm);
      if (!parsed.isPlace) {
        continue;
      }
      itemsParsedAsPlaces++;

      if (!parsed.hasInstagram || !parsed.rawUsername) {
        noInstagramCount++;
        continue;
      }
      withInstagramUsername++;

      if (seenUsernames.has(parsed.rawUsername)) {
        duplicatesSkipped++;
        continue;
      }

      if (parsed.isOutOfArea) {
        outOfAreaCount++;
        continue;
      }

      seenUsernames.add(parsed.rawUsername);
      if (parsed.candidate) {
        candidates.push(parsed.candidate);
      }
    }

    console.log(
      `[IG-PLACES-DISCOVERY] Processed ${itemsReturnedRaw} place items: ` +
        `parsed=${itemsParsedAsPlaces}, with_ig=${withInstagramUsername}, no_ig=${noInstagramCount}, ` +
        `out_of_area=${outOfAreaCount}, duplicates=${duplicatesSkipped}, kept=${candidates.length}`,
    );

    return {
      candidates,
      runId: safeResult.run.id,
      datasetId: safeResult.run.defaultDatasetId ?? null,
      actor: actorId,
      usageTotalUsd: safeResult.usageTotalUsd,
      computeUnits: safeResult.computeUnits,
      itemsReturnedRaw,
      itemsParsedAsPlaces,
      withInstagramUsername,
      noInstagramCount,
      outOfAreaCount,
      duplicatesSkipped,
      candidatesKept: candidates.length,
      placesReturned: itemsReturnedRaw,
      placesWithInstagram: withInstagramUsername,
      requestsUsed: 1,
      sourceProvider: "instagram_places",
      executedQueries: [searchQuery],
      isTimedOut: safeResult.isTimedOut,
      isWasted: safeResult.isWasted,
      keywordStats: [
        {
          query: searchQuery,
          candidatesCount: candidates.length,
          rawCount: itemsReturnedRaw,
        },
      ],
    };
  }
}

