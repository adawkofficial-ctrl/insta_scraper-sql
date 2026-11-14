/**
 * Country-to-top-cities fallback dictionary and multi-city resolver for discovery.
 *
 * When a user provides a broad country name (e.g. "Canada", "United States")
 * instead of specific cities, Google Maps requires localized city search queries.
 * This module expands country-level queries into top economic/population hubs.
 */

export const COUNTRY_TOP_CITIES: Record<string, string[]> = {
  canada: [
    "Toronto, ON",
    "Vancouver, BC",
    "Montreal, QC",
    "Calgary, AB",
    "Ottawa, ON",
  ],
  "united states": [
    "New York, NY",
    "Los Angeles, CA",
    "Chicago, IL",
    "Houston, TX",
    "Miami, FL",
  ],
  usa: [
    "New York, NY",
    "Los Angeles, CA",
    "Chicago, IL",
    "Houston, TX",
    "Miami, FL",
  ],
  us: [
    "New York, NY",
    "Los Angeles, CA",
    "Chicago, IL",
    "Houston, TX",
    "Miami, FL",
  ],
  "united kingdom": [
    "London, UK",
    "Manchester, UK",
    "Birmingham, UK",
    "Leeds, UK",
    "Glasgow, UK",
  ],
  uk: [
    "London, UK",
    "Manchester, UK",
    "Birmingham, UK",
    "Leeds, UK",
    "Glasgow, UK",
  ],
  australia: [
    "Sydney, Australia",
    "Melbourne, Australia",
    "Brisbane, Australia",
    "Perth, Australia",
    "Adelaide, Australia",
  ],
  pakistan: [
    "Karachi, Pakistan",
    "Lahore, Pakistan",
    "Islamabad, Pakistan",
    "Rawalpindi, Pakistan",
    "Faisalabad, Pakistan",
  ],
  uae: [
    "Dubai, UAE",
    "Abu Dhabi, UAE",
    "Sharjah, UAE",
    "Ajman, UAE",
    "Ras Al Khaimah, UAE",
  ],
  "united arab emirates": [
    "Dubai, UAE",
    "Abu Dhabi, UAE",
    "Sharjah, UAE",
    "Ajman, UAE",
    "Ras Al Khaimah, UAE",
  ],
  germany: [
    "Berlin, Germany",
    "Munich, Germany",
    "Frankfurt, Germany",
    "Hamburg, Germany",
    "Cologne, Germany",
  ],
  france: [
    "Paris, France",
    "Lyon, France",
    "Marseille, France",
    "Toulouse, France",
    "Nice, France",
  ],
  brazil: [
    "Sao Paulo, Brazil",
    "Rio de Janeiro, Brazil",
    "Belo Horizonte, Brazil",
    "Curitiba, Brazil",
    "Brasilia, Brazil",
  ],
  brasil: [
    "Sao Paulo, Brazil",
    "Rio de Janeiro, Brazil",
    "Belo Horizonte, Brazil",
    "Curitiba, Brazil",
    "Brasilia, Brazil",
  ],
};

export const COUNTRY_CODE_MAP: Record<string, string> = {
  canada: "ca",
  "united states": "us",
  usa: "us",
  us: "us",
  "united kingdom": "gb",
  uk: "gb",
  australia: "au",
  pakistan: "pk",
  uae: "ae",
  "united arab emirates": "ae",
  germany: "de",
  france: "fr",
  brazil: "br",
  brasil: "br",
  india: "in",
  mexico: "mx",
  italy: "it",
  spain: "es",
  japan: "jp",
};

/**
 * Resolves a two-letter ISO country code from a location string if possible.
 */
