/**
 * Instagram all-in-one provider test suite (mocked actor; no network, no DB writes).
 *
 * Covers STEP 6 requirements:
 * - default env uses only apify/instagram-scraper (zero disabled-actor calls)
 * - old providers remain selectable
 * - tolerant mapper (full/partial/empty fixtures)
 * - search -> Gemini pre-gate -> details only for survivors
 * - budget ceiling, per-job result cap, dry-run makes no call
 * - location verification (same-name other city, unknown location, country-only block)
 * - query variant dedupe/caps
 * - scoring re-normalization with unknown Maps fields, tiers, NO_CONTACT_CHANNEL
 * - chain/group detection
 * - persist source resolves to instagram_scraper
 */

import "./preload_server_only.cjs";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import {
  setMockActorRunnerForTesting,
  isDryRunMode,
} from "../src/lib/services/scraper/apify-cost-guard";
import { setDiscoveryProviderForTesting, getActiveDiscoveryMode, getDiscoveryProvider } from "../src/lib/services/discovery/discovery-service";
import {
  getDiscoveryProviderName,
  getEnrichmentProviderName,
  getIgScraperCostPerResultUsd,
} from "../src/lib/env";
import {
  InstagramAllInOneDiscoveryProvider,
  runInstagramDetailsBatch,
} from "../src/lib/services/discovery/instagram-all-in-one-provider";
import {
  mapInstagramScraperItem,
  mapInstagramPlaceSignal,
} from "../src/lib/services/discovery/instagram-all-in-one-mapper";
import {
  planInstagramQueries,
  verifyCandidateLocation,
} from "../src/lib/services/discovery/instagram-all-in-one-query";
import { freeRulesStage } from "../src/lib/services/discovery/pipeline/stages/free-rules";
import { mapsGateStage } from "../src/lib/services/discovery/pipeline/stages/maps-gate";
import { computeLeadScore } from "../src/lib/services/discovery/lead-quality-score";
import { detectChains } from "../src/lib/services/discovery/chain-detector";
import { createInstagramAllInOneCriteria } from "../src/lib/services/discovery/local-business-criteria";
import { evaluateEnrichmentCriteria } from "../src/lib/services/discovery/enrichment-criteria";
import { resolveDiscoveryPersistSource } from "../src/lib/services/discovery/pipeline/stages/persist";
import { getIgEnrichmentActorMode, getActiveEnrichmentActorId } from "../src/lib/services/scraper/instagram-profile";
import type { DiscoveredCandidate } from "../src/lib/services/discovery/discovery-provider";

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

