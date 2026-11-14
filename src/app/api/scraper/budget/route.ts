import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import {
  getMonthlyBudgetUsd,
  getMonthlyApifySpend,
  getMonthlyApifyBudgetRemaining,
  getMaxChargePerRunUsd,
  getMaxChargePerJobUsd,
  isDryRunMode,
  isApifyEnabled,
} from "@/lib/services/scraper/apify-cost-guard";
import { getActiveDiscoveryMode } from "@/lib/services/discovery/discovery-service";
import {
  getRollingMapsCostPerPlace,
  getKeywordYieldSuggestions,
} from "@/lib/services/discovery/discovery-coverage-service";
import {
  getAreaCooldownDays,
  getMinIgYieldPercent,
} from "@/lib/services/discovery/google-maps-cost-optimizer";
import { getMaxLeadLimit } from "@/lib/services/scraper/instagram-profile";
import { getActiveProviderSummary } from "@/lib/services/scraper/provider-switch";
import {
  getIgSearchLimit,
  getIgMaxQueriesPerJob,
  getIgMaxResultsPerJob,
  getIgScraperCostPerResultUsd,
  areApifyCostLimitsEnabled,
} from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);

    const [monthlySpendUsd, remainingBudgetUsd, rollingMapsCost, keywordSuggestions] =
      await Promise.all([
        getMonthlyApifySpend(),
        getMonthlyApifyBudgetRemaining(),
        getRollingMapsCostPerPlace(user.id, 5).catch(() => ({
          costPerPlaceUsd: null,
          samples: 0,
        })),
        getKeywordYieldSuggestions(user.id, 3).catch(() => []),
      ]);

    const costLimitsEnabled = areApifyCostLimitsEnabled();

    return Response.json({
      costLimitsEnabled,
      monthlyBudgetUsd: getMonthlyBudgetUsd(),
      monthlySpendUsd,
      remainingBudgetUsd,
      perRunCapUsd: getMaxChargePerRunUsd(),
      perJobCapUsd: getMaxChargePerJobUsd(),
      isDryRun: isDryRunMode(),
      isEnabled: isApifyEnabled(),
      discoveryProvider: getActiveDiscoveryMode(),
      activeProviders: getActiveProviderSummary(),
      igSearchLimit: getIgSearchLimit(),
      igMaxQueriesPerJob: getIgMaxQueriesPerJob(),
      igMaxResultsPerJob: getIgMaxResultsPerJob(),
      igScraperCostPerResultUsd: getIgScraperCostPerResultUsd(),
      discoveryMaxJobUsd: costLimitsEnabled
        ? Number.parseFloat(process.env.DISCOVERY_MAX_JOB_USD || "0.60")
        : null,
      discoveryStage: process.env.DISCOVERY_STAGE || "default",
      maxLeadsCap: getMaxLeadLimit(),
      gmapsMaxTotalPlaces: Number.parseInt(process.env.GMAPS_MAX_TOTAL_PLACES || "15", 10),
      gmapsMaxCities: Math.max(1, Number.parseInt(process.env.GMAPS_MAX_CITIES || "20", 10)),
      contactsEnrichmentEnabled:
        process.env.GMAPS_SOCIAL_ENRICHMENT === "true" ||
        process.env.GMAPS_SCRAPE_CONTACTS === "true",
      contactsEnrichmentCostPerPlaceUsd: 0.002,
      placesScrapedCostPerPlaceUsd: 0.003,
      mapsRollingCostPerPlaceUsd: rollingMapsCost.costPerPlaceUsd,
      mapsRollingCostSamples: rollingMapsCost.samples,
      mapsAreaCooldownDays: getAreaCooldownDays(),
      mapsMinIgYieldPercent: getMinIgYieldPercent(),
      keywordSuggestions,
      mapsStartFeeUsd: 0.007,
      profileEnrichmentCostPerItemUsd: 0.0023,
      geminiCostPerItemUsd: 0.001,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