export function resolveCountryCode(location: string | null | undefined): string | null {
  if (!location || typeof location !== "string") {
    return null;
  }
  const clean = location.trim().toLowerCase();
  const normalizedKey = clean.replace(/[^a-z0-9 ]/g, "").trim();

  // 1. Direct match on known country
  if (COUNTRY_CODE_MAP[normalizedKey]) {
    return COUNTRY_CODE_MAP[normalizedKey].toUpperCase();
  }

  // 2. Check suffix (e.g. "Toronto, ON, Canada" or "London, UK")
  for (const [countryName, code] of Object.entries(COUNTRY_CODE_MAP)) {
    if (clean.endsWith(` ${countryName}`) || clean.endsWith(`, ${countryName}`) || clean.endsWith(`(${countryName})`)) {
      return code.toUpperCase();
    }
  }

  // 3. Check known Canadian and international major cities
  const canadianCities = [
    "toronto",
    "scarborough",
    "north york",
    "etobicoke",
    "mississauga",
    "markham",
    "vaughan",
    "richmond hill",
    "brampton",
    "vancouver",
    "montreal",
    "calgary",
    "ottawa",
    "edmonton",
    "winnipeg",
    "hamilton",
    "kitchener",
    "waterloo",
    "halifax",
  ];
  if (canadianCities.some((c) => normalizedKey === c || clean.startsWith(`${c},`) || clean.startsWith(`${c} `))) {
    return "CA";
  }

  // 4. Check Canadian province suffixes and names
  if (/\b(on|bc|qc|ab|mb|sk|ns|nb|nl|pe|ontario|quebec|alberta|manitoba|saskatchewan)\b/i.test(clean)) {
    return "CA";
  }

  // 5. Check US state abbreviations
  if (/\b(ny|ca|tx|fl|il|pa|oh|ga|nc|mi)\b/i.test(clean)) {
    return "US";
  }

  return null;
}

export type CityResolutionResult = {
  cities: string[];
  isCountryFallback: boolean;
  countryName?: string;
  recommendedCities?: string[];
  warning?: string;
};

export function isCountryName(location: string | null | undefined): boolean {
  if (!location || typeof location !== "string") return false;
  const key = location.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  return Boolean(COUNTRY_TOP_CITIES[key] || COUNTRY_CODE_MAP[key]);
}

export function getRecommendedCitiesForCountry(location: string | null | undefined): string[] {
  if (!location || typeof location !== "string") return [];
  const key = location.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  return COUNTRY_TOP_CITIES[key] ?? [];
}

/**
 * Resolves a campaign location string into a list of target cities.
 *
 * Supports:
 * - Single city: "Toronto" -> ["Toronto"]
 * - Multiple cities (comma or semicolon separated): "Toronto, Vancouver, Calgary" -> ["Toronto", "Vancouver", "Calgary"]
 * - Country fallback: "Canada" -> ["Toronto, ON", "Vancouver, BC", ...] with pre-run plan
 */
export function resolveTargetCities(
  location: string | null | undefined,
): CityResolutionResult {
  if (!location || typeof location !== "string") {
    return {
      cities: [],
      isCountryFallback: false,
      warning: "No location specified. Please provide at least one city.",
    };
  }

  const trimmed = location.trim();
  if (trimmed.length === 0) {
    return {
      cities: [],
      isCountryFallback: false,
      warning: "Empty location specified. Please provide at least one city.",
    };
  }

  // Check if the entire location string is a known country name
  const normalizedCountryKey = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();

  const fallbackCities = COUNTRY_TOP_CITIES[normalizedCountryKey];
  if (fallbackCities && fallbackCities.length > 0) {
    const warning = `[GMAPS-DISCOVERY] Location "${trimmed}" is a whole country. Target cities planned: ${fallbackCities.join(", ")}.`;
    return {
      cities: fallbackCities,
      isCountryFallback: true,
      countryName: trimmed,
      recommendedCities: fallbackCities,
      warning,
    };
  }

  // Split multi-city strings on commas, semicolons, pipes, or slashes
  const parts = trimmed
    .split(/[,;\n\r|/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (parts.length === 0) {
    return {
      cities: [trimmed],
      isCountryFallback: false,
    };
  }

  // Deduplicate case-insensitively while preserving original casing
  const seen = new Set<string>();
  const uniqueCities: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      uniqueCities.push(part);
    }
  }

  return {
    cities: uniqueCities,
    isCountryFallback: false,
  };
}

export const LOCATION_PREFIXES = [
  "downtown",
  "north",
  "south",
  "east",
  "west",
  "central",
  "greater",
  "old",
  "new",
  "uptown",
  "midtown",
];

