/**
 * Deterministic fixture-based tests for Google Maps Toronto/GTA discovery pipeline.
 *
 * Covers:
 * 1. 14 of 15 places saved (as IG-ready or contact-only) and Toronto Public Health Dental Clinic
 *    rejected as NON_TARGET_ENTITY; no place rejected for missing city.
 * 2. Unit tests:
 *    - city null with state "Ontario" and Scarborough street/postal code accepted
 *    - same record with state "Alabama" or country "US" rejected
 *    - coordinates outside the radius rejected
 *    - "ON" vs "Ontario" equivalence
 *    - Markham accepted for a Toronto/GTA campaign when GTA region is enabled and rejected when campaign is strict "Toronto only"
 *    - null rating still passes free rules and scoring
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl } = require("./test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || "mock-apify-test-token";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import {
  derivePlaceLocation,
  normalizeState,
  areStatesEqual,
} from "../src/lib/services/discovery/country-cities";
import { GoogleMapsDiscoveryProvider } from "../src/lib/services/discovery/google-maps-discovery-provider";
import { setMockActorRunnerForTesting } from "../src/lib/services/scraper/apify-cost-guard";
import { setMockWaterfallRunnerForTesting } from "../src/lib/services/discovery/handle-discovery-waterfall";
import { freeRulesStage } from "../src/lib/services/discovery/pipeline/stages/free-rules";
import { handleDiscoveryStage } from "../src/lib/services/discovery/pipeline/stages/handle-discovery";
import { computeLeadScore } from "../src/lib/services/discovery/lead-quality-score";
import type { PipelineStageContext } from "../src/lib/services/discovery/pipeline/types";

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
  console.log("\n=== 1. Unit Tests: State Normalization & Equivalence ===");
  check(normalizeState("Ontario") === "ON", 'normalizeState("Ontario") -> ON');
  check(normalizeState("ON") === "ON", 'normalizeState("ON") -> ON');
  check(normalizeState("ontario") === "ON", 'normalizeState("ontario") -> ON');
  check(areStatesEqual("Ontario", "ON"), '"ON" vs "Ontario" equivalence');
  check(areStatesEqual("on", "Ontario"), '"on" vs "Ontario" case-insensitive equivalence');
  check(normalizeState("Alabama") === "AL", 'normalizeState("Alabama") -> AL');
  check(!areStatesEqual("Ontario", "Alabama"), 'Ontario is not equal to Alabama');

  console.log("\n=== 2. Unit Tests: Missing City Location Derivation ===");
  const scarboroughItem = {
    city: null,
    neighborhood: "Woburn",
    postalCode: "M1H 3B7",
    street: "2100 Ellesmere Rd #204",
    state: "Ontario",
    countryCode: "CA",
    location: { lat: 43.7745, lng: -79.2398 },
  };

  const derivedScarb = derivePlaceLocation(scarboroughItem, "Toronto", "Toronto");
  check(!derivedScarb.isExplicitMismatch, "Scarborough record with city=null is accepted");
  check(derivedScarb.city === "Scarborough", `Derived city is "Scarborough", got "${derivedScarb.city}"`);
  check(derivedScarb.locationConfidence === "high", "Location confidence is high from postal code/neighborhood");

  console.log("\n=== 3. Unit Tests: Explicit Mismatches (Wrong State / Country) ===");
  const wrongStateItem = {
    ...scarboroughItem,
    state: "Alabama",
  };
  const derivedWrongState = derivePlaceLocation(wrongStateItem, "Toronto", "Toronto");
  check(derivedWrongState.isExplicitMismatch, "Record with state 'Alabama' is rejected as explicit mismatch");

  const wrongCountryItem = {
    ...scarboroughItem,
    countryCode: "US",
  };
  const derivedWrongCountry = derivePlaceLocation(wrongCountryItem, "Toronto", "Toronto");
  check(derivedWrongCountry.isExplicitMismatch, "Record with country 'US' is rejected as explicit mismatch");

  console.log("\n=== 4. Unit Tests: Coordinates Outside Radius ===");
  const farCoordsItem = {
    ...scarboroughItem,
    // Montreal coordinates (~500 km away)
    location: { lat: 45.5017, lng: -73.5673 },
  };
  const derivedFarCoords = derivePlaceLocation(farCoordsItem, "Toronto", "Toronto", { radiusKm: 60 });
  check(derivedFarCoords.isExplicitMismatch, "Record with coordinates outside 60 km radius is rejected");

  console.log("\n=== 5. Unit Tests: Markham with GTA Enabled vs Strict Toronto Only ===");
  const markhamItem = {
    city: "Markham",
    state: "ON",
    countryCode: "CA",
    street: "1200 Markham Rd",
    location: { lat: 43.8561, lng: -79.337 },
  };

  const markhamGta = derivePlaceLocation(markhamItem, "Toronto", "Toronto/GTA", { gtaEnabled: true });
  check(!markhamGta.isExplicitMismatch, "Markham accepted when GTA region is enabled (Toronto/GTA)");

  const markhamStrict = derivePlaceLocation(markhamItem, "Toronto", "Toronto", { strictCityOnly: true, gtaEnabled: false });
  check(markhamStrict.isExplicitMismatch, "Markham rejected when campaign is strict 'Toronto only'");

  console.log("\n=== 6. Unit Tests: Null Rating and Reviews Pass Free Rules & Quality Score ===");
  const nullRatingCandidate = {
    fullName: "Gentle Dental Clinic",
    rating: null,
    reviewCount: null,
    city: "Toronto",
    website: "https://gentledental.ca",
    phone: "+1-416-555-0101",
    availableChannels: ["WEBSITE", "PHONE"],
  };

  const dummyContext: PipelineStageContext = {
    campaign: {
      id: "cmp_test",
      userId: "usr_test",
      intent: "Dentist",
      location: "Toronto",
      category: "Dentist",
      minRating: 4.0,
      minReviews: 10,
      excludeChains: true,
      companyProfile: null,
    },
    jobId: "job_test",
    userId: "usr_test",
    requestedLimit: 10,
    existingLeadCount: 0,
    remainingCapacity: 10,
    criteria: {} as any,
    caches: {
      seenCandidates: new Set<string>(),
      existingUsernames: new Set<string>(),
      existingPlaceIds: new Set<string>(),
      existingDomains: new Set<string>(),
      existingPhones: new Set<string>(),
    },
  };

  const freeResult = await freeRulesStage({ candidates: [nullRatingCandidate] }, dummyContext);
  check(freeResult.survivors.length === 1, "Null rating candidate passes free rules stage");

  const scoreResult = computeLeadScore({
    rating: null,
    reviewCount: null,
    website: "https://gentledental.ca",
    phone: "+1-416-555-0101",
    hasInstagram: false,
    availableChannels: ["WEBSITE", "PHONE"],
  });
  check(scoreResult.score >= 30, `Null rating with website/phone scores ${scoreResult.score} >= 30`);
  check(scoreResult.tier !== "D", `Tier is ${scoreResult.tier} (not D)`);

  console.log("\n=== 7. Fixture Test: 14/15 Places Saved & Toronto Public Health Rejected ===");
  const fixturePath = path.resolve(__dirname, "fixtures/gmaps_toronto_sample.json");
  const fixtureItems: any[] = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  check(fixtureItems.length === 15, "Fixture contains exactly 15 items");

  setMockActorRunnerForTesting(async () => ({
    run: { id: "test-run", defaultDatasetId: "test-ds" } as any,
    items: fixtureItems,
    usageTotalUsd: 0,
    computeUnits: 0,
    isDryRun: true,
  }));

  setMockWaterfallRunnerForTesting(async (input) => {
    // Provide mocked handle for 2 places to test handle waterfall routing, others contact-only
    if (input.businessName?.includes("Ellesmere Dental") || input.businessName?.includes("Midland Dental")) {
      return {
        handle: input.businessName.toLowerCase().replace(/[^a-z0-9]/g, ""),
        handleSource: "homepage",
        handleConfidence: "high",
        stepsAttempted: ["maps", "homepage"],
        candidates: [],
        socialLinks: {},
      };
    }
    return {
      handle: null,
      handleSource: null,
      handleConfidence: null,
      stepsAttempted: ["maps"],
      candidates: [],
      socialLinks: {},
    };
  });

  const testId = `test_run_${Date.now()}`;
  const provider = new GoogleMapsDiscoveryProvider();
  const discovery = await provider.discover({
    query: "Dentist",
    location: "Toronto/Scarborough",
    category: "Dentist",
    limit: 20,
    campaignId: testId,
    userId: testId,
    isDryRun: true,
  });

  check(discovery.candidates.length === 15, `Discovery yielded 15 raw candidates, got ${discovery.candidates.length}`);

  // Run through freeRulesStage
  const stageContext: PipelineStageContext = {
    campaign: {
      id: testId,
      userId: testId,
      intent: "Dentist",
      location: "Toronto/Scarborough",
      category: "Dentist",
      minRating: 4.0,
      minReviews: 10,
      excludeChains: true,
      companyProfile: null,
    },
    jobId: `job_${testId}`,
    userId: testId,
    requestedLimit: 20,
    existingLeadCount: 0,
    remainingCapacity: 20,
    criteria: {} as any,
    caches: {
      seenCandidates: new Set<string>(),
      existingUsernames: new Set<string>(),
      existingPlaceIds: new Set<string>(),
      existingDomains: new Set<string>(),
      existingPhones: new Set<string>(),
    },
  };

  const freeStageResult = await freeRulesStage({ candidates: discovery.candidates }, stageContext);
  check(freeStageResult.survivors.length === 14, `14 of 15 survived freeRules, got ${freeStageResult.survivors.length}`);

  const publicHealthRejection = freeStageResult.rejected.find((r) =>
    r.id?.includes("Toronto Public Health Dental Clinic")
  );
  check(Boolean(publicHealthRejection), "Toronto Public Health Dental Clinic was rejected");
  check(publicHealthRejection?.reason === "NON_TARGET_ENTITY", `Rejection reason is NON_TARGET_ENTITY, got "${publicHealthRejection?.reason}"`);

  // Run through handleDiscoveryStage
  const handleStageResult = await handleDiscoveryStage({ candidates: freeStageResult.survivors }, stageContext);
  const routing = handleStageResult.survivors[0];
  const totalSaved = routing.igCandidates.length + routing.multiChannelCandidates.length;
  check(totalSaved === 14, `Total saved places is 14 (IG: ${routing.igCandidates.length}, Contact-only: ${routing.multiChannelCandidates.length})`);

  // Check that all saved places have derived city (none have null city)
  const allSaved = [...routing.igCandidates, ...routing.multiChannelCandidates];
  const nullCityCount = allSaved.filter((c) => !c.city && !c.gmapsCity).length;
  check(nullCityCount === 0, `No place rejected or saved with missing city (null city count = ${nullCityCount})`);

  console.log(`\nPASSED: ${passed} | FAILED: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
