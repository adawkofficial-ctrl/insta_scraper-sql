export function getServerEnv(name: string): string | undefined {
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
    dsn: dsn || rootUrl,
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