export function stripLocationPrefixes(token: string): string {
  let cleaned = token.toLowerCase().trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of LOCATION_PREFIXES) {
      if (cleaned.startsWith(`${prefix} `)) {
        cleaned = cleaned.slice(prefix.length + 1).trim();
        changed = true;
      }
    }
  }
  return cleaned;
}

/**
 * Built-in fully qualified area lists for the Greater Toronto Area (GTA)
 * to ensure unambiguous geocoding on Google Maps.
 */
export const GTA_AREAS: Record<string, { area: string; city: string; state: string; country: string }> = {
  toronto: { area: "Toronto", city: "Toronto", state: "ON", country: "Canada" },
  "north york": { area: "North York", city: "Toronto", state: "ON", country: "Canada" },
  scarborough: { area: "Scarborough", city: "Toronto", state: "ON", country: "Canada" },
  etobicoke: { area: "Etobicoke", city: "Toronto", state: "ON", country: "Canada" },
  mississauga: { area: "Mississauga", city: "Mississauga", state: "ON", country: "Canada" },
  markham: { area: "Markham", city: "Markham", state: "ON", country: "Canada" },
  vaughan: { area: "Vaughan", city: "Vaughan", state: "ON", country: "Canada" },
  "richmond hill": { area: "Richmond Hill", city: "Richmond Hill", state: "ON", country: "Canada" },
  ajax: { area: "Ajax", city: "Ajax", state: "ON", country: "Canada" },
  pickering: { area: "Pickering", city: "Pickering", state: "ON", country: "Canada" },
  brampton: { area: "Brampton", city: "Brampton", state: "ON", country: "Canada" },
};

/**
 * Builds a fully qualified Maps location string from structured parts:
 * "<area>, <city>, <province/state>, <country>" (e.g. "Scarborough, Toronto, ON, Canada").
 * Never sends a bare ambiguous name like "Scarborough" or "Vancouver".
 */
export function buildQualifiedLocationString(
  area: string,
  targetContext?: string | null,
  countryCode?: string | null,
): string {
  // A campaign may legitimately list several cities in `location`
  // ("Toronto, ON, Vancouver, BC, ..."). If that whole string ever reaches
  // `area`, never send it to the actor as one location: use the first
  // searchable city instead. Four parts are allowed for GTA-style
  // "Scarborough, Toronto, ON, Canada" values.
  const rawParts = area
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const effectiveArea =
    rawParts.length > 4
      ? rawParts.find((part) => part.length >= 3 && !/^[A-Z]{2}$/i.test(part)) ??
        rawParts[0] ??
        area
      : area;

  const normArea = effectiveArea.toLowerCase().trim();
  const stripped = stripLocationPrefixes(normArea);

  // 1. Direct GTA area mapping
  if (GTA_AREAS[stripped] || GTA_AREAS[normArea]) {
    const info = GTA_AREAS[stripped] || GTA_AREAS[normArea];
    return `${effectiveArea}, ${info.city}, ${info.state}, ${info.country}`;
  }

  // 2. If area already contains commas (e.g. "Vancouver, BC, Canada"), ensure country if missing
  if (effectiveArea.includes(",")) {
    const parts = effectiveArea.split(",").map((p) => p.trim());
    if (parts.length >= 3) return effectiveArea;
    const resolvedCountry = (countryCode || resolveCountryCode(targetContext || effectiveArea) || "CA").toUpperCase();
    const countryName = resolvedCountry === "CA" ? "Canada" : resolvedCountry === "US" ? "USA" : resolvedCountry;
    if (!effectiveArea.toLowerCase().includes(countryName.toLowerCase())) {
      return `${effectiveArea}, ${countryName}`;
    }
    return effectiveArea;
  }

  // 3. Fallback: combine area with target context or default country.
  // Never concatenate two different cities (e.g. "Downtown Vancouver, Toronto").
  const resolvedCountry = (countryCode || resolveCountryCode(targetContext) || "CA").toUpperCase();
  const countryName = resolvedCountry === "CA" ? "Canada" : resolvedCountry === "US" ? "USA" : resolvedCountry;
  const targetNorm = targetContext?.toLowerCase().trim() ?? "";
  const targetIsCountryLike =
    Boolean(targetNorm) &&
    (targetNorm === "canada" ||
      targetNorm === "usa" ||
      targetNorm === "united states" ||
      targetNorm === "uk" ||
      targetNorm === "united kingdom" ||
      targetNorm === "australia");

  if (
    targetContext &&
    targetContext !== effectiveArea &&
    !targetIsCountryLike &&
    !targetNorm.includes(normArea) &&
    !normArea.includes(targetNorm)
  ) {
    // Different city/context: keep the target city, add only the country.
    return `${effectiveArea}, ${countryName}`;
  }

  if (
    targetContext &&
    targetNorm.includes(normArea) &&
    targetNorm !== normArea &&
    targetContext.split(",").length <= 2
  ) {
    // targetContext is a single area plus province (e.g. "Toronto" + "Toronto, ON").
    return buildQualifiedLocationString(targetContext, undefined, countryCode);
  }

  return `${effectiveArea}, ${countryName}`;
}

