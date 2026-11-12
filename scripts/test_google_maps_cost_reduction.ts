/**
 * Google Maps discovery cost-reduction tests (mocked actor; no real calls).
 */

import "./preload_server_only.cjs";
import "dotenv/config";

import {
  getMaxChargePerJobUsd,
  getMaxChargePerRunUsd,
  getMonthlyBudgetUsd,
  setMockActorRunnerForTesting,
} from "../src/lib/services/scraper/apify-cost-guard";
import { areApifyCostLimitsEnabled } from "../src/lib/env";
import { GoogleMapsDiscoveryProvider } from "../src/lib/services/discovery/google-maps-discovery-provider";
import {
  CITY_AREAS,
  buildYieldStats,
  getAreasForCity,
  isAreaCoolingDown,
  isFirstBatchMostlySeen,
  parseChargedBreakdown,
  pickNextArea,
  placeOverlapRatio,
  rankKeywordSuggestions,
  shouldDropKeyword,
  shouldStopForLowYield,
} from "../src/lib/services/discovery/google-maps-cost-optimizer";
import {
  getCoverageRows,
  getRollingMapsCostPerPlace,
  getKeywordYieldSuggestions,
  recordCoverage,
} from "../src/lib/services/discovery/discovery-coverage-service";
import { getPrismaClient } from "../src/lib/db/prisma";

