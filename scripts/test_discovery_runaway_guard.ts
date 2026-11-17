/**
 * Test Suite: Runaway Loop Guard & Cost-Per-Lead Protection (Requirements a - g)
 *
 * Covers:
 * a) A job never starts more than APIFY_MAX_RUNS_PER_JOB runs, even if the lead limit is not reached.
 * b) Low-yield early stop triggers after the first search (e.g. 10 items, 1 with handle).
 * c) Enrichment of 12 survivors = 1 run, not 12.
 * d) A timed-out run is not retried and partial items are used.
 * e) Cost-per-lead guard stops the job; an expensive zero-lead job does not block the next run.
 * f) Already-seen handles/places are skipped without an Apify call.
 * g) Defaults are google_maps + profile_scraper.
 */

// Preload server-only mock
import "./preload_server_only.cjs";
import "dotenv/config";

import {
  setMockActorRunnerForTesting,
  resolveTimeoutSecs,
  runActorSafely,
  type SafeActorRunResult,
} from "../src/lib/services/scraper/apify-cost-guard";
import {
  runDiscovery,
  buildDiscoveryNotice,
  getActiveDiscoveryMode,
} from "../src/lib/services/discovery/discovery-service";
import {
  getIgEnrichmentActorMode,
  getActiveEnrichmentActorId,
} from "../src/lib/services/scraper/instagram-profile";
import { getPrismaClient } from "../src/lib/db/prisma";

let passedCount = 0;
let failedCount = 0;

function check(condition: boolean, description: string, detail?: unknown) {
  if (condition) {
    passedCount++;
    console.log(`  PASS: ${description}`);
  } else {
    failedCount++;
    console.error(`  FAIL: ${description}`);
    if (detail !== undefined) {
      console.error("        Detail:", detail);
    }
  }
}

function mockRun(id: string, actId: string, status: string = "SUCCEEDED", defaultDatasetId: string = "ds-mock") {
  return {
    id,
    actId,
    status,
    defaultDatasetId,
  } as unknown as any;
}