/**
 * City center coordinates lookup for location radius validation in Instagram Places discovery.
 */
export const CITY_COORDINATES: Record<string, { lat: number; lng: number }> = {
  toronto: { lat: 43.6532, lng: -79.3832 },
  scarborough: { lat: 43.7764, lng: -79.2318 },
  "north york": { lat: 43.7615, lng: -79.4111 },
  etobicoke: { lat: 43.6205, lng: -79.5132 },
  mississauga: { lat: 43.5890, lng: -79.6441 },
  markham: { lat: 43.8561, lng: -79.3370 },
  vaughan: { lat: 43.8563, lng: -79.5085 },
  "richmond hill": { lat: 43.8828, lng: -79.4403 },
  ajax: { lat: 43.8509, lng: -79.0204 },
  pickering: { lat: 43.8384, lng: -79.0868 },
  brampton: { lat: 43.7315, lng: -79.7624 },
  vancouver: { lat: 49.2827, lng: -123.1207 },
  "downtown vancouver": { lat: 49.2827, lng: -123.1207 },
  montreal: { lat: 45.5017, lng: -73.5673 },
  calgary: { lat: 51.0447, lng: -114.0719 },
  ottawa: { lat: 45.4215, lng: -75.6972 },
  "new york": { lat: 40.7128, lng: -74.006 },
  "los angeles": { lat: 34.0522, lng: -118.2437 },
  chicago: { lat: 41.8781, lng: -87.6298 },
  houston: { lat: 29.7604, lng: -95.3698 },
  miami: { lat: 25.7617, lng: -80.1918 },
  london: { lat: 51.5074, lng: -0.1278 },
  manchester: { lat: 53.4808, lng: -2.2426 },
  birmingham: { lat: 52.4862, lng: -1.8904 },
  leeds: { lat: 53.8008, lng: -1.5491 },
  glasgow: { lat: 55.8642, lng: -4.2518 },
  sydney: { lat: -33.8688, lng: 151.2093 },
  melbourne: { lat: -37.8136, lng: 144.9631 },
  brisbane: { lat: -27.4698, lng: 153.0251 },
  perth: { lat: -31.9505, lng: 115.8605 },
  adelaide: { lat: -34.9285, lng: 138.6007 },
  karachi: { lat: 24.8607, lng: 67.0011 },
  lahore: { lat: 31.5204, lng: 74.3587 },
  islamabad: { lat: 33.6844, lng: 73.0479 },
  rawalpindi: { lat: 33.5651, lng: 73.0169 },
  faisalabad: { lat: 31.4504, lng: 73.135 },
  dubai: { lat: 25.2048, lng: 55.2708 },
  "abu dhabi": { lat: 24.4539, lng: 54.3773 },
  berlin: { lat: 52.52, lng: 13.405 },
  munich: { lat: 48.1351, lng: 11.582 },
  frankfurt: { lat: 50.1109, lng: 8.6821 },
  paris: { lat: 48.8566, lng: 2.3522 },
  "sao paulo": { lat: -23.5505, lng: -46.6333 },
};

/**
 * Calculates great-circle distance between two points on Earth using Haversine formula (km).
 */
