/**
 * Pre-enrichment relevance filter test suite.
 *
 * Verifies that:
 * 1. Candidates with clear search-stage mismatches (wrong category, explicit contradicting
 *    location in bio snippet or businessAddress) are rejected pre-enrichment as PRE_ENRICHMENT_REJECTED.
 * 2. Candidates with ambiguous or missing search-stage signals (empty bio, short bio < 15 chars,
 *    absent location, unmentioned category) proceed to enrichment (zero false negatives).
 * 3. Regression fixtures from real campaigns (e.g. Rawalpindi fitness) behave correctly.
 * 4. Funnel counters and skip breakdowns properly separate PRE_ENRICHMENT_REJECTED from
 *    post-enrichment IRRELEVANT_* reasons.
 */

import {
  prefilterCandidate,
  type PreFilterResult,
  type RelevanceCampaignContext,
  type DiscoverySkipCounts,
  createEmptySkipCounts,
  sumSkipCounts,
  DISCOVERY_SKIP_REASONS,
} from "../src/lib/services/discovery/lead-relevance";
import type { DiscoveredProfile } from "../src/lib/services/discovery/discovery-provider";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}`);
    failed++;
  }
}

function assertReject(
  res: PreFilterResult,
  name: string,
): asserts res is Extract<PreFilterResult, { action: "REJECT" }> {
  check(res.action === "REJECT", name);
}

const FITNESS_CAMPAIGN: RelevanceCampaignContext = {
  intent: "fitness gyms and fitness trainers",
  location: "Rawalpindi",
  category: "Fitness",
};

const DENTAL_CAMPAIGN: RelevanceCampaignContext = {
  intent: "dental clinic dentist teeth whitening",
  location: "Austin, TX",
  category: "Dentist",
};

async function main(): Promise<void> {
  console.log("=================================================================");
  console.log("   PRE-ENRICHMENT RELEVANCE FILTER TEST SUITE                    ");
  console.log("=================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. CLEAR SEARCH-STAGE MISMATCHES (MUST REJECT)
  // ---------------------------------------------------------------------------
  console.log("[1. Clear search-stage mismatches -> REJECT]");

  // A. Explicit contradicting location in location field
  const foreignLocationCand: DiscoveredProfile = {
    username: "taipei_coffee_house",
    profileUrl: "https://www.instagram.com/taipei_coffee_house",
    location: "Taipei, Taiwan",
    category: "Coffee Shop",
    biography: "Artisan specialty coffee and brunch in Taipei",
  };
  const res1 = prefilterCandidate(foreignLocationCand, FITNESS_CAMPAIGN);
  assertReject(res1, "Candidate with Taipei location is rejected");
  check(res1.reason === "PRE_ENRICHMENT_REJECTED", "Rejection reason is PRE_ENRICHMENT_REJECTED");
  check(res1.underlyingReason === "IRRELEVANT_LOCATION", "Underlying reason is IRRELEVANT_LOCATION");

  // B. Explicit contradicting location in businessAddress (city_name)
  const surabayaCand: DiscoveredProfile = {
    username: "surabaya_gym",
    profileUrl: "https://www.instagram.com/surabaya_gym",
    category: "Fitness Trainer",
    businessAddress: { city_name: "Surabaya" },
    biography: "Gym and personal training center in Surabaya East Java",
  };
  const res2 = prefilterCandidate(surabayaCand, FITNESS_CAMPAIGN);
  assertReject(res2, "Candidate with businessAddress in Surabaya is rejected for Rawalpindi campaign");
  check(res2.underlyingReason === "IRRELEVANT_LOCATION", "Underlying reason is IRRELEVANT_LOCATION from businessAddress");

  // C. National scale account mismatch (media/magazine giant with >500k followers)
  const nationalMediaCand: DiscoveredProfile = {
    username: "global_sports_news",
    profileUrl: "https://www.instagram.com/global_sports_news",
    fullName: "Global Sports News",
    category: "News & Media Website",
    biography: "Breaking sports news, athlete interviews, and fitness highlights around the world",
    followersCount: 2_000_000,
    followers: 2_000_000,
  };
  const res3 = prefilterCandidate(nationalMediaCand, FITNESS_CAMPAIGN);
  assertReject(res3, "National/global media account with >500k followers is rejected pre-enrichment");
  check(
    res3.underlyingReason === "IRRELEVANT_LOCATION_NATIONAL_SCALE",
    "Underlying reason is IRRELEVANT_LOCATION_NATIONAL_SCALE",
  );

  // C2. Huge global entity with irrelevant intent (e.g. Manchester United)
  const manUtdCand: DiscoveredProfile = {
    username: "manutd",
    profileUrl: "https://www.instagram.com/manutd",
    fullName: "Manchester United",
    category: "Sports Club",
    biography: "Official Manchester United Football Club account",
    followersCount: 63_000_000,
    followers: 63_000_000,
  };
  const resManUtd = prefilterCandidate(manUtdCand, FITNESS_CAMPAIGN);
  assertReject(resManUtd, "Manchester United is rejected pre-enrichment");
  check(resManUtd.reason === "PRE_ENRICHMENT_REJECTED", "Rejection reason is PRE_ENRICHMENT_REJECTED");

  // D. Conflicting category + 0 intent match
  const musicianCand: DiscoveredProfile = {
    username: "sample_singer",
    profileUrl: "https://www.instagram.com/sample_singer",
    fullName: "Singer Artist",
    businessCategoryName: "Musician/Band",
    category: "Musician/Band",
    biography: "Singer, songwriter, live music performances and upcoming tour tickets",
  };
  const res4 = prefilterCandidate(musicianCand, FITNESS_CAMPAIGN);
  assertReject(res4, "Musician/Band category with zero fitness overlap is rejected");
  check(res4.underlyingReason === "IRRELEVANT_CATEGORY", "Underlying reason is IRRELEVANT_CATEGORY");

  // E. Long bio (>=15 chars) with zero intent overlap
  const realEstateCand: DiscoveredProfile = {
    username: "realtor_properties",
    profileUrl: "https://www.instagram.com/realtor_properties",
    biography: "Luxury residential homes, luxury apartments, and commercial real estate brokerage",
  };
  const res5 = prefilterCandidate(realEstateCand, FITNESS_CAMPAIGN);
  assertReject(res5, "Real estate bio with 0 fitness overlap rejected for intent");
  check(res5.underlyingReason === "IRRELEVANT_INTENT", "Underlying reason is IRRELEVANT_INTENT");

  // ---------------------------------------------------------------------------
  // 2. CONSERVATIVE BEHAVIOR: AMBIGUOUS & MISSING DATA (MUST PROCEED)
  // ---------------------------------------------------------------------------
  console.log("\n[2. Ambiguous & missing search data -> PROCEED (no false negatives)]");

  // A. Empty metadata (only username)
  const emptyCand: DiscoveredProfile = {
    username: "mystery_lead_123",
    profileUrl: "https://www.instagram.com/mystery_lead_123",
  };
  const resEmpty = prefilterCandidate(emptyCand, FITNESS_CAMPAIGN);
  check(resEmpty.action === "PROCEED", "Empty candidate proceeds to enrichment");

  // B. Short bio (< 15 chars) — insufficient signal to reject
  const shortBioCand: DiscoveredProfile = {
    username: "short_bio_coach",
    profileUrl: "https://www.instagram.com/short_bio_coach",
    biography: "DM for info", // 11 chars
  };
  const resShort = prefilterCandidate(shortBioCand, FITNESS_CAMPAIGN);
  check(resShort.action === "PROCEED", "Short bio (<15 chars) proceeds to enrichment rather than false reject");

  // C. Missing location in candidate — allowed because allowUnknownLocation is true
  const noLocGym: DiscoveredProfile = {
    username: "elite_crossfit_box",
    profileUrl: "https://www.instagram.com/elite_crossfit_box",
    biography: "Crossfit, strength training, HIIT conditioning and community workouts",
    category: "Gym/Physical Fitness Center",
  };
  const resNoLoc = prefilterCandidate(noLocGym, FITNESS_CAMPAIGN);
  check(resNoLoc.action === "PROCEED", "Candidate matching fitness with absent location proceeds to enrichment");

  // D. Missing category in candidate — allowed because allowUnknownCategory is true
  const noCatGym: DiscoveredProfile = {
    username: "rawalpindi_muscle",
    profileUrl: "https://www.instagram.com/rawalpindi_muscle",
    biography: "Rawalpindi premier gym and fitness center. Personal coaching available.",
  };
  const resNoCat = prefilterCandidate(noCatGym, FITNESS_CAMPAIGN);
  check(resNoCat.action === "PROCEED", "Candidate with matching bio and no declared category proceeds to enrichment");

  // ---------------------------------------------------------------------------
  // 3. REAL SUCCESSFUL DISCOVERY REGRESSION FIXTURES
  // ---------------------------------------------------------------------------
  console.log("\n[3. Real successful discovery fixtures -> PROCEED]");

  // Real Rawalpindi fitness fixture
  const realGymFixture: DiscoveredProfile = {
    username: "paf_officers_gym",
    profileUrl: "https://www.instagram.com/paf_officers_gym",
    fullName: "PAF Officers Gym Rawalpindi",
    biography: "Official gym facility for officers. Fitness, cardio, bodybuilding in Rawalpindi.",
    category: "Gym/Physical Fitness Center",
    businessAddress: { city_name: "Rawalpindi" },
    followersCount: 4200,
  };
  const resGym = prefilterCandidate(realGymFixture, FITNESS_CAMPAIGN);
  check(resGym.action === "PROCEED", "Real Rawalpindi gym fixture proceeds to enrichment");

  // Real Austin dentist fixture
  const realDentistFixture: DiscoveredProfile = {
    username: "austin_smile_studio",
    profileUrl: "https://www.instagram.com/austin_smile_studio",
    fullName: "Austin Smile Studio",
    biography: "General & cosmetic dentistry in Austin TX. Teeth whitening, cleanings & implants.",
    category: "Dentist & Dental Clinic",
    location: "Austin, Texas",
    followersCount: 2300,
  };
  const resDentist = prefilterCandidate(realDentistFixture, DENTAL_CAMPAIGN);
  check(resDentist.action === "PROCEED", "Real Austin dentist fixture proceeds to enrichment");

  // Google Maps often declares "Dentist" while the campaign category is the
  // more descriptive plural "Dental Clinics". It must resolve to the dental
  // synonym group rather than being rejected as an irrelevant category.
  const googleMapsDentist: DiscoveredProfile = {
    username: "markham_dental_smiles",
    profileUrl: "https://www.instagram.com/markham_dental_smiles",
    fullName: "Markham Dental Smiles",
    biography: "Family dental clinic in Markham. Cleanings, implants and cosmetic dentistry.",
    category: "Dentist",
    location: "Markham, Ontario",
  };
  const pluralDentalCampaign: RelevanceCampaignContext = {
    ...DENTAL_CAMPAIGN,
    category: "Dental Clinics",
    location: "Markham, ON",
  };
  const resPluralDental = prefilterCandidate(googleMapsDentist, pluralDentalCampaign);
  check(
    resPluralDental.action === "PROCEED",
    "Google Maps 'Dentist' proceeds for campaign category 'Dental Clinics'",
  );

  // ---------------------------------------------------------------------------
  // 4. FUNNEL SKIP REASON TRACKING
  // ---------------------------------------------------------------------------
  console.log("\n[4. Funnel skip reason tracking & separation]");

  const skipCounts = createEmptySkipCounts();
  check(
    "PRE_ENRICHMENT_REJECTED" in skipCounts,
    "PRE_ENRICHMENT_REJECTED exists in createEmptySkipCounts()",
  );
  check(
    DISCOVERY_SKIP_REASONS.includes("PRE_ENRICHMENT_REJECTED"),
    "PRE_ENRICHMENT_REJECTED is listed in DISCOVERY_SKIP_REASONS",
  );

  // Simulate a discovery round with 5 candidates: 2 clear mismatches, 1 duplicate, 2 valid
  skipCounts.PRE_ENRICHMENT_REJECTED += 2;
  skipCounts.DUPLICATE += 1;
  skipCounts.IRRELEVANT_LOCATION += 1; // Post-enrichment location reject

  check(
    skipCounts.PRE_ENRICHMENT_REJECTED === 2,
    "PRE_ENRICHMENT_REJECTED tracks pre-enrichment rejections correctly",
  );
  check(
    skipCounts.IRRELEVANT_LOCATION === 1,
    "Post-enrichment IRRELEVANT_LOCATION is tracked separately",
  );
  check(
    sumSkipCounts(skipCounts) === 4,
    "sumSkipCounts includes PRE_ENRICHMENT_REJECTED alongside other skip reasons",
  );

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log("\n=================================================================");
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("=================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test failed with unhandled error:", err);
  process.exit(1);
});
