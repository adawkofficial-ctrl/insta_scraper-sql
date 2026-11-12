import "server-only";

import {
  getDiscoveryProviderName,
  getEnrichmentProviderName,
  getServerEnv,
} from "@/lib/env";

export const GMAPS_DISABLED_ACTOR_ID = "compass/crawler-google-places";
export const LEGACY_PROFILE_ACTOR_ID = "apify/instagram-profile-scraper";

function actorIncludes(actorId: string, fragment: string): boolean {
  return actorId.trim().toLowerCase().includes(fragment.toLowerCase());
}

/**
 * Throws loudly when the active all-in-one configuration would call an actor
 * that the operator disabled by switching providers. Old providers remain
 * selectable through DISCOVERY_PROVIDER / ENRICHMENT_PROVIDER.
 */
export function assertDiscoveryActorEnabled(actorId: string): void {
  if (getDiscoveryProviderName() !== "instagram_all_in_one") {
    return;
  }
  if (actorIncludes(actorId, "crawler-google-places")) {
    throw new Error(
      `DISCOVERY_PROVIDER=instagram_all_in_one forbids the disabled Google Maps actor "${actorId}". ` +
        `Set DISCOVERY_PROVIDER=google_maps to use it.`,
    );
  }
}

export function assertEnrichmentActorEnabled(actorId: string): void {
  if (getEnrichmentProviderName() !== "instagram_scraper") {
    return;
  }
  const explicitMode = getServerEnv("IG_ENRICHMENT_ACTOR")?.toLowerCase();
  if (explicitMode === "profile_scraper") {
    return;
  }
  if (actorIncludes(actorId, "instagram-profile-scraper")) {
    throw new Error(
      `ENRICHMENT_PROVIDER=instagram_scraper forbids the disabled profile actor "${actorId}". ` +
        `Set ENRICHMENT_PROVIDER=instagram_profile_scraper to use it.`,
    );
  }
}

/** Informational snapshot for health checks and the discovery UI (no secrets). */
export function getActiveProviderSummary(): {
  discoveryProvider: string;
  enrichmentProvider: string;
  discoveryActor: string;
  enrichmentActor: string;
  mapsActorDisabled: boolean;
  profileActorDisabled: boolean;
} {
  const discoveryProvider = getDiscoveryProviderName();
  const enrichmentProvider = getEnrichmentProviderName();
  const igActor =
    getServerEnv("APIFY_IG_SCRAPER_ACTOR_ID") ?? "apify/instagram-scraper";
  return {
    discoveryProvider,
    enrichmentProvider,
    discoveryActor:
      discoveryProvider === "instagram_all_in_one"
        ? igActor
        : discoveryProvider === "google_maps"
          ? GMAPS_DISABLED_ACTOR_ID
          : discoveryProvider,
    enrichmentActor:
      enrichmentProvider === "instagram_scraper"
        ? igActor
        : LEGACY_PROFILE_ACTOR_ID,
    mapsActorDisabled: discoveryProvider === "instagram_all_in_one",
    profileActorDisabled: enrichmentProvider === "instagram_scraper",
  };
}