export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // Earth's mean radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function getIgPlacesRadiusKm(): number {
  const envVal = process.env.IG_PLACES_RADIUS_KM;
  if (envVal) {
    const parsed = Number.parseFloat(envVal);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 40;
}

/**
 * Normalizes a target city input string into a lookup key (e.g. "Toronto, ON" -> "toronto").
 * Strips directional/center prefixes (e.g. "Downtown Vancouver" -> "vancouver").
 */
export function normalizeCityKey(targetCity: string): string {
  const firstSegment = targetCity.split(",")[0].trim().toLowerCase();
  const stripped = stripLocationPrefixes(firstSegment);
  return stripped.replace(/[^a-z0-9 ]/g, "").trim();
}

export type PlausibilityCheckOptions = {
  address?: string | null;
  zip?: string | null;
  lat?: number | null;
  lng?: number | null;
  targetCity: string;
  radiusKm?: number;
};

/**
 * Location check: keeps a place only if its address/zip or lat/lng is plausibly inside the requested city.
 *
 * Algorithm:
 * 1. If lat & lng are provided and target city has known center coordinates in CITY_COORDINATES:
 *    Calculates Haversine distance. If distance <= radiusKm (default 40km), returns true.
 *    If distance > radiusKm, returns false.
 * 2. If coordinates are absent or city coordinates unknown:
 *    Falls back to checking whether address or zip code text contains the city name.
 */
export function isPlausiblyInCity(options: PlausibilityCheckOptions): boolean {
  const { address, zip, lat, lng, targetCity } = options;
  if (!targetCity || typeof targetCity !== "string" || targetCity.trim().length === 0) {
    return true; // No target city specified, cannot invalidate
  }

  const radiusKm = options.radiusKm ?? getIgPlacesRadiusKm();
  const cityKey = normalizeCityKey(targetCity);
  const cityCenter = CITY_COORDINATES[cityKey];

  const hasCoords =
    typeof lat === "number" &&
    typeof lng === "number" &&
    !Number.isNaN(lat) &&
    !Number.isNaN(lng) &&
    (lat !== 0 || lng !== 0);

  if (hasCoords && cityCenter) {
    const dist = haversineDistanceKm(cityCenter.lat, cityCenter.lng, lat, lng);
    return dist <= radiusKm;
  }

  // Fallback to text check in address or zip
  const normAddress = (address ?? "").toLowerCase();
  const normZip = (zip ?? "").toLowerCase();
  const rawTargetLower = targetCity.toLowerCase();

  if (cityKey.length > 0 && (normAddress.includes(cityKey) || normZip.includes(cityKey))) {
    return true;
  }

  if (normAddress.includes(rawTargetLower) || normZip.includes(rawTargetLower)) {
    return true;
  }

  // An unknown city has no center coordinates, so coordinates cannot prove the
  // place is outside it. Treat the location as unknown rather than rejecting.
  return !cityCenter;
}

/**
 * State and Province normalization dictionary.
 * Normalizes province/state names and abbreviations bidirectionally to 2-letter codes.
 */
export const STATE_PROVINCE_MAP: Record<string, string> = {
  // Canada
  ontario: "ON",
  on: "ON",
  quebec: "QC",
  québec: "QC",
  qc: "QC",
  "british columbia": "BC",
  bc: "BC",
  alberta: "AB",
  ab: "AB",
  manitoba: "MB",
  mb: "MB",
  saskatchewan: "SK",
  sk: "SK",
  "nova scotia": "NS",
  ns: "NS",
  "new brunswick": "NB",
  nb: "NB",
  newfoundland: "NL",
  "newfoundland and labrador": "NL",
  nl: "NL",
  "prince edward island": "PE",
  pei: "PE",
  pe: "PE",
  "northwest territories": "NT",
  nt: "NT",
  yukon: "YT",
  yt: "YT",
  nunavut: "NU",
  nu: "NU",

  // United States (samples + commonly tested)
  alabama: "AL",
  al: "AL",
  california: "CA_US",
  new_york: "NY",
  "new york": "NY",
  ny: "NY",
  texas: "TX",
  tx: "TX",
  florida: "FL",
  fl: "FL",
  illinois: "IL",
  il: "IL",
  washington: "WA",
  wa: "WA",
};