function readFixture<T>(name: string): T {
  const file = path.join(process.cwd(), "scripts", "fixtures", "instagram-all-in-one", name);
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

type ActorCall = { actorId: string; input: Record<string, unknown> };

function makeMockRunner(options: {
  calls: ActorCall[];
  searchItems: unknown[];
  detailsItems: unknown[];
  placeItems?: unknown[];
  usagePerRunUsd?: number;
}) {
  return async (actorId: string, input: Record<string, unknown>) => {
    options.calls.push({ actorId, input });
    const usage = options.usagePerRunUsd ?? 0;
    const items =
      input.resultsType === "details"
        ? options.detailsItems
        : input.searchType === "place"
          ? (options.placeItems ?? [])
          : options.searchItems;
    return {
      run: {
        id: `run_${options.calls.length}`,
        actId: actorId,
        defaultDatasetId: `dataset_${options.calls.length}`,
        status: "SUCCEEDED",
        stats: { computeUnits: 0 },
        usageTotalUsd: usage,
      },
      items,
      usageTotalUsd: usage,
      computeUnits: 0,
    } as never;
  };
}

const ENV_KEYS = [
  "DISCOVERY_PROVIDER",
  "ENRICHMENT_PROVIDER",
  "IG_ENRICHMENT_ACTOR",
  "APIFY_IG_SCRAPER_ACTOR_ID",
  "DISCOVERY_MAX_JOB_USD",
  "IG_SEARCH_LIMIT",
  "IG_MAX_QUERIES_PER_JOB",
  "IG_MAX_RESULTS_PER_JOB",
  "IG_SCRAPER_COST_PER_RESULT_USD",
  "IG_SEARCH_INCLUDE_PLACES",
  "APIFY_DRY_RUN",
  "APIFY_ALLOWED_ACTORS",
  "IG_NEIGHBOURHOODS",
];

async function main(): Promise<void> {
  console.log("================================================================");
  console.log("  INSTAGRAM ALL-IN-ONE PROVIDER TEST SUITE (MOCKED)");
  console.log("================================================================\n");

  const savedEnv = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

  const restoreEnv = (): void => {
    for (const [key, value] of savedEnv.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    // ---------------------------------------------------------------------
    console.log("[1. Defaults and disabled actors]");
    delete process.env.DISCOVERY_PROVIDER;
    delete process.env.ENRICHMENT_PROVIDER;
    delete process.env.IG_ENRICHMENT_ACTOR;
    delete process.env.APIFY_IG_SCRAPER_ACTOR_ID;
    setDiscoveryProviderForTesting(null);

    check(getDiscoveryProviderName() === "instagram_all_in_one", "default DISCOVERY_PROVIDER is instagram_all_in_one");
    check(getEnrichmentProviderName() === "instagram_scraper", "default ENRICHMENT_PROVIDER is instagram_scraper");
    check(getActiveDiscoveryMode() === "instagram_all_in_one", "active discovery mode is instagram_all_in_one");
    check(getDiscoveryProvider().name === "instagram_all_in_one", "provider factory returns the all-in-one provider");
    check(getIgEnrichmentActorMode() === "instagram_scraper_details", "enrichment mode defaults to instagram_scraper details");
    check(getActiveEnrichmentActorId() === "apify/instagram-scraper", "enrichment actor is apify/instagram-scraper");

    const calls: ActorCall[] = [];
    const searchItems = readFixture<unknown[]>("search-user.json");
    const detailsItems = readFixture<unknown[]>("details-profile.json");
    setMockActorRunnerForTesting(
      makeMockRunner({ calls, searchItems, detailsItems, usagePerRunUsd: 0.01 }),
    );

    process.env.IG_SEARCH_LIMIT = "5";
    process.env.IG_MAX_QUERIES_PER_JOB = "2";
    process.env.IG_MAX_RESULTS_PER_JOB = "20";
    process.env.DISCOVERY_MAX_JOB_USD = "5";

    const provider = new InstagramAllInOneDiscoveryProvider();
    const searchResult = await provider.discover({
      query: "dental clinic",
      category: "Dentist",
      location: "Toronto",
      limit: 5,
    });
    check(searchResult.candidates.length > 0, "search mode returns candidates", searchResult.candidates.length);
    check(
      calls.every((call) => call.actorId === "apify/instagram-scraper"),
      "search mode calls only apify/instagram-scraper",
      calls.map((c) => c.actorId).join(","),
    );
    check(
      calls.every((call) => !call.actorId.includes("crawler-google-places")),
      "zero Google Maps actor calls",
    );
    check(
      calls.every((call) => !call.actorId.includes("instagram-profile-scraper")),
      "zero legacy profile actor calls in search mode",
    );

    const details = await runInstagramDetailsBatch(["toronto_dental_studio"], {
      maxResults: 5,
      maxJobUsd: 5,
    });
    check(details.profiles.length === 1, "details mode maps one profile");
    check(
      calls[calls.length - 1]?.actorId === "apify/instagram-scraper",
      "details mode calls only apify/instagram-scraper",
    );
    check(
      calls[calls.length - 1]?.input.resultsType === "details",
      "details input uses resultsType=details (never mixed with search)",
    );

    // ---------------------------------------------------------------------
    console.log("\n[2. Old providers still selectable]");
    process.env.DISCOVERY_PROVIDER = "google_maps";
    setDiscoveryProviderForTesting(null);
    check(getActiveDiscoveryMode() === "google_maps", "DISCOVERY_PROVIDER=google_maps restores Maps mode");
    check(getDiscoveryProvider().name === "google_maps", "factory returns Google Maps provider");

    process.env.ENRICHMENT_PROVIDER = "instagram_profile_scraper";
    check(getIgEnrichmentActorMode() === "profile_scraper", "ENRICHMENT_PROVIDER restores profile scraper mode");
    check(getActiveEnrichmentActorId() === "apify/instagram-profile-scraper", "legacy profile actor selectable");

    delete process.env.DISCOVERY_PROVIDER;
    delete process.env.ENRICHMENT_PROVIDER;
    setDiscoveryProviderForTesting(null);
    setMockActorRunnerForTesting(null);

    // ---------------------------------------------------------------------
    console.log("\n[3. Tolerant mapper (full/partial/empty)]");
    const full = mapInstagramScraperItem(readFixture<unknown[]>("details-profile.json")[0]);
    check(full?.username === "toronto_dental_studio", "full fixture username mapped");
    check(full?.followersCount === 4820, "full fixture follower count mapped");
    check(full?.postsCount === 186, "full fixture posts count mapped");
    check(full?.email === "hello@torontodentalstudio.example.com", "public email mapped");
    check(full?.phone === "+1 416 555 0123", "public phone mapped");
    check(full?.businessAddress?.city_name === "Toronto", "business address city mapped");
    check(full?.latestPosts?.length === 2, "latest posts mapped");
    check(typeof full?.recentLikesAvg === "number", "recent likes average computed");
    check(typeof full?.engagementRate === "number", "engagement rate recorded");

    const partial = mapInstagramScraperItem(readFixture<unknown[]>("partial-profile.json")[0]);
    check(partial?.username === "partial_account", "partial fixture maps username");
    check(partial?.followersCount === null, "missing followers stay null (unknown, not zero)");
    check(partial?.postsCount === null, "missing posts stay null (unknown, not zero)");
    check(partial?.biography === null, "missing bio stays null");
    check((partial?.missingFields?.length ?? 0) > 0, "missing fields are reported for diagnostics");

    const empty = mapInstagramScraperItem(readFixture<unknown[]>("empty-profile.json")[0]);
    check(empty === null, "actor error item is not treated as a profile");

    const place = mapInstagramPlaceSignal(readFixture<unknown[]>("search-place.json")[0]);
    check(place?.city === "Toronto", "place result city used as location signal");
    check(!("rating" in (place as object)), "place signal never carries Maps rating");
    check(!("phone" in (place as object)), "place signal never carries Maps phone");

    // ---------------------------------------------------------------------
    console.log("\n[4. Query planner and location verification]");
    const plan = planInstagramQueries({
      query: "dental clinic, cosmetic dentist",
      category: "Dentist",
      location: "Toronto",
      maxQueries: 6,
      searchLimit: 10,
    });
    check(!plan.blocked, "city query plan is not blocked");
    check(plan.queries.every((q) => q.toLowerCase().includes("toronto")), "every query includes the city");
    check(new Set(plan.queries.map((q) => q.toLowerCase())).size === plan.queries.length, "query variants deduped");
    check(plan.queries.length <= 6, "query count capped by IG_MAX_QUERIES_PER_JOB");

    const countryPlan = planInstagramQueries({ query: "dentist", location: "Canada" });
    check(countryPlan.blocked, "country-only location is blocked");
    check(countryPlan.recommendedCities.length > 0, "country-only plan recommends major cities");

    const sameNameOtherCity = mapInstagramScraperItem(readFixture<unknown[]>("partial-profile.json")[1])!;
    const wrong = verifyCandidateLocation(sameNameOtherCity, "Toronto", "ca");
    check(wrong.status === "wrong_location", "same-name account explicitly in Montreal is rejected for Toronto", wrong.status);

    const noCityBio = mapInstagramScraperItem({
      username: "no_city_dentist",
      biography: "Family dentistry. Book an appointment today.",
      businessCategoryName: "Dentist",
    })!;
    const unverified = verifyCandidateLocation(noCityBio, "Toronto", "ca");
    check(unverified.status === "unverified", "no-city bio is location_unverified", unverified.status);

    const torontoBio = mapInstagramScraperItem({
      username: "toronto_smile",
      biography: "Dentist serving Toronto and the GTA",
    })!;
    check(verifyCandidateLocation(torontoBio, "Toronto", "ca").status === "verified", "city token in bio verifies location");

    // ---------------------------------------------------------------------
    console.log("\n[5. Search -> Gemini pre-gate -> Details only for survivors]");
    const gateCalls: ActorCall[] = [];
    setMockActorRunnerForTesting(
      makeMockRunner({
        calls: gateCalls,
        searchItems,
        detailsItems,
        usagePerRunUsd: 0.001,
      }),
    );
    process.env.IG_SEARCH_LIMIT = "5";
    process.env.IG_MAX_QUERIES_PER_JOB = "1";
    process.env.IG_MAX_RESULTS_PER_JOB = "20";
    process.env.DISCOVERY_MAX_JOB_USD = "5";

    const stageProvider = new InstagramAllInOneDiscoveryProvider();
    const discovered = await stageProvider.discover({
      query: "dental clinic",
      category: "Dentist",
      location: "Toronto",
      limit: 5,
    });
    const searchCalls = gateCalls.length;

    const context = {
      campaign: {
        id: "campaign_test",
        userId: "user_test",
        intent: "dental clinic",
        location: "Toronto",
        category: "Dentist",
        minRating: null,
        minReviews: null,
        excludeChains: true,
        companyProfile: null,
      },
      jobId: "job_test",
      userId: "user_test",
      requestedLimit: 10,
      existingLeadCount: 0,
      remainingCapacity: 10,
      criteria: createInstagramAllInOneCriteria(),
      caches: {
        seenCandidates: new Set<string>(),
        existingUsernames: new Set<string>(),
        existingPlaceIds: new Set<string>(),
        existingDomains: new Set<string>(),
        existingPhones: new Set<string>(),
      },
    };

    const free = await freeRulesStage({ candidates: discovered.candidates as DiscoveredCandidate[] }, context);
    let gateEvaluated = 0;
    const gate = await mapsGateStage({ candidates: free.survivors, useAiRelevanceCheck: true }, context, {
      evalMapsGemini: async (candidate) => {
        gateEvaluated++;
        return {
          relevant: !candidate.biography?.toLowerCase().includes("vancouver"),
          reason: "mock gate",
        };
      },
    });
    check(searchCalls >= 1, "search stage called the actor");
    check(gateEvaluated === free.survivors.length, "Gemini pre-gate evaluated every search-stage survivor");
    check(gate.survivors.every((c) => !c.biography?.toLowerCase().includes("vancouver")), "pre-gate rejects wrong-city result");

    const survivorUsernames = gate.survivors.map((c) => c.username!).filter(Boolean);
    await runInstagramDetailsBatch(survivorUsernames, { maxResults: 10, maxJobUsd: 5 });
    const detailsCalls = gateCalls.slice(searchCalls).filter((c) => c.input.resultsType === "details");
    check(detailsCalls.length === (survivorUsernames.length > 0 ? 1 : 0), "details runs only for gate survivors (batched)", `${detailsCalls.length} calls for ${survivorUsernames.length} survivors`);

    // ---------------------------------------------------------------------
    console.log("\n[6. Budget ceiling, result cap, dry run]");
    setMockActorRunnerForTesting(null);
    const budgetCalls: ActorCall[] = [];
    setMockActorRunnerForTesting(
      makeMockRunner({ calls: budgetCalls, searchItems, detailsItems, usagePerRunUsd: 0 }),
    );
    process.env.DISCOVERY_MAX_JOB_USD = "0.00001";
    process.env.IG_SEARCH_LIMIT = "10";
    process.env.IG_SCRAPER_COST_PER_RESULT_USD = getIgScraperCostPerResultUsd().toString();
    const budgetProvider = new InstagramAllInOneDiscoveryProvider();
    const budgetResult = await budgetProvider.discover({
      query: "dentist",
      location: "Toronto",
      limit: 10,
    });
    check(budgetResult.stopReason === "budget_exhausted", "budget ceiling stops the run", budgetResult.stopReason);
    check(budgetCalls.length === 0, "budget ceiling makes zero actor calls");

    process.env.DISCOVERY_MAX_JOB_USD = "5";
    process.env.IG_SEARCH_LIMIT = "2";
    process.env.IG_MAX_RESULTS_PER_JOB = "2";
    process.env.IG_MAX_QUERIES_PER_JOB = "4";
    const capCalls: ActorCall[] = [];
    setMockActorRunnerForTesting(
      makeMockRunner({ calls: capCalls, searchItems, detailsItems, usagePerRunUsd: 0 }),
    );
    const capProvider = new InstagramAllInOneDiscoveryProvider();
    const capResult = await capProvider.discover({
      query: "dentist, orthodontist",
      location: "Toronto",
      limit: 2,
    });
    check(capResult.stopReason === "budget_exhausted", "per-job results cap stops the run", capResult.stopReason);
    check(capCalls.length === 1, "per-job results cap stops after the first search run", capCalls.length);

    // Dry run: no mock runner, no client call.
    setMockActorRunnerForTesting(null);
    process.env.APIFY_DRY_RUN = "true";
    process.env.DISCOVERY_MAX_JOB_USD = "5";
    process.env.IG_MAX_RESULTS_PER_JOB = "20";
    process.env.IG_MAX_QUERIES_PER_JOB = "1";
    const dryProvider = new InstagramAllInOneDiscoveryProvider();
    const dryResult = await dryProvider.discover({
      query: "dentist",
      location: "Toronto",
      limit: 5,
    });
    check(isDryRunMode() === true, "dry-run mode active");
    check(dryResult.usageTotalUsd === 0, "dry run reports zero spend");
    delete process.env.APIFY_DRY_RUN;

    // ---------------------------------------------------------------------
    console.log("\n[7. Scoring, criteria, chain detection, persist source]");
    const scoreNoMaps = computeLeadScore({
      website: "https://torontodentalstudio.example.com",
      phone: null,
      rating: null,
      reviewCount: null,
      isClaimed: null,
      hasInstagram: true,
      lastPostAt: new Date().toISOString(),
      postsCount: 80,
      followers: 4200,
      isBusinessAccount: true,
      isPrivate: false,
      email: "hello@torontodentalstudio.example.com",
      availableChannels: ["INSTAGRAM", "EMAIL"],
    });
    check(scoreNoMaps.flags.includes("UNKNOWN_MAPS_DATA"), "unknown Maps data flag emitted");
    check(["A", "B", "C", "D"].includes(scoreNoMaps.tier), "tier produced with re-normalized weights");
    check(scoreNoMaps.breakdown.some((b) => b.category === "businessHealth" && !b.skipped), "business health re-normalized, not skipped");

    const noContact = computeLeadScore({
      hasInstagram: true,
      followers: 1000,
      postsCount: 50,
      lastPostAt: new Date().toISOString(),
      availableChannels: ["INSTAGRAM"],
      isBusinessAccount: true,
      isPrivate: false,
      rating: null,
      reviewCount: null,
      isClaimed: null,
    });
    check(noContact.flags.includes("NO_CONTACT_CHANNEL"), "NO_CONTACT_CHANNEL flag emitted");
    check(noContact.tier === "C" || noContact.tier === "D", "tier capped at C when no off-Instagram contact channel", noContact.tier);

    const criteriaDefaults = createInstagramAllInOneCriteria();
    check(criteriaDefaults.minFollowers === 300, "default minFollowers=300");
    check(criteriaDefaults.maxFollowers === 20000, "default maxFollowers=20000");
    check(criteriaDefaults.minPosts === 20, "default minPosts=20");
    check(criteriaDefaults.requireContactSignal === true, "default requires contact signal (soft flag)");
    check(criteriaDefaults.maxDaysSinceLastPost === 60, "default last-post recency is 60 days");
    const staleEval = evaluateEnrichmentCriteria(
      ({
        username: "stale_clinic",
        profileUrl: "https://www.instagram.com/stale_clinic",
        fullName: "Stale Clinic",
        followers: 1000,
        followersCount: 1000,
        postsCount: 50,
        latestPosts: null,
        isPrivate: false,
        externalUrl: "https://stale.example.com",
        location: "Toronto",
        email: null,
        phone: null,
        lastPostAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
        source: "instagram_scraper",
        scrapedAt: new Date().toISOString(),
      } as unknown) as Parameters<typeof evaluateEnrichmentCriteria>[0],
      criteriaDefaults,
      { intent: "dental clinic", location: "Toronto", category: "Dentist" },
    );
    check(
      !staleEval.passed && staleEval.reasons.some((r) => r.rule === "maxDaysSinceLastPost"),
      "last post older than 60 days is rejected",
    );

    const chainCandidates = [
      { fullName: "Bright Smile Dental", website: "https://brightsmile.example.com", biography: "Book today" },
      { fullName: "Bright Smile Dental", website: "https://brightsmile.example.com/contact", biography: "Our branches" },
      { fullName: "Bright Smile Dental", website: "https://brightsmile.example.com/locations", biography: "Locations" },
    ];
    const chains = detectChains(chainCandidates, { minOccurrencesForChain: 2 });
    check(Array.from(chains.values()).every((r) => r.isChain), "same domain/name across handles is detected as a chain/group");
    const bioChain = detectChains([
      { fullName: "Unique Clinic", biography: "Now serving patients at our branches across Ontario" },
      { fullName: "Another Clinic", biography: "Independent practice" },
    ], { minOccurrencesForChain: 2 });
    check(Array.from(bioChain.values())[0].isChain, "bio phrase 'branches' triggers group detection");

    check(
      resolveDiscoveryPersistSource([{ source: "instagram_scraper", sourceProvider: "instagram_scraper" }]) === "instagram_scraper",
      "persist source resolves to instagram_scraper",
    );
    check(
      resolveDiscoveryPersistSource([{ source: "apify", sourceProvider: "google_maps" }]) === "discovery",
      "Google Maps providers keep the legacy discovery source",
    );
  } finally {
    setMockActorRunnerForTesting(null);
    setDiscoveryProviderForTesting(null);
    restoreEnv();
  }

  console.log(`\nPASSED: ${passed} | FAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
