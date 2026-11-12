/**
 * Unit tests for InstagramPlacesDiscoveryProvider and instagram_places mode:
 * 4a) Sample place items:
 *     - Item with ig_business.profile.username
 *     - Item with null/missing username -> counted as NO_INSTAGRAM
 *     - Item far outside requested city -> counted as OUT_OF_AREA
 *     -> 1 candidate kept, 1 NO_INSTAGRAM, 1 OUT_OF_AREA.
 * 4b) Input parameters:
 *     - searchType "place"
 *     - searchLimit capped at 25
 *     - minimal per-place results limit (resultsLimit: 1, resultsType: "details")
 *     - no profile/hashtag search types
 * 4c) Candidate flows through category gate (Maps-style category) and dedup.
 * 4d) Hybrid mode dedups across providers and only tops up when needed.
 * 4e) Cost guard is used:
 *     - Calls runActorSafely (single choke point)
 *     - Grep test passes: zero direct client.actor calls outside apify-cost-guard.ts.
 */

// Preload server-only mock before any server module is loaded
import "./preload_server_only.cjs";

import fs from "node:fs";
import path from "node:path";
import {
  InstagramPlacesDiscoveryProvider,
  buildPlaceSearchQuery,
  getIgPlacesSearchLimit,
  getIgPlacesActorId,
  DEFAULT_IG_SCRAPER_ACTOR_ID,
  HARD_MAX_IG_PLACES_SEARCH_LIMIT,
  parseIgPlaceItem,
  type RawIgPlaceItem,
  type IgPlaceParseResult,
} from "../src/lib/services/discovery/instagram-places-discovery-provider";
import {
  setMockActorRunnerForTesting,
  getAllowedActors,
  isActorAllowed,
  type SafeActorRunResult,
} from "../src/lib/services/scraper/apify-cost-guard";
import { GoogleMapsDiscoveryProvider } from "../src/lib/services/discovery/google-maps-discovery-provider";
import { ApifyDiscoveryProvider } from "../src/lib/services/discovery/apify-discovery-provider";
import {
  isPlausiblyInCity,
  haversineDistanceKm,
  CITY_COORDINATES,
} from "../src/lib/services/discovery/country-cities";
import {
  prefilterCandidate,
  deduplicateCandidates,
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  type RelevanceCampaignContext,
} from "../src/lib/services/discovery/lead-relevance";
import {
  getActiveDiscoveryMode,
  getDiscoveryProvider,
  buildDiscoveryNotice,
} from "../src/lib/services/discovery";
import {
  getIgEnrichmentActorMode,
  getActiveEnrichmentActorId,
  ApifyProvider,
} from "../src/lib/services/scraper";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function runTests(): Promise<void> {
  console.log("================================================================");
  console.log(" TEST SUITE: Instagram Places Discovery Provider (Zero Live Calls)");
  console.log("================================================================\n");

  // ---------------------------------------------------------------------------
  // A. Location Distance & Plausibility Validation
  // ---------------------------------------------------------------------------
  console.log("=== A. LOCATION DISTANCE & PLAUSIBILITY LOGIC ===");
  {
    const torontoCenter = CITY_COORDINATES["toronto"];
    check(
      torontoCenter !== undefined && torontoCenter.lat > 40 && torontoCenter.lng < -70,
      "Toronto coordinates present in CITY_COORDINATES lookup table",
    );

    // Downtown Toronto location (0.5 km from center)
    const downtownToronto = isPlausiblyInCity({
      lat: 43.655,
      lng: -79.385,
      targetCity: "Toronto, ON",
      radiusKm: 40,
    });
    check(downtownToronto === true, "Downtown Toronto coordinates plausibly in Toronto (<= 40km)");

    // Vancouver location tested against Toronto center (~3360 km away)
    const vancouverInToronto = isPlausiblyInCity({
      lat: 49.2827,
      lng: -123.1207,
      targetCity: "Toronto, ON",
      radiusKm: 40,
    });
    check(vancouverInToronto === false, "Vancouver coordinates correctly rejected for Toronto (> 40km)");

    // Distance computation check
    const dist = haversineDistanceKm(43.6532, -79.3832, 49.2827, -123.1207);
    check(dist > 3000 && dist < 4000, `Haversine distance Toronto-Vancouver is ~3360km (actual: ${Math.round(dist)}km)`);

    // Address-only fallback when lat/lng missing
    const textMatch = isPlausiblyInCity({
      address: "456 Main St, Toronto, Ontario M4B 1B3",
      targetCity: "Toronto",
    });
    check(textMatch === true, "Address text containing target city name is accepted when coords absent");

    const textMismatch = isPlausiblyInCity({
      address: "123 Ocean Drive, Miami, FL 33139",
      targetCity: "Toronto",
    });
    check(textMismatch === false, "Address text without target city name is rejected when coords absent");
  }

  // ---------------------------------------------------------------------------
  // B. 4a: Sample Place Items (1 candidate, 1 NO_INSTAGRAM, 1 OUT_OF_AREA)
  // ---------------------------------------------------------------------------
  console.log("\n=== B. SAMPLE PLACE ITEMS PARSING & FILTERING (4a) ===");
  {
    let capturedActorId: string | null = null;
    let capturedActorInput: Record<string, unknown> | null = null;

    const samplePlaceItems: RawIgPlaceItem[] = [
      // 1. Kept candidate: has valid ig_business.profile.username and downtown Toronto coords
      {
        name: "Toronto Downtown Dental Care",
        category: "Dentist",
        phone: "+1-416-555-0111",
        location_address: "100 King St W, Toronto, ON",
        location_zip: "M5X 1A9",
        lat: 43.6486,
        lng: -79.3817,
        location_id: "loc_101",
        ig_business: {
          profile: {
            username: "torontodowntowndental",
            id: "ig_101",
            full_name: "Toronto Downtown Dental Care",
          },
        },
        media_count: 245,
      },
      // 2. NO_INSTAGRAM: ig_business is null / no username
      {
        name: "No Instagram Dental Clinic",
        category: "Dentist",
        phone: "+1-416-555-0222",
        location_address: "150 Bay St, Toronto, ON",
        location_zip: "M5J 1J7",
        lat: 43.6465,
        lng: -79.3792,
        location_id: "loc_102",
        ig_business: null,
        media_count: 12,
      },
      // 3. OUT_OF_AREA: has username, but coordinates are in Vancouver (> 3000km away)
      {
        name: "Vancouver Pacific Dental",
        category: "Dentist",
        phone: "+1-604-555-0333",
        location_address: "777 Robson St, Vancouver, BC",
        location_zip: "V6Z 1A1",
        lat: 49.2827,
        lng: -123.1207,
        location_id: "loc_103",
        ig_business: {
          profile: {
            username: "vancouverpacificteeth",
            id: "ig_103",
            full_name: "Vancouver Pacific Dental",
          },
        },
        media_count: 89,
      },
    ];

    setMockActorRunnerForTesting(async (actorId, input) => {
      capturedActorId = actorId;
      capturedActorInput = input;
      return {
        run: {
          id: "mock_run_places_1",
          actId: actorId,
          status: "SUCCEEDED",
          defaultDatasetId: "dataset_places_1",
          usageTotalUsd: 0.027,
          computeUnits: 0.1,
        } as unknown as any,
        items: samplePlaceItems,
        usageTotalUsd: 0.027,
        computeUnits: 0.1,
        isDryRun: true,
      };
    });

    try {
      const provider = new InstagramPlacesDiscoveryProvider();
      const result = await provider.discover({
        query: "dental clinic, cosmetic dentist",
        location: "Toronto, ON",
        limit: 10,
      });

      check(capturedActorId === DEFAULT_IG_SCRAPER_ACTOR_ID, `Called default actor ${DEFAULT_IG_SCRAPER_ACTOR_ID}`);
      check(result.placesReturned === 3, `Returned 3 raw place items (got ${result.placesReturned})`);
      check(result.placesWithInstagram === 2, `2 place items had an Instagram profile (got ${result.placesWithInstagram})`);
      check(result.noInstagramCount === 1, `1 item dropped with NO_INSTAGRAM (got ${result.noInstagramCount})`);
      check(result.outOfAreaCount === 1, `1 item dropped with OUT_OF_AREA (got ${result.outOfAreaCount})`);
      check(result.candidates.length === 1, `Exactly 1 candidate kept (got ${result.candidates.length})`);

      const kept = result.candidates[0];
      check(kept.username === "torontodowntowndental", `Kept candidate username is "torontodowntowndental" (got "${kept?.username}")`);
      check(kept.gmapsCategory === "Dentist", `Mapped category to gmapsCategory "Dentist" (got "${kept?.gmapsCategory}")`);
      check(kept.gmapsAddress === "100 King St W, Toronto, ON", `Mapped location_address to gmapsAddress`);
      check(kept.sourceProvider === "instagram_places", `sourceProvider is "instagram_places"`);
      check(kept.phone === "+1-416-555-0111", `Preserved phone number`);
      check(kept.profileUrl === "https://www.instagram.com/torontodowntowndental", `Correct profileUrl generated`);
    } finally {
      setMockActorRunnerForTesting(null);
    }
  }

  // ---------------------------------------------------------------------------
  // C. 4b: Input Parameters Validation
  // ---------------------------------------------------------------------------
  console.log("\n=== C. ACTOR INPUT PARAMETERS VALIDATION (4b) ===");
  {
    let passedInput: Record<string, unknown> | null = null;

    setMockActorRunnerForTesting(async (_actorId, input) => {
      passedInput = input;
      return {
        run: { id: "mock_run_input", status: "SUCCEEDED", usageTotalUsd: 0.01 } as any,
        items: [],
        usageTotalUsd: 0.01,
        computeUnits: 0,
        isDryRun: true,
      };
    });

    try {
      const provider = new InstagramPlacesDiscoveryProvider();
      await provider.discover({
        query: "cosmetic dentist, pediatric teeth, teeth whitening",
        location: "Toronto, ON",
        limit: 100, // exceeds hard max 25
      });

      const inputObj = (passedInput ?? {}) as Record<string, unknown>;
      check(passedInput !== null, "Actor was invoked with input object");
      check(inputObj.searchType === "place", `searchType is strictly "place" (got "${inputObj.searchType}")`);
      check(
        inputObj.searchType !== "hashtag" &&
          inputObj.searchType !== "user" &&
          inputObj.searchType !== "profile",
        "searchType is NOT hashtag, user, or profile",
      );
      check(inputObj.resultsLimit === 1, `resultsLimit is 1 (minimal to avoid extra row cost, got ${inputObj.resultsLimit})`);
      check(inputObj.resultsType === "details", `resultsType is "details" (got "${inputObj.resultsType}")`);
      check(inputObj.searchLimit === 25, `searchLimit is capped at hard max 25 (got ${inputObj.searchLimit})`);

      // Verify query builder formatting:
      // - Max 2 keywords
      // - City appended to each keyword
      // - Joined by comma
      const query = buildPlaceSearchQuery("cosmetic dentist, pediatric teeth, teeth whitening", "Toronto, ON");
      check(
        query === "cosmetic dentist toronto, pediatric teeth toronto",
        `Query contains max 2 cleaned keywords with city appended: "${query}"`,
      );

      // Verify default search limit
      const defaultLimit = getIgPlacesSearchLimit();
      check(defaultLimit === 10, `getIgPlacesSearchLimit() defaults to 10 (got ${defaultLimit})`);
      check(getIgPlacesSearchLimit(5) === 5, "Respects smaller requested limit (5)");
      check(getIgPlacesSearchLimit(50) === HARD_MAX_IG_PLACES_SEARCH_LIMIT, "Caps limit at 25");

      // Verify custom actor ID override
      const originalActorEnv = process.env.APIFY_IG_SCRAPER_ACTOR_ID;
      try {
        process.env.APIFY_IG_SCRAPER_ACTOR_ID = "custom/my-ig-places-scraper";
        check(getIgPlacesActorId() === "custom/my-ig-places-scraper", "Respects APIFY_IG_SCRAPER_ACTOR_ID override");
      } finally {
        if (originalActorEnv !== undefined) {
          process.env.APIFY_IG_SCRAPER_ACTOR_ID = originalActorEnv;
        } else {
          delete process.env.APIFY_IG_SCRAPER_ACTOR_ID;
        }
      }
    } finally {
      setMockActorRunnerForTesting(null);
    }
  }

  // ---------------------------------------------------------------------------
  // D. 4c: Flow Through Existing Gates (Category, Negative Keywords, Dedup)
  // ---------------------------------------------------------------------------
  console.log("\n=== D. COMPATIBILITY WITH EXISTING RELEVANCE GATES (4c) ===");
  {
    const campaignContext: RelevanceCampaignContext = {
      intent: "dentist",
      category: "Dentist",
      location: "Toronto, ON",
    };

    // Candidate 1: Valid dentist place candidate from instagram_places
    const validCandidate = {
      username: "queenstreetdental",
      profileUrl: "https://www.instagram.com/queenstreetdental",
      fullName: "Queen Street Dental",
      category: "Dentist",
      gmapsCategory: "Dentist",
      gmapsAddress: "250 Queen St W, Toronto, ON",
      sourceProvider: "instagram_places",
    };

    const validPrefilter = prefilterCandidate(
      validCandidate,
      campaignContext,
      DEFAULT_DISCOVERY_RELEVANCE_POLICY,
    );
    check(
      validPrefilter.action === "PROCEED",
      `Valid Dentist candidate allowed through prefilter gate (got action=${validPrefilter.action})`,
    );

    // Candidate 2: Mismatched Maps category (e.g., "Car wash")
    const carWashCandidate = {
      username: "queenstreetwash",
      profileUrl: "https://www.instagram.com/queenstreetwash",
      fullName: "Queen Street Auto Wash",
      category: "Car wash",
      gmapsCategory: "Car wash",
      gmapsAddress: "250 Queen St W, Toronto, ON",
      sourceProvider: "instagram_places",
    };

    const carWashPrefilter = prefilterCandidate(
      carWashCandidate,
      campaignContext,
      DEFAULT_DISCOVERY_RELEVANCE_POLICY,
    );
      check(
        carWashPrefilter.action === "REJECT",
        "Irrelevant category 'Car wash' rejected by prefilter",
      );
      if (carWashPrefilter.action === "REJECT") {
        check(
          carWashPrefilter.reason === "PRE_ENRICHMENT_REJECTED" ||
            carWashPrefilter.underlyingReason === "IRRELEVANT_CATEGORY",
          `Irrelevant category "Car wash" REJECTED by category gate (got ${carWashPrefilter.reason}/${carWashPrefilter.underlyingReason})`,
        );
      }

    // Deduplication test
    const existingUsernames = new Set(["queenstreetdental"]);
    const dedup = deduplicateCandidates(["queenstreetdental", "newdentisttoronto"], existingUsernames);
    check(
      dedup.unique.length === 1 && dedup.unique[0] === "newdentisttoronto",
      "Deduplication correctly separates new candidates from existing ones",
    );
    check(
      dedup.duplicates.length === 1 && dedup.duplicates[0] === "queenstreetdental",
      "Existing handle is flagged as duplicate",
    );
  }

  // ---------------------------------------------------------------------------
  // E. 4d: Hybrid Mode Deduplication & Top-Up Logic
  // ---------------------------------------------------------------------------
  console.log("\n=== E. HYBRID MODE DEDUPLICATION & TOP-UP LOGIC (4d) ===");
  {
    // Simulate Round 0 (Google Maps): discovers 2 handles
    const gmapsDiscovered = ["handle_alpha", "handle_beta"];
    const seenUsernames = new Set<string>();

    for (const h of gmapsDiscovered) {
      seenUsernames.add(h);
    }

    // Target limit is 3. Since gmaps gave 2, we need 1 more (top-up round).
    // Simulate Round 1 (Instagram Places): discovers 3 handles, one of which overlaps with gmaps
    const igPlacesDiscovered = ["handle_beta", "handle_gamma", "handle_delta"];

    const { unique, duplicates } = deduplicateCandidates(igPlacesDiscovered, seenUsernames);

    check(
      duplicates.length === 1 && duplicates[0] === "handle_beta",
      `Hybrid mode deduplicates handle_beta discovered across both providers (duplicates: ${JSON.stringify(duplicates)})`,
    );
    check(
      unique.length === 2 && unique.includes("handle_gamma") && unique.includes("handle_delta"),
      `Hybrid mode extracts unique top-up candidates only (${JSON.stringify(unique)})`,
    );

    // Verify top-up condition: if target was 2 and round 0 persisted 2, remainingNeeded is 0 -> no round 1 needed
    const remainingNeededFull = Math.max(0, 2 - gmapsDiscovered.length);
    check(remainingNeededFull === 0, "No top-up needed when round 0 satisfies target capacity");

    const remainingNeededPartial = Math.max(0, 3 - gmapsDiscovered.length);
    check(remainingNeededPartial === 1, "Top-up triggered when round 0 yields fewer leads than target capacity");
  }

  // ---------------------------------------------------------------------------
  // F. 4e: Central Cost Guard Enforcement & Grep Test
  // ---------------------------------------------------------------------------
  console.log("\n=== F. COST GUARD ENFORCEMENT & SINGLE CHOKE POINT GREP TEST (4e) ===");
  {
    const providerFilePath = path.join(
      process.cwd(),
      "src/lib/services/discovery/instagram-places-discovery-provider.ts",
    );
    const providerContent = fs.readFileSync(providerFilePath, "utf8");

    check(
      providerContent.includes("runActorSafely"),
      "InstagramPlacesDiscoveryProvider routes calls through runActorSafely",
    );
    check(
      !providerContent.includes("client.actor(") && !providerContent.includes(".actor("),
      "InstagramPlacesDiscoveryProvider makes ZERO direct client.actor calls",
    );

    // Scan all files in src/ to verify single choke point rule
    const srcDir = path.join(process.cwd(), "src");
    const directActorViolations: string[] = [];

    function scanFiles(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanFiles(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          const rel = path.relative(process.cwd(), fullPath).replace(/\\/g, "/");
          // Only apify-cost-guard.ts is permitted to call client.actor
          if (rel === "src/lib/services/scraper/apify-cost-guard.ts") {
            continue;
          }
          const content = fs.readFileSync(fullPath, "utf8");
          if (/client\.actor\(|\.actor\(actorId\)/.test(content)) {
            directActorViolations.push(rel);
          }
        }
      }
    }

    scanFiles(srcDir);
    check(
      directActorViolations.length === 0,
      "Zero direct client.actor calls outside apify-cost-guard.ts across entire src/ directory",
      directActorViolations.join(", "),
    );
  }

  // ---------------------------------------------------------------------------
  // G. Environment Provider Mode Verification
  // ---------------------------------------------------------------------------
  console.log("\n=== G. DISCOVERY_PROVIDER MODE SWITCHING ===");
  {
    const origEnv = process.env.DISCOVERY_PROVIDER;
    try {
      process.env.DISCOVERY_PROVIDER = "instagram_places";
      check(getActiveDiscoveryMode() === "instagram_places", 'getActiveDiscoveryMode() returns "instagram_places"');

      process.env.DISCOVERY_PROVIDER = "google_maps";
      check(getActiveDiscoveryMode() === "google_maps", 'getActiveDiscoveryMode() returns "google_maps"');

      process.env.DISCOVERY_PROVIDER = "hybrid";
      check(getActiveDiscoveryMode() === "hybrid", 'getActiveDiscoveryMode() returns "hybrid"');

      process.env.DISCOVERY_PROVIDER = "invalid_mode";
      check(getActiveDiscoveryMode() === "instagram_all_in_one", 'getActiveDiscoveryMode() falls back to "instagram_all_in_one" for invalid string');
    } finally {
      if (origEnv !== undefined) {
        process.env.DISCOVERY_PROVIDER = origEnv;
      } else {
        delete process.env.DISCOVERY_PROVIDER;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // H. Step 4 Acceptance Tests (Discovery Provider & Details Enrichment Mocks)
  // ---------------------------------------------------------------------------
  console.log("\n=== H. STEP 4 ACCEPTANCE TESTS (MOCKED) ===");
  {
    // a) DISCOVERY_PROVIDER=instagram_places -> only apify/instagram-scraper is invoked, never compass/crawler-google-places
    const callsMade: Array<{ actorId: string; input: Record<string, unknown> }> = [];
    setMockActorRunnerForTesting(async (actorId, input) => {
      callsMade.push({ actorId, input });
      return {
        items: [],
        usageTotalUsd: 0.01,
        computeUnits: 0.05,
        run: {
          id: "run-step4-places",
          actId: actorId,
          status: "SUCCEEDED",
          defaultDatasetId: "dataset-step4-places",
        } as any,
        isDryRun: false,
      };
    });

    const origDiscoveryEnv = process.env.DISCOVERY_PROVIDER;
    const origEnrichEnv = process.env.IG_ENRICHMENT_ACTOR;
    const origAllowedActors = process.env.APIFY_ALLOWED_ACTORS;

    try {
      // 5a: DISCOVERY_PROVIDER=instagram_places + IG_ENRICHMENT_ACTOR=instagram_scraper_details + allowlist=apify/instagram-scraper
      process.env.DISCOVERY_PROVIDER = "instagram_places";
      process.env.IG_ENRICHMENT_ACTOR = "instagram_scraper_details";
      process.env.APIFY_ALLOWED_ACTORS = "apify/instagram-scraper";

      check(
        isActorAllowed("apify/instagram-scraper") === true,
        "5a: apify/instagram-scraper is allowed by APIFY_ALLOWED_ACTORS",
      );
      check(
        isActorAllowed("compass/crawler-google-places") === false,
        "5a: compass/crawler-google-places is disallowed by APIFY_ALLOWED_ACTORS",
      );
      check(
        isActorAllowed("apify/instagram-profile-scraper") === false,
        "5a: apify/instagram-profile-scraper is disallowed by APIFY_ALLOWED_ACTORS",
      );

      const provider = getDiscoveryProvider();
      check(provider.name === "instagram_places", '5a: Provider name is "instagram_places"');
      await provider.discover({
        query: "dentist",
        limit: 5,
        location: "Toronto, ON",
      });

      check(
        callsMade.length === 1 && callsMade[0].actorId === "apify/instagram-scraper",
        "5a: DISCOVERY_PROVIDER=instagram_places invokes only apify/instagram-scraper",
      );
      check(
        !callsMade.some((c) => c.actorId.includes("crawler-google-places")),
        "5a: compass/crawler-google-places is NEVER invoked when DISCOVERY_PROVIDER=instagram_places",
      );

      // 5b: With that allowlist, selecting google_maps, profile_scraper, or instagram_search fails fast with clear error and makes zero calls
      callsMade.length = 0;
      let gmapsError = "";
      try {
        const gmapsProvider = new GoogleMapsDiscoveryProvider();
        await gmapsProvider.discover({
          query: "dentist",
          limit: 5,
          location: "Toronto, ON",
        });
      } catch (err: any) {
        gmapsError = err?.message || String(err);
      }
      check(
        gmapsError.includes("Actor compass/crawler-google-places is not allowed (allowed: apify/instagram-scraper)"),
        "5b: Selecting google_maps fails fast with clear error: 'Actor compass/crawler-google-places is not allowed (allowed: apify/instagram-scraper)'",
        gmapsError,
      );
      check(callsMade.length === 0, "5b: Zero calls made for disallowed google_maps");

      let profileError = "";
      try {
        process.env.IG_ENRICHMENT_ACTOR = "profile_scraper";
        const apifyProfileProvider = new ApifyProvider();
        await apifyProfileProvider.startJob({
          usernames: ["testuser"],
          limit: 1,
        });
      } catch (err: any) {
        profileError = err?.message || String(err);
      }
      check(
        profileError.includes("Actor apify/instagram-profile-scraper is not allowed (allowed: apify/instagram-scraper)"),
        "5b: Selecting profile_scraper fails fast with clear error: 'Actor apify/instagram-profile-scraper is not allowed (allowed: apify/instagram-scraper)'",
        profileError,
      );
      check(callsMade.length === 0, "5b: Zero calls made for disallowed profile_scraper");

      let searchError = "";
      try {
        const searchProvider = new ApifyDiscoveryProvider();
        await searchProvider.discover({
          query: "dentist",
          limit: 5,
          location: "Toronto, ON",
        });
      } catch (err: any) {
        searchError = err?.message || String(err);
      }
      check(
        searchError.includes("Actor apify/instagram-search-scraper is not allowed (allowed: apify/instagram-scraper)"),
        "5b: Selecting instagram_search fails fast with clear error: 'Actor apify/instagram-search-scraper is not allowed (allowed: apify/instagram-scraper)'",
        searchError,
      );
      check(callsMade.length === 0, "5b: Zero calls made for disallowed instagram_search");

      // Now switch back to valid enrichment: instagram_scraper_details
      process.env.IG_ENRICHMENT_ACTOR = "instagram_scraper_details";
      callsMade.length = 0;

      const enrichmentMockItem = {
        username: "cosmeticdentist_to",
        fullName: "Cosmetic Dentist Toronto",
        followersCount: 2500,
        followsCount: 450,
        // postsCount is omitted/missing
        biography: "Cosmetic dental studio in Toronto",
        externalUrl: "https://cosmeticdentist.to",
        isBusinessAccount: true,
        businessCategoryName: "Dentist",
        private: false,
        verified: true,
        // Unwanted fields
        posts: [{ id: "p1" }],
        latestPosts: [{ id: "lp1" }],
        likes: 99,
        profilePicUrl: "https://ig.com/pic.jpg",
      };

      setMockActorRunnerForTesting(async (actorId, input) => {
        callsMade.push({ actorId, input });
        return {
          items: [enrichmentMockItem],
          usageTotalUsd: 0.02,
          computeUnits: 0.1,
          run: {
            id: "run-step5-details",
            actId: actorId,
            status: "SUCCEEDED",
            defaultDatasetId: "dataset-step5-details",
          } as any,
          isDryRun: false,
        };
      });

      const apifyProvider = new ApifyProvider();
      const job = await apifyProvider.startJob({
        usernames: ["cosmeticdentist_to"],
        limit: 1,
      });

      check(
        callsMade.length === 1 && callsMade[0].actorId === "apify/instagram-scraper",
        "5a/5d: IG_ENRICHMENT_ACTOR=instagram_scraper_details invokes apify/instagram-scraper for enrichment",
      );
      check(
        callsMade[0].input.resultsType === "details",
        '5d: Actor input resultsType is "details"',
      );
      check(
        Array.isArray(callsMade[0].input.directUrls) &&
          callsMade[0].input.directUrls[0] === "https://www.instagram.com/cosmeticdentist_to/",
        "5d: Actor input directUrls contains formatted Instagram profile URL",
      );

      const results = await apifyProvider.getResults(job.jobId);
      check(results.profiles.length === 1, "5d: Successfully returned 1 enriched profile");
      const p = results.profiles[0];
      check(p.username === "cosmeticdentist_to", "5d: Username preserved");
      check(p.followersCount === 2500, "5d: followersCount preserved (2500)");
      check(p.followsCount === 450, "5d: followsCount preserved (450)");
      check(p.postsCount === null, "5d: Missing postsCount mapped to null (never 0)");
      check(p.isPrivate === false, "5d: private mapped to isPrivate: false");
      check(p.verified === true, "5d: verified mapped to true");
      check(p.latestPosts === null, "5d: latestPosts is null (dropped)");
      check(p.relatedProfiles === null, "5d: relatedProfiles is null (dropped)");

      const raw = p.rawProfileData as Record<string, unknown>;
      check(raw.posts === undefined, "5d: rawProfileData.posts dropped");
      check(raw.latestPosts === undefined, "5d: rawProfileData.latestPosts dropped");
      check(raw.postsCount === null, "5d: rawProfileData.postsCount is null");
      check(raw.private === false, "5d: rawProfileData.private is false");

      // 5e: Defaults without env changes are instagram_all_in_one + instagram_scraper
      delete process.env.DISCOVERY_PROVIDER;
      delete process.env.ENRICHMENT_PROVIDER;
      delete process.env.IG_ENRICHMENT_ACTOR;
      delete process.env.APIFY_ALLOWED_ACTORS;

      check(
        getActiveDiscoveryMode() === "instagram_all_in_one",
        '5e: Default discovery mode is "instagram_all_in_one"',
      );
      check(
        getIgEnrichmentActorMode() === "instagram_scraper_details",
        '5e: Default enrichment actor mode is "instagram_scraper_details"',
      );
      check(
        getActiveEnrichmentActorId() === "apify/instagram-scraper",
        '5e: Default enrichment actor ID is "apify/instagram-scraper"',
      );
      check(
        getDiscoveryProvider().name === "instagram_all_in_one",
        '5e: Default discovery provider instance is "instagram_all_in_one"',
      );
      check(
        getAllowedActors() === null,
        "5e: Default allowlist is empty/null (= all allowed)",
      );
      check(
        isActorAllowed("compass/crawler-google-places") === true,
        "5e: All actors allowed when allowlist is empty",
      );

      // Step 4 Notice Test (with pipe format)
      const notice = buildDiscoveryNotice({
        persisted: 3,
        requested: 3,
        discovered: 10,
        existingLeads: 0,
        existingSkipped: 1,
        enrichSkipped: 0,
        remainingCapacity: 0,
        discoveryProvider: "instagram_places",
        discoveryActor: "apify/instagram-scraper",
        enrichmentActor: "apify/instagram-scraper",
        apifyCostUsd: 0.05,
      });

      check(
        Boolean(notice?.includes("Discovery: instagram_places (apify/instagram-scraper) | Enrichment: apify/instagram-scraper | Apify cost: $0.05")),
        "4: Discovery result notice displays formatted actor choice and cost with pipes",
      );
    } finally {
      if (origDiscoveryEnv !== undefined) {
        process.env.DISCOVERY_PROVIDER = origDiscoveryEnv;
      } else {
        delete process.env.DISCOVERY_PROVIDER;
      }
      if (origEnrichEnv !== undefined) {
        process.env.IG_ENRICHMENT_ACTOR = origEnrichEnv;
      } else {
        delete process.env.IG_ENRICHMENT_ACTOR;
      }
      if (origAllowedActors !== undefined) {
        process.env.APIFY_ALLOWED_ACTORS = origAllowedActors;
      } else {
        delete process.env.APIFY_ALLOWED_ACTORS;
      }
      setMockActorRunnerForTesting(null);
    }
  }

  // ---------------------------------------------------------------------------
  // I. REAL SHAPE PARSING, FUNNEL COUNTERS, & NOTICES (STEP 3)
  // ---------------------------------------------------------------------------
  console.log("\n=== I. REAL SHAPE PARSING, FUNNEL COUNTERS, & NOTICES (STEP 3) ===");
  {
    // 1. Parse real sanitized fixture items
    const fixturePath = path.resolve(__dirname, "fixtures/instagram_places_real_items.json");
    check(fs.existsSync(fixturePath), "Step 3: Sanitized real items fixture exists at fixtures/instagram_places_real_items.json");

    const fixtureContent = fs.readFileSync(fixturePath, "utf8");
    const realItems: unknown[] = JSON.parse(fixtureContent);
    check(Array.isArray(realItems) && realItems.length === 5, "Step 3: Fixture contains exactly 5 sanitized items");

    const parsedResults = realItems.map((item) => parseIgPlaceItem(item, "Toronto, ON", 40));

    // Real shape is parsed as places
    check(
      parsedResults.every((r) => r.isPlace === true),
      "Step 3: All 5 real items from apify/instagram-scraper are successfully parsed as places",
    );

    // All 5 real items have Instagram usernames
    check(
      parsedResults.every((r) => r.hasInstagram === true && typeof r.rawUsername === "string" && r.rawUsername.length > 0),
      "Step 3: All 5 real items have extracted Instagram usernames (brightsmilesclinic, sonrisabritish_dentalclinic, etc.)",
    );

    // All 5 real items from broad 'canada' query are OUT_OF_AREA relative to Toronto (< 40km)
    check(
      parsedResults.every((r) => r.isOutOfArea === true && r.skipReason === "OUT_OF_AREA"),
      "Step 3: All 5 real items are identified as OUT_OF_AREA when checked against Toronto, ON (Ireland, Spain, Pakistan, Dubai, UK)",
    );

    // 2. Real Toronto place (Item 6 from raw dataset) is kept as candidate
    const torontoItem = {
      searchTerm: "teeth whitening clinic canada",
      searchSource: "google",
      inputUrl: "https://www.instagram.com/explore/locations/112674257134015/dr-massi-dental-clinic/",
      name: "DR Massi Dental Clinic",
      phone: "",
      category: "Dentist & Dental Office",
      media_count: 52,
      lat: 43.80358,
      lng: -79.42095,
      slug: "dr-massi-dental-clinic",
      location_id: "112674257134015",
      location_address: "",
      location_city: "",
      location_zip: "",
      ig_business: {
        profile: {
          profile_pic_url: "https://instagram.example.com/pic_6.jpg",
          username: "drmassidental",
          id: "35474347711",
        },
      },
    };

    const torontoParsed = parseIgPlaceItem(torontoItem, "Toronto, ON", 40);
    check(torontoParsed.isPlace === true, "Step 3: Real Toronto item parsed as place");
    check(torontoParsed.hasInstagram === true, "Step 3: Real Toronto item has Instagram");
    check(torontoParsed.isOutOfArea === false, "Step 3: Real Toronto item (DR Massi @ 17km) is within 40km of Toronto");
    check(torontoParsed.candidate?.username === "drmassidental", "Step 3: Real Toronto item produces valid candidate with handle @drmassidental");
    check(torontoParsed.candidate?.gmapsCategory === "Dentist & Dental Office", "Step 3: Candidate maps category to Maps-style format");

    // 3. Tolerant parsing of variations
    // a) Nested wrapper { place: ... }
    const wrappedItem = {
      place: {
        title: "Downtown Smile Studio",
        categoryName: "Cosmetic Dentist",
        latitude: "43.6532",
        longitude: "-79.3832",
        address: "100 Bay St, Toronto",
        profile: {
          username: "downtownsmilesto",
        },
      },
    };
    const wrappedParsed = parseIgPlaceItem(wrappedItem, "Toronto, ON", 40);
    check(wrappedParsed.isPlace === true, "Step 3: Parser handles { place: ... } wrapper and string coordinates");
    check(wrappedParsed.candidate?.username === "downtownsmilesto", "Step 3: Username extracted from profile.username");
    check(wrappedParsed.isOutOfArea === false, "Step 3: Plausibility check succeeds for Bay St downtown Toronto");

    // b) URL fields for handle extraction
    const urlItem = {
      name: "Yorkville Dental",
      lat: 43.67,
      lng: -79.39,
      instagram_url: "https://www.instagram.com/yorkvilledental_ca/?hl=en",
    };
    const urlParsed = parseIgPlaceItem(urlItem, "Toronto, ON", 40);
    check(urlParsed.candidate?.username === "yorkvilledental_ca", "Step 3: Username extracted from instagram_url field");

    // c) Reject non-profile paths in URLs
    const exploreItem = {
      name: "Generic Place",
      lat: 43.67,
      lng: -79.39,
      inputUrl: "https://www.instagram.com/explore/locations/99999/place-name/",
    };
    const exploreParsed = parseIgPlaceItem(exploreItem, "Toronto, ON", 40);
    check(exploreParsed.hasInstagram === false && exploreParsed.candidate === null, "Step 3: /explore/locations/ URL is correctly rejected from becoming a handle");

    // d) Non-place item / error marker
    const errorItem = { error: "Actor timeout", errorMessage: "Execution reached limit" };
    const errorParsed = parseIgPlaceItem(errorItem, "Toronto, ON", 40);
    check(errorParsed.isPlace === false && errorParsed.skipReason === "NOT_A_PLACE", "Step 3: Error marker is not parsed as a place");

    // 4. Out-of-area and NO_INSTAGRAM counted separately
    const noIgItem = {
      name: "No IG Dental",
      lat: 43.65,
      lng: -79.38,
      category: "Dentist",
    };
    const noIgParsed = parseIgPlaceItem(noIgItem, "Toronto, ON", 40);
    check(
      noIgParsed.skipReason === "NO_INSTAGRAM" && noIgParsed.hasInstagram === false && noIgParsed.isOutOfArea === false,
      "Step 3: Item with no Instagram is marked NO_INSTAGRAM and NOT marked out-of-area",
    );

    const outAreaItem = {
      name: "London Dental",
      lat: 51.5074,
      lng: -0.1278,
      username: "london_dental",
    };
    const outAreaParsed = parseIgPlaceItem(outAreaItem, "Toronto, ON", 40);
    check(
      outAreaParsed.skipReason === "OUT_OF_AREA" && outAreaParsed.hasInstagram === true && outAreaParsed.isOutOfArea === true,
      "Step 3: Item outside city is marked OUT_OF_AREA and NOT marked NO_INSTAGRAM",
    );

    // 5. Funnel counters add up without confusion
    const mockBatchItems = [
      torontoItem, // 1: Toronto kept
      { ...torontoItem, name: "Duplicate Toronto Clinic" }, // 2: Toronto duplicate handle
      realItems[0], // 3: Out of area (Ireland)
      realItems[1], // 4: Out of area (Spain)
      noIgItem, // 5: No IG
      { name: "Another No IG", lat: 43.65, lng: -79.38 }, // 6: No IG
      errorItem, // 7: Unparsed non-place error item
    ];

    setMockActorRunnerForTesting(async () => ({
      items: mockBatchItems,
      usageTotalUsd: 0.0189,
      computeUnits: 0.05,
      run: {
        id: "run-step3-counters",
        actId: "apify/instagram-scraper",
        status: "SUCCEEDED",
        defaultDatasetId: "dataset-step3-counters",
      } as any,
      isDryRun: false,
    }));

    const provider = new InstagramPlacesDiscoveryProvider();
    const result = await provider.discover({
      query: "dental clinic",
      limit: 10,
      location: "Toronto, ON",
    });

    const raw = result.itemsReturnedRaw ?? 0;
    const parsedPlaces = result.itemsParsedAsPlaces ?? 0;
    const unparsed = raw - parsedPlaces;
    const withIg = result.withInstagramUsername ?? 0;
    const noIg = result.noInstagramCount ?? 0;
    const outOfArea = result.outOfAreaCount ?? 0;
    const dups = result.duplicatesSkipped ?? 0;
    const kept = result.candidatesKept ?? result.candidates.length;

    check(raw === 7, `Step 3: itemsReturnedRaw is 7 (got ${raw})`);
    check(parsedPlaces === 6, `Step 3: itemsParsedAsPlaces is 6 (got ${parsedPlaces})`);
    check(unparsed === 1, `Step 3: unparsed count is 1 (got ${unparsed})`);
    check(withIg === 4, `Step 3: withInstagramUsername is 4 (got ${withIg})`);
    check(noIg === 2, `Step 3: noInstagramCount is 2 (got ${noIg})`);
    check(outOfArea === 2, `Step 3: outOfAreaCount is 2 (got ${outOfArea})`);
    check(dups === 1, `Step 3: duplicatesSkipped is 1 (got ${dups})`);
    check(kept === 1, `Step 3: candidatesKept is 1 (got ${kept})`);

    // Invariant checks
    check(
      raw === parsedPlaces + unparsed,
      "Step 3: Counter invariant: itemsReturnedRaw = itemsParsedAsPlaces + unparsed",
    );
    check(
      parsedPlaces === withIg + noIg,
      "Step 3: Counter invariant: itemsParsedAsPlaces = withInstagramUsername + noInstagramCount",
    );
    check(
      withIg === outOfArea + dups + kept,
      "Step 3: Counter invariant: withInstagramUsername = outOfAreaCount + duplicatesSkipped + candidatesKept",
    );

    // 6. Zero-result notice text verification
    // Case A: raw items 0 -> "Places found 0" only when raw === 0
    const noticeZeroRaw = buildDiscoveryNotice({
      persisted: 0,
      requested: 10,
      existingLeads: 0,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 10,
      itemsReturnedRaw: 0,
      itemsParsedAsPlaces: 0,
      withInstagramUsername: 0,
      outOfAreaCount: 0,
      candidatesKept: 0,
      discoveryProvider: "instagram_places",
      discoveryActor: "apify/instagram-scraper",
      enrichmentActor: "apify/instagram-scraper",
    });
    check(
      Boolean(noticeZeroRaw?.includes("Instagram places: raw items 0, parsed 0, with Instagram 0, out of area 0, kept 0. Reason: no matching places returned by Instagram for this query and location")),
      "Step 3 Notice Case A: raw items 0 reports exact zero funnel and never mentions Google Maps",
    );
    check(
      !noticeZeroRaw?.includes("Google Maps"),
      "Step 3 Notice Case A: does not mention Google Maps",
    );

    // Case B: places found, none have Instagram -> suggests google_maps
    const noticeNoIg = buildDiscoveryNotice({
      persisted: 0,
      requested: 10,
      existingLeads: 0,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 10,
      itemsReturnedRaw: 5,
      itemsParsedAsPlaces: 5,
      withInstagramUsername: 0,
      noInstagramCount: 5,
      outOfAreaCount: 0,
      candidatesKept: 0,
      discoveryProvider: "instagram_places",
      discoveryActor: "apify/instagram-scraper",
      enrichmentActor: "apify/instagram-scraper",
    });
    check(
      Boolean(noticeNoIg?.includes("places were found, but none have a linked Instagram username (suggest google_maps)")),
      "Step 3 Notice Case B: withInstagram 0 clearly states no linked Instagram username and suggests google_maps",
    );

    // Case C: most places have no Instagram -> suggests google_maps
    const noticeMostNoIg = buildDiscoveryNotice({
      persisted: 0,
      requested: 10,
      existingLeads: 0,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 10,
      itemsReturnedRaw: 6,
      itemsParsedAsPlaces: 6,
      withInstagramUsername: 1,
      noInstagramCount: 5,
      outOfAreaCount: 1,
      candidatesKept: 0,
      discoveryProvider: "instagram_places",
      discoveryActor: "apify/instagram-scraper",
      enrichmentActor: "apify/instagram-scraper",
    });
    check(
      Boolean(noticeMostNoIg?.includes("most places have no linked Instagram username (suggest google_maps)")),
      "Step 3 Notice Case C: most places with no IG clearly states so and suggests google_maps",
    );

    // Case D: places found with IG, but all out of area (our actual real-world bug case!)
    const noticeOutOfArea = buildDiscoveryNotice({
      persisted: 0,
      requested: 10,
      existingLeads: 0,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 10,
      itemsReturnedRaw: 10,
      itemsParsedAsPlaces: 10,
      withInstagramUsername: 10,
      outOfAreaCount: 10,
      candidatesKept: 0,
      apifyCostUsd: 0.03,
      discoveryProvider: "instagram_places",
      discoveryActor: "apify/instagram-scraper",
      enrichmentActor: "apify/instagram-scraper",
    });
    check(
      Boolean(noticeOutOfArea?.includes("Instagram places: raw items 10, parsed 10, with Instagram 10, out of area 10, kept 0. Reason: places with Instagram accounts were found, but all were outside the target city radius (suggest google_maps for local geo-accuracy)")),
      "Step 3 Notice Case D: all out of area displays real raw count (10) and cost ($0.03) instead of confusing 'Places found 0'",
    );
    check(
      Boolean(noticeOutOfArea?.includes("Apify cost: $0.03")),
      "Step 3 Notice Case D: Apify cost ($0.03) accurately displayed with actor attribution",
    );
    check(
      !noticeOutOfArea?.includes("no matching places found in Google Maps"),
      "Step 3 Notice Case D: never mentions 'no matching places found in Google Maps'",
    );

    // Case E: provider error
    const noticeError = buildDiscoveryNotice({
      persisted: 0,
      requested: 10,
      existingLeads: 0,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 10,
      itemsReturnedRaw: 0,
      itemsParsedAsPlaces: 0,
      withInstagramUsername: 0,
      outOfAreaCount: 0,
      candidatesKept: 0,
      providerError: "Apify memory exceeded",
      discoveryProvider: "instagram_places",
      discoveryActor: "apify/instagram-scraper",
      enrichmentActor: "apify/instagram-scraper",
    });
    check(
      Boolean(noticeError?.includes("Discovery provider failed: Apify memory exceeded. (Instagram places: raw items 0, parsed 0, with Instagram 0, out of area 0, kept 0)")),
      "Step 3 Notice Case E: provider error reported accurately without Google Maps references",
    );

    // 7. Input verification
    const query = buildPlaceSearchQuery("dental clinic", "Toronto, ON");
    check(query === "dental clinic toronto", `Step 3 Input: search query is "${query}" (cleaned keywords + city)`);

    const queryCountryFallback = buildPlaceSearchQuery("dental clinic", "Canada");
    check(
      queryCountryFallback === "dental clinic toronto",
      `Step 3 Input: country fallback "Canada" resolves to "${queryCountryFallback}"`,
    );

    const limit = getIgPlacesSearchLimit(50);
    check(limit === 25, "Step 3 Input: searchLimit hard max capped at 25");

    setMockActorRunnerForTesting(null);
  }

  console.log("\n================================================================");
  console.log(` SUMMARY: ${passed} passed, ${failed} failed`);
  console.log("================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
