/**
 * Pure Google Maps discovery cost-optimization helpers.
 *
 * No network, no DB, no secrets: everything here is deterministic and unit
 * testable with mocked actor output.
 */

export const DEFAULT_AREA_COOLDOWN_DAYS = 30;
export const DEFAULT_PLACE_OUTCOME_CACHE_DAYS = 90;
export const DEFAULT_MIN_IG_YIELD_PERCENT = 10;
export const DEFAULT_ROLLING_COST_RUNS = 5;
export const DEFAULT_FALLBACK_COST_PER_PLACE_USD = 0.003; // $3.00 per 1,000 places
export const KEYWORD_OVERLAP_DROP_RATIO = 0.7;
export const FIRST_BATCH_SEEN_STOP_RATIO = 0.6;

export type CoverageRow = {
  keyword: string;
  area: string;
  runDate: Date | string;
  placeIds?: string[];
  newPlaces?: number;
  acceptedLeads?: number;
};

export type PlaceOutcomeRow = {
  placeId: string;
  outcome: "accepted" | "rejected" | "no_contact" | string;
  reason?: string | null;
  updatedAt: Date | string;
};

export type ChargedEvent = {
  event: string;
  count: number | null;
  usd: number | null;
};

export type ChargedBreakdown = {
  chargedUsd: number;
  events: ChargedEvent[];
  raw: Record<string, unknown> | null;
};

export function getAreaCooldownDays(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.DISCOVERY_AREA_COOLDOWN_DAYS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AREA_COOLDOWN_DAYS;
}

export function getPlaceOutcomeCacheDays(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.DISCOVERY_CACHE_DAYS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PLACE_OUTCOME_CACHE_DAYS;
}

export function getMinIgYieldPercent(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseFloat(env.GMAPS_MIN_IG_YIELD_PERCENT ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_IG_YIELD_PERCENT;
}

export function normalizeKeyword(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeArea(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function coverageKey(keyword: string, area: string): string {
  return `${normalizeKeyword(keyword)}|${normalizeArea(area)}`;
}

/**
 * Built-in sub-areas for major Canadian and US cities. A configured list can
 * be supplied per city via env GMAPS_AREA_OVERRIDES (JSON) — see getAreasForCity.
 */
export const CITY_AREAS: Record<string, string[]> = {
  toronto: ["Downtown Toronto", "North York", "Scarborough", "Etobicoke", "Mississauga", "Vaughan", "Markham", "Richmond Hill"],
  vancouver: ["Downtown Vancouver", "Kitsilano", "Burnaby", "Richmond", "Surrey", "North Vancouver", "Coquitlam"],
  montreal: ["Downtown Montreal", "Plateau", "Laval", "Longueuil", "Brossard", "West Island"],
  calgary: ["Downtown Calgary", "Northwest Calgary", "Northeast Calgary", "Southeast Calgary", "Airdrie"],
  ottawa: ["Downtown Ottawa", "Kanata", "Nepean", "Orleans", "Gatineau"],
  edmonton: ["Downtown Edmonton", "West Edmonton", "South Edmonton", "St. Albert"],
  mississauga: ["City Centre", "Port Credit", "Streetsville", "Malton", "Brampton"],
  "new york": ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "Jersey City"],
  "los angeles": ["Downtown LA", "Hollywood", "Santa Monica", "Pasadena", "Long Beach", "Beverly Hills"],
  chicago: ["Downtown Chicago", "Lincoln Park", "Wicker Park", "Evanston", "Oak Park"],
  houston: ["Downtown Houston", "The Woodlands", "Sugar Land", "Katy"],
  miami: ["Downtown Miami", "Brickell", "Coral Gables", "Hialeah", "Fort Lauderdale"],
  "san francisco": ["Downtown SF", "Mission District", "Oakland", "Berkeley", "Daly City"],
  seattle: ["Downtown Seattle", "Bellevue", "Redmond", "Tacoma", "Everett"],
  boston: ["Downtown Boston", "Cambridge", "Somerville", "Brookline", "Quincy"],
  austin: ["Downtown Austin", "North Austin", "South Austin", "Round Rock", "Cedar Park"],
  dallas: ["Downtown Dallas", "Plano", "Irving", "Arlington", "Frisco"],
  atlanta: ["Downtown Atlanta", "Buckhead", "Decatur", "Marietta", "Sandy Springs"],
  philadelphia: ["Center City", "University City", "Camden", "King of Prussia"],
  phoenix: ["Downtown Phoenix", "Scottsdale", "Tempe", "Mesa", "Chandler"],
  "san diego": ["Downtown San Diego", "La Jolla", "Chula Vista", "Carlsbad"],
  denver: ["Downtown Denver", "Aurora", "Lakewood", "Boulder"],
};

function readOverrideAreas(env: NodeJS.ProcessEnv): Record<string, string[]> {
  const raw = env.GMAPS_AREA_OVERRIDES?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [city, values] of Object.entries(parsed)) {
      if (!Array.isArray(values)) continue;
      const areas = values
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean);
      if (areas.length > 0) out[normalizeKeyword(city)] = areas;
    }
    return out;
  } catch {
    return {};
  }
}

