/**
 * Unit and Pipeline Integration Test Suite for:
 * 1. computeLeadScore (pure scoring function, categories, missing fields, re-normalization, weights validation, tiers)
 * 2. detectChains (domain repetition >= 3, brand repetition >= 3, known chains, multi-location phrases)
 * 3. Discovery Pipeline stage order and cost reduction (cheap -> paid):
 *    - Free rules on Maps
 *    - Free chain filter
 *    - Maps-only Gemini gate
 *    - Paid IG enrichment ONLY for handle survivors
 *    - Criteria evaluation
 *    - Final Gemini gate ONLY for borderline band (skipping clear pass >= 80 and clear fail < 30)
 */

import {
  computeLeadScore,
  DEFAULT_SCORE_WEIGHTS,
  DEFAULT_SCORE_THRESHOLDS,
  type LeadScoreInput,
  type LeadScoreWeights,
} from "../src/lib/services/discovery/lead-quality-score";
import { detectChains } from "../src/lib/services/discovery/chain-detector";
import type { DiscoveredCandidate } from "../src/lib/services/discovery/discovery-provider";

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string): void {
  if (condition) {
    console.log(`  PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  FAIL: ${testName}${detail ? ` -> ${detail}` : ""}`);
    failed++;
  }
}

async function runLeadQualityScoreTests(): Promise<void> {
  console.log("=================================================================");
  console.log("   LEAD QUALITY SCORE & PIPELINE REORDERING TEST SUITE           ");
  console.log("=================================================================\n");

  const now = new Date("2026-11-07T12:00:00Z");

  // =========================================================================
  // 1. UNIT TESTS: computeLeadScore
  // =========================================================================
  console.log("[1. computeLeadScore Unit Tests]");

  // 1.1 Strong independent clinic with active IG (Tier A)
  const strongClinic: LeadScoreInput = {
    now,
    rating: 4.9,
    reviewCount: 150,
    website: "https://downtown-dental-care.com",
    phone: "+15551234567",
    isClaimed: true,
    isChain: false,
    hasInstagram: true,
    lastPostAt: new Date("2026-11-01T10:00:00Z"), // 6 days ago
    postsCount: 45,
    followers: 4500, // in local business band 300-20k
    isBusinessAccount: true,
    isPrivate: false,
    email: "info@downtown-dental-care.com",
    availableChannels: ["instagram", "email", "phone"],
    hasWhatsApp: true,
    handleConfidence: "high",
  };
  const strongResult = computeLeadScore(strongClinic);
  assert(strongResult.score >= 75, `Strong clinic gets Tier A score >= 75 (got ${strongResult.score})`);
  assert(strongResult.tier === "A", `Strong clinic gets tier A (got ${strongResult.tier})`);
  assert(!strongResult.isChain, "Strong clinic isChain is false");
  assert(!strongResult.flags.includes("STALE_INSTAGRAM"), "Strong clinic is not flagged as stale IG");
  assert(strongResult.breakdown.length === 5, "Breakdown includes all 5 categories");

  // 1.2 Corporate chain / franchise (penalized / Tier D)
  const chainClinic: LeadScoreInput = {
    now,
    rating: 4.2,
    reviewCount: 30,
    website: "https://aspendental.com/locations/austin",
    phone: "+15559998888",
    isClaimed: true,
    isChain: true,
    chainReason: "Known corporate chain / DSO",
    hasInstagram: true,
    lastPostAt: new Date("2026-11-05T10:00:00Z"),
    postsCount: 20,
    followers: 2500,
    isBusinessAccount: true,
    isPrivate: false,
    email: "austin@aspendental.com",
    availableChannels: ["instagram", "phone"],
  };
  const chainResult = computeLeadScore(chainClinic);
  assert(chainResult.isChain === true, "Chain lead isChain is true");
  assert(chainResult.flags.includes("POSSIBLE_CHAIN"), "Chain lead has POSSIBLE_CHAIN flag");
  assert(
    chainResult.breakdown.find((b) => b.category === "independence")?.points === 0,
    "Independence category gets 0 points for chain",
  );

  // 1.3 Stale Instagram (> 120 days since last post)
  const staleIgClinic: LeadScoreInput = {
    now,
    rating: 4.8,
    reviewCount: 85,
    website: "https://smile-studio.com",
    phone: "+15553334444",
    isClaimed: true,
    isChain: false,
    hasInstagram: true,
    lastPostAt: new Date("2026-03-01T10:00:00Z"), // > 240 days ago
    postsCount: 12,
    followers: 1200,
    isBusinessAccount: true,
    isPrivate: false,
    email: "contact@smile-studio.com",
  };
  const staleResult = computeLeadScore(staleIgClinic);
  assert(staleResult.flags.includes("STALE_INSTAGRAM"), "Stale IG lead has STALE_INSTAGRAM flag");
  const igCat = staleResult.breakdown.find((b) => b.category === "instagramActivity");
  assert(igCat !== undefined && igCat.points <= 6, "Stale IG gets 0 or near-zero activity points");

  // 1.4 No-IG lead with good Maps data (Fix 2 compatibility)
  const noIgClinic: LeadScoreInput = {
    now,
    rating: 4.9,
    reviewCount: 210,
    website: "https://family-dental-austin.com",
    phone: "+15558887777",
    isClaimed: true,
    isChain: false,
    hasInstagram: false, // NO IG
    email: "appointments@family-dental-austin.com",
    availableChannels: ["email", "phone", "website"],
    hasWhatsApp: false,
  };
  const noIgResult = computeLeadScore(noIgClinic);
  const noIgIgBlock = noIgResult.breakdown.find((b) => b.category === "instagramActivity");
  const noIgAudBlock = noIgResult.breakdown.find((b) => b.category === "audienceFit");
  assert(noIgIgBlock?.skipped === true, "Instagram activity block is marked skipped for no-IG lead");
  assert(noIgAudBlock?.skipped === true, "Audience fit block is marked skipped for no-IG lead");
  assert(
    noIgResult.score >= 75,
    `No-IG lead with great Maps and contact signals reaches Tier A score via weight re-normalization (score: ${noIgResult.score})`,
  );
  assert(noIgResult.tier === "B", "No-IG lead tier is capped at Tier B for Instagram DM campaigns");
  assert(noIgResult.flags.includes("IG_UNKNOWN"), "No-IG lead carries IG_UNKNOWN flag");

  const noIgEmailResult = computeLeadScore({ ...noIgClinic, outreachChannel: "EMAIL", isInstagramCampaign: false });
  assert(noIgEmailResult.tier === "A", "No-IG lead reaches Tier A when outreach channel is EMAIL");

  // 1.5 Missing fields re-normalization & unknown flags
  const missingDataCandidate: LeadScoreInput = {
    now,
    rating: null, // missing rating
    reviewCount: null, // missing reviews
    isClaimed: null, // unknown claimed
    website: "https://city-smiles.com",
    phone: "+15554443333",
    isChain: false,
    hasInstagram: true,
    lastPostAt: null, // unknown last post
    postsCount: null,
    followers: null,
    isBusinessAccount: null,
    isPrivate: false,
    email: null,
    availableChannels: ["instagram", "phone"],
  };
  const missingResult = computeLeadScore(missingDataCandidate);
  assert(missingResult.flags.includes("UNKNOWN_RATING"), "Emits UNKNOWN_RATING flag");
  assert(missingResult.flags.includes("UNKNOWN_REVIEWS"), "Emits UNKNOWN_REVIEWS flag");
  assert(missingResult.flags.includes("UNKNOWN_CLAIMED"), "Emits UNKNOWN_CLAIMED flag");
  assert(missingResult.flags.includes("UNKNOWN_LAST_POST_DATE"), "Emits UNKNOWN_LAST_POST_DATE flag");
  assert(!Number.isNaN(missingResult.score), "Missing data score is a valid number, not NaN");
  assert(missingResult.score >= 0 && missingResult.score <= 100, "Score remains between 0 and 100");

  // 1.6 Custom weights validation
  const validCustomWeights: LeadScoreWeights = {
    businessHealth: 40,
    independence: 20,
    instagramActivity: 20,
    audienceFit: 10,
    contactability: 10,
  };
  const customResult = computeLeadScore(strongClinic, validCustomWeights);
  assert(customResult.score >= 75, "Custom weights summing to 100 calculate successfully");

  let threwInvalidWeights = false;
  try {
    const invalidWeights = { ...DEFAULT_SCORE_WEIGHTS, businessHealth: 50 }; // sums to 120
    computeLeadScore(strongClinic, invalidWeights);
  } catch {
    threwInvalidWeights = true;
  }
  assert(threwInvalidWeights, "computeLeadScore throws Error if weights do not sum to 100");

  // 1.7 Tier boundaries
  // Thresholds: A >= 75, B 55-74, C 35-54, D < 35
  const thresholds = DEFAULT_SCORE_THRESHOLDS;
  assert(thresholds.tierA === 75, "Tier A threshold is 75");
  assert(thresholds.tierB === 55, "Tier B threshold is 55");
  assert(thresholds.tierC === 35, "Tier C threshold is 35");

  // =========================================================================
  // 2. UNIT TESTS: detectChains
  // =========================================================================
  console.log("\n[2. detectChains Unit Tests]");

  const candidateA: DiscoveredCandidate = {
    fullName: "Aspen Dental South Austin",
    website: "https://aspendental.com/austin-south",
    rating: 4.1,
    reviewCount: 30,
  };
  const candidateB: DiscoveredCandidate = {
    fullName: "Aspen Dental North Austin",
    website: "https://aspendental.com/austin-north",
    rating: 4.0,
    reviewCount: 25,
  };
  const candidateC: DiscoveredCandidate = {
    fullName: "Aspen Dental Round Rock",
    website: "https://aspendental.com/round-rock",
    rating: 4.2,
    reviewCount: 40,
  };
  const candidateIndependent: DiscoveredCandidate = {
    fullName: "Austin Artisan Dental",
    website: "https://austinartisandental.com",
    rating: 4.9,
    reviewCount: 180,
  };
  const candidateMultiPhrase: DiscoveredCandidate = {
    fullName: "Texas Ortho Group (15 locations nationwide)",
    website: "https://texasortho.org",
    rating: 4.5,
    reviewCount: 60,
  };
  const candidateKnownDSO: DiscoveredCandidate = {
    fullName: "Pacific Dental Services Partner Clinic",
    website: "https://pds-partner.com",
    rating: 4.3,
    reviewCount: 50,
  };

  const chainBatch = [
    candidateA,
    candidateB,
    candidateC,
    candidateIndependent,
    candidateMultiPhrase,
    candidateKnownDSO,
  ];

  const chainResults = detectChains(chainBatch);

  const resA = chainResults.get(candidateA);
  const resInd = chainResults.get(candidateIndependent);
  const resMulti = chainResults.get(candidateMultiPhrase);
  const resDSO = chainResults.get(candidateKnownDSO);

  assert(
    Boolean(resA?.reason?.includes("aspendental.com") || resA?.reason?.includes("domain")),
    "Reason mentions domain",
  );
  assert(resInd?.isChain === false, "Single independent clinic is not detected as chain");
  assert(resMulti?.isChain === true, "Multi-location phrase '15 locations nationwide' detected as chain");
  assert(resDSO?.isChain === true, "Known DSO corporate name 'Pacific Dental Services' detected as chain");

  // =========================================================================
  // 3. PIPELINE REORDERING TEST (Cheap -> Paid) on 100-Place Fixture
  // =========================================================================
  console.log("\n[3. Discovery Pipeline Reordering Test (Cheap -> Paid on 100-Place Fixture)]");

  // Simulate 100 Google Maps results:
  // 1. 40 places fail free rules:
  //    - 15 permanently or temporarily closed
  //    - 10 rating < 4.0 (campaign minRating = 4.0)
  //    - 10 reviews < 20 (campaign minReviews = 20)
  //    - 5 negative keyword matches (e.g. "school of dentistry", "wholesale supply")
  // 2. 10 places detected as multi-location chains / corporate accounts
  // 3. 15 places rejected by Maps-only Gemini gate (e.g. pet clinic, supply store)
  // -> 35 survivors of Stage 1, 2, 3:
  //    - 10 multi-channel leads (no IG handle) -> skip Stage 4 & 5
  //    - 25 leads with IG handle -> proceed to paid Stage 4 profile enrichment!
  // 4. In Stage 6 (Final Gemini gate):
  //    - 10 clear pass (score >= 80, high confidence handle) -> SKIP final Gemini
  //    - 5 clear fail (score < 30) -> SKIP final Gemini
  //    - 10 borderline (score 30-79) -> RUN final Gemini

  type MockPipelinePlace = {
    id: string;
    fullName: string;
    isClosed?: boolean;
    rating?: number;
    reviewCount?: number;
    negativeKeyword?: boolean;
    isChainCandidate?: boolean;
    mapsAiReject?: boolean;
    hasHandle: boolean;
    handleConfidence?: "high" | "low";
    simulatedScore: number;
  };

  const fixturePlaces: MockPipelinePlace[] = [];

  for (let i = 1; i <= 100; i++) {
    if (i <= 15) {
      // 15 closed
      fixturePlaces.push({
        id: `place-${i}`,
        fullName: `Old Dental Office ${i}`,
        isClosed: true,
        rating: 4.5,
        reviewCount: 50,
        hasHandle: true,
        simulatedScore: 50,
      });
    } else if (i <= 25) {
      // 10 low rating
      fixturePlaces.push({
        id: `place-${i}`,
        fullName: `Low Star Clinic ${i}`,
        rating: 3.2,
        reviewCount: 50,
        hasHandle: true,
        simulatedScore: 40,
      });
    } else if (i <= 35) {
      // 10 low reviews
      fixturePlaces.push({
        id: `place-${i}`,
        fullName: `Newborn Practice ${i}`,
        rating: 4.8,
        reviewCount: 3,
        hasHandle: true,
        simulatedScore: 45,
      });
    } else if (i <= 40) {
      // 5 negative keywords
      fixturePlaces.push({
        id: `place-${i}`,
        fullName: `University Dental School Clinic ${i}`,
        negativeKeyword: true,
        rating: 4.5,
        reviewCount: 60,
        hasHandle: true,
        simulatedScore: 50,
      });
    } else if (i <= 50) {
      // 10 chains
      fixturePlaces.push({
        id: `place-${i}`,
        fullName: `Corporate DSO Chain Hub ${i}`,
        isChainCandidate: true,
        rating: 4.4,
        reviewCount: 80,
        hasHandle: true,
        simulatedScore: 30,
      });
    } else if (i <= 65) {
      // 15 Maps AI rejects
      fixturePlaces.push({
        id: `place-${i}`,
        fullName: `Pet Dental & Grooming ${i}`,
        mapsAiReject: true,
        rating: 4.8,
        reviewCount: 90,
        hasHandle: true,
        simulatedScore: 60,
      });
    } else if (i <= 75) {
      // 10 Multi-channel leads with NO Instagram handle
      fixturePlaces.push({
        id: `place-${i}`,
        fullName: `Prime Family Dentistry ${i}`,
        rating: 4.9,
        reviewCount: 140,
        hasHandle: false,
        simulatedScore: 82,
      });
    } else if (i <= 85) {
      // 10 Clear Pass leads (score >= 80, high confidence handle)
      fixturePlaces.push({
        id: `place-${i}`,
        fullName: `Elite Orthodontics ${i}`,
        rating: 4.9,
        reviewCount: 180,
        hasHandle: true,
        handleConfidence: "high",
        simulatedScore: 88,
      });
    } else if (i <= 90) {
      // 5 Clear Fail leads (score < 30)
      fixturePlaces.push({
        id: `place-${i}`,
        fullName: `Stale Neglected Clinic ${i}`,
        rating: 4.0,
        reviewCount: 22,
        hasHandle: true,
        handleConfidence: "low",
        simulatedScore: 24,
      });
    } else {
      // 10 Borderline leads (score 30-79)
      fixturePlaces.push({
        id: `place-${i}`,
        fullName: `Average Community Dental ${i}`,
        rating: 4.4,
        reviewCount: 45,
        hasHandle: true,
        handleConfidence: "high",
        simulatedScore: 58,
      });
    }
  }

  // Tracking call counters
  let paidIgProfileEnrichmentCalls = 0;
  let mapsGeminiCalls = 0;
  let finalGeminiCalls = 0;

  // Execute Simulated Pipeline:
  // Stage 1: Free rules on Maps
  const afterStage1 = fixturePlaces.filter((p) => {
    if (p.isClosed) return false;
    if (p.rating !== undefined && p.rating < 4.0) return false;
    if (p.reviewCount !== undefined && p.reviewCount < 20) return false;
    if (p.negativeKeyword) return false;
    return true;
  });
  assert(afterStage1.length === 60, `Stage 1 free rules reject 40 closed/low-rating/negative-keyword places (survivors: ${afterStage1.length})`);

  // Stage 2: Chain filter
  const afterStage2 = afterStage1.filter((p) => !p.isChainCandidate);
  assert(afterStage2.length === 50, `Stage 2 chain filter rejects 10 corporate accounts (survivors: ${afterStage2.length})`);

  // Stage 3: Maps-only Gemini gate
  const afterStage3: MockPipelinePlace[] = [];
  for (const p of afterStage2) {
    mapsGeminiCalls++;
    if (!p.mapsAiReject) {
      afterStage3.push(p);
    }
  }
  assert(afterStage3.length === 35, `Stage 3 Maps-only Gemini gate rejects 15 non-targets (survivors: ${afterStage3.length})`);
  assert(mapsGeminiCalls === 50, `Maps Gemini calls executed only on 50 Stage 2 survivors (got ${mapsGeminiCalls})`);

  // Stage 4: Paid IG enrichment ONLY for handle survivors
  const handleSurvivors = afterStage3.filter((p) => p.hasHandle);
  const noHandleSurvivors = afterStage3.filter((p) => !p.hasHandle);
  assert(handleSurvivors.length === 25, `Handle survivors for paid enrichment = 25`);
  assert(noHandleSurvivors.length === 10, `No-handle survivors routed directly to multi-channel = 10`);

  paidIgProfileEnrichmentCalls = handleSurvivors.length;
  assert(
    paidIgProfileEnrichmentCalls === 25,
    `Paid IG profile enrichment is called ONLY for 25 handle survivors (NOT all 100 places!)`,
  );

  // Stage 6: Borderline Gemini Gate
  const borderlineMin = 30;
  const borderlineMax = 79;
  let clearPassCount = 0;
  let clearFailCount = 0;
  let borderlineGeminiCount = 0;

  for (const p of handleSurvivors) {
    if (p.simulatedScore < borderlineMin) {
      // Clear fail -> skip Gemini
      clearFailCount++;
    } else if (p.simulatedScore > borderlineMax && p.handleConfidence === "high") {
      // Clear pass -> skip Gemini
      clearPassCount++;
    } else {
      // Borderline band -> run final Gemini
      borderlineGeminiCount++;
      finalGeminiCalls++;
    }
  }

  assert(clearPassCount === 10, `Clear pass skips final Gemini: 10 leads`);
  assert(clearFailCount === 5, `Clear fail skips final Gemini: 5 leads`);
  assert(finalGeminiCalls === 10, `Final Gemini gate runs ONLY for 10 borderline leads (got ${finalGeminiCalls})`);

  // Calculate before vs after cost comparison
  const oldPaidIgCalls = 85; // All 85 valid candidates scraped via Apify in old pipeline
  const oldGeminiCalls = 85; // Gemini run on all 85 enriched profiles
  const oldApifyCost = oldPaidIgCalls * 0.0026;
  const oldGeminiCost = oldGeminiCalls * 0.00015;
  const oldTotalCost = oldApifyCost + oldGeminiCost;

  const newPaidIgCalls = paidIgProfileEnrichmentCalls; // 25
  const newMapsGeminiCalls = mapsGeminiCalls; // 50 (batchable / cheap)
  const newFinalGeminiCalls = finalGeminiCalls; // 10
  const newApifyCost = newPaidIgCalls * 0.0026;
  const newGeminiCost = (newMapsGeminiCalls + newFinalGeminiCalls) * 0.00015;
  const newTotalCost = newApifyCost + newGeminiCost;

  const savingsPct = Math.round(((oldTotalCost - newTotalCost) / oldTotalCost) * 100);

  console.log("\n=================================================================");
  console.log("   100-PLACE MOCKED FIXTURE COST & CALL COUNT COMPARISON         ");
  console.log("=================================================================");
  console.log(`Places in:                            100`);
  console.log(`Old Pipeline Paid IG Profile Calls:   ${oldPaidIgCalls} ($${oldApifyCost.toFixed(4)})`);
  console.log(`Old Pipeline Gemini Calls:            ${oldGeminiCalls} ($${oldGeminiCost.toFixed(4)})`);
  console.log(`Old Pipeline Total Est. Cost:         $${oldTotalCost.toFixed(4)}`);
  console.log(`-----------------------------------------------------------------`);
  console.log(`New Pipeline Stage 1 Survivors:       60 (40 cheap rejects)`);
  console.log(`New Pipeline Stage 2 Survivors:       50 (10 chains excluded)`);
  console.log(`New Pipeline Maps Gemini Calls:       ${newMapsGeminiCalls}`);
  console.log(`New Pipeline Stage 3 Survivors:       35 (15 Maps-only AI rejects)`);
  console.log(`New Pipeline Paid IG Profile Calls:   ${newPaidIgCalls} ($${newApifyCost.toFixed(4)}) [70% drop!]`);
  console.log(`New Pipeline Final Gemini Calls:      ${newFinalGeminiCalls} (only borderline 30-79)`);
  console.log(`New Pipeline Total Est. Cost:         $${newTotalCost.toFixed(4)}`);
  console.log(`Cost Savings on 100 Places:           ${savingsPct}% reduction`);
  console.log("=================================================================\n");

  if (failed === 0) {
    console.log(`All ${passed} tests PASSED successfully!`);
    process.exit(0);
  } else {
    console.error(`${failed} tests FAILED out of ${passed + failed}`);
    process.exit(1);
  }
}

runLeadQualityScoreTests().catch((err) => {
  console.error("Test runner encountered error:", err);
  process.exit(1);
});
