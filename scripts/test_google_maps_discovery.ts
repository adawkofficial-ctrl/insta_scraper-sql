/**
 * Unit tests for GoogleMapsDiscoveryProvider and Google Maps discovery pipeline:
 * a. Handle normalizer:
 *    - "https://www.instagram.com/horizonsdental/?hl=en" -> "horizonsdental"
 *    - "@Smile.Clinic" -> "smile.clinic"
 *    - "instagram.com/p/XYZ" -> rejected
 *    - "instagram.com/explore/tags/x" -> rejected
 * b. Multi-city parsing:
 *    - "Toronto, Vancouver" -> 2 searches
 *    - "Canada" -> fallback to top 5 cities + warning
 * c. Place with no Instagram -> skipped and counted as NO_INSTAGRAM
 * d. Duplicate website domain / duplicate handle -> deduped
 * e. Maps candidate passes into existing gates; Location is set from Maps;
 *    place with Maps category "Car wash" is rejected by the category gate.
 * f. Apify failure for one city does not stop other cities.
 */

// Preload server-only mock before any server module is loaded
import "dotenv/config";
// Test doubles (Apify mock) are only honored when NODE_ENV=test. Set it here so
// running this file directly can never hit the live Apify API.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl } = require("./test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || "mock-apify-test-token";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import {
  normalizeInstagramHandle,
  normalizeInstagramHandleFromUrl,
  GoogleMapsDiscoveryProvider,
  extractInstagramHandlesFromPlace,
  isPrivateOrBlockedUrl,
  validateMapsActorOutput,
} from "../src/lib/services/discovery/google-maps-discovery-provider";
import { buildDiscoveryNotice } from "../src/lib/services/discovery/discovery-service";
import {
  resolveTargetCities,
  COUNTRY_TOP_CITIES,
} from "../src/lib/services/discovery/country-cities";
import { setApifyClientForTesting } from "../src/lib/services/scraper/apify-client";
import {
  evaluateProfileRelevance,
  decideRelevance,
  prefilterCandidate,
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  type RelevanceCampaignContext,
} from "../src/lib/services/discovery/lead-relevance";
import type { LeadProfile } from "../src/lib/types";

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

