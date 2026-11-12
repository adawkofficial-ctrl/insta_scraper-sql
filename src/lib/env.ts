import fs from "fs";
import path from "path";

let lastEnvMtime = (() => {
  try {
    if (typeof process === "undefined" || typeof process.cwd !== "function") return 0;
    const envPath = path.resolve(process.cwd(), ".env");
    return fs.existsSync(envPath) ? fs.statSync(envPath).mtimeMs : 0;
  } catch {
    return 0;
  }
})();

function syncEnvFromDisk(): void {
  try {
    if (typeof process === "undefined" || typeof process.cwd !== "function") return;
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const stat = fs.statSync(envPath);
    if (stat.mtimeMs !== lastEnvMtime) {
      lastEnvMtime = stat.mtimeMs;
      const content = fs.readFileSync(envPath, "utf-8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  } catch {
    // Non-fatal if filesystem is inaccessible
  }
}

export function getServerEnv(name: string): string | undefined {
  syncEnvFromDisk();
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function requireServerEnv(name: string): string {
  const value = getServerEnv(name);
  if (value === undefined) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }

  return value;
}

export type ScraperProviderType = "apify" | "sparior";

export function getScraperProviderName(): ScraperProviderType {
  const raw = getServerEnv("SCRAPER_PROVIDER") ?? "apify";
  const normalized = raw.toLowerCase();
  if (normalized !== "apify" && normalized !== "sparior") {
    throw new Error(
      `Invalid SCRAPER_PROVIDER: "${raw}". Must be "apify" or "sparior".`,
    );
  }
  return normalized;
}

/**
 * Discovery provider switch.
 *
 * Defaults to `instagram_all_in_one` (apify/instagram-scraper only) so the
 * disabled Maps/profile-scraper actors are never called unless explicitly
 * selected. `DISCOVERY_PROVIDER=google_maps` restores the previous behaviour.
 */
export type DiscoveryProviderName =
  | "instagram_all_in_one"
  | "google_maps"
  | "instagram_search"
  | "instagram_places"
  | "hybrid";

const VALID_DISCOVERY_PROVIDERS: DiscoveryProviderName[] = [
  "instagram_all_in_one",
  "google_maps",
  "instagram_search",
  "instagram_places",
  "hybrid",
];

export function getDiscoveryProviderName(): DiscoveryProviderName {
  const raw = getServerEnv("DISCOVERY_PROVIDER");
  if (!raw) {
    return "instagram_all_in_one";
  }
  const normalized = raw.toLowerCase();
  if (!VALID_DISCOVERY_PROVIDERS.includes(normalized as DiscoveryProviderName)) {
    return "instagram_all_in_one";
  }
  return normalized as DiscoveryProviderName;
}

/**
 * Profile enrichment actor switch.
 *
 * - `instagram_scraper` (default): apify/instagram-scraper details mode.
 * - `instagram_profile_scraper`: legacy apify/instagram-profile-scraper.
 */
export type EnrichmentProviderName = "instagram_scraper" | "instagram_profile_scraper";

export function getEnrichmentProviderName(): EnrichmentProviderName {
  const raw = getServerEnv("ENRICHMENT_PROVIDER");
  if (!raw) {
    return "instagram_scraper";
  }
  const normalized = raw.toLowerCase();
  if (normalized !== "instagram_scraper" && normalized !== "instagram_profile_scraper") {
    return "instagram_scraper";
  }
  return normalized;
}

export function getIgScraperCostPerResultUsd(): number {
  const parsed = Number.parseFloat(getServerEnv("IG_SCRAPER_COST_PER_RESULT_USD") ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.0027;
}

export function getIgSearchLimit(): number {
  const parsed = Number.parseInt(getServerEnv("IG_SEARCH_LIMIT") ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 250) : 10;
}

export function getIgMaxQueriesPerJob(): number {
  const parsed = Number.parseInt(getServerEnv("IG_MAX_QUERIES_PER_JOB") ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
}

export function getIgMaxResultsPerJob(): number {
  const parsed = Number.parseInt(getServerEnv("IG_MAX_RESULTS_PER_JOB") ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

export function getDiscoveryMaxJobUsd(): number {
  const parsed = Number.parseFloat(getServerEnv("DISCOVERY_MAX_JOB_USD") ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.30;
}

/**
 * Master switch for Apify spend guardrails (monthly/report/dashboard limits).
 * Set APIFY_COST_LIMITS_ENABLED=false to disable monthly, per-run, per-job and
 * pre-run ceiling enforcement. The APIFY_ENABLED kill switch still applies.
 */
export function areApifyCostLimitsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.APIFY_COST_LIMITS_ENABLED ?? "").trim().toLowerCase();
  return raw !== "false" && raw !== "0";
}

export type SpariorConfig = {
  apiKey: string;
  apiHost: string;
  baseUrl: string;
  monthlyPriceUsd: number;
  monthlyRequestLimit: number;
  maxRequestsPerRun: number;
  maxPagesPerRun: number;
  maxProfilesPerRun: number;
  monthlySoftLimitPercent: number;
  requestDelayMs: number;
  quotaReserve: number;
};

export function getSpariorConfig(validate = true): SpariorConfig {
  const apiKey = getServerEnv("SPARIOR_API_KEY") ?? "";
  const apiHost =
    getServerEnv("SPARIOR_API_HOST") ?? "instagram-social.p.rapidapi.com";
  const baseUrl = (
    getServerEnv("SPARIOR_BASE_URL") ??
    "https://instagram-social.p.rapidapi.com"
  ).replace(/\/+$/, "");
  const monthlyPriceUsd = parseFloat(
    getServerEnv("SPARIOR_MONTHLY_PRICE_USD") ?? "14.95",
  );
  const monthlyRequestLimit = parseInt(
    getServerEnv("SPARIOR_MONTHLY_REQUEST_LIMIT") ?? "10000",
    10,
  );
  const maxRequestsPerRun = parseInt(
    getServerEnv("SPARIOR_MAX_REQUESTS_PER_RUN") ?? "50",
    10,
  );
  const maxPagesPerRun = parseInt(
    getServerEnv("SPARIOR_MAX_PAGES_PER_RUN") ?? "10",
    10,
  );
  const maxProfilesPerRun = parseInt(
    getServerEnv("SPARIOR_MAX_PROFILES_PER_RUN") ?? "100",
    10,
  );
  const monthlySoftLimitPercent = parseInt(
    getServerEnv("SPARIOR_MONTHLY_SOFT_LIMIT_PERCENT") ?? "90",
    10,
  );
  const requestDelayMs = parseInt(
    getServerEnv("SPARIOR_REQUEST_DELAY_MS") ?? "250",
    10,
  );
  const quotaReserve = parseInt(
    getServerEnv("SPARIOR_QUOTA_RESERVE") ?? "5",
    10,
  );

  if (validate) {
    if (!apiKey) {
      throw new Error(
        "Missing required environment variable: SPARIOR_API_KEY when SCRAPER_PROVIDER=sparior",
      );
    }
    if (!apiHost) {
      throw new Error(
        "Missing required environment variable: SPARIOR_API_HOST when SCRAPER_PROVIDER=sparior",
      );
    }
    const rawReserve = getServerEnv("SPARIOR_QUOTA_RESERVE");
    if (rawReserve !== undefined && (isNaN(quotaReserve) || quotaReserve < 0)) {
      throw new Error(
        "Invalid environment variable: SPARIOR_QUOTA_RESERVE must be a non-negative integer",
      );
    }
  }

  return {
    apiKey,
    apiHost,
    baseUrl,
    monthlyPriceUsd: isNaN(monthlyPriceUsd) ? 14.95 : monthlyPriceUsd,
    monthlyRequestLimit: isNaN(monthlyRequestLimit) ? 10000 : monthlyRequestLimit,
    maxRequestsPerRun: isNaN(maxRequestsPerRun) ? 50 : maxRequestsPerRun,
    maxPagesPerRun: isNaN(maxPagesPerRun) ? 10 : maxPagesPerRun,
    maxProfilesPerRun: isNaN(maxProfilesPerRun) ? 100 : maxProfilesPerRun,
    monthlySoftLimitPercent: isNaN(monthlySoftLimitPercent) ? 90 : monthlySoftLimitPercent,
    requestDelayMs: isNaN(requestDelayMs) ? 250 : requestDelayMs,
    quotaReserve: isNaN(quotaReserve) ? 5 : quotaReserve,
  };
}

export function validateScraperConfig(): void {
  const provider = getScraperProviderName();
  if (provider === "sparior") {
    getSpariorConfig(true);
  } else if (provider === "apify") {
    requireServerEnv("APIFY_API_TOKEN");
  }
}

export type UnipileConfig = {
  apiKey: string;
  dsn: string;
  baseUrl: string;
  isConfigured: boolean;
};

export function getUnipileConfig(): UnipileConfig {
  const apiKey = getServerEnv("UNIPILE_API_KEY") ?? "";
  const dsn = getServerEnv("UNIPILE_DSN") ?? "";
  const customBaseUrl = getServerEnv("UNIPILE_BASE_URL");

  const rawHost = customBaseUrl || dsn || "https://api.unipile.com";
  let normalized = rawHost.trim().replace(/\/+$/, "");
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = `https://${normalized}`;
  }

  // Strip /api/v1 if already present to find the clean root host
  const rootUrl = normalized.replace(/\/api\/v1\/?$/i, "");
  // Unipile API endpoints are under /api/v1
  const baseUrl = `${rootUrl}/api/v1`;

  return {
    apiKey,
    dsn: rootUrl,
    baseUrl,
    isConfigured: Boolean(apiKey && (dsn || customBaseUrl)),
  };
}

export function getNotificationMaxPerMinute(): number {
  const raw = Number(getServerEnv("NOTIFICATION_MAX_PER_MINUTE") ?? "20");
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 20;
}

export function getNotificationHighScoreThreshold(): number {
  const raw = Number(getServerEnv("NOTIFICATION_HIGH_SCORE_THRESHOLD") ?? "85");
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? Math.trunc(raw) : 85;
}

export type AdminCredentials = {
  email: string;
  password: string;
};

export function getAdminCredentials(): AdminCredentials {
  const email = getServerEnv("ADMIN_EMAIL") ?? "admin@instascraper.com";
  const password = getServerEnv("ADMIN_PASSWORD") ?? "AdminPass2026!Secure";
  return {
    email: email.trim().toLowerCase(),
    password: password.trim(),
  };
}

