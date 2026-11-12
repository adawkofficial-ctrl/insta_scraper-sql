/**
 * STEP 6 — Discovery Fixes Verification Test Suite
 *
 * Verifies:
 * 1. Real-mode run with a mocked Apify client returning 15 realistic places
 *    (some without website, some without IG, one closed, one chain, one wrong city)
 *    while 6 dry-run leads + cache rows exist:
 *    - Real leads saved (persisted > 0)
 *    - Dry-run rows ignored
 *    - remainingCapacity computed without dry-run rows
 *    - No ALL_DUPLICATES notice
 * 2. Dry-run does not pollute real dedup.
 * 3. Cleanup deletes only dry-run rows and preserves real rows.
 * 4. Failing ScrapeJob.create aborts discovery (fails loud, HTTP 500 / rejected).
 * 5. Country location produces the pre-run plan (resolves major cities).
 * 6. Keyword is not suffixed with city when passed to Google Maps.
 */

import "dotenv/config";
import type { DiscoveryRequest } from "../src/lib/services/discovery/discovery-service";
(process.env as Record<string, string>).NODE_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl } = require("./test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` -> ${detail}` : ""}`);
    failed++;
  }
}

async function main() {
  const { getPrismaClient } = await import("../src/lib/db/prisma");
  const { setApifyClientForTesting } = await import("../src/lib/services/scraper/apify-client");
  const {
    runDiscovery,
    prepareDiscoveryRun,
  } = await import("../src/lib/services/discovery/discovery-service");
  const {
    resolveTargetCities,
    isCountryName,
    getRecommendedCitiesForCountry,
  } = await import("../src/lib/services/discovery/country-cities");
  const { buildPerKeywordSearchQueries } = await import("../src/lib/services/discovery/discovery-query");
  const { classifyProfiles } = await import("../src/lib/services/dedup/dedup-service");
  const { getDryRunCounts, deleteDryRunData } = await import("../src/lib/services/lead/dry-run-cleanup");

  console.log("=== STEP 6: DISCOVERY FIXES & DATA ISOLATION VERIFICATION ===");
  const prisma = getPrismaClient();

  const testEmail = `disc-fixes-${Date.now()}@test.local`;
  const user = await prisma.user.create({
    data: {
      email: testEmail,
      name: "Discovery Fixes Tester",
      passwordHash: "test-hash",
    },
  });

  const companyProfile = await prisma.companyProfile.create({
    data: {
      userId: user.id,
      name: "Downtown Dental Clinic",
      description: "Cosmetic and general dentistry in Toronto",
      isDefault: true,
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      name: "Toronto Dental Discovery Test",
      companyProfileId: companyProfile.id,
      intent: "cosmetic dentist",
      location: "Toronto, ON",
      category: "Dentist",
    },
  });

  try {
    // =========================================================================
    // 1. COUNTRY LOCATION PRE-RUN PLAN & KEYWORD SUFFIX INTEGRITY
    // =========================================================================
    console.log("\n[Test 1] Country location produces multi-city plan & clean keywords");
    {
      const isCanadaCountry = isCountryName("canada");
      check(isCanadaCountry, "isCountryName('canada') is true");

      const resolution = resolveTargetCities("canada");
      check(
        resolution.cities.length === 5,
        `resolveTargetCities('canada') returns top 5 cities (got ${resolution.cities.length})`,
      );
      check(
        resolution.cities.includes("Toronto, ON") && resolution.cities.includes("Vancouver, BC"),
        "Canada plan includes Toronto and Vancouver",
      );

      const recommended = getRecommendedCitiesForCountry("canada");
      check(
        recommended.length >= 5 && recommended[0] === "Toronto, ON",
        "getRecommendedCitiesForCountry('canada') recommends major hubs",
      );

      // Verify keyword is NOT suffixed with city when appendLocation is false (Google Maps provider)
      const queriesWithoutLocation = buildPerKeywordSearchQueries({
        query: "cosmetic dentist, teeth whitening",
        location: "Toronto, ON",
        appendLocation: false,
      });
      check(
        queriesWithoutLocation[0] === "cosmetic dentist" &&
          queriesWithoutLocation[1] === "teeth whitening",
        `Keywords NOT suffixed with city when appendLocation=false (got: ${queriesWithoutLocation.join(", ")})`,
      );

      // Verify keyword preserves campaign intent words (does NOT replace with category unless empty)
      const queriesWithCategoryFallback = buildPerKeywordSearchQueries({
        query: "",
        category: "Dentist",
        appendLocation: false,
      });
      check(
        queriesWithCategoryFallback.length === 1 &&
          queriesWithCategoryFallback[0].toLowerCase() === "dentist",
        "Empty query falls back cleanly to category",
      );
    }

    // =========================================================================
    // 2. DRY-RUN DOES NOT POLLUTE REAL DEDUP
    // =========================================================================
    console.log("\n[Test 2] Dry-run leads do not pollute real dedup");
    {
      // Insert a dry-run lead
      const dryLead = await prisma.lead.create({
        data: {
          userId: user.id,
          campaignId: campaign.id,
          username: "sample_dentist_existing",
          usernameNormalized: "sample_dentist_existing",
          isDryRun: true,
          source: "dry_run",
          website: "https://sampledentist.example.com",
          phone: "+1-555-0199",
        },
      });

      // Classify this same profile for a REAL run
      const realDedupResult = await classifyProfiles({
        userId: user.id,
        campaignId: campaign.id,
        profiles: [
          {
            username: "sample_dentist_existing",
            website: "https://sampledentist.example.com",
            phone: "+1-555-0199",
          },
        ],
        isDryRun: false,
      });

      const decision = realDedupResult.find(
        (d) => d.normalized.usernameNormalized === "sample_dentist_existing",
      );
      check(
        decision?.kind === "NEW",
        `Real run dedup completely ignores dry-run lead (got kind: ${decision?.kind ?? "NEW"})`,
      );

      // Clean up the sample dry lead
      await prisma.lead.delete({ where: { id: dryLead.id } });
    }

    // =========================================================================
    // 3. FAILING ScrapeJob.create FAILS LOUD & ABORTS DISCOVERY
    // =========================================================================
    console.log("\n[Test 3] Failing ScrapeJob.create fails loud and aborts discovery");
    {
      // Invalidate campaign ID so ScrapeJob.create foreign key constraint fails
      const badInput: DiscoveryRequest = {
        campaignId: "00000000-0000-0000-0000-000000000000",
        query: "dentist",
        location: "Toronto, ON",
        category: "Dentist",
        maxLeads: 10,
      };

      let abortedWithException = false;
      try {
        await prepareDiscoveryRun(badInput, user.id);
      } catch (err) {
        abortedWithException = true;
      }

      check(
        abortedWithException,
        "prepareDiscoveryRun fails loud with rejection when ScrapeJob creation fails",
      );
    }

    // =========================================================================
    // 4. REAL-MODE RUN WITH MOCKED APIFY CLIENT (15 realistic places) & 6 DRY LEADS
    // =========================================================================
    console.log(
      "\n[Test 4] Real-mode run with 15 realistic places while 6 dry-run leads exist",
    );
    {
      // Insert 6 dry-run fixture leads for this campaign
      const dryLeadsData = [
        {
          userId: user.id,
          campaignId: campaign.id,
          username: "sample_business_1",
          usernameNormalized: "sample_business_1",
          isDryRun: true,
          source: "sample_fixture",
          website: "https://clinic1.example.com",
          phone: "555-0101",
        },
        {
          userId: user.id,
          campaignId: campaign.id,
          username: "sample_business_2",
          usernameNormalized: "sample_business_2",
          isDryRun: true,
          source: "sample_fixture",
          website: "https://clinic2.example.com",
          phone: "555-0102",
        },
        {
          userId: user.id,
          campaignId: campaign.id,
          username: "sample_business_3",
          usernameNormalized: "sample_business_3",
          isDryRun: true,
          source: "sample_fixture",
          website: "https://clinic3.example.com",
          phone: "555-0103",
        },
        {
          userId: user.id,
          campaignId: campaign.id,
          username: "sample_business_4",
          usernameNormalized: "sample_business_4",
          isDryRun: true,
          source: "sample_fixture",
          website: "https://clinic4.example.com",
          phone: "555-0104",
        },
        {
          userId: user.id,
          campaignId: campaign.id,
          username: "sample_business_5",
          usernameNormalized: "sample_business_5",
          isDryRun: true,
          source: "sample_fixture",
          website: "https://clinic5.example.com",
          phone: "555-0105",
        },
        {
          userId: user.id,
          campaignId: campaign.id,
          username: "sample_business_6",
          usernameNormalized: "sample_business_6",
          isDryRun: true,
          source: "sample_fixture",
          website: "https://clinic6.example.com",
          phone: "555-0106",
        },
      ];

      await prisma.lead.createMany({ data: dryLeadsData });

      const dryCountBefore = await prisma.lead.count({
        where: { campaignId: campaign.id, isDryRun: true },
      });
      check(dryCountBefore === 6, `Inserted 6 dry-run leads (got ${dryCountBefore})`);

      // Construct 15 realistic Google Maps places:
      // - Some valid with website and IG
      // - Some without website
      // - Some without IG
      // - One permanently closed
      // - One chain
      // - One wrong city (Vancouver place in Toronto search)
      const mockPlaces = [
        // 1. Valid cosmetic dentist
        {
          title: "Toronto Smile Studio",
          address: "100 Bay St, Toronto, ON",
          city: "Toronto",
          categoryName: "Cosmetic dentist",
          phone: "+1 416-200-0101",
          website: "https://torontosmilestudio.ca",
          socialMediaProfiles: { instagram: "https://instagram.com/torontosmilestudio" },
        },
        // 2. Valid dental clinic
        {
          title: "Yorkville Family Dental",
          address: "55 Bloor St W, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0102",
          website: "https://yorkvillefamilydental.ca",
          socialMediaProfiles: { instagram: "https://instagram.com/yorkvilledental" },
        },
        // 3. Valid dental center
        {
          title: "Downtown Toronto Dentistry",
          address: "200 King St W, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0103",
          website: "https://downtowntorontodentistry.com",
          socialMediaProfiles: { instagram: "https://instagram.com/downtowndentisto" },
        },
        // 4. No website
        {
          title: "No Website Dental Office",
          address: "300 Queen St W, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0104",
          website: null,
          socialMediaProfiles: {},
        },
        // 5. No Instagram
        {
          title: "No Instagram Dental Clinic",
          address: "400 Spadina Ave, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0105",
          website: "https://noigclinic.ca",
          socialMediaProfiles: {},
        },
        // 6. Closed clinic
        {
          title: "Permanently Closed Dentistry",
          address: "500 Yonge St, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0106",
          website: "https://closeddental.ca",
          isPermanentlyClosed: true,
          permanentlyClosed: true,
          socialMediaProfiles: { instagram: "https://instagram.com/closeddental" },
        },
        // 7. National chain
        {
          title: "Dentalcorp National Smiles",
          address: "600 Queen St E, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0107",
          website: "https://dentalcorp.ca/location",
          socialMediaProfiles: { instagram: "https://instagram.com/dentalcorp" },
        },
        // 8. Wrong city (Vancouver place in Toronto search)
        {
          title: "Vancouver Pacific Dental",
          address: "800 Granville St, Vancouver, BC",
          city: "Vancouver",
          lat: 49.2827,
          lng: -123.1207,
          categoryName: "Dentist",
          phone: "+1 604-555-0199",
          website: "https://vancouverpacificdental.ca",
          socialMediaProfiles: { instagram: "https://instagram.com/vancouverpacificdental" },
        },
        // 9. Valid clinic
        {
          title: "Bay Street Dental Center",
          address: "700 Bay St, Toronto, ON",
          city: "Toronto",
          categoryName: "Cosmetic dentist",
          phone: "+1 416-200-0109",
          website: "https://baystreetdentalcenter.ca",
          socialMediaProfiles: { instagram: "https://instagram.com/baystreetdental" },
        },
        // 10. Valid clinic
        {
          title: "Bloor Smiles Care",
          address: "850 Bloor St W, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0110",
          website: "https://bloorsmilescare.ca",
          socialMediaProfiles: { instagram: "https://instagram.com/bloorsmilescare" },
        },
        // 11. Valid clinic
        {
          title: "Danforth Smiles Clinic",
          address: "320 Danforth Ave, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0111",
          website: "https://danforthsmilesclinic.ca",
          socialMediaProfiles: { instagram: "https://instagram.com/danforthsmiles" },
        },
        // 12. Another place without website
        {
          title: "Walk-in Dental No Web",
          address: "120 College St, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0112",
          website: null,
          socialMediaProfiles: {},
        },
        // 13. Valid clinic
        {
          title: "Yonge Eglinton Dental Care",
          address: "2150 Yonge St, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0113",
          website: "https://yongeeglintondentalcare.ca",
          socialMediaProfiles: { instagram: "https://instagram.com/yongeeglintondental" },
        },
        // 14. Another place without IG
        {
          title: "College Street Dental No IG",
          address: "450 College St, Toronto, ON",
          city: "Toronto",
          categoryName: "Dentist",
          phone: "+1 416-200-0114",
          website: "https://collegestreetdentalnoig.ca",
          socialMediaProfiles: {},
        },
        // 15. Valid clinic
        {
          title: "Forest Hill Smile Design",
          address: "500 St Clair Ave W, Toronto, ON",
          city: "Toronto",
          categoryName: "Cosmetic dentist",
          phone: "+1 416-200-0115",
          website: "https://foresthillsmiledesign.ca",
          socialMediaProfiles: { instagram: "https://instagram.com/foresthillsmiles" },
        },
      ];

      // Setup Apify Mock Client returning realistic places and profile scraping
      const mockApifyClient = {
        actor: (actorId: string) => ({
          call: async () => ({
            id: `real_run_${Date.now()}`,
            status: "SUCCEEDED",
            defaultDatasetId: `dataset_${Date.now()}`,
            usageTotalUsd: 0.03,
            stats: { computeUnits: 0.015 },
          }),
        }),
        run: (runId: string) => ({
          waitForFinish: async () => ({
            id: runId || `real_run_${Date.now()}`,
            status: "SUCCEEDED",
            defaultDatasetId: `dataset_${Date.now()}`,
            usageTotalUsd: 0.03,
            stats: { computeUnits: 0.015 },
          }),
        }),
        dataset: (datasetId: string) => ({
          listItems: async () => {
            // If this is google places scraping, return the 15 mock places
            return {
              items: mockPlaces,
            };
          },
        }),
      };

      setApifyClientForTesting(mockApifyClient as any);

      // Explicitly set APIFY_DRY_RUN to "false" to test REAL MODE
      const prevDryEnv = process.env.APIFY_DRY_RUN;
      const prevDiscoveryProvider = process.env.DISCOVERY_PROVIDER;
      const prevEnrichmentProvider = process.env.ENRICHMENT_PROVIDER;
      const prevEnrichActor = process.env.IG_ENRICHMENT_ACTOR;
      process.env.APIFY_DRY_RUN = "false";
      // This suite exercises the legacy Google Maps fixtures + profile actor.
      process.env.DISCOVERY_PROVIDER = "google_maps";
      process.env.ENRICHMENT_PROVIDER = "instagram_profile_scraper";
      process.env.IG_ENRICHMENT_ACTOR = "profile_scraper";

      try {
        const discoveryResult = await runDiscovery(
          {
            campaignId: campaign.id,
            query: "cosmetic dentist",
            location: "Toronto, ON",
            category: "Dentist",
            maxLeads: 10,
          },
          user.id,
        );

        // Verify remaining capacity was computed WITHOUT dry-run rows:
        // Request limit was 10, existing real leads was 0.
        // Before our fix, remainingCapacity would have been 10 - 6 = 4.
        // With our fix, remainingCapacity is 10 (or 10 - persisted).
        check(
          discoveryResult.requestedLimit === 10,
          `Requested limit is 10 (got ${discoveryResult.requestedLimit})`,
        );

        check(
          (discoveryResult.existingLeads ?? 0) === 0,
          `Existing leads counted in real run is 0 (dry-run rows ignored; got ${discoveryResult.existingLeads})`,
        );

        // Verify no ALL_DUPLICATES notice was generated
        check(
          discoveryResult.notice !== "ALL_DUPLICATES",
          `Notice is not ALL_DUPLICATES (notice: ${discoveryResult.notice ?? "none"})`,
        );

        // Verify real leads were saved and marked with isDryRun=false
        const realLeads = await prisma.lead.findMany({
          where: { campaignId: campaign.id, isDryRun: false },
        });
        check(
          realLeads.length > 0,
          `Real leads persisted to database with isDryRun=false (persisted: ${realLeads.length})`,
        );

        // Verify all saved real leads have isDryRun === false
        const allRealAreNotDry = realLeads.every((l) => l.isDryRun === false);
        check(allRealAreNotDry, "All persisted leads have isDryRun strictly false");
      } finally {
        process.env.APIFY_DRY_RUN = prevDryEnv;
        if (prevDiscoveryProvider !== undefined) process.env.DISCOVERY_PROVIDER = prevDiscoveryProvider;
        else delete process.env.DISCOVERY_PROVIDER;
        if (prevEnrichmentProvider !== undefined) process.env.ENRICHMENT_PROVIDER = prevEnrichmentProvider;
        else delete process.env.ENRICHMENT_PROVIDER;
        if (prevEnrichActor !== undefined) process.env.IG_ENRICHMENT_ACTOR = prevEnrichActor;
        else delete process.env.IG_ENRICHMENT_ACTOR;
      }
    }

    // =========================================================================
    // 5. CLEANUP DELETES ONLY DRY-RUN ROWS AND PRESERVES REAL ROWS
    // =========================================================================
    console.log("\n[Test 5] Cleanup deletes only dry-run rows and preserves real rows");
    {
      const countsBefore = await getDryRunCounts(user.id);
      check(
        countsBefore.dryLeads >= 6,
        `Dry run counts detect at least 6 dry leads before cleanup (got ${countsBefore.dryLeads})`,
      );

      const realLeadsCountBefore = await prisma.lead.count({
        where: { campaignId: campaign.id, isDryRun: false },
      });
      check(
        realLeadsCountBefore > 0,
        `Real leads exist before cleanup (count: ${realLeadsCountBefore})`,
      );

      // Execute cleanup for this user
      const cleanupResult = await deleteDryRunData({ userId: user.id });
      check(
        cleanupResult.deletedLeads >= 6,
        `Cleanup deleted ${cleanupResult.deletedLeads} dry-run leads`,
      );

      const countsAfter = await getDryRunCounts(user.id);
      check(
        countsAfter.dryLeads === 0,
        `Dry-run leads for this user is 0 after cleanup (got ${countsAfter.dryLeads})`,
      );

      // Verify REAL leads are 100% untouched and preserved
      const realLeadsCountAfter = await prisma.lead.count({
        where: { campaignId: campaign.id, isDryRun: false },
      });
      check(
        realLeadsCountAfter === realLeadsCountBefore,
        `Real leads are 100% preserved after dry-run cleanup (${realLeadsCountAfter} leads)`,
      );
    }
  } finally {
    // Teardown test campaign & user
    await prisma.lead.deleteMany({ where: { campaignId: campaign.id } }).catch(() => {});
    await prisma.scrapeJob.deleteMany({ where: { campaignId: campaign.id } }).catch(() => {});
    await prisma.campaign.delete({ where: { id: campaign.id } }).catch(() => {});
    await prisma.companyProfile.delete({ where: { id: companyProfile.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }

  console.log(`\n=================================================`);
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`=================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