function makeMockProfile(
  overrides: Partial<LeadProfile> & { username: string },
): LeadProfile {
  return {
    profileUrl: `https://www.instagram.com/${overrides.username}/`,
    instagramId: null,
    fullName: null,
    biography: null,
    followers: null,
    following: null,
    postsCount: null,
    profilePictureUrl: null,
    isVerified: null,
    isBusiness: true,
    isBusinessAccount: true,
    category: null,
    businessCategoryName: null,
    externalUrl: null,
    website: null,
    location: null,
    relatedProfiles: null,
    latestPosts: null,
    source: "apify",
    scrapedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function runTests() {
  const originalDryRun = process.env.APIFY_DRY_RUN;
  const originalMonthly = process.env.APIFY_MONTHLY_BUDGET_USD;
  process.env.APIFY_DRY_RUN = "false";
  process.env.APIFY_MONTHLY_BUDGET_USD = "100.00";

  console.log("=== A. HANDLE NORMALIZER TESTS ===");
  {
    // 1. https://www.instagram.com/horizonsdental/?hl=en -> horizonsdental
    const t1 = normalizeInstagramHandle(
      "https://www.instagram.com/horizonsdental/?hl=en",
    );
    check(
      t1 === "horizonsdental",
      'URL with query params: "https://www.instagram.com/horizonsdental/?hl=en" -> "horizonsdental"',
      `Got: ${t1}`,
    );

    // 2. @Smile.Clinic -> smile.clinic
    const t2 = normalizeInstagramHandle("@Smile.Clinic");
    check(
      t2 === "smile.clinic",
      'Handle with @ and casing: "@Smile.Clinic" -> "smile.clinic"',
      `Got: ${t2}`,
    );

    // 3. instagram.com/p/XYZ -> rejected (null)
    const t3 = normalizeInstagramHandle("instagram.com/p/XYZ");
    check(
      t3 === null,
      'Post path: "instagram.com/p/XYZ" -> rejected (null)',
      `Got: ${t3}`,
    );

    // 4. instagram.com/explore/tags/x -> rejected (null)
    const t4 = normalizeInstagramHandle("instagram.com/explore/tags/x");
    check(
      t4 === null,
      'Explore path: "instagram.com/explore/tags/x" -> rejected (null)',
      `Got: ${t4}`,
    );

    // 5. Reel path: instagram.com/reel/abc123/ -> rejected (null)
    const t5 = normalizeInstagramHandle("https://www.instagram.com/reel/abc123/");
    check(
      t5 === null,
      'Reel path: "https://www.instagram.com/reel/abc123/" -> rejected (null)',
      `Got: ${t5}`,
    );

    // 6. Stories path: instagram.com/stories/highlights/123/ -> rejected (null)
    const t6 = normalizeInstagramHandle("instagram.com/stories/highlights/123/");
    check(
      t6 === null,
      'Stories path: "instagram.com/stories/highlights/123/" -> rejected (null)',
      `Got: ${t6}`,
    );

    // 7. Trailing slashes and whitespace
    const t7 = normalizeInstagramHandle("  http://instagram.com/clean.teeth/  ");
    check(
      t7 === "clean.teeth",
      'HTTP with trailing slash and whitespace: "clean.teeth"',
      `Got: ${t7}`,
    );

    // 8. Alias function works identically
    const t8 = normalizeInstagramHandleFromUrl("https://instagram.com/torontodental");
    check(
      t8 === "torontodental",
      'normalizeInstagramHandleFromUrl alias works: "torontodental"',
      `Got: ${t8}`,
    );
  }

  console.log("\n=== B. MULTI-CITY PARSING & COUNTRY FALLBACK TESTS ===");
  {
    // 1. Multi-city parsing: "Toronto, Vancouver" -> 2 searches
    const res1 = resolveTargetCities("Toronto, Vancouver");
    check(
      res1.cities.length === 2 &&
      res1.cities[0] === "Toronto" &&
      res1.cities[1] === "Vancouver",
      'Multi-city string "Toronto, Vancouver" resolves to ["Toronto", "Vancouver"]',
      JSON.stringify(res1),
    );
    check(
      res1.isCountryFallback === false,
      "isCountryFallback is false for city list",
    );

    // 2. Multi-city with extra delimiters: "Toronto, Calgary; Vancouver | Montreal"
    const res2 = resolveTargetCities("Toronto, Calgary; Vancouver | Montreal");
    check(
      res2.cities.length === 4 && res2.cities.includes("Calgary"),
      "Supports comma, semicolon, and pipe separators",
      JSON.stringify(res2.cities),
    );

    // 3. Country fallback: "Canada" -> expands to top major cities with plan
    const res3 = resolveTargetCities("Canada");
    check(
      res3.isCountryFallback === true,
      'Country name "Canada" triggers isCountryFallback = true',
    );
    check(
      res3.cities.length >= 1,
      `Country-only location returns major cities: got ${res3.cities.length}`,
      JSON.stringify(res3.cities),
    );
    check(
      res3.cities[0] === "Toronto, ON",
      "Canada fallback returns first city Toronto, ON",
      JSON.stringify(res3.cities),
    );
    check(
      typeof res3.warning === "string" && res3.warning.includes("Canada"),
      "Country fallback produces warning message asking user to specify cities",
      res3.warning,
    );

    // 4. USA fallback
    const res4 = resolveTargetCities("United States");
    check(
      res4.isCountryFallback === true && res4.cities.length >= 1 && res4.cities[0] === "New York, NY",
      '"United States" triggers USA top cities fallback',
      JSON.stringify(res4.cities),
    );
  }

  console.log("\n=== C. MOCKED APIFY DISCOVERY: NO_INSTAGRAM SKIPPED ===");
  {
    // Create mock Apify client returning places, some without Instagram
    const mockDatasetItems = [
      {
        title: "Maple Dental Care",
        address: "100 King St W, Toronto, ON",
        city: "Toronto",
        categoryName: "Dentist",
        categories: ["Dentist", "Dental clinic"],
        phone: "+1 416-555-0101",
        website: "https://mapledental.ca",
        totalScore: 4.8,
        reviewsCount: 120,
        socialMediaProfiles: {
          instagram: "https://www.instagram.com/mapledentalcare/",
        },
      },
      {
        title: "Ghost Clinic (No Socials)",
        address: "200 Queen St W, Toronto, ON",
        city: "Toronto",
        categoryName: "Dental clinic",
        phone: "+1 416-555-0102",
        website: null, // no website and no instagram
        totalScore: 4.2,
        reviewsCount: 15,
      },
      {
        title: "Bad Link Dental",
        address: "300 Bay St, Toronto, ON",
        city: "Toronto",
        categoryName: "Dentist",
        phone: "+1 416-555-0103",
        website: null,
        socialMediaProfiles: {
          instagram: "https://www.instagram.com/p/PostId123/", // invalid non-profile path
        },
      },
    ];

    const mockClient = {
      actor: () => ({
        call: async () => ({
          id: "run-test-c",
          status: "SUCCEEDED",
          defaultDatasetId: "dataset-test-c",
          usageTotalUsd: 0.05,
          stats: { computeUnits: 0.02 },
        }),
      }),
      run: () => ({
        waitForFinish: async () => ({
          id: "run-test-c",
          status: "SUCCEEDED",
          defaultDatasetId: "dataset-test-c",
          usageTotalUsd: 0.05,
          stats: { computeUnits: 0.02 },
        }),
      }),
      dataset: () => ({
        listItems: async () => ({
          items: mockDatasetItems,
        }),
      }),
    };

    setApifyClientForTesting(mockClient as any);

    const provider = new GoogleMapsDiscoveryProvider();
    const result = await provider.discover({
      query: "dental clinic",
      limit: 10,
      location: "Toronto",
    });

    const igCandidates = result.candidates.filter((c) => c.username);
    check(
      igCandidates.length === 1,
      `Only 1 candidate with valid Instagram was extracted (got ${igCandidates.length})`,
      JSON.stringify(result.candidates.map((c) => c.username)),
    );
    check(
      igCandidates[0]?.username === "mapledentalcare",
      'Extracted candidate has username "mapledentalcare"',
    );
    check(
      result.candidates.length === 3,
      `Total 3 candidates returned (1 IG + 2 contactable multi-channel) (got ${result.candidates.length})`,
    );
    check(
      result.gmapsPlacesFound === 3,
      `gmapsPlacesFound is 3 (got ${result.gmapsPlacesFound})`,
    );
    check(
      result.noInstagramCount === 2,
      `noInstagramCount is 2 (got ${result.noInstagramCount})`,
    );
  }

  console.log("\n=== C2. COUNTRY-LEVEL LOCATION USES THE PLANNED CITY FALLBACK ===");
  {
    let actorCalls = 0;
    const mockClient = {
      actor: () => ({
        call: async () => {
          actorCalls++;
          return {
            id: `run-country-${actorCalls}`,
            status: "SUCCEEDED",
            defaultDatasetId: `dataset-country-${actorCalls}`,
            usageTotalUsd: 0.01,
            stats: { computeUnits: 0.01 },
          };
        },
      }),
      run: () => ({
        waitForFinish: async () => ({
          id: "run-country",
          status: "SUCCEEDED",
          defaultDatasetId: "dataset-country",
          usageTotalUsd: 0.01,
          stats: { computeUnits: 0.01 },
        }),
      }),
      dataset: () => ({
        listItems: async () => ({
          items: [
            {
              title: "Canada Wide Dental",
              address: "100 King St W, Toronto, ON",
              city: "Toronto",
              state: "ON",
              countryCode: "CA",
              categoryName: "Dentist",
              phone: "+1 416-555-0199",
              website: "https://canadawidedental.ca",
              totalScore: 4.7,
              reviewsCount: 80,
              socialMediaProfiles: {
                instagram: "https://www.instagram.com/canadawidedental/",
              },
            },
          ],
        }),
      }),
    };

    setApifyClientForTesting(mockClient as any);
    const provider = new GoogleMapsDiscoveryProvider();
    const result = await provider.discover({
      query: "dental clinic",
      limit: 10,
      location: "Canada",
    });

    check(
      result.stopReason !== "country_level_requires_cities",
      "Country-level location does not stop before paid calls",
      `stopReason=${result.stopReason}`,
    );
    check(
      actorCalls > 0,
      `Country-level location executes the planned city search (actor calls=${actorCalls})`,
    );
    check(
      (result.executedQueries ?? []).length === 1 &&
        (result.executedQueries ?? [])[0]?.includes("Toronto"),
      "Country fallback runs the first planned city only (no 5-city fanout)",
      JSON.stringify(result.executedQueries),
    );
    check(
      result.candidates.length > 0,
      `Country fallback returns candidates (got ${result.candidates.length})`,
      JSON.stringify(result.candidates.map((c) => c.username)),
    );
    check(
      typeof result.notice === "string" &&
        result.notice.includes("Canada") &&
        result.notice.includes("Searching planned city"),
      "Country fallback result carries the planned-city notice",
      String(result.notice),
    );
  }

  console.log("\n=== D. DUPLICATE WEBSITE DOMAIN & HANDLE DEDUPLICATION ===");
  {
    const mockDatasetItems = [
      {
        title: "City Dental Downtown",
        address: "100 Bay St, Toronto, ON",
        city: "Toronto",
        categoryName: "Dentist",
        phone: "+1 416-555-0101",
        website: "https://citydental.com/toronto",
        socialMediaProfiles: {
          instagram: "https://www.instagram.com/citydental/",
        },
      },
      {
        title: "City Dental Uptown (Same Handle)",
        address: "500 Yonge St, Toronto, ON",
        city: "Toronto",
        categoryName: "Dentist",
        phone: "+1 416-555-0102",
        website: "https://citydental.com/uptown",
        socialMediaProfiles: {
          instagram: "https://www.instagram.com/citydental/", // Duplicate handle
        },
      },
      {
        title: "City Dental North (Same Domain, Different Handle)",
        address: "900 Yonge St, Toronto, ON",
        city: "Toronto",
        categoryName: "Dentist",
        phone: "+1 416-555-0103",
        website: "https://citydental.com/north", // Duplicate domain
        socialMediaProfiles: {
          instagram: "https://www.instagram.com/citydentalnorth/",
        },
      },
      {
        title: "Distinct Clinic",
        address: "10 Bloor St, Toronto, ON",
        city: "Toronto",
        categoryName: "Cosmetic dentist",
        phone: "+1 416-555-0104",
        website: "https://distinctsmiles.ca",
        socialMediaProfiles: {
          instagram: "https://www.instagram.com/distinctsmiles/",
        },
      },
    ];

    const mockClient = {
      actor: () => ({
        call: async () => ({
          id: "run-test-d",
          status: "SUCCEEDED",
          defaultDatasetId: "dataset-test-d",
          usageTotalUsd: 0.05,
          stats: { computeUnits: 0.02 },
        }),
      }),
      run: () => ({
        waitForFinish: async () => ({
          id: "run-test-d",
          status: "SUCCEEDED",
          defaultDatasetId: "dataset-test-d",
          usageTotalUsd: 0.05,
          stats: { computeUnits: 0.02 },
        }),
      }),
      dataset: () => ({
        listItems: async () => ({
          items: mockDatasetItems,
        }),
      }),
    };

    setApifyClientForTesting(mockClient as any);

    const provider = new GoogleMapsDiscoveryProvider();
    const result = await provider.discover({
      query: "cosmetic dentist",
      limit: 10,
      location: "Toronto",
    });

    check(
      result.candidates.length === 2,
      `Deduped duplicate handle and domain: 2 candidates returned (got ${result.candidates.length})`,
      JSON.stringify(result.candidates.map((c) => c.username)),
    );
    check(
      result.duplicatesSkipped === 2,
      `duplicatesSkipped is 2 (got ${result.duplicatesSkipped})`,
    );
    check(
      result.candidates.some((c) => c.username === "citydental") &&
      result.candidates.some((c) => c.username === "distinctsmiles"),
      "Retained distinct entries citydental and distinctsmiles",
    );
  }

  console.log("\n=== E. PIPELINE INTEGRATION & GATES: LOCATION & CATEGORY ===");
  {
    const campaignContext: RelevanceCampaignContext = {
      intent: "cosmetic dentistry and dental clinic practices",
      location: "Toronto",
      category: "Dental",
    };

    // 1. Maps candidate with verified Google Maps location & category passes gates
    const mapsDentistProfile = makeMockProfile({
      username: "maple_dental_toronto",
      fullName: "Maple Dental Toronto",
      biography: "Serving downtown Toronto with complete dental services.",
      location: null, // IG location is null/empty
      gmapsCity: "Toronto",
      gmapsAddress: "123 King St W, Toronto, ON",
      gmapsCategory: "Dentist",
      gmapsRating: 4.9,
      gmapsReviews: 140,
      sourceProvider: "google_maps",
    });

    const evalDentist = evaluateProfileRelevance(
      mapsDentistProfile,
      campaignContext,
      DEFAULT_DISCOVERY_RELEVANCE_POLICY,
    );
    const decisionDentist = decideRelevance(
      evalDentist,
      DEFAULT_DISCOVERY_RELEVANCE_POLICY,
    );

    check(
      mapsDentistProfile.location !== null &&
      mapsDentistProfile.location.includes("Toronto"),
      "Location is populated from Google Maps data (not null/empty)",
      `Location: "${mapsDentistProfile.location}"`,
    );
    check(
      evalDentist.locationMatch === "MATCHED",
      'Google Maps candidate treats locationMatch as "MATCHED"',
      `locationMatch: ${evalDentist.locationMatch}`,
    );
    check(
      evalDentist.categoryMatch === "MATCHED",
      'Google Maps category "Dentist" matches campaign category "Dental"',
      `categoryMatch: ${evalDentist.categoryMatch}`,
    );
    check(
      decisionDentist.relevant === true,
      "Google Maps dentist candidate is accepted by the pipeline gates",
    );

    // 2. Maps candidate with category "Car wash" is REJECTED by category gate
    const carWashProfile = makeMockProfile({
      username: "primewash_carwash",
      fullName: "Prime Wash Auto Spa",
      biography: "Best detailing and car wash services in the GTA.",
      location: null,
      gmapsCity: "Toronto",
      gmapsAddress: "456 Queen St E, Toronto, ON",
      gmapsCategory: "Car wash", // Explicitly non-dental Maps category
      sourceProvider: "google_maps",
    });

    const evalCarWash = evaluateProfileRelevance(
      carWashProfile,
      campaignContext,
      DEFAULT_DISCOVERY_RELEVANCE_POLICY,
    );
    const decisionCarWash = decideRelevance(
      evalCarWash,
      DEFAULT_DISCOVERY_RELEVANCE_POLICY,
    );

    check(
      evalCarWash.categoryMatch === "NOT_MATCHED",
      'Category "Car wash" yields categoryMatch = "NOT_MATCHED"',
      `categoryMatch: ${evalCarWash.categoryMatch}`,
    );
    check(
      !decisionCarWash.relevant &&
      (decisionCarWash.reason === "IRRELEVANT_CATEGORY" ||
        decisionCarWash.gate === "category" ||
        decisionCarWash.gate === "negative_keyword"),
      'Candidate with Maps category "Car wash" is rejected by the category/negative keyword gate',
      !decisionCarWash.relevant
        ? `reason: ${decisionCarWash.reason}, gate: ${decisionCarWash.gate}`
        : "passed",
    );

    // 3. Check prefilterCandidate also rejects "Car wash"
    const preResult = prefilterCandidate(
      {
        username: "primewash_sp",
        gmapsCategory: "Car wash",
        gmapsCity: "Toronto",
      },
      campaignContext,
    );
    check(
      preResult.action === "REJECT",
      'prefilterCandidate rejects Maps candidate with "Car wash" category early',
      preResult.action === "REJECT"
        ? `Action: ${preResult.action}, reason: ${preResult.underlyingReason ?? preResult.reason}`
        : "passed",
    );
  }

  console.log("\n=== F. APIFY ERROR TOLERANCE: MULTI-CITY FAILS ON CITY 1, SUCCEEDS ON CITY 2 ===");
  {
    let callCount = 0;
    const mockClient = {
      actor: () => ({
        call: async (input: { locationQuery: string }) => {
          callCount++;
          if (callCount === 1) {
            // First city fails with network timeout
            throw new Error("Network timeout on Toronto");
          }
          // Second city succeeds
          return {
            id: "run-city-2",
            status: "SUCCEEDED",
            defaultDatasetId: "dataset-city-2",
            usageTotalUsd: 0.08,
            stats: { computeUnits: 0.03 },
          };
        },
      }),
      run: () => ({
        waitForFinish: async () => ({
          id: "run-city-2",
          status: "SUCCEEDED",
          defaultDatasetId: "dataset-city-2",
          usageTotalUsd: 0.08,
          stats: { computeUnits: 0.03 },
        }),
      }),
      dataset: () => ({
        listItems: async () => ({
          items: [
            {
              title: "Vancouver Dental Studio",
              address: "789 Robson St, Vancouver, BC",
              city: "Vancouver",
              categoryName: "Cosmetic dentist",
              socialMediaProfiles: {
                instagram: "https://www.instagram.com/vancouverdentalstudio/",
              },
            },
          ],
        }),
      }),
    };

    setApifyClientForTesting(mockClient as any);

    const provider = new GoogleMapsDiscoveryProvider();
    // Run with 2 cities: "Toronto, Vancouver"
    const result = await provider.discover({
      query: "dental clinic",
      limit: 10,
      location: "Toronto, Vancouver",
    });

    check(
      callCount === 2,
      `Provider attempted both cities (calls=${callCount}) despite city 1 failure`,
    );
    check(
      result.candidates.length === 1 &&
      result.candidates[0].username === "vancouverdentalstudio",
      "Provider completed and returned candidates from surviving city (Vancouver)",
      JSON.stringify(result.candidates.map((c) => c.username)),
    );
    check(
      Boolean(result.placesByCity && result.placesByCity["Vancouver"] === 1),
      "placesByCity records Vancouver results",
    );
  }

  console.log("\n=== G. TOLERANT INSTAGRAM PARSER: RAW APIFY ITEM SHAPE ===");
  {
    // Real item shape from crawler-google-places dataset 1nggl5no1G8Vrs6fD:
    const realApifyPlace = {
      title: "Connected Fitness",
      website: "https://connectedcommunity.fitness/",
      phone: "(773) 863-3334",
      categories: ["Gym"],
      instagrams: ["https://www.instagram.com/connectedfitnesslv"],
      instagramProfiles: [
        {
          profileName: "Connected Fitness",
          username: "connectedfitnesslv",
          profileURL: "https://www.instagram.com/connectedfitnesslv",
          isBusinessAccount: true,
          followersCount: 1666,
        },
      ],
      emails: ["info@connectedcommunity.fitness"],
    };

    const handles = extractInstagramHandlesFromPlace(realApifyPlace);
    check(
      handles.includes("connectedfitnesslv"),
      'Extracts handle from real Apify "instagrams" and "instagramProfiles" objects',
      JSON.stringify(handles),
    );

    // Deeply nested / contact object:
    const placeWithContacts = {
      title: "Clinic ABC",
      contacts: {
        instagram: "https://www.instagram.com/clinic_abc?hl=en",
      },
    };
    const handles2 = extractInstagramHandlesFromPlace(placeWithContacts);
    check(
      handles2.includes("clinic_abc"),
      'Extracts handle from nested "contacts.instagram"',
      JSON.stringify(handles2),
    );
  }

  console.log("\n=== H. WEBSITE HTML EXTRACTION & SSRF PROTECTION ===");
  {
    // SSRF blocking
    check(
      isPrivateOrBlockedUrl("http://localhost:3000") === true,
      "Blocks localhost URL",
    );
    check(
      isPrivateOrBlockedUrl("http://127.0.0.1/admin") === true,
      "Blocks 127.0.0.1",
    );
    check(
      isPrivateOrBlockedUrl("http://192.168.1.50/info") === true,
      "Blocks 192.168.x.x private IP",
    );
    check(
      isPrivateOrBlockedUrl("http://10.0.0.1/status") === true,
      "Blocks 10.x.x.x private IP",
    );
    check(
      isPrivateOrBlockedUrl("http://172.16.5.10/test") === true,
      "Blocks 172.16-31.x.x private IP",
    );
    check(
      isPrivateOrBlockedUrl("ftp://example.com/file") === true,
      "Blocks non-http/https protocol",
    );
    check(
      isPrivateOrBlockedUrl("https://example.com") === false,
      "Allows valid public https URL",
    );
  }

  console.log("\n=== I. FATAL APIFY ERROR SURFACING: MONTHLY USAGE LIMIT EXCEEDED ===");
  {
    const quotaError = new Error("Monthly usage hard limit exceeded");
    (quotaError as any).statusCode = 403;
    (quotaError as any).type = "platform-feature-disabled";

    const mockClientQuotaError = {
      actor: () => ({
        call: async () => {
          throw quotaError;
        },
      }),
      run: () => ({
        waitForFinish: async () => {
          throw quotaError;
        },
      }),
      dataset: () => ({
        listItems: async () => ({ items: [] }),
      }),
    };

    setApifyClientForTesting(mockClientQuotaError as any);

    const provider = new GoogleMapsDiscoveryProvider();
    const result = await provider.discover({
      query: "dental clinic",
      limit: 15,
      location: "Toronto, Vancouver",
    });

    check(
      result.candidates.length === 0,
      "Candidates count is 0 on fatal quota error",
    );
    check(
      Boolean(result.error && result.error.includes("Monthly usage hard limit exceeded")),
      `Surfaces real error message in result.error: "${result.error}"`,
    );
  }

  console.log("\n=== J. FUNNEL NO_RESULTS NOTICE MESSAGES ===");
  {
    // Case 1: Provider failed with Apify quota error
    const noticeError = buildDiscoveryNotice({
      persisted: 0,
      requested: 15,
      existingLeads: 7,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 8,
      gmapsPlacesFound: 0,
      gmapsWithWebsite: 0,
      gmapsWithInstagram: 0,
      gmapsDuplicatesSkipped: 0,
      providerError: "Monthly usage hard limit exceeded",
    });

    check(
      Boolean(
        noticeError?.includes("Monthly usage hard limit exceeded") &&
        noticeError?.includes("NO_RESULTS: Discovery provider failed:"),
      ),
      'Surfaces provider failure in notice: "NO_RESULTS: Discovery provider failed: Monthly usage hard limit exceeded."',
      noticeError || undefined,
    );

    // Case 2: Places found but none had website or instagram
    const noticeNoSocial = buildDiscoveryNotice({
      persisted: 0,
      requested: 15,
      existingLeads: 7,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 8,
      gmapsPlacesFound: 25,
      gmapsWithWebsite: 0,
      gmapsWithInstagram: 0,
      gmapsDuplicatesSkipped: 0,
    });

    check(
      Boolean(
        noticeNoSocial?.includes(
          "Places found 25, with website 0, with Instagram 0, skipped duplicates 0",
        ) && noticeNoSocial?.includes("Reason:"),
      ),
      "Notice shows full funnel and reason when 0 websites found",
      noticeNoSocial || undefined,
    );

    // Case 3: Places found with website and Instagram, but all dropped as duplicates
    const noticeAllDuplicates = buildDiscoveryNotice({
      persisted: 0,
      requested: 15,
      existingLeads: 7,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 8,
      gmapsPlacesFound: 20,
      gmapsWithWebsite: 15,
      gmapsWithInstagram: 5,
      gmapsDuplicatesSkipped: 5,
    });

    check(
      Boolean(
        noticeAllDuplicates?.includes(
          "Places found 20, with website 15, with Instagram 5, skipped duplicates 5",
        ) && noticeAllDuplicates?.includes("Reason: all discovered Instagram handles are already in your campaign leads"),
      ),
      "Notice shows funnel and duplicates reason when all handles were duplicates",
      noticeAllDuplicates || undefined,
    );

    // Case 4: Country-level requirement is preserved with the provider's
    // actionable notice instead of being rewritten to all_keywords_exhausted.
    const countryNotice =
      'Location "Canada" is a country or province. Please choose specific target cities in the campaign settings (suggested: Toronto, ON, Vancouver, BC).';
    const noticeCountry = buildDiscoveryNotice({
      persisted: 0,
      requested: 20,
      existingLeads: 13,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 7,
      stopReason: "country_level_requires_cities",
      providerNotice: countryNotice,
      gmapsPlacesFound: 0,
      gmapsWithWebsite: 0,
      gmapsWithInstagram: 0,
      gmapsDuplicatesSkipped: 0,
    });

    check(
      Boolean(
        noticeCountry?.includes(countryNotice) &&
          noticeCountry?.includes("No paid Google Maps calls were made") &&
          !noticeCountry?.includes("all_keywords_exhausted"),
      ),
      "Country-level stop reason keeps its actionable notice (not all_keywords_exhausted)",
      noticeCountry || undefined,
    );
  }

  console.log("\n=== K. validateMapsActorOutput VALIDATION TESTS ===");
  {
    // Valid output passes
    let validPassed = false;
    try {
      validateMapsActorOutput([
        { title: "Dental Clinic", website: "https://dental.com", categoryName: "Dentist" },
        { name: "Smile Studio", url: "https://smile.com", category: "Cosmetic Dentist" },
        { title: "Downtown Care", website: "https://care.com", categories: ["Health"] },
      ]);
      validPassed = true;
    } catch {
      validPassed = false;
    }
    check(validPassed, "validateMapsActorOutput passes on valid sample containing name, website, category");

    // Missing website fails
    let missingWebsiteFailed = false;
    try {
      validateMapsActorOutput([
        { title: "No Website Clinic", categoryName: "Dentist" },
      ]);
    } catch (err) {
      missingWebsiteFailed = String(err).includes("missing required fields") && String(err).includes("website");
    }
    check(missingWebsiteFailed, "validateMapsActorOutput fails when website is missing");

    // Missing name fails
    let missingNameFailed = false;
    try {
      validateMapsActorOutput([
        { website: "https://dental.com", categoryName: "Dentist" },
      ]);
    } catch (err) {
      missingNameFailed = String(err).includes("missing required fields") && String(err).includes("name");
    }
    check(missingNameFailed, "validateMapsActorOutput fails when name is missing");

    // Missing category fails
    let missingCategoryFailed = false;
    try {
      validateMapsActorOutput([
        { title: "Dental Clinic", website: "https://dental.com" },
      ]);
    } catch (err) {
      missingCategoryFailed = String(err).includes("missing required fields") && String(err).includes("category");
    }
    check(missingCategoryFailed, "validateMapsActorOutput fails when category is missing");
  }

  // Reset test client
  setApifyClientForTesting(null);

  console.log(`\n========================================`);
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner encountered unhandled error:", err);
  process.exit(1);
});