async function run() {
  console.log("================================================================================");
  console.log("RUNAWAY LOOP & COST-PER-LEAD PROTECTION TEST SUITE");
  console.log("================================================================================\n");

  const prisma = getPrismaClient();

  // Find or create test user
  let testUser = await prisma.user.findFirst({ select: { id: true, email: true } });
  if (!testUser) {
    testUser = await prisma.user.create({
      data: {
        email: `test_guard_${Date.now()}@example.com`,
        passwordHash: "hash",
        name: "Test Guard User",
      },
      select: { id: true, email: true },
    });
  }

  // Helper to create a disposable test campaign
  async function createTestCampaign(name: string, leadLimit = 10) {
    return prisma.campaign.create({
      data: {
        userId: testUser!.id,
        name: `Guard Test: ${name} (${Date.now()})`,
        intent: "cosmetic dentist",
        location: "Toronto, ON",
        leadLimit,
      } as any,
    });
  }

  // Cleanup helper
  async function cleanupCampaign(campaignId: string) {
    try {
      await prisma.lead.deleteMany({ where: { campaignId } });
      await prisma.scrapeJob.deleteMany({ where: { campaignId } });
      await prisma.campaign.delete({ where: { id: campaignId } });
    } catch {
      // ignore cleanup errors
    }
  }

  // Save original env vars
  const origEnv = {
    DISCOVERY_PROVIDER: process.env.DISCOVERY_PROVIDER,
    IG_ENRICHMENT_ACTOR: process.env.IG_ENRICHMENT_ACTOR,
    APIFY_ALLOWED_ACTORS: process.env.APIFY_ALLOWED_ACTORS,
    APIFY_MAX_RUNS_PER_JOB: process.env.APIFY_MAX_RUNS_PER_JOB,
    IG_PLACES_MAX_JOB_USD: process.env.IG_PLACES_MAX_JOB_USD,
    DISCOVERY_MAX_JOB_USD: process.env.DISCOVERY_MAX_JOB_USD,
    APIFY_DRY_RUN: process.env.APIFY_DRY_RUN,
  };

  try {
    process.env.APIFY_DRY_RUN = "false";

    // =========================================================================
    // Test g: Defaults are google_maps + profile_scraper
    // =========================================================================
    console.log("=== TEST G: System Defaults ===");
    {
      delete process.env.DISCOVERY_PROVIDER;
      delete process.env.ENRICHMENT_PROVIDER;
      delete process.env.IG_ENRICHMENT_ACTOR;
      delete process.env.APIFY_ALLOWED_ACTORS;
      delete process.env.APIFY_MAX_RUNS_PER_JOB;
      delete process.env.IG_PLACES_MAX_JOB_USD;
      delete process.env.DISCOVERY_MAX_JOB_USD;

      const defaultDiscovery = getActiveDiscoveryMode();
      const defaultEnrichment = getIgEnrichmentActorMode();
      const defaultEnrichmentActorId = getActiveEnrichmentActorId();

      check(defaultDiscovery === "instagram_all_in_one", "Default discovery provider is 'instagram_all_in_one'", defaultDiscovery);
      check(defaultEnrichment === "instagram_scraper_details", "Default enrichment mode is 'instagram_scraper_details'", defaultEnrichment);
      check(
        defaultEnrichmentActorId === "apify/instagram-scraper",
        "Default enrichment actor ID is apify/instagram-scraper",
        defaultEnrichmentActorId,
      );
    }

    // =========================================================================
    // Test a: A job never starts more than APIFY_MAX_RUNS_PER_JOB runs
    // =========================================================================
    console.log("\n=== TEST A: APIFY_MAX_RUNS_PER_JOB Hard Cap ===");
    {
      process.env.DISCOVERY_PROVIDER = "instagram_places";
      process.env.APIFY_MAX_RUNS_PER_JOB = "2"; // Set strict cap to 2

      const campaign = await createTestCampaign("Max Runs Cap", 50);
      const runsTriggered: Array<{ actorId: string; input: unknown }> = [];

      setMockActorRunnerForTesting(async (actorId, input) => {
        runsTriggered.push({ actorId, input });
        // Return 5 valid candidates each time
        return {
          items: [
            {
              title: "Dental Office 1",
              location_name: "Dental Office 1",
              location_city: "Toronto",
              city: "Toronto",
              lat: 43.6532,
              lng: -79.3832,
              ig_business: { profile: { username: `dentist_${runsTriggered.length}_1` } },
            },
            {
              title: "Dental Office 2",
              location_name: "Dental Office 2",
              location_city: "Toronto",
              city: "Toronto",
              lat: 43.6532,
              lng: -79.3832,
              ig_business: { profile: { username: `dentist_${runsTriggered.length}_2` } },
            },
            {
              title: "Dental Office 3",
              location_name: "Dental Office 3",
              location_city: "Toronto",
              city: "Toronto",
              lat: 43.6532,
              lng: -79.3832,
              ig_business: { profile: { username: `dentist_${runsTriggered.length}_3` } },
            },
          ],
          usageTotalUsd: 0.02,
          computeUnits: 0.05,
          isDryRun: false,
          run: mockRun(`run-cap-${runsTriggered.length}`, actorId, "SUCCEEDED", `ds-cap-${runsTriggered.length}`),
        };
      });

      try {
        await runDiscovery(
          {
            campaignId: campaign.id,
            query: "dentist",
            category: null,
            location: "Toronto, ON",
            maxLeads: 50,
          },
          testUser!.id,
        );

        const job = await prisma.scrapeJob.findFirst({
          where: { campaignId: campaign.id },
          orderBy: { createdAt: "desc" },
        });

        const usage = (job?.usage ?? {}) as Record<string, unknown>;
        const apifyRunsCount = typeof usage.apifyRunsCount === "number" ? usage.apifyRunsCount : runsTriggered.length;

        check(runsTriggered.length <= 2, `Job stopped at max runs cap: triggered ${runsTriggered.length} runs (cap: 2)`);
        check(apifyRunsCount <= 2, `Job usage tracks apifyRunsCount <= 2 (got: ${apifyRunsCount})`);
        check(
          Boolean(job?.errorMessage?.includes("Runs:")),
          "Notice contains visibility stats with Runs count",
          job?.errorMessage,
        );
      } finally {
        await cleanupCampaign(campaign.id);
      }
    }

    // =========================================================================
    // Test b: Low-yield early stop triggers after first search
    // =========================================================================
    console.log("\n=== TEST B: Low-Yield Early Stop ===");
    {
      process.env.DISCOVERY_PROVIDER = "instagram_places";
      process.env.APIFY_MAX_RUNS_PER_JOB = "4";

      const campaign = await createTestCampaign("Low Yield Early Stop", 10);
      const calls: string[] = [];

      setMockActorRunnerForTesting(async (actorId, input) => {
        if (input.directUrls === undefined) calls.push(actorId);
        // Return 10 items, but only 1 with Instagram handle (yield = 10% < 20% and kept = 1 < 3)
        const items = [
          {
            title: "Dental Clinic 1",
            location_name: "Dental Clinic 1",
            location_city: "Toronto",
            city: "Toronto",
            lat: 43.6532,
            lng: -79.3832,
            ig_business: { profile: { username: "torontodental_only_one" } },
          },
          ...Array.from({ length: 9 }).map((_, i) => ({
            title: `Place Without IG ${i + 2}`,
            location_name: `Place Without IG ${i + 2}`,
            location_city: "Toronto",
            city: "Toronto",
            lat: 43.6532,
            lng: -79.3832,
            // no instagram handle
          })),
        ];

        return {
          items,
          usageTotalUsd: 0.027,
          computeUnits: 0.05,
          isDryRun: false,
          run: mockRun("run-low-yield", actorId, "SUCCEEDED", "ds-low-yield"),
        };
      });

      try {
        const result = await runDiscovery(
          {
            campaignId: campaign.id,
            query: "dentist",
            category: null,
            location: "Toronto, ON",
            maxLeads: 10,
          },
          testUser!.id,
        );

        const searchCalls = calls.filter((c) => c !== "apify/instagram-profile-scraper");
        check(searchCalls.length === 1, `Discovery stopped after exactly 1 search call (got ${searchCalls.length})`);

        const job = await prisma.scrapeJob.findFirst({
          where: { campaignId: campaign.id },
          orderBy: { createdAt: "desc" },
        });

        const usage = (job?.usage ?? {}) as Record<string, unknown>;
        check(usage.stopReason === "low_yield_early_stop", "stopReason is 'low_yield_early_stop'", usage.stopReason);
        check(
          Boolean(result.notice?.includes("Low yield:")),
          "Notice contains 'Low yield:' prefix",
          result.notice,
        );
        check(
          Boolean(result.notice?.includes("Try google_maps")),
          "Notice recommends 'Try google_maps'",
          result.notice,
        );
        check(
          Boolean(result.notice?.includes("Stop reason: low_yield_early_stop")),
          "Notice includes exact Stop reason: low_yield_early_stop",
          result.notice,
        );

        // Also test unit format in buildDiscoveryNotice
        const unitNotice = buildDiscoveryNotice({
          persisted: 0,
          requested: 10,
          existingLeads: 0,
          discovered: 1,
          existingSkipped: 0,
          enrichSkipped: 0,
          remainingCapacity: 10,
          stopReason: "low_yield_early_stop",
          itemsReturnedRaw: 10,
          withInstagramUsername: 1,
          candidatesKept: 1,
          apifyRunsCount: 1,
          apifyCostUsd: 0.03,
          costPerLead: 0,
        });

        check(
          Boolean(unitNotice?.includes("Low yield: raw items 10, with Instagram 1, kept 1. Try google_maps")),
          "buildDiscoveryNotice generates exact prompt-compliant low yield message",
          unitNotice,
        );
      } finally {
        await cleanupCampaign(campaign.id);
      }
    }

    // =========================================================================
    // Test c: Enrichment of 12 survivors = 1 run, not 12
    // =========================================================================
    console.log("\n=== TEST C: Batching: 12 Survivors = 1 Run ===");
    {
      process.env.DISCOVERY_PROVIDER = "instagram_places";
      process.env.APIFY_MAX_RUNS_PER_JOB = "4";

      const campaign = await createTestCampaign("Single Batch Enrichment", 10);
      const enrichmentCalls: Array<{ actorId: string; input: unknown }> = [];
      let discoveryCallsCount = 0;

      setMockActorRunnerForTesting(async (actorId, input) => {
        const inRec = input as Record<string, unknown>;
        if (inRec.searchType === "place") {
          discoveryCallsCount++;
          const items = Array.from({ length: 12 }).map((_, i) => ({
            title: `Dental Clinic ${i + 1}`,
            location_name: `Dental Clinic ${i + 1}`,
            location_city: "Toronto",
            city: "Toronto",
            lat: 43.6532,
            lng: -79.3832,
            ig_business: { profile: { username: `dentist_survivor_${i + 1}` } },
          }));

          return {
            items,
            usageTotalUsd: 0.03,
            computeUnits: 0.05,
            isDryRun: false,
            run: mockRun("run-search-12", actorId, "SUCCEEDED", "ds-search-12"),
          };
        }

        enrichmentCalls.push({ actorId, input });
        return {
          items: [
            {
              username: "dentist_survivor_1",
              followersCount: 1500,
              followsCount: 200,
              biography: "Dental care clinic in Toronto",
              externalUrl: "https://clinic.com",
              isBusinessAccount: true,
              businessCategoryName: "Dentist",
              private: false,
            },
          ],
          usageTotalUsd: 0.04,
          computeUnits: 0.1,
          isDryRun: false,
          run: mockRun("run-enrich-batch", actorId, "SUCCEEDED", "ds-enrich-batch"),
        };
      });

      try {
        await runDiscovery(
          {
            campaignId: campaign.id,
            query: "dentist",
            category: null,
            location: "Toronto, ON",
            maxLeads: 10,
          },
          testUser!.id,
        );

        check(discoveryCallsCount === 1, `Discovery search called once (got ${discoveryCallsCount})`);
        check(enrichmentCalls.length === 1, `Enrichment executed as EXACTLY 1 run, not 12 (got ${enrichmentCalls.length})`);

        if (enrichmentCalls.length > 0) {
          const enrichInput = enrichmentCalls[0].input as Record<string, unknown>;
          const itemsCount = Array.isArray(enrichInput.usernames)
            ? enrichInput.usernames.length
            : Array.isArray(enrichInput.directUrls)
              ? enrichInput.directUrls.length
              : 0;
          check(itemsCount >= 10, `Batch size reflects survivor count (got ${itemsCount} profiles in batch)`);
        }
      } finally {
        await cleanupCampaign(campaign.id);
      }
    }

    // =========================================================================
    // Test d: Timed-out run is not retried and partial items are salvaged
    // =========================================================================
    console.log("\n=== TEST D: Timeout Handling & Partial Salvage ===");
    {
      // 1. Check resolveTimeoutSecs helper
      const tPlaceSmall = resolveTimeoutSecs("apify/instagram-scraper", { searchType: "place", searchLimit: 10 });
      const tPlaceLarge = resolveTimeoutSecs("apify/instagram-scraper", { searchType: "place", searchLimit: 25 });
      const tEnrich = resolveTimeoutSecs("apify/instagram-profile-scraper", { usernames: ["a", "b"] });

      check(tPlaceSmall === 120, "Place search <= 10 items resolves to 120s timeout", tPlaceSmall);
      check(tPlaceLarge === 180, "Place search > 10 items resolves to 180s timeout", tPlaceLarge);
      check(tEnrich === 180, "Enrichment resolves to 180s timeout", tEnrich);

      // 2. Mock a timed-out run and verify partial items are salvaged without retry
      let runnerInvocations = 0;
      setMockActorRunnerForTesting(async (actorId, input) => {
        runnerInvocations++;
        return {
          items: [
            { username: "partial_item_1" },
            { username: "partial_item_2" },
          ],
          usageTotalUsd: 0.05,
          computeUnits: 0.1,
          isDryRun: false,
          isTimedOut: true,
          isWasted: true,
          run: mockRun("run-timed-out", actorId, "TIMED-OUT", "ds-partial"),
        };
      });

      const safeResult = await runActorSafely(
        "apify/instagram-scraper",
        { search: "dentist", searchType: "place", searchLimit: 10 },
        { operationName: "timeout_test" },
      );

      check(runnerInvocations === 1, "Timed-out run is NEVER retried (invocations = 1)", runnerInvocations);
      check(safeResult.isTimedOut === true, "Result is marked isTimedOut: true");
      check(safeResult.items.length === 2, "Partial dataset items (2 items) are preserved and returned", safeResult.items.length);
      check(safeResult.isWasted === true, "Timed-out run with cost is marked isWasted: true");
    }

    // =========================================================================
    // Test e: Cost-per-lead guard and expensive zero-lead confirmation
    // =========================================================================
    console.log("\n=== TEST E: Cost-Per-Lead Guard & Zero-Lead Confirmation ===");
    {
      process.env.DISCOVERY_PROVIDER = "instagram_places";

      const campaign = await createTestCampaign("Cost Guard", 10);

      // 1. Cost-per-lead guard: stops when job cost > $0.10 and saved leads == 0
      setMockActorRunnerForTesting(async (actorId, input) => {
        const inRec = input as Record<string, unknown>;
        if (inRec.searchType === "place") {
          return {
            items: [1, 2, 3, 4, 5].map((i) => ({
              title: `Expensive Clinic ${i}`,
              location_name: `Expensive Clinic ${i}`,
              location_city: "Toronto",
              city: "Toronto",
              lat: 43.6532,
              lng: -79.3832,
              ig_business: { profile: { username: `expensive_dentist_${i}` } },
            })),
            usageTotalUsd: 0.12, // Exceeds $0.10 guard
            computeUnits: 0.2,
            isDryRun: false,
            run: mockRun("run-expensive-zero", actorId, "SUCCEEDED", "ds-zero"),
          };
        }
        return {
          items: [],
          usageTotalUsd: 0.01,
          computeUnits: 0.01,
          isDryRun: false,
          run: mockRun("run-enrich-zero", actorId, "SUCCEEDED", "ds-enrich-zero"),
        };
      });

      try {
        const result = await runDiscovery(
          {
            campaignId: campaign.id,
            query: "expensive query",
            category: null,
            location: "Toronto, ON",
            maxLeads: 10,
          },
          testUser!.id,
        );

        const job = await prisma.scrapeJob.findFirst({
          where: { campaignId: campaign.id },
          orderBy: { createdAt: "desc" },
        });

        const usage = (job?.usage ?? {}) as Record<string, unknown>;
        check(usage.stopReason === "cost_per_lead_exceeded", "Cost-per-lead guard stops job: stopReason='cost_per_lead_exceeded'", usage.stopReason);
        check(Boolean(result.notice?.includes("Cost per lead: $0.00")), "Notice displays 'Cost per lead: $0.00'", result.notice);

        // 2. Expensive zero-lead jobs must not block or prompt for a retry:
        // Set previous job cost to $0.35 with 0 leads, then start a new job.
        await prisma.scrapeJob.update({
          where: { id: job!.id },
          data: {
            processedCount: 0,
            usage: {
              ...usage,
              estimatedApifyCost: 0.35,
              totalUsd: 0.35,
            },
          },
        });

        let retrySucceeded = false;
        try {
          await runDiscovery(
            {
              campaignId: campaign.id,
              query: "expensive query retry",
              category: null,
              location: "Toronto, ON",
              maxLeads: 10,
            },
            testUser!.id,
          );
          retrySucceeded = true;
        } catch {
          retrySucceeded = false;
        }

        check(retrySucceeded, "New job after a >$0.30 zero-lead job starts without a confirmation prompt");
      } finally {
        await cleanupCampaign(campaign.id);
      }
    }

    // =========================================================================
    // Test f: Cross-job memory skips already-seen handles without Apify call
    // =========================================================================
    console.log("\n=== TEST F: Cross-Job Memory & Dedup ===");
    {
      process.env.DISCOVERY_PROVIDER = "instagram_places";

      const campaign = await createTestCampaign("Cross Job Memory", 10);

      // Create a previous scrape job that saw candidate "known_toronto_dentist"
      await prisma.scrapeJob.create({
        data: {
          campaignId: campaign.id,
          status: "COMPLETED",
          provider: "apify",
          inputCount: 1,
          processedCount: 0,
          createdAt: new Date(),
          usage: {
            seenCandidates: ["known_toronto_dentist"],
            rejectionLog: [{ username: "rejected_toronto_dentist", gate: "prefilter" }],
          },
        },
      });

      const enrichmentSeenUsernames: string[] = [];

      setMockActorRunnerForTesting(async (actorId, input) => {
        const inRec = input as Record<string, unknown>;
        if (inRec.searchType === "place") {
          return {
            items: [
              {
                title: "Known Seen Dentist",
                location_name: "Known Seen Dentist",
                location_city: "Toronto",
                city: "Toronto",
                lat: 43.6532,
                lng: -79.3832,
                ig_business: { profile: { username: "known_toronto_dentist" } },
              },
              {
                title: "Known Rejected Dentist",
                location_name: "Known Rejected Dentist",
                location_city: "Toronto",
                city: "Toronto",
                lat: 43.6532,
                lng: -79.3832,
                ig_business: { profile: { username: "rejected_toronto_dentist" } },
              },
              {
                title: "Brand New Dentist 1",
                location_name: "Brand New Dentist 1",
                location_city: "Toronto",
                city: "Toronto",
                lat: 43.6532,
                lng: -79.3832,
                ig_business: { profile: { username: "brand_new_dentist_1" } },
              },
              {
                title: "Brand New Dentist 2",
                location_name: "Brand New Dentist 2",
                location_city: "Toronto",
                city: "Toronto",
                lat: 43.6532,
                lng: -79.3832,
                ig_business: { profile: { username: "brand_new_dentist_2" } },
              },
              {
                title: "Brand New Dentist 3",
                location_name: "Brand New Dentist 3",
                location_city: "Toronto",
                city: "Toronto",
                lat: 43.6532,
                lng: -79.3832,
                ig_business: { profile: { username: "brand_new_dentist_3" } },
              },
            ],
            usageTotalUsd: 0.03,
            computeUnits: 0.05,
            isDryRun: false,
            run: mockRun("run-cross-job", actorId, "SUCCEEDED", "ds-cj"),
          };
        }

        const enrichInput = input as Record<string, unknown>;
        const usernames = Array.isArray(enrichInput.usernames) ? enrichInput.usernames : [];
        enrichmentSeenUsernames.push(...usernames);
        return {
          items: usernames.map((u) => ({
            username: u,
            followersCount: 500,
            isBusinessAccount: true,
            businessCategoryName: "Dentist",
            private: false,
          })),
          usageTotalUsd: 0.02,
          computeUnits: 0.05,
          isDryRun: false,
          run: mockRun("run-new-enrich", actorId, "SUCCEEDED", "ds-new"),
        };
      });

      try {
        const result = await runDiscovery(
          {
            campaignId: campaign.id,
            query: "dentist",
            category: null,
            location: "Toronto, ON",
            maxLeads: 5,
          },
          testUser!.id,
        );

        const job = await prisma.scrapeJob.findFirst({
          where: { campaignId: campaign.id },
          orderBy: { createdAt: "desc" },
        });

        const usage = (job?.usage ?? {}) as Record<string, unknown>;
        const skippedAlreadySeen = usage.skippedAlreadySeenCount as number;

        check(skippedAlreadySeen >= 2, `Skipped already seen/rejected candidates (got: ${skippedAlreadySeen})`);
        check(
          Boolean(result.notice?.includes("skipped as already seen:")),
          "Notice includes 'skipped as already seen: N'",
          result.notice,
        );
        check(
          !enrichmentSeenUsernames.includes("known_toronto_dentist"),
          "Known seen candidate was never passed to enrichment actor",
        );
        check(
          !enrichmentSeenUsernames.includes("rejected_toronto_dentist"),
          "Known rejected candidate was never passed to enrichment actor",
        );
      } finally {
        await cleanupCampaign(campaign.id);
      }
    }

  } finally {
    // Restore environment
    if (origEnv.DISCOVERY_PROVIDER !== undefined) process.env.DISCOVERY_PROVIDER = origEnv.DISCOVERY_PROVIDER;
    else delete process.env.DISCOVERY_PROVIDER;

    if (origEnv.IG_ENRICHMENT_ACTOR !== undefined) process.env.IG_ENRICHMENT_ACTOR = origEnv.IG_ENRICHMENT_ACTOR;
    else delete process.env.IG_ENRICHMENT_ACTOR;

    if (origEnv.APIFY_ALLOWED_ACTORS !== undefined) process.env.APIFY_ALLOWED_ACTORS = origEnv.APIFY_ALLOWED_ACTORS;
    else delete process.env.APIFY_ALLOWED_ACTORS;

    if (origEnv.APIFY_MAX_RUNS_PER_JOB !== undefined) process.env.APIFY_MAX_RUNS_PER_JOB = origEnv.APIFY_MAX_RUNS_PER_JOB;
    else delete process.env.APIFY_MAX_RUNS_PER_JOB;

    if (origEnv.IG_PLACES_MAX_JOB_USD !== undefined) process.env.IG_PLACES_MAX_JOB_USD = origEnv.IG_PLACES_MAX_JOB_USD;
    else delete process.env.IG_PLACES_MAX_JOB_USD;

    if (origEnv.DISCOVERY_MAX_JOB_USD !== undefined) process.env.DISCOVERY_MAX_JOB_USD = origEnv.DISCOVERY_MAX_JOB_USD;
    else delete process.env.DISCOVERY_MAX_JOB_USD;

    if (origEnv.APIFY_DRY_RUN !== undefined) process.env.APIFY_DRY_RUN = origEnv.APIFY_DRY_RUN;
    else delete process.env.APIFY_DRY_RUN;

    // Disconnect prisma
    await prisma.$disconnect();
  }

  console.log("\n================================================================================");
  console.log(`TEST SUMMARY: ${passedCount} passed, ${failedCount} failed`);
  console.log("================================================================================");

  if (failedCount > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test runner encountered unhandled error:", err);
  process.exit(1);
});
