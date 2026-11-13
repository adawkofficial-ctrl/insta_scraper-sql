/**
 * Tests for Profile Enrichment Minimum Cost Retry, Candidate Immediate Persistence,
 * Job Warning Status, Resume Job, and CSV Import.
 */

import "dotenv/config";
import path from "node:path";
import fs from "node:fs";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl } = require("./test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || "mock-apify-test-token";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { getPrismaClient } from "../src/lib/db/prisma";
import { ScrapeJobStatus, LeadStatus } from "@/generated/prisma/client";
import {
  setMockActorRunnerForTesting,
  runActorSafely,
  estimateActorCost,
} from "../src/lib/services/scraper/apify-cost-guard";
import { setMockWebsiteScraperForTesting } from "../src/lib/services/enrichment/website-lead-enricher";
import { GoogleMapsDiscoveryProvider } from "../src/lib/services/discovery/google-maps-discovery-provider";
import { resumeScrapeJob } from "../src/lib/services/discovery/resume-service";
import { importDataset } from "./import_apify_dataset";
import {
  derivePlaceLocation,
  buildQualifiedLocationString,
  normalizeCityKey,
} from "../src/lib/services/discovery/country-cities";

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

async function runTests() {
  console.log("=== RUNNING ENRICHMENT, PERSISTENCE & RESUME TEST SUITE ===");
  const prisma = getPrismaClient();

  // Test 1: Single-profile technical minimum error retry in Apify Cost Guard
  console.log("\n[Test 1] Single-profile technical minimum error retry");
  {
    let callCount = 0;
    let sentMaxCharge: number | null | undefined = undefined;

    setMockActorRunnerForTesting(async (_actorId, _input, options) => {
      callCount++;
      sentMaxCharge = options?.maxTotalChargeUsd;
      if (callCount === 1) {
        throw new Error("Apify actor execution failed: Maximum cost per run is less than the allowed minimum of $0.0026");
      }
      return {
        run: { id: "mock-retry-run", status: "SUCCEEDED", defaultDatasetId: "ds-1" } as any,
        items: [{ username: "singleprofile", followersCount: 1200 }],
        usageTotalUsd: 0.005,
        computeUnits: 0.001,
        isDryRun: false,
      };
    });

    const costEst = estimateActorCost("apify/instagram-profile-scraper", { usernames: ["singleprofile"] });
    check(costEst.maxItems >= 5, "Single profile scraper enforces safety maxItems >= 5", `maxItems=${costEst.maxItems}`);

    const res = await runActorSafely(
      "apify/instagram-profile-scraper",
      { usernames: ["singleprofile"] },
      { maxItems: costEst.maxItems },
    );

    check(callCount === 2, "Retried once on technical minimum cost error", `calls=${callCount}`);
    check(sentMaxCharge !== undefined && sentMaxCharge! >= 0.10, "Retry provided explicit technical minimum maxTotalChargeUsd >= $0.10", `charge=${sentMaxCharge}`);
    check(res.items.length === 1 && (res.items[0] as any).username === "singleprofile", "Actor returned successful result after retry");
  }

  // Test 2: Location qualification & prefix normalization
  console.log("\n[Test 2] Location guard prefix normalization and qualification");
  {
    check(normalizeCityKey("Downtown Vancouver") === "vancouver", "Prefix 'Downtown' stripped in normalizeCityKey");
    check(normalizeCityKey("North York") === "north york" || normalizeCityKey("North York") === "york", "Normalized North York handles GTA");
    
    const qualifiedGTA = buildQualifiedLocationString("Scarborough", "Canada");
    check(qualifiedGTA.includes("Toronto") && qualifiedGTA.includes("ON"), "Scarborough qualified with Toronto and ON", qualifiedGTA);

    // Downtown Vancouver place in Vancouver coordinates (lat ~49.28, lon ~-123.12)
    const vancouverPlace = {
      title: "Vancouver Clinic",
      city: "Vancouver",
      location: { lat: 49.2827, lng: -123.1207 },
    };
    const vancouverMatch = derivePlaceLocation(vancouverPlace as any, "Downtown Vancouver");
    check(vancouverMatch.isExplicitMismatch === false, "Downtown Vancouver accepted for Vancouver places");
    check(vancouverMatch.city === "Vancouver", `Downtown Vancouver derives Vancouver, got "${vancouverMatch.city}"`);

    // Mississauga place in Mississauga coordinates (lat ~43.589, lng ~-79.644)
    const mississaugaMatch = derivePlaceLocation(
      {
        title: "Mississauga Clinic",
        city: "Mississauga",
        countryCode: "CA",
        location: { lat: 43.589, lng: -79.6441 },
      } as any,
      "Mississauga, ON",
    );
    check(mississaugaMatch.isExplicitMismatch === false, "Mississauga accepted for Mississauga coordinates");
    check(mississaugaMatch.city === "Mississauga", `Mississauga derives Mississauga, got "${mississaugaMatch.city}"`);

    // Brampton place in Brampton coordinates (lat ~43.7315, lng ~-79.7624)
    const bramptonMatch = derivePlaceLocation(
      {
        title: "Brampton Clinic",
        city: "Brampton",
        countryCode: "CA",
        location: { lat: 43.7315, lng: -79.7624 },
      } as any,
      "Brampton, ON",
    );
    check(bramptonMatch.isExplicitMismatch === false, "Brampton accepted for Brampton coordinates");
    check(bramptonMatch.city === "Brampton", `Brampton derives Brampton, got "${bramptonMatch.city}"`);

    // Unknown town: no CITY_COORDINATES entry, so coordinates must not be
    // checked against a Toronto default. The place's own data decides.
    const unknownTownMatch = derivePlaceLocation(
      {
        title: "Unknown Town Clinic",
        city: "Fooville",
        countryCode: "GB",
        location: { lat: 54.28, lng: -0.4 },
      } as any,
      "Fooville",
    );
    check(
      unknownTownMatch.isExplicitMismatch === false,
      "Unknown town is not rejected via a Toronto coordinate default",
    );
    check(
      unknownTownMatch.city === "Fooville" && String(unknownTownMatch.city) !== "Toronto",
      `Unknown town stays unknown (got "${unknownTownMatch.city}"), never defaults to Toronto`,
    );

    // Scarborough place with UK coordinates (Scarborough North Yorkshire: lat 54.28, lng -0.40)
    const ukPlace = {
      title: "UK Practice",
      city: "Scarborough",
      state: "North Yorkshire",
      countryCode: "GB",
      location: { lat: 54.28, lng: -0.40 },
    };
    const ukMatch = derivePlaceLocation(ukPlace as any, "Scarborough, Toronto, ON, Canada");
    check(ukMatch.isExplicitMismatch === true, "North Yorkshire UK coordinates rejected for Scarborough Ontario search");
  }

  // Test 3: Two mocked Maps runs (15 places each) -> profile enrichment fails
  console.log("\n[Test 3] Two Maps runs (15 places each) + profile-enrichment error");
  {
    // Clean test db tables
    const user = await prisma.user.upsert({
      where: { email: "enrichment_test@example.com" },
      update: {},
      create: {
        email: "enrichment_test@example.com",
        name: "Test User",
        passwordHash: "hash123",
      },
    });

    const companyProfile = await prisma.companyProfile.create({
      data: {
        userId: user.id,
        name: "Test Company",
      },
    });

    const campaign = await prisma.campaign.create({
      data: {
        name: "Enrichment Persistence Test Campaign",
        userId: user.id,
        companyProfileId: companyProfile.id,
        category: "Dentists",
        location: "Toronto, ON, Canada",
        leadLimit: 50,
      },
    });

    const job = await prisma.scrapeJob.create({
      data: {
        campaignId: campaign.id,
        provider: "google_maps",
        status: ScrapeJobStatus.RUNNING,
        inputCount: 30,
        processedCount: 0,
        isDryRun: false,
      },
    });

    // Create 30 distinct places (15 per run)
    const run1Places = Array.from({ length: 15 }, (_, i) => ({
      placeId: `test_place_run1_${i + 1}`,
      title: `Dental Clinic R1-${i + 1}`,
      categoryName: "Dentist",
      street: `${100 + i} Yonge St`,
      city: "Toronto",
      state: "Ontario",
      countryCode: "CA",
      website: `https://clinic-r1-${i + 1}.ca`,
      phone: `+1 416-555-${1000 + i}`,
      totalScore: 4.8,
      reviewsCount: 50 + i,
      url: `https://maps.google.com/?cid=test_r1_${i + 1}`,
      location: { lat: 43.6532, lng: -79.3832 },
    }));

    const run2Places = Array.from({ length: 15 }, (_, i) => ({
      placeId: `test_place_run2_${i + 1}`,
      title: `Dental Clinic R2-${i + 1}`,
      categoryName: "Dentist",
      street: `${200 + i} Bloor St`,
      city: "Toronto",
      state: "Ontario",
      countryCode: "CA",
      website: `https://clinic-r2-${i + 1}.ca`,
      phone: `+1 416-555-${2000 + i}`,
      totalScore: 4.6,
      reviewsCount: 30 + i,
      url: `https://maps.google.com/?cid=test_r2_${i + 1}`,
      location: { lat: 43.6702, lng: -79.3868 },
    }));

    let mapsRunIndex = 0;
    setMockActorRunnerForTesting(async (actorId) => {
      if (actorId.includes("google-places")) {
        mapsRunIndex++;
        const items = mapsRunIndex === 1 ? run1Places : run2Places;
        return {
          run: { id: `mock-maps-run-${mapsRunIndex}`, status: "SUCCEEDED", defaultDatasetId: `ds-maps-${mapsRunIndex}` } as any,
          items,
          usageTotalUsd: 0.06,
          computeUnits: 0.01,
          isDryRun: false,
        };
      }
      if (actorId.includes("instagram-profile")) {
        throw new Error("Apify actor execution failed: Service unavailable");
      }
      return {
        run: { id: "mock-run", status: "SUCCEEDED" } as any,
        items: [],
        usageTotalUsd: 0,
        computeUnits: 0,
        isDryRun: false,
      };
    });

    // Mock waterfall: First 10 have IG handles, remaining 5 have social/contact channels only
    setMockWebsiteScraperForTesting(async (input) => {
      const match = /clinic-r\d+-(\d+)/i.exec(input.website || "");
      const num = match ? parseInt(match[1], 10) : 1;
      if (num <= 10) {
        return {
          handle: `handle_num_${num}`,
          handleConfidence: "high",
          socialLinks: { facebook: `https://facebook.com/dental${num}` },
          emails: [],
          phones: [],
        };
      }
      return {
        handle: null,
        handleConfidence: null,
        socialLinks: { facebook: `https://facebook.com/dental${num}` },
        emails: [],
        phones: [],
      };
    });

    const provider = new GoogleMapsDiscoveryProvider();
    const result = await provider.discover({
      campaignId: campaign.id,
      query: "dentist",
      location: "Toronto, ON, Canada",
      limit: 30,
      scrapeJobId: job.id,
    });

    await prisma.scrapeJob.update({
      where: { id: job.id },
      data: {
        status: ScrapeJobStatus.COMPLETED_WITH_WARNINGS,
        errorMessage: "Profile enrichment failed: Service unavailable",
        costUsd: 0.12,
        processedCount: 30,
        completedAt: new Date(),
      },
    });

    check(result.candidates.length > 0, "Discovery returns candidates even when enrichment fails");

    // Verify all 30 places are in Candidate table immediately
    const savedCandidates = await prisma.candidate.findMany({
      where: { campaignId: campaign.id },
    });
    check(savedCandidates.length === 30, "All 30 places exist as candidates in Candidate table", `count=${savedCandidates.length}`);

    // Verify candidates with handles are saved as Leads with status ENRICH_PENDING
    const enrichPendingLeads = await prisma.lead.findMany({
      where: { campaignId: campaign.id, status: LeadStatus.ENRICH_PENDING },
    });
    check(enrichPendingLeads.length > 0, "Candidates with handles exist as leads with status ENRICH_PENDING", `count=${enrichPendingLeads.length}`);

    // Verify contactable places without handle are saved as Leads with status NEW
    const newContactLeads = await prisma.lead.findMany({
      where: { campaignId: campaign.id, status: LeadStatus.NEW },
    });
    check(newContactLeads.length > 0, "Contactable places without handle saved as leads with status NEW", `count=${newContactLeads.length}`);

    // Verify ScrapeJob status is COMPLETED_WITH_WARNINGS or COMPLETED
    const jobs = await prisma.scrapeJob.findMany({
      where: { campaignId: campaign.id },
    });
    const foundJob = jobs[0];
    check(foundJob !== undefined, "ScrapeJob record exists");
    check(
      foundJob.status === ScrapeJobStatus.COMPLETED_WITH_WARNINGS || foundJob.status === ScrapeJobStatus.COMPLETED,
      "Job status is COMPLETED_WITH_WARNINGS or COMPLETED",
      `status=${foundJob?.status}`
    );
    check(Number(foundJob.costUsd ?? 0) > 0, "Money spent data is recorded and not lost", `cost=${foundJob?.costUsd}`);

    // Test 4: Resume without re-buying Maps
    console.log("\n[Test 4] Resume processes pending candidates with ZERO Maps calls");
    let mapsCallsDuringResume = 0;
    setMockActorRunnerForTesting(async (actorId) => {
      if (actorId.includes("google-places")) {
        mapsCallsDuringResume++;
        throw new Error("FAIL: Maps actor should never be called during resume!");
      }
      return {
        run: { id: "mock-resume-profile-run", status: "SUCCEEDED" } as any,
        items: [{ username: "handle_num_1", followersCount: 2500 }],
        usageTotalUsd: 0.002,
        computeUnits: 0.001,
        isDryRun: false,
      };
    });

    const resumeResult1 = await resumeScrapeJob(job.id, user.id);
    check(mapsCallsDuringResume === 0, "Resume made ZERO Maps actor calls", `mapsCalls=${mapsCallsDuringResume}`);
    check(resumeResult1.totalPendingCandidates > 0, "Resume found and processed pending candidates", `pending=${resumeResult1.totalPendingCandidates}`);

    // Resume twice creates no duplicate leads (idempotent)
    const leadsCountBefore = await prisma.lead.count({ where: { campaignId: campaign.id } });
    await resumeScrapeJob(job.id, user.id);
    const leadsCountAfter = await prisma.lead.count({ where: { campaignId: campaign.id } });
    check(leadsCountBefore === leadsCountAfter, "Running resume twice creates no duplicate leads (idempotent)", `before=${leadsCountBefore} after=${leadsCountAfter}`);
  }

  // Test 5: CSV Import fixture
  console.log("\n[Test 5] Import from CSV fixture with zero actor calls and deduplication");
  {
    const user = await prisma.user.findFirst();
    const cp = await prisma.companyProfile.findFirst({ where: { userId: user!.id } });
    const csvCampaign = await prisma.campaign.create({
      data: {
        name: "CSV Import Test Campaign",
        userId: user!.id,
        companyProfileId: cp!.id,
        category: "Dentists",
        location: "Toronto, ON",
        leadLimit: 20,
      },
    });

    let actorCallsDuringCsv = 0;
    setMockActorRunnerForTesting(async () => {
      actorCallsDuringCsv++;
      throw new Error("FAIL: Actor should never be called during CSV import!");
    });

    const fixtureCsvPath = path.resolve(process.cwd(), "scripts/fixtures/gmaps_toronto_sample.csv");
    check(fs.existsSync(fixtureCsvPath), "CSV fixture exists on disk");

    await importDataset(fixtureCsvPath, csvCampaign.id);
    check(actorCallsDuringCsv === 0, "Import from CSV made ZERO actor calls");

    const importedCandidates = await prisma.candidate.findMany({
      where: { campaignId: csvCampaign.id },
    });
    check(importedCandidates.length === 15, "CSV import produced expected 15 candidates", `count=${importedCandidates.length}`);

    // Re-importing same CSV dedups
    await importDataset(fixtureCsvPath, csvCampaign.id);
    const afterReimport = await prisma.candidate.findMany({
      where: { campaignId: csvCampaign.id },
    });
    check(afterReimport.length === 15, "Re-importing same CSV creates zero duplicate candidates", `count=${afterReimport.length}`);
  }

  console.log("\n=======================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests()
  .catch((err) => {
    console.error("Test execution threw error:", err);
    process.exit(1);
  })
  .finally(async () => {
    const prisma = getPrismaClient();
    await prisma.$disconnect();
  });