export function normalizeState(state: string | null | undefined): string | null {
  if (!state || typeof state !== "string") return null;
  const clean = state.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return STATE_PROVINCE_MAP[clean] ?? clean.toUpperCase();
}

export function areStatesEqual(s1: string | null | undefined, s2: string | null | undefined): boolean {
  const norm1 = normalizeState(s1);
  const norm2 = normalizeState(s2);
  if (!norm1 || !norm2) return false;
  return norm1 === norm2;
}

/**
 * Configurable metropolitan regions mapping target metro to recognized suburbs and neighborhoods.
 */
export const METRO_REGIONS: Record<string, string[]> = {
  toronto: [
    "toronto",
    "markham",
    "scarborough",
    "north york",
    "etobicoke",
    "mississauga",
    "vaughan",
    "richmond hill",
    "ajax",
    "pickering",
    "brampton",
    "oakville",
    "milton",
    "whitby",
    "oshawa",
    "newmarket",
    "aurora",
    "east york",
    "york",
    "downtown toronto",
    "greater toronto area",
    "gta",
  ],
};

/**
 * Maps Canadian Forward Sortation Area (first 3 chars of postal code) to city and metro.
 */
export function mapCanadianFsaToMetro(postalCode: string | null | undefined): {
  city: string;
  metro: string;
  suburb?: string;
} | null {
  if (!postalCode || typeof postalCode !== "string") return null;
  const match = postalCode.trim().toUpperCase().match(/^([A-Z]\d[A-Z])/);
  if (!match) return null;
  const fsa = match[1];

  // All 'M' FSAs are in the City of Toronto / Metropolitan Toronto
  if (fsa.startsWith("M1")) {
    return { city: "Scarborough", metro: "Toronto", suburb: "Scarborough" };
  }
  if (fsa.startsWith("M2") || fsa.startsWith("M3")) {
    return { city: "North York", metro: "Toronto", suburb: "North York" };
  }
  if (fsa.startsWith("M4")) {
    return { city: "East York", metro: "Toronto", suburb: "East York" };
  }
  if (fsa.startsWith("M5") || fsa.startsWith("M6") || fsa.startsWith("M7")) {
    return { city: "Toronto", metro: "Toronto" };
  }
  if (fsa.startsWith("M8") || fsa.startsWith("M9")) {
    return { city: "Etobicoke", metro: "Toronto", suburb: "Etobicoke" };
  }
  if (fsa.startsWith("M")) {
    return { city: "Toronto", metro: "Toronto" };
  }

  // Common GTA 905 FSAs
  if (/^L(3R|3S|6B|6C|6E)/.test(fsa)) {
    return { city: "Markham", metro: "Toronto", suburb: "Markham" };
  }
  if (/^L(4B|4C|4S)/.test(fsa)) {
    return { city: "Richmond Hill", metro: "Toronto", suburb: "Richmond Hill" };
  }
  if (/^L(4H|4J|4K|4L)/.test(fsa)) {
    return { city: "Vaughan", metro: "Toronto", suburb: "Vaughan" };
  }
  if (/^L(4T|4W|4X|4Y|4Z|5)/.test(fsa)) {
    return { city: "Mississauga", metro: "Toronto", suburb: "Mississauga" };
  }
  if (/^L(6P|6R|6S|6T|6V|6W|6X|6Y|6Z)/.test(fsa)) {
    return { city: "Brampton", metro: "Toronto", suburb: "Brampton" };
  }
  if (/^L(1S|1T|1Z)/.test(fsa)) {
    return { city: "Ajax", metro: "Toronto", suburb: "Ajax" };
  }
  if (/^L(1V|1W|1X)/.test(fsa)) {
    return { city: "Pickering", metro: "Toronto", suburb: "Pickering" };
  }

  return null;
}

export const DEFAULT_MAPS_LOCATION_RADIUS_KM = 60;

export function getMapsRadiusKm(): number {
  if (typeof process !== "undefined" && process.env?.MAPS_LOCATION_RADIUS_KM) {
    const val = Number.parseFloat(process.env.MAPS_LOCATION_RADIUS_KM);
    if (!Number.isNaN(val) && val > 0) return val;
  }
  return DEFAULT_MAPS_LOCATION_RADIUS_KM;
}

