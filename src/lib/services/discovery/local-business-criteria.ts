import {
  DEFAULT_ENRICHMENT_CRITERIA,
  type EnrichmentCriteria,
} from "./enrichment-criteria";

/**
 * Sensible local-business defaults for the Instagram-only provider.
 *
 * These are applied ONLY when DISCOVERY_PROVIDER=instagram_all_in_one, so the
 * legacy Google Maps criteria and their tests stay unchanged.
 *
 * Configurable per campaign via the discovery request `criteria` object and
 * via env overrides below.
 */
export function createInstagramAllInOneCriteria(
  overrides?: EnrichmentCriteria | null,
  env: NodeJS.ProcessEnv = process.env,
): EnrichmentCriteria {
  const readInt = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(env[name] ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };

  return {
    ...DEFAULT_ENRICHMENT_CRITERIA,
    minFollowers: readInt("IG_MIN_FOLLOWERS", 300),
    maxFollowers: readInt("IG_MAX_FOLLOWERS", 20_000),
    minPosts: readInt("IG_MIN_POSTS", 20),
    maxDaysSinceLastPost: getMaxDaysSinceLastPost(env),
    excludePrivate: true,
    requireContactSignal: true,
    ...overrides,
    ruleModes: {
      ...DEFAULT_ENRICHMENT_CRITERIA.ruleModes,
      minFollowers: "hard",
      maxFollowers: "hard",
      excludePrivate: "hard",
      minPosts: "hard",
      maxDaysSinceLastPost: "hard",
      requireContactSignal: "soft",
      ...overrides?.ruleModes,
    },
  };
}

/**
 * Last-post recency is evaluated by scoring/criteria; this constant documents
 * the local-business default and the env override used by the provider mode.
 */
export function getMaxDaysSinceLastPost(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.IG_MAX_DAYS_SINCE_LAST_POST ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

/**
 * Tier thresholds are intentionally configurable and NOT comparable with
 * Google-Maps-based leads: Maps-only business health inputs are unknown in this
 * mode, so the score re-normalizes around Instagram and contactability signals.
 */
export function getLeadTierThresholds(env: NodeJS.ProcessEnv = process.env): {
  tierA: number;
  tierB: number;
  tierC: number;
} {
  const read = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(env[name] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    tierA: read("LEAD_TIER_A_MIN", 75),
    tierB: read("LEAD_TIER_B_MIN", 55),
    tierC: read("LEAD_TIER_C_MIN", 35),
  };
}
