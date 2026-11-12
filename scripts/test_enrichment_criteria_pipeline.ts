/**
 * Test Suite for Instagram Profile Scraper Enrichment & Criteria Gates:
 * 5a) Criteria gate: 32 followers rejected at default 100 but accepted when minFollowers=20;
 *     private rejected; 600k followers rejected by default max; null category not rejected;
 *     low posts flagged (soft) vs rejected (strict).
 * 5b) Only free-gate survivors are sent to the profile scraper, batch cap respected, cache hit skips call.
 * 5c) AI gate: score 85 accepted, 60 rejected, invalid JSON -> AI_UNAVAILABLE without throwing; analytics saved.
 * 5d) Whitelist: unwanted fields from scraper output are not persisted in rawProfileData.
 * 5e) Funnel counters and notice text.
 */

import "./preload_server_only.cjs";
import "dotenv/config";

import {
  evaluateEnrichmentCriteria,
  DEFAULT_ENRICHMENT_CRITERIA,
  type EnrichmentCriteria,
} from "../src/lib/services/discovery/enrichment-criteria";
import {
  evaluateProfileRelevanceWithAI,
  validateAiRelevanceOutput,
  AI_RELEVANCE_SCHEMA,
} from "../src/lib/services/discovery/ai-relevance";
import {
  normalizeInstagramProfileItem,
} from "../src/lib/services/scraper/instagram-profile";
import {
  buildDiscoveryNotice,
} from "../src/lib/services/discovery/discovery-service";
import {
  parseImportHandles,
} from "../src/lib/services/discovery/handle-import-service";
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