export type DerivedLocationResult = {
  city: string;
  state: string | null;
  countryCode: string | null;
  locationConfidence: "high" | "medium";
  derivedFrom: "explicit_city" | "postal_code" | "neighborhood" | "address_text" | "coordinates" | "search_area";
  isExplicitMismatch: boolean;
  mismatchReason?: string;
};

/**
 * Derives location when city is null and validates against explicit mismatches only.
 */
export function derivePlaceLocation(
  place: {
    city?: string | null;
    neighborhood?: string | null;
    postalCode?: string | null;
    street?: string | null;
    address?: string | null;
    state?: string | null;
    countryCode?: string | null;
    location?: { lat?: number | null; lng?: number | null } | null;
    lat?: number | null;
    lng?: number | null;
  },
  searchArea: string,
  targetLocation?: string | null,
  options?: { gtaEnabled?: boolean; strictCityOnly?: boolean; radiusKm?: number },
): DerivedLocationResult {
  const normTargetLoc = (targetLocation || searchArea || "").toLowerCase();
  const isGtaTarget =
    options?.gtaEnabled ??
    (normTargetLoc.includes("gta") ||
      normTargetLoc.includes("greater toronto") ||
      normTargetLoc.includes("scarborough") ||
      normTargetLoc.includes("markham") ||
      normTargetLoc.includes("/") ||
      !options?.strictCityOnly);

  const isStrictCity = options?.strictCityOnly ?? (normTargetLoc === "toronto" || normTargetLoc.includes("strict"));

  // Unknown cities/countries must stay unknown: never fall back to Canada (or
  // any other country) because that turns an unknown location into a rejection.
  const targetCountry = resolveCountryCode(targetLocation || searchArea);
  const placeCountry = place.countryCode?.trim().toUpperCase() || null;

  // 1. Explicit Country Mismatch
  if (placeCountry && targetCountry && placeCountry !== targetCountry) {
    return {
      city: place.city || searchArea,
      state: place.state || null,
      countryCode: placeCountry,
      locationConfidence: "high",
      derivedFrom: "explicit_city",
      isExplicitMismatch: true,
      mismatchReason: `Country mismatch: got ${placeCountry}, expected ${targetCountry}`,
    };
  }

  // 2. Explicit State / Province Mismatch
  const placeStateNorm = normalizeState(place.state);
  let targetStateNorm: string | null = null;
  if (targetCountry === "CA") {
    const combinedTarget = `${normTargetLoc} ${searchArea.toLowerCase()}`;
    if (
      combinedTarget.includes("toronto") ||
      combinedTarget.includes("on") ||
      combinedTarget.includes("ontario") ||
      combinedTarget.includes("scarborough") ||
      combinedTarget.includes("markham") ||
      combinedTarget.includes("ottawa")
    ) {
      targetStateNorm = "ON";
    } else if (
      combinedTarget.includes("vancouver") ||
      combinedTarget.includes("bc") ||
      combinedTarget.includes("british columbia")
    ) {
      targetStateNorm = "BC";
    } else if (
      combinedTarget.includes("montreal") ||
      combinedTarget.includes("qc") ||
      combinedTarget.includes("quebec")
    ) {
      targetStateNorm = "QC";
    } else if (
      combinedTarget.includes("calgary") ||
      combinedTarget.includes("ab") ||
      combinedTarget.includes("alberta") ||
      combinedTarget.includes("edmonton")
    ) {
      targetStateNorm = "AB";
    }
  }

  if (placeStateNorm && targetStateNorm && placeStateNorm !== targetStateNorm) {
    return {
      city: place.city || searchArea,
      state: place.state || null,
      countryCode: placeCountry || targetCountry,
      locationConfidence: "high",
      derivedFrom: "explicit_city",
      isExplicitMismatch: true,
      mismatchReason: `State/Province mismatch: got ${place.state} (${placeStateNorm}), expected ${targetStateNorm}`,
    };
  }

  // 3. Coordinates Radius Check
  const lat = place.location?.lat ?? place.lat;
  const lng = place.location?.lng ?? place.lng;
  const radius = options?.radiusKm ?? getMapsRadiusKm();
  const searchCityKey = normalizeCityKey(searchArea);
  const targetCityKey = normalizeCityKey(targetLocation || "");
  // An unknown city has no entry in CITY_COORDINATES; it must NEVER default to Toronto.
  // When coordinates are unknown, coordinates check is skipped and result's own address/FSA decide.
  const searchCoords =
    CITY_COORDINATES[searchCityKey] ||
    CITY_COORDINATES[targetCityKey] ||
    undefined;

  if (typeof lat === "number" && typeof lng === "number" && searchCoords) {
    const dist = haversineDistanceKm(searchCoords.lat, searchCoords.lng, lat, lng);
    if (dist > radius) {
      return {
        city: place.city || searchArea,
        state: place.state || null,
        countryCode: placeCountry || targetCountry,
        locationConfidence: "medium",
        derivedFrom: "coordinates",
        isExplicitMismatch: true,
        mismatchReason: `Coordinates distance (${dist.toFixed(1)} km) exceeds radius (${radius} km)`,
      };
    }
  }

  // 4. City Derivation
  let derivedCity: string | null = null;
  let derivedFrom: DerivedLocationResult["derivedFrom"] = "search_area";
  let locationConfidence: "high" | "medium" = "medium";

  // Check explicit place.city
  if (typeof place.city === "string" && place.city.trim().length > 0) {
    derivedCity = place.city.trim();
    derivedFrom = "explicit_city";
    locationConfidence = "high";
  }

  // Derivation from Canadian FSA postal code
  if (!derivedCity && place.postalCode) {
    const fsaMatch = mapCanadianFsaToMetro(place.postalCode);
    if (fsaMatch) {
      derivedCity = fsaMatch.city;
      derivedFrom = "postal_code";
      locationConfidence = "high";
    }
  }

  // Derivation from neighborhood
  if (!derivedCity && place.neighborhood) {
    const neigh = place.neighborhood.trim();
    const neighLower = neigh.toLowerCase();
    const gtaSuburbs = METRO_REGIONS.toronto;
    for (const sub of gtaSuburbs) {
      if (neighLower.includes(sub)) {
        derivedCity = sub.charAt(0).toUpperCase() + sub.slice(1);
        derivedFrom = "neighborhood";
        locationConfidence = "high";
        break;
      }
    }
    if (!derivedCity) {
      derivedCity = neigh;
      derivedFrom = "neighborhood";
      locationConfidence = "high";
    }
  }

  // Derivation from street / address text
  if (!derivedCity && (place.street || place.address)) {
    const addrText = `${place.street || ""} ${place.address || ""}`.toLowerCase();
    for (const sub of METRO_REGIONS.toronto) {
      if (addrText.includes(sub)) {
        derivedCity = sub.charAt(0).toUpperCase() + sub.slice(1);
        derivedFrom = "address_text";
        locationConfidence = "high";
        break;
      }
    }
  }

  // Fallback to search area
  if (!derivedCity) {
    const cleanSearch = searchArea.split(/[/,]/)[0].trim();
    derivedCity = cleanSearch.charAt(0).toUpperCase() + cleanSearch.slice(1);
    derivedFrom = "search_area";
    locationConfidence = "medium";
  }

  // 5. Explicit City / Region Mismatch
  const derivedCityLower = derivedCity.toLowerCase();
  if (isStrictCity && !isGtaTarget) {
    if (derivedCityLower === "markham" || (derivedCityLower !== "toronto" && !derivedCityLower.includes("toronto"))) {
      return {
        city: derivedCity,
        state: place.state || null,
        countryCode: placeCountry || targetCountry,
        locationConfidence,
        derivedFrom,
        isExplicitMismatch: true,
        mismatchReason: `Explicit city mismatch: "${derivedCity}" outside strict target "${targetLocation || searchArea}"`,
      };
    }
  }

  return {
    city: derivedCity,
    state: place.state || null,
    countryCode: placeCountry || targetCountry,
    locationConfidence,
    derivedFrom,
    isExplicitMismatch: false,
  };
}

