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

  // 3. Check Canadian province suffixes
  if (/\b(on|bc|qc|ab|mb|sk|ns|nb|nl|pe)\b/i.test(clean)) {
    return "CA";
  }

  // 4. Check US state abbreviations
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

/**
 * City center coordinates lookup for location radius validation in Instagram Places discovery.
 */
export const CITY_COORDINATES: Record<string, { lat: number; lng: number }> = {
  toronto: { lat: 43.6532, lng: -79.3832 },
  vancouver: { lat: 49.2827, lng: -123.1207 },
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
 */
export function normalizeCityKey(targetCity: string): string {
  const firstSegment = targetCity.split(",")[0].trim().toLowerCase();
  return firstSegment.replace(/[^a-z0-9 ]/g, "").trim();
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

  return false;
}