export function getAreasForCity(
  city: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = city.trim();
  if (!raw) return [];
  const cityOnly = raw.split(",")[0].trim();
  const key = normalizeKeyword(cityOnly);
  const overrides = readOverrideAreas(env);
  const configured = overrides[key] ?? CITY_AREAS[key] ?? [];
  const areas = [cityOnly, ...configured];
  return Array.from(new Set(areas.map((a) => a.trim()).filter(Boolean)));
}

export function isAreaCoolingDown(
  rows: CoverageRow[],
  keyword: string,
  area: string,
  cooldownDays: number,
  now: Date = new Date(),
): boolean {
  if (cooldownDays <= 0) return false;
  const cutoff = now.getTime() - cooldownDays * 24 * 60 * 60 * 1000;
  const key = coverageKey(keyword, area);
  return rows.some((row) => {
    if (coverageKey(row.keyword, row.area) !== key) return false;
    const ts = new Date(row.runDate).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

/**
 * Picks the least-recently-covered area that is not in cooldown. Areas are
 * ordered from the city itself outward so new jobs rotate into sub-areas.
 */
export function pickNextArea(
  city: string,
  keyword: string,
  rows: CoverageRow[],
  cooldownDays: number,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const areas = getAreasForCity(city, env);
  if (areas.length === 0) return null;

  const lastRunByArea = new Map<string, number>();
  for (const row of rows) {
    const key = coverageKey(row.keyword, row.area);
    const ts = new Date(row.runDate).getTime();
    if (!Number.isFinite(ts)) continue;
    lastRunByArea.set(key, Math.max(lastRunByArea.get(key) ?? 0, ts));
  }

  const available = areas.filter(
    (area) => !isAreaCoolingDown(rows, keyword, area, cooldownDays, now),
  );
  if (available.length === 0) return null;

  available.sort((a, b) => {
    const aLast = lastRunByArea.get(coverageKey(keyword, a)) ?? 0;
    const bLast = lastRunByArea.get(coverageKey(keyword, b)) ?? 0;
    return aLast - bLast;
  });
  return available[0] ?? null;
}

export function placeOverlapRatio(
  existingPlaceIds: Iterable<string>,
  newPlaceIds: Iterable<string>,
): number {
  const existing = new Set(existingPlaceIds);
  const ids = Array.from(new Set(newPlaceIds)).filter(Boolean);
  if (ids.length === 0) return 0;
  const overlap = ids.filter((id) => existing.has(id)).length;
  return overlap / ids.length;
}

export function shouldDropKeyword(overlapRatio: number): boolean {
  return overlapRatio > KEYWORD_OVERLAP_DROP_RATIO;
}

export function isFirstBatchMostlySeen(
  newPlaces: number,
  totalPlaces: number,
): boolean {
  if (totalPlaces <= 0) return false;
  return 1 - newPlaces / totalPlaces > FIRST_BATCH_SEEN_STOP_RATIO;
}

export function computeIgYieldPercent(
  itemsReturned: number,
  leadsWithIg: number,
): number {
  if (itemsReturned <= 0) return 0;
  return (leadsWithIg / itemsReturned) * 100;
}

export function shouldStopForLowYield(
  itemsReturned: number,
  leadsWithIg: number,
  thresholdPercent: number,
): boolean {
  return itemsReturned > 0 && computeIgYieldPercent(itemsReturned, leadsWithIg) < thresholdPercent;
}

/** Tolerant extraction of the actual charged amount + charged-event breakdown. */
export function parseChargedBreakdown(run: unknown): ChargedBreakdown {
  const record =
    run !== null && typeof run === "object" && !Array.isArray(run)
      ? (run as Record<string, unknown>)
      : null;
  if (!record) return { chargedUsd: 0, events: [], raw: null };

  const chargedUsdCandidates = [
    record.usageTotalUsd,
    record.chargedUsd,
    record.usageUsd,
  ];
  let chargedUsd = 0;
  for (const candidate of chargedUsdCandidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      chargedUsd = candidate;
      break;
    }
  }

  const events: ChargedEvent[] = [];
  const rawCandidates = [record.usage, record.usageUsd, record.chargedEvents, record.pricingInfo];
  let raw: Record<string, unknown> | null = null;
  for (const candidate of rawCandidates) {
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      raw = candidate as Record<string, unknown>;
      break;
    }
  }

  if (raw) {
    for (const [event, value] of Object.entries(raw)) {
      if (typeof value === "number") {
        events.push({
          event,
          count: Number.isInteger(value) ? value : null,
          usd: event.toLowerCase().includes("usd") ? value : null,
        });
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const count = typeof obj.count === "number" ? obj.count : null;
        const usd =
          typeof obj.usd === "number"
            ? obj.usd
            : typeof obj.usageUsd === "number"
              ? obj.usageUsd
              : null;
        events.push({ event, count, usd });
      }
    }
  }

  return { chargedUsd, events, raw };
}

export type YieldStats = {
  placesReturned: number;
  costUsd: number;
  costPerPlaceUsd: number | null;
  igReadyLeads: number;
  contactableLeads: number;
  costPerIgReadyLeadUsd: number | null;
  costPerContactableLeadUsd: number | null;
  wastedSpendUsd: number;
  wastedByReason: Record<string, number>;
  handleYieldBySource: Record<string, number>;
  handleYieldByArea: Record<string, number>;
  handleYieldByKeyword: Record<string, number>;
};

export function buildYieldStats(input: {
  placesReturned: number;
  costUsd: number;
  leadsWithIg: number;
  contactableLeads: number;
  wastedByReason?: Record<string, number>;
  handleYieldBySource?: Record<string, number>;
  handleYieldByArea?: Record<string, number>;
  handleYieldByKeyword?: Record<string, number>;
}): YieldStats {
  const cost = Math.max(0, input.costUsd);
  const wastedByReason = input.wastedByReason ?? {};
  const wastedSpendUsd = Object.values(wastedByReason).reduce(
    (sum, value) => sum + (Number.isFinite(value) ? value : 0),
    0,
  );
  return {
    placesReturned: input.placesReturned,
    costUsd: Number(cost.toFixed(4)),
    costPerPlaceUsd:
      input.placesReturned > 0 ? Number((cost / input.placesReturned).toFixed(4)) : null,
    igReadyLeads: input.leadsWithIg,
    contactableLeads: input.contactableLeads,
    costPerIgReadyLeadUsd:
      input.leadsWithIg > 0 ? Number((cost / input.leadsWithIg).toFixed(4)) : null,
    costPerContactableLeadUsd:
      input.contactableLeads > 0
        ? Number((cost / input.contactableLeads).toFixed(4))
        : null,
    wastedSpendUsd: Number(wastedSpendUsd.toFixed(4)),
    wastedByReason,
    handleYieldBySource: input.handleYieldBySource ?? {},
    handleYieldByArea: input.handleYieldByArea ?? {},
    handleYieldByKeyword: input.handleYieldByKeyword ?? {},
  };
}

export function rankKeywordSuggestions(
  stats: Array<{ keyword: string; places: number; igReady: number }>,
  limit = 3,
): Array<{ keyword: string; places: number; igReady: number; yield: number }> {
  return stats
    .filter((s) => s.places > 0)
    .map((s) => ({
      keyword: s.keyword,
      places: s.places,
      igReady: s.igReady,
      yield: s.igReady / s.places,
    }))
    .sort((a, b) => b.yield - a.yield)
    .slice(0, limit);
}