let passed = 0;
let failed = 0;
function check(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail === undefined ? "" : ` -> ${String(detail)}`}`);
    failed++;
  }
}

type ActorCall = {
  actorId: string;
  input: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
};

function mockRun(usageTotalUsd: number, items: unknown[], usage?: Record<string, unknown>) {
  return {
    run: {
      id: `run_${Math.random().toString(36).slice(2)}`,
      actId: "compass/crawler-google-places",
      defaultDatasetId: "dataset_mock",
      status: "SUCCEEDED",
      usageTotalUsd,
      ...(usage ? { usage } : {}),
    },
    items,
    usageTotalUsd,
    computeUnits: 0,
  } as never;
}

async function main(): Promise<void> {
  console.log("=================================================");
  console.log("  GMAPS COST REDUCTION TESTS (MOCKED ACTOR)");
  console.log("=================================================\n");

  const calls: ActorCall[] = [];
  const prevEnv = {
    DISCOVERY_MAX_JOB_USD: process.env.DISCOVERY_MAX_JOB_USD,
    GMAPS_MAX_SEARCHES_PER_JOB: process.env.GMAPS_MAX_SEARCHES_PER_JOB,
    GMAPS_MIN_IG_YIELD_PERCENT: process.env.GMAPS_MIN_IG_YIELD_PERCENT,
    GMAPS_MERGE_KEYWORDS: process.env.GMAPS_MERGE_KEYWORDS,
    GMAPS_SCRAPE_CONTACTS: process.env.GMAPS_SCRAPE_CONTACTS,
    DISCOVERY_PROVIDER: process.env.DISCOVERY_PROVIDER,
  };

  try {
    delete process.env.GMAPS_SCRAPE_CONTACTS;
    delete process.env.GMAPS_MERGE_KEYWORDS;
    process.env.DISCOVERY_PROVIDER = "google_maps";
    process.env.DISCOVERY_MAX_JOB_USD = "0.30";
    process.env.GMAPS_MAX_SEARCHES_PER_JOB = "1";
    process.env.GMAPS_MIN_IG_YIELD_PERCENT = "10";

    // ---------------------------------------------------------------------
    console.log("[1. Minimal actor input, spend cap, closed places, actual cost]");
    setMockActorRunnerForTesting(async (actorId, input, options) => {
      calls.push({
        actorId,
        input,
        options: options as Record<string, unknown> | undefined,
      });
      return mockRun(
        0.06,
        [
          {
            title: "Open Clinic",
            placeId: "place_open",
            city: "Toronto",
            address: "1 King St, Toronto",
            phone: "+1 416 555 0100",
            permanentlyClosed: false,
          },
          {
            title: "Closed Clinic",
            placeId: "place_closed",
            city: "Toronto",
            address: "2 King St, Toronto",
            permanentlyClosed: true,
          },
        ],
        { PLACE_SEARCH: 2, ACTOR_START: 1 },
      );
    });

    const provider = new GoogleMapsDiscoveryProvider();
    const result = await provider.discover({
      query: "dentist",
      location: "Toronto",
      limit: 15,
    });

    const call = calls[0];
    check(Boolean(call), "actor was called", calls.length);
    check(call?.actorId === "compass/crawler-google-places", "correct Maps actor", call?.actorId);
    check(call?.input.skipClosedPlaces === true, "skipClosedPlaces=true");
    check(
      typeof call?.input.maxCrawledPlacesPerSearch === "number",
      "maxCrawledPlacesPerSearch always passed",
    );
    check(
      typeof call?.input.maxTotalChargeUsd === "number" &&
        (call!.input.maxTotalChargeUsd as number) > 0,
      "run-level maxTotalChargeUsd passed",
      call?.input.maxTotalChargeUsd,
    );
    check(
      (call?.options as { maxTotalChargeUsd?: number } | undefined)?.maxTotalChargeUsd !== undefined,
      "cost guard receives the same spend cap",
    );
    check(!("scrapeContacts" in (call?.input ?? {})), "no contacts add-on by default");
    check(!("scrapeSocialMediaProfiles" in (call?.input ?? {})), "no social add-on by default");
    check(!("maxReviews" in (call?.input ?? {})), "no reviews field sent");
    check(!("maxImages" in (call?.input ?? {})), "no images field sent");
    check(!("scrapePlaceDetailPage" in (call?.input ?? {})), "no detail-page field sent");
    check(!("categoryFilter" in (call?.input ?? {})), "no category filter by default");
    check(call?.input.searchStringsArray instanceof Array && (call!.input.searchStringsArray as string[]).length === 1, "default is one keyword per run");

    check(result.actualCostUsd === 0.06, "actual charged cost recorded", result.actualCostUsd);
    check(
      Array.isArray(result.chargedEvents) && result.chargedEvents.length === 1,
      "charged-event breakdown recorded",
    );
    check(
      !result.candidates.some((c) => c.gmapsPlaceId === "place_closed"),
      "closed place skipped",
    );

    // ---------------------------------------------------------------------
    console.log("\n[2. Area rotation, cooldown, keyword overlap, auto-stop]");
    const prevLimitsEnabled = process.env.APIFY_COST_LIMITS_ENABLED;
    const prevMonthlyBudget = process.env.APIFY_MONTHLY_BUDGET_USD;
    process.env.APIFY_COST_LIMITS_ENABLED = "false";
    process.env.APIFY_MONTHLY_BUDGET_USD = "10";
    check(!areApifyCostLimitsEnabled(), "cost limits can be disabled completely");
    check(getMaxChargePerRunUsd() === Number.POSITIVE_INFINITY, "per-run cap unlimited when disabled");
    check(getMaxChargePerJobUsd() === Number.POSITIVE_INFINITY, "per-job cap unlimited when disabled");
    check(getMonthlyBudgetUsd() === null, "monthly budget unlimited when disabled");
    if (prevLimitsEnabled === undefined) delete process.env.APIFY_COST_LIMITS_ENABLED;
    else process.env.APIFY_COST_LIMITS_ENABLED = prevLimitsEnabled;
    if (prevMonthlyBudget === undefined) delete process.env.APIFY_MONTHLY_BUDGET_USD;
    else process.env.APIFY_MONTHLY_BUDGET_USD = prevMonthlyBudget;
    check(getMaxChargePerRunUsd() > 0, "per-run cap restored after re-enabling limits");
    check(getAreasForCity("Toronto").length > 1, "Toronto has sub-areas");
    check(getAreasForCity("New York").length > 1, "US city has sub-areas");
    check(Boolean(CITY_AREAS.toronto), "built-in area list exists");

    const now = new Date();
    const recentRow = {
      keyword: "dentist",
      area: "Toronto",
      runDate: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      placeIds: ["a", "b"],
      newPlaces: 1,
      acceptedLeads: 1,
    };
    check(isAreaCoolingDown([recentRow], "dentist", "Toronto", 30, now), "recent area is in cooldown");
    check(!isAreaCoolingDown([recentRow], "dentist", "Toronto", 30, new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000)), "cooldown expires");
    const nextArea = pickNextArea("Toronto", "dentist", [recentRow], 30, now);
    check(nextArea !== null && nextArea !== "Toronto", "rotation picks the next least-covered area", nextArea);

    const overlap = placeOverlapRatio(["a", "b", "c", "d"], ["a", "b", "c", "x"]);
    check(overlap === 0.75, "overlap ratio computed", overlap);
    check(shouldDropKeyword(overlap), "keyword dropped above 70% overlap");
    check(isFirstBatchMostlySeen(3, 15), "first batch >60% seen detected");
    check(!isFirstBatchMostlySeen(6, 15), "new batch below 60% seen continues");

    check(
      shouldStopForLowYield(15, 1, 10),
      "auto-stop when IG yield <10%",
    );
    check(!shouldStopForLowYield(15, 2, 10), "does not stop at 13% IG yield");

    const charged = parseChargedBreakdown({
      usageTotalUsd: 0.06,
      usage: { PLACE_SEARCH: 15, ACTOR_START: 1 },
    });
    check(charged.chargedUsd === 0.06, "charged amount parsed");
    check(charged.events.length === 2, "charged events parsed", charged.events);

    const stats = buildYieldStats({
      placesReturned: 15,
      costUsd: 0.06,
      leadsWithIg: 1,
      contactableLeads: 4,
      wastedByReason: { duplicates: 0.02, no_contact: 0.01 },
      handleYieldByArea: { Toronto: 1 },
      handleYieldByKeyword: { dentist: 1 },
    });
    check(stats.costPerPlaceUsd === 0.004, "cost per place", stats.costPerPlaceUsd);
    check(stats.costPerIgReadyLeadUsd === 0.06, "cost per IG-ready lead", stats.costPerIgReadyLeadUsd);
    check(stats.costPerContactableLeadUsd === 0.015, "cost per contactable lead", stats.costPerContactableLeadUsd);
    check(stats.wastedSpendUsd === 0.03, "wasted spend summed", stats.wastedSpendUsd);

    const ranked = rankKeywordSuggestions(
      [
        { keyword: "dentist", places: 15, igReady: 1 },
        { keyword: "cosmetic dentist", places: 10, igReady: 4 },
        { keyword: "orthodontist", places: 8, igReady: 2 },
      ],
      2,
    );
    check(ranked.length === 2 && ranked[0].keyword === "cosmetic dentist", "keyword suggestions ranked by IG yield", ranked);

    // ---------------------------------------------------------------------
    console.log("\n[3. Low-yield auto-stop and keyword overlap in a real provider call]");
    calls.length = 0;
    setMockActorRunnerForTesting(async (actorId, input, options) => {
      calls.push({ actorId, input, options: options as Record<string, unknown> | undefined });
      return mockRun(
        0.04,
        Array.from({ length: 10 }).map((_, i) => ({
          title: `No IG Place ${i}`,
          placeId: `noig_${i}`,
          city: "Toronto",
          address: `${i} Queen St, Toronto`,
          phone: "+1 416 555 0100",
        })),
      );
    });
    const lowYield = await new GoogleMapsDiscoveryProvider().discover({
      query: "dentist",
      location: "Toronto",
      limit: 15,
    });
    check(lowYield.stopReason === "low_ig_yield", "provider stops on low IG yield", lowYield.stopReason);
    check(calls.length === 1, "stops after the first paid batch", calls.length);

    // ---------------------------------------------------------------------
    console.log("\n[4. Coverage ledger + rolling actual cost (test DB)]");
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        email: `gmaps-cost-${Date.now()}@example.test`,
        passwordHash: "test-hash",
        name: "GMaps Cost Test",
      },
    });
    const companyProfile = await prisma.companyProfile.create({
      data: { userId: user.id, name: "GMaps Cost Co" },
    });
    const campaign = await prisma.campaign.create({
      data: { userId: user.id, name: "GMaps Cost Campaign", companyProfileId: companyProfile.id },
    });
    try {
      await recordCoverage({
        userId: user.id,
        campaignId: campaign.id,
        keyword: "dentist",
        area: "Toronto",
        placeIds: ["p1", "p2", "p3"],
        newPlaces: 1,
        acceptedLeads: 1,
      });
      const rows = await getCoverageRows(user.id);
      check(rows.length === 1, "coverage row persisted", rows.length);
      check(rows[0].placeIds?.length === 3, "placeIds stored");
      check(
        pickNextArea("Toronto", "dentist", rows, 30) !== "Toronto",
        "repeat run of same area is skipped by the ledger",
      );

      await prisma.scrapeJob.create({
        data: {
          campaignId: campaign.id,
          provider: "apify",
          discoveryActor: "compass/crawler-google-places",
          candidatesDiscovered: 15,
          costUsd: 0.06,
          status: "COMPLETED",
        },
      });
      await prisma.scrapeJob.create({
        data: {
          campaignId: campaign.id,
          provider: "apify",
          discoveryActor: "compass/crawler-google-places",
          candidatesDiscovered: 10,
          costUsd: 0.03,
          status: "COMPLETED",
        },
      });
      const rolling = await getRollingMapsCostPerPlace(user.id, 5);
      check(rolling.samples === 2, "rolling cost samples last runs", rolling.samples);
      check(rolling.costPerPlaceUsd === 0.0035, "rolling cost per place used for next estimate", rolling.costPerPlaceUsd);

      const suggestions = await getKeywordYieldSuggestions(user.id, 3);
      check(suggestions.length === 1 && suggestions[0].keyword === "dentist", "keyword suggestions from ledger", suggestions);
    } finally {
      await prisma.discoveryPlaceOutcome.deleteMany({ where: { userId: user.id } });
      await prisma.discoveryCoverage.deleteMany({ where: { userId: user.id } });
      await prisma.scrapeJob.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.campaign.delete({ where: { id: campaign.id } });
      await prisma.companyProfile.delete({ where: { id: companyProfile.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  } finally {
    setMockActorRunnerForTesting(null);
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log(`\nPASSED: ${passed} | FAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