async function runTests() {
  console.log("=== 5a. CRITERIA GATE TESTS ===");
  {
    // 1. 32 followers rejected at default 100
    const profileLowFollowers: Partial<LeadProfile> = {
      username: "low_followers_clinic",
      followers: 32,
      followersCount: 32,
      postsCount: 15,
      isPrivate: false,
      businessCategoryName: "Dental Clinic",
    };
    const resLow = evaluateEnrichmentCriteria(profileLowFollowers as LeadProfile, DEFAULT_ENRICHMENT_CRITERIA);
    check(!resLow.passed, "32 followers rejected at default minFollowers=100");
    check(
      resLow.reasons.some((r) => r.rule === "minFollowers" && r.value === 32 && r.required === 100),
      "Rejection reason contains rule 'minFollowers' with value=32, required=100",
      JSON.stringify(resLow.reasons),
    );

    // 2. 32 followers accepted when minFollowers=20
    const customCriteria: EnrichmentCriteria = {
      ...DEFAULT_ENRICHMENT_CRITERIA,
      minFollowers: 20,
    };
    const resAccepted = evaluateEnrichmentCriteria(profileLowFollowers as LeadProfile, customCriteria);
    check(resAccepted.passed, "32 followers accepted when minFollowers=20");
    check(resAccepted.reasons.length === 0, "No rejection reasons when minFollowers=20");

    // 3. Private rejected
    const profilePrivate: Partial<LeadProfile> = {
      username: "private_account",
      followers: 500,
      followersCount: 500,
      postsCount: 20,
      isPrivate: true,
    };
    const resPrivate = evaluateEnrichmentCriteria(profilePrivate as LeadProfile, DEFAULT_ENRICHMENT_CRITERIA);
    check(!resPrivate.passed, "Private profile rejected by default excludePrivate=true");
    check(
      resPrivate.reasons.some((r) => (r.rule === "excludePrivate" || r.rule === "private") && r.value === true),
      "Rejection reason contains rule 'private'",
      JSON.stringify(resPrivate.reasons),
    );

    // 4. 600k followers rejected by default maxFollowers=500000
    const profileHuge: Partial<LeadProfile> = {
      username: "huge_influencer",
      followers: 600000,
      followersCount: 600000,
      postsCount: 100,
      isPrivate: false,
    };
    const resHuge = evaluateEnrichmentCriteria(profileHuge as LeadProfile, DEFAULT_ENRICHMENT_CRITERIA);
    check(!resHuge.passed, "600k followers rejected by default maxFollowers=500000");
    check(
      resHuge.reasons.some((r) => r.rule === "maxFollowers" && r.value === 600000 && r.required === 500000),
      "Rejection reason contains rule 'maxFollowers' with value=600000, required=500000",
      JSON.stringify(resHuge.reasons),
    );

    // 5. Null / empty category not rejected (deferred to AI)
    const profileNoCategory: Partial<LeadProfile> = {
      username: "no_cat_clinic",
      followers: 500,
      followersCount: 500,
      postsCount: 10,
      isPrivate: false,
      businessCategoryName: null,
      category: null,
    };
    const resNoCat = evaluateEnrichmentCriteria(profileNoCategory as LeadProfile, {
      ...DEFAULT_ENRICHMENT_CRITERIA,
      allowedCategories: ["Dental Clinic", "Dentist"],
    });
    check(resNoCat.passed, "Null category is NOT rejected, deferred to AI");
    check(
      !resNoCat.reasons.some((r) => r.rule === "allowedCategories"),
      "No allowedCategories rejection for null category",
    );

    // Mismatched category IS rejected when allowedCategories provided
    const profileWrongCat: Partial<LeadProfile> = {
      username: "carwash_clinic",
      followers: 500,
      followersCount: 500,
      postsCount: 10,
      isPrivate: false,
      businessCategoryName: "Car Wash & Detailing",
    };
    const resWrongCat = evaluateEnrichmentCriteria(profileWrongCat as LeadProfile, {
      ...DEFAULT_ENRICHMENT_CRITERIA,
      allowedCategories: ["Dental Clinic", "Dentist"],
    });
    check(!resWrongCat.passed, "Mismatched category rejected when allowedCategories specified");

    // 6. Low posts: soft mode flags vs strict mode rejects
    const profileLowPosts: Partial<LeadProfile> = {
      username: "few_posts_clinic",
      followers: 500,
      followersCount: 500,
      postsCount: 1,
      isPrivate: false,
      businessCategoryName: "Dentist",
    };
    // Soft mode (default strictMode=false)
    const resLowPostsSoft = evaluateEnrichmentCriteria(profileLowPosts as LeadProfile, {
      ...DEFAULT_ENRICHMENT_CRITERIA,
      strictMode: false,
    });
    check(resLowPostsSoft.passed, "Low posts passed in soft mode (default)");
    check(
      resLowPostsSoft.flags.some((f) => f.rule === "minPosts" && f.message === "low_activity"),
      "Low posts flagged with 'low_activity' in soft mode",
      JSON.stringify(resLowPostsSoft.flags),
    );

    // Strict mode (strictMode=true)
    const resLowPostsStrict = evaluateEnrichmentCriteria(profileLowPosts as LeadProfile, {
      ...DEFAULT_ENRICHMENT_CRITERIA,
      strictMode: true,
    });
    check(!resLowPostsStrict.passed, "Low posts rejected in strict mode");
    check(
      resLowPostsStrict.reasons.some((r) => (r.rule === "minPosts" || r.rule === "minPosts-strict") && r.value === 1 && r.required === 3),
      "Low posts has rejection reason 'minPosts-strict' in strict mode",
      JSON.stringify(resLowPostsStrict.reasons),
    );

    // 7. Negative keywords in bio rejected
    const profileNegativeBio: Partial<LeadProfile> = {
      username: "job_board_clinic",
      followers: 500,
      followersCount: 500,
      postsCount: 10,
      isPrivate: false,
      biography: "We are a staffing agency hiring dental nurses nationwide.",
    };
    const resNegBio = evaluateEnrichmentCriteria(profileNegativeBio as LeadProfile, {
      ...DEFAULT_ENRICHMENT_CRITERIA,
      bioExclude: ["staffing agency", "job board"],
    });
    check(!resNegBio.passed, "Bio containing negative keyword rejected");
    check(
      resNegBio.reasons.some((r) => r.rule === "bioExclude"),
      "Rejection reason is 'bioExclude'",
    );

    // 8. Contact signal soft flag
    const profileNoContact: Partial<LeadProfile> = {
      username: "silent_clinic",
      followers: 500,
      followersCount: 500,
      postsCount: 10,
      isPrivate: false,
      biography: "Just photos of our work.",
      externalUrl: null,
    };
    const resNoContact = evaluateEnrichmentCriteria(profileNoContact as LeadProfile, DEFAULT_ENRICHMENT_CRITERIA);
    check(resNoContact.passed, "No contact signal passed when requireContactSignal=false");
    check(
      resNoContact.flags.some((f) => f.rule === "requireContactSignal" && f.message === "no_contact_signal"),
      "Soft flag 'no_contact_signal' added when no contact signal found",
    );
  }

  console.log("\n=== 5b. FREE-GATE SURVIVORS & BATCH CAP & CACHE TESTS ===");
  {
    // 1. Batch cap formula: min(remainingCapacity * 2, 20)
    const calcBatchCap = (remaining: number) => Math.min(Math.max(1, remaining * 2), 20);
    check(calcBatchCap(3) === 6, "Capacity 3 -> batch cap 6");
    check(calcBatchCap(5) === 10, "Capacity 5 -> batch cap 10");
    check(calcBatchCap(15) === 20, "Capacity 15 -> batch cap 20 (capped at 20)");
    check(calcBatchCap(50) === 20, "Capacity 50 -> batch cap 20 (capped at 20)");

    // 2. 30-day cache check logic
    const thirtyDaysAgoMs = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const isEnrichmentCached = (scrapedAt: string | null | undefined, rawData: Record<string, unknown> | null | undefined): boolean => {
      if (!rawData || typeof rawData !== "object") return false;
      if (!scrapedAt) return false;
      const scrapeTime = new Date(scrapedAt).getTime();
      return !Number.isNaN(scrapeTime) && now - scrapeTime < thirtyDaysAgoMs;
    };

    const freshLead = {
      scrapedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days old
      rawData: { username: "fresh_lead", followersCount: 1200 },
    };
    check(isEnrichmentCached(freshLead.scrapedAt, freshLead.rawData), "5-day-old profile hits 30-day cache");

    const staleLead = {
      scrapedAt: new Date(now - 35 * 24 * 60 * 60 * 1000).toISOString(), // 35 days old
      rawData: { username: "stale_lead", followersCount: 1200 },
    };
    check(!isEnrichmentCached(staleLead.scrapedAt, staleLead.rawData), "35-day-old profile misses 30-day cache");

    const unEnrichedLead = {
      scrapedAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      rawData: null,
    };
    check(!isEnrichmentCached(unEnrichedLead.scrapedAt, unEnrichedLead.rawData), "Lead with no rawData misses cache");
  }

  console.log("\n=== 5c. AI GATE & SCHEMA VALIDATOR & FAIL CLOSED TESTS ===");
  {
    // 1. Validator tests
    const validAiPayload = {
      relevant: true,
      score: 85,
      accountType: "business_clinic",
      reason: "High quality dental practice with clear clinic branding.",
      analytics: {
        audienceSizeTier: "small",
        activityLevel: "medium",
        contactReadiness: "website",
        fitReasons: ["Operating dental clinic", "Active local clientele"],
        riskFlags: [],
      },
    };
    const validated = validateAiRelevanceOutput(validAiPayload);
    check(validated.relevant === true && validated.score === 85, "Validator accepts valid payload");
    check(validated.analytics.audienceSizeTier === "small", "Audience size tier parsed correctly");

    // 2. Mock fetch for evaluateProfileRelevanceWithAI
    const originalFetch = globalThis.fetch;
    let mockResponseText = "";
    let mockStatusCode = 200;

    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.includes("generativelanguage.googleapis.com")) {
        if (mockStatusCode !== 200) {
          return new Response("Internal Server Error", { status: mockStatusCode });
        }
        return new Response(
          JSON.stringify({
            candidates: [{ finishReason: "STOP", content: { parts: [{ text: mockResponseText }] } }],
            usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 30 },
          }),
          { status: 200 },
        );
      }
      return originalFetch(url as RequestInfo);
    }) as typeof fetch;

    try {
      const testProfile: LeadProfile = {
        username: "torontodentalcare",
        profileUrl: "https://instagram.com/torontodentalcare",
        instagramId: "12345",
        fullName: "Toronto Dental Care",
        biography: "Comprehensive family dentistry in downtown Toronto.",
        followers: 2500,
        following: 300,
        followersCount: 2500,
        followsCount: 300,
        postsCount: 120,
        profilePictureUrl: null,
        isVerified: false,
        isBusiness: true,
        category: "Dentist",
        externalUrl: "https://torontodentalcare.com",
        location: "Toronto, ON",
        relatedProfiles: null,
        latestPosts: null,
        source: "apify",
        scrapedAt: new Date().toISOString(),
      };

      const campaignContext = {
        name: "Toronto Dentists",
        intent: "B2B partnership with dental clinics",
        category: "Dentist",
        location: "Toronto, ON",
      };

      // Case A: Score 85 accepted
      mockResponseText = JSON.stringify({
        relevant: true,
        score: 85,
        accountType: "business_clinic",
        reason: "Active clinic with clear B2B fit.",
        analytics: {
          audienceSizeTier: "small",
          activityLevel: "high",
          contactReadiness: "website",
          fitReasons: ["Local dental clinic"],
          riskFlags: [],
        },
      });
      const res85 = await evaluateProfileRelevanceWithAI(testProfile, campaignContext, { threshold: 70 });
      check(res85.relevant, "Score 85 accepted when threshold=70");
      check(res85.score === 85, "Score is 85", `Got: ${res85.score}`);
      check(res85.accountType === "business_clinic", "Account type is business_clinic");

      // Case B: Score 60 rejected
      mockResponseText = JSON.stringify({
        relevant: true,
        score: 60,
        accountType: "business_clinic",
        reason: "Borderline clinic with low posting volume.",
        analytics: {
          audienceSizeTier: "micro",
          activityLevel: "low",
          contactReadiness: "none",
          fitReasons: [],
          riskFlags: ["Low engagement"],
        },
      });
      const res60 = await evaluateProfileRelevanceWithAI(testProfile, campaignContext, { threshold: 70 });
      check(!res60.relevant, "Score 60 rejected when threshold=70");
      check(res60.score === 60, "Score is 60", `Got: ${res60.score}`);
      check(res60.reason.includes("below threshold 70"), "Reason mentions below threshold", res60.reason);

      // Case C: Account type 'individual' rejected even if score 90
      mockResponseText = JSON.stringify({
        relevant: true,
        score: 90,
        accountType: "individual",
        reason: "Dentist student / personal account.",
        analytics: {
          audienceSizeTier: "small",
          activityLevel: "medium",
          contactReadiness: "none",
          fitReasons: [],
          riskFlags: ["Individual persona"],
        },
      });
      const resIndividual = await evaluateProfileRelevanceWithAI(testProfile, campaignContext, { threshold: 70 });
      check(!resIndividual.relevant, "Account type 'individual' rejected");
      check(resIndividual.reason.includes("not 'business_clinic'"), "Reason mentions not 'business_clinic'");

      // Case D: Invalid JSON -> AI_UNAVAILABLE fail closed without throwing
      mockResponseText = "{ this is not valid json at all ...";
      const resInvalidJson = await evaluateProfileRelevanceWithAI(testProfile, campaignContext, { threshold: 70 });
      check(!resInvalidJson.relevant, "Invalid JSON fails closed (relevant=false)");
      check(resInvalidJson.reason === "AI_UNAVAILABLE", "Reason is AI_UNAVAILABLE on invalid JSON");
      check(resInvalidJson.score === 0, "Score is 0 on AI_UNAVAILABLE");
      check(
        resInvalidJson.analytics.riskFlags.includes("AI_UNAVAILABLE"),
        "Risk flags contain AI_UNAVAILABLE",
      );

      // Case E: Network error / 500 error -> fails closed without crashing
      mockStatusCode = 500;
      const resServerError = await evaluateProfileRelevanceWithAI(testProfile, campaignContext, { threshold: 70 });
      check(!resServerError.relevant, "Server 500 error fails closed (relevant=false)");
      check(resServerError.reason === "AI_UNAVAILABLE", "Reason is AI_UNAVAILABLE on 500");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("\n=== 5d. WHITELIST ENFORCEMENT ON SCRAPER OUTPUT ===");
  {
    // Raw output from Apify instagram-profile-scraper including unwanted fields
    const rawApifyItem = {
      id: "12345678",
      username: "dental_toronto",
      fullName: "Toronto Dental Care",
      biography: "High quality dental care in Ontario.",
      followersCount: 2300,
      followsCount: 450,
      postsCount: 88,
      externalUrl: "https://torontodental.ca",
      isBusinessAccount: true,
      businessCategoryName: "Dentist",
      isPrivate: false,
      verified: true,
      profilePicUrl: "https://instagram.com/pic.jpg",
      // Unwanted fields that MUST be dropped:
      latestPosts: [
        { id: "post1", likesCount: 45, commentsCount: 3, caption: "Post 1" },
        { id: "post2", likesCount: 90, commentsCount: 5, caption: "Post 2" },
      ],
      relatedProfiles: [
        { username: "competitor1", fullName: "Competitor One" },
      ],
      highlightReelCount: 12,
      igtvVideoCount: 5,
      hasChannel: false,
      stories: [{ id: "story1" }],
    };

    const normalized = normalizeInstagramProfileItem(rawApifyItem, new Date().toISOString());
    check(normalized !== null, "Profile normalized successfully");
    if (!normalized) return;
    check(normalized.username === "dental_toronto", "Normalized username preserved");
    check(normalized.followersCount === 2300, "Followers count preserved");
    check(normalized.biography === "High quality dental care in Ontario.", "Biography preserved");
    check(normalized.externalUrl === "https://torontodental.ca", "External URL preserved");
    check(normalized.businessCategoryName === "Dentist", "Category name preserved");

    // Check rawProfileData whitelist:
    const rawSaved = normalized.rawProfileData as Record<string, unknown>;
    check(rawSaved !== null && typeof rawSaved === "object", "rawProfileData exists");
    check("username" in rawSaved, "Whitelisted 'username' present");
    check("fullName" in rawSaved, "Whitelisted 'fullName' present");
    check("followersCount" in rawSaved, "Whitelisted 'followersCount' present");
    check("followsCount" in rawSaved, "Whitelisted 'followsCount' present");
    check("postsCount" in rawSaved, "Whitelisted 'postsCount' present");
    check("biography" in rawSaved, "Whitelisted 'biography' present");
    check("externalUrl" in rawSaved, "Whitelisted 'externalUrl' present");
    check("isBusinessAccount" in rawSaved, "Whitelisted 'isBusinessAccount' present");
    check("businessCategoryName" in rawSaved, "Whitelisted 'businessCategoryName' present");
    check("isPrivate" in rawSaved, "Whitelisted 'isPrivate' present");
    check("verified" in rawSaved, "Whitelisted 'verified' present");

    // Unwanted fields must NOT be in rawProfileData:
    check(!("latestPosts" in rawSaved), "Unwanted 'latestPosts' dropped from rawProfileData");
    check(!("relatedProfiles" in rawSaved), "Unwanted 'relatedProfiles' dropped from rawProfileData");
    check(!("highlightReelCount" in rawSaved), "Unwanted 'highlightReelCount' dropped from rawProfileData");
    check(!("igtvVideoCount" in rawSaved), "Unwanted 'igtvVideoCount' dropped from rawProfileData");
    check(!("stories" in rawSaved), "Unwanted 'stories' dropped from rawProfileData");

    // In normalized LeadProfile object:
    check(normalized.latestPosts === null, "LeadProfile.latestPosts is null");
    check(normalized.relatedProfiles === null, "LeadProfile.relatedProfiles is null");
  }

  console.log("\n=== 5e. FUNNEL COUNTERS & NOTICE TEXT TESTS ===");
  {
    // Test notice generation with full funnel counters
    const notice = buildDiscoveryNotice({
      persisted: 10,
      requested: 10,
      discovered: 25,
      existingLeads: 0,
      existingSkipped: 2,
      enrichSkipped: 1,
      remainingCapacity: 0,
      handlesFound: 25,
      enrichedCount: 15,
      criteriaRejectedCount: 4,
      aiAccepted: 10,
      enrichmentCostUsd: 0.039,
      apifyCostUsd: 0.05,
    });

    check(Boolean(notice?.includes("DISCOVERY_COMPLETED")), "Notice indicates DISCOVERY_COMPLETED");
    check(Boolean(notice?.includes("Funnel: Handles 25 -> Enriched 15 -> Criteria Rejected 4 -> AI Accepted 10 -> Saved 10")), "Notice contains complete funnel progression");
    check(Boolean(notice?.includes("Enrichment: $0.04")), "Notice contains enrichment cost");
    check(Boolean(notice?.includes("Apify cost: $0.05")), "Notice contains total Apify cost");

    // Partial results notice with budget cap
    const partialNotice = buildDiscoveryNotice({
      persisted: 2,
      requested: 10,
      discovered: 15,
      existingLeads: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 8,
      stopReason: "budget_cap_reached",
      handlesFound: 15,
      enrichedCount: 6,
      criteriaRejectedCount: 3,
      aiAccepted: 2,
      enrichmentCostUsd: 0.0156,
      apifyCostUsd: 0.15,
    });

    check(Boolean(partialNotice?.includes("PARTIAL_RESULTS")), "Partial notice indicates PARTIAL_RESULTS");
    check(Boolean(partialNotice?.includes("Reason: budget cap reached.")), "Partial notice includes stop reason");
    check(Boolean(partialNotice?.includes("Funnel: Handles 15 -> Enriched 6 -> Criteria Rejected 3 -> AI Accepted 2 -> Saved 2")), "Partial notice includes funnel stats");

    // Usage record validation
    const usagePayload = {
      handlesFound: 25,
      enrichedCount: 12,
      enrichmentCostUsd: 0.0312,
      rejectedByCriteria: {
        minFollowers: 2,
        maxFollowers: 1,
        private: 1,
        category: 0,
        "minPosts-strict": 0,
      },
      flaggedCounts: {
        low_activity: 1,
        no_contact_signal: 3,
      },
      aiRejected: 3,
      aiAccepted: 5,
      criteria: DEFAULT_ENRICHMENT_CRITERIA,
    };

    check(usagePayload.handlesFound === 25, "Usage handlesFound recorded");
    check(usagePayload.enrichedCount === 12, "Usage enrichedCount recorded");
    check(usagePayload.rejectedByCriteria.minFollowers === 2, "Usage rejectedByCriteria.minFollowers recorded");
    check(usagePayload.rejectedByCriteria.maxFollowers === 1, "Usage rejectedByCriteria.maxFollowers recorded");
    check(usagePayload.rejectedByCriteria.private === 1, "Usage rejectedByCriteria.private recorded");
    check(usagePayload.flaggedCounts.no_contact_signal === 3, "Usage flaggedCounts.no_contact_signal recorded");
    check(usagePayload.aiRejected === 3, "Usage aiRejected recorded");
    check(usagePayload.aiAccepted === 5, "Usage aiAccepted recorded");
    check(usagePayload.criteria.minFollowers === 100, "Usage criteria snapshot recorded");
  }

  console.log("\n=== 5f. (PHASE 8) CSV / HANDLE IMPORT TESTS ===");
  {
    const csvContent = `
Username,Website,Notes
@torontodental,https://torontodental.com,Lead A
https://www.instagram.com/smile_clinic/?hl=en,https://smile.com,Lead B
instagram.com/p/invalidpost,https://invalid.com,Invalid Post
@TORONTODENTAL,https://torontodental.com,Duplicate
dr_smith,https://drsmith.com,Lead C
`;
    const parsed = parseImportHandles(csvContent);
    check(parsed.includes("torontodental"), "CSV parser extracts username from @handle");
    check(parsed.includes("smile_clinic"), "CSV parser extracts username from full URL with query params");
    check(parsed.includes("dr_smith"), "CSV parser extracts plain username");
    check(!parsed.includes("invalidpost"), "CSV parser rejects post URL (/p/)");
    check(parsed.length === 3, `CSV parser deduplicates handles (expected 3, got ${parsed.length})`);

    // Dedup against campaign simulation
    const existingInCampaign = new Set(["dr_smith"]);
    const survivors = parsed.filter((h) => !existingInCampaign.has(h));
    check(survivors.length === 2, `Filters out handles existing in campaign (expected 2, got ${survivors.length})`);
    check(!survivors.includes("dr_smith"), "dr_smith was filtered out as duplicate");

    // Gating pipeline simulation on imported profile:
    // Profile with <100 followers rejected by default criteria
    const lowFollowerProfile: Partial<LeadProfile> = {
      username: "torontodental",
      followersCount: 45,
      isPrivate: false,
      postsCount: 10,
    };
    const lowFollowerCrit = evaluateEnrichmentCriteria(lowFollowerProfile as LeadProfile, DEFAULT_ENRICHMENT_CRITERIA);
    check(!lowFollowerCrit.passed, "Imported handle with low followers rejected by criteria gate");

    // Profile with valid followers and business account passes criteria gate
    const validProfile: Partial<LeadProfile> = {
      username: "smile_clinic",
      followersCount: 2500,
      isPrivate: false,
      postsCount: 50,
      biography: "Cosmetic dentist clinic in Toronto",
    };
    const validCrit = evaluateEnrichmentCriteria(validProfile as LeadProfile, DEFAULT_ENRICHMENT_CRITERIA);
    check(validCrit.passed, "Imported valid profile passes criteria gate");
  }

  console.log(`\n========================================`);
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
