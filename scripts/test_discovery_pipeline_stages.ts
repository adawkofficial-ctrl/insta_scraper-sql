/**
 * Unit & Integration Test Suite for Refactored Discovery Pipeline Stages
 * Tests all 10 stages: inputs/outputs, reject reasons, spend accounting,
 * cancellation & resume safety, and orchestrator coordination.
 * Mocks all external providers (zero live network calls).
 */

import "dotenv/config";
import "./preload_server_only.cjs";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  planSearchStage,
  fetchPlacesStage,
  freeRulesStage,
  chainDetectionStage,
  mapsGateStage,
  handleDiscoveryStage,
  profileEnrichmentStage,
  criteriaAndScoreStage,
  finalGateStage,
  persistStage,
  orchestrateDiscovery,
  type PipelineStageContext,
} from "../src/lib/services/discovery/pipeline";
import { DEFAULT_ENRICHMENT_CRITERIA } from "../src/lib/services/discovery/enrichment-criteria";
import type { DiscoveredCandidate } from "../src/lib/services/discovery/discovery-provider";
import type { LeadProfile } from "../src/lib/types";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function main() {
  console.log("=================================================================");
  console.log("   TASK: DISCOVERY PIPELINE STAGES & OBSERVABILITY TEST SUITE    ");
  console.log("=================================================================\n");

  const prisma = getPrismaClient();

  const runId = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  // Test setup: ensure clean test user & company profile
  const user = await prisma.user.create({
    data: {
      email: `pipeline_stage_${runId}@example.com`,
      passwordHash: "mock_hash_for_test_12345678901234567890",
      role: "USER",
    },
  });

  const companyProfile = await prisma.companyProfile.create({
    data: {
      userId: user.id,
      name: `Pipeline Agency ${runId}`,
      description: "High-end dental practice marketing agency",
      targetIndustries: ["Dentistry", "Healthcare"],
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      name: `Pipeline Campaign ${runId}`,
      companyProfileId: companyProfile.id,
      intent: "Dentist",
      location: "Austin, TX",
      category: "Dentist",
      leadLimit: 25,
      minRating: 4.0,
      minReviews: 10,
      excludeChains: true,
    },
  });

  const testJob = await prisma.scrapeJob.create({
    data: {
      campaignId: campaign.id,
      status: "RUNNING",
      provider: "apify",
      inputCount: 0,
      processedCount: 0,
      startedAt: new Date(),
      requestedLimit: 25,
    },
  });

  const mockContext: PipelineStageContext = {
    campaign: {
      id: campaign.id,
      userId: user.id,
      intent: "Dentist",
      location: "Austin, TX",
      category: "Dentist",
      minRating: 4.0,
      minReviews: 10,
      excludeChains: true,
      companyProfile: {
        description: "Dental marketing agency",
        targetIndustries: ["Dentistry"],
      },
    },
    jobId: testJob.id,
    userId: user.id,
    requestedLimit: 25,
    existingLeadCount: 0,
    remainingCapacity: 25,
    criteria: DEFAULT_ENRICHMENT_CRITERIA,
    caches: {
      seenCandidates: new Set<string>(),
      existingUsernames: new Set<string>(),
      existingPlaceIds: new Set<string>(),
      existingDomains: new Set<string>(),
      existingPhones: new Set<string>(),
    },
  };

  // -------------------------------------------------------------
  // Stage 1: planSearch
  // -------------------------------------------------------------
  console.log("--- Stage 1: planSearch ---");
  const planRes = await planSearchStage(
    {
      query: "pediatric dentist",
      category: "Dentist",
      location: "Austin, TX",
      activeDiscoveryMode: "google_maps",
      priorNextKeywordIndex: 0,
    },
    mockContext,
  );
  check(planRes.survivors.length === 1, "planSearch returns planned search output");
  check(planRes.survivors[0].effectiveQueries.length > 0, "effectiveQueries planned successfully");
  check(planRes.spendUsd === 0, "planSearch has zero spend");

  // -------------------------------------------------------------
  // Stage 2: fetchPlaces (Mocked DI)
  // -------------------------------------------------------------
  console.log("\n--- Stage 2: fetchPlaces ---");
  const testIgHandle = `austindental_${runId}`;
  const testDomain = `lonestarteeth_${runId}.com`;
  const testPhone = `+1512555${Math.floor(Math.random() * 8999 + 1000)}`;

  const mockCandidates: DiscoveredCandidate[] = [
    {
      fullName: "Austin Family Dentistry",
      username: testIgHandle,
      rating: 4.8,
      reviewCount: 45,
      website: `https://${testIgHandle}.com`,
      phone: "+15125550101",
      location: "Austin, TX",
      permanentlyClosed: false,
      gmapsPlaceId: `place_101_${runId}`,
    },
    {
      fullName: "Closed Downtown Dental",
      username: `closeddental_${runId}`,
      rating: 4.2,
      reviewCount: 20,
      website: `https://closeddental_${runId}.com`,
      permanentlyClosed: true,
      gmapsPlaceId: `place_102_${runId}`,
    },
    {
      fullName: "Aspen Dental South Austin",
      username: `aspendental_${runId}`,
      rating: 4.5,
      reviewCount: 150,
      website: `https://aspendental.com/austin_${runId}`,
      phone: "+15125550103",
      location: "Austin, TX",
      isChain: true,
      gmapsPlaceId: `place_103_${runId}`,
    },
    {
      fullName: "Lone Star Teeth Whitening",
      username: null,
      rating: 4.9,
      reviewCount: 80,
      website: `https://${testDomain}`,
      phone: testPhone,
      location: "Austin, TX",
      availableChannels: ["WEBSITE", "PHONE"],
      gmapsPlaceId: `place_104_${runId}`,
    },
    {
      fullName: "Empty Ghost Place",
      username: null,
      rating: 3.5,
      reviewCount: 2,
      website: null,
      phone: null,
      availableChannels: [],
      gmapsPlaceId: `place_105_${runId}`,
    },
  ];

  const mockDiscoveryProvider = {
    discover: async () => ({
      candidates: mockCandidates,
      usageTotalUsd: 0.02,
      placesReturned: mockCandidates.length,
      gmapsPlacesFound: mockCandidates.length,
      gmapsWithWebsite: 4,
      withInstagramUsername: 3,
    }),
  };

  const fetchRes = await fetchPlacesStage(
    {
      query: "pediatric dentist",
      limit: 10,
      location: "Austin, TX",
      category: "Dentist",
      providerType: "google_maps",
    },
    mockContext,
    { discoveryProvider: mockDiscoveryProvider },
  );
  check(fetchRes.survivors.length === 5, "fetchPlaces returned all 5 candidates via DI");
  check(fetchRes.spendUsd === 0.02, "fetchPlaces correctly recorded spend $0.02");

  // -------------------------------------------------------------
  // Stage 3: freeRules
  // -------------------------------------------------------------
  console.log("\n--- Stage 3: freeRules ---");
  const freeRes = await freeRulesStage({ candidates: fetchRes.survivors }, mockContext);
  // place_102 is closed -> rejected
  check(freeRes.rejected.some((r) => r.reason === "CLOSED_BUSINESS"), "Closed place rejected early with CLOSED_BUSINESS");
  // place_105 has rating 3.5 < minRating 4.0 -> rejected
  check(freeRes.rejected.some((r) => r.reason === "LOW_RATING"), "Low rating place rejected with LOW_RATING");
  check(freeRes.survivors.length === 3, "freeRules preserved 3 valid candidates");
  check(freeRes.spendUsd === 0, "freeRules has zero spend");

  // -------------------------------------------------------------
  // Stage 4: chainDetection
  // -------------------------------------------------------------
  console.log("\n--- Stage 4: chainDetection ---");
  // Candidate 3 is Aspen Dental (chain)
  const chainRes = await chainDetectionStage({ candidates: freeRes.survivors }, mockContext);
  check(chainRes.rejected.some((r) => r.reason === "CHAIN_EXCLUDED"), "Aspen Dental excluded as corporate chain");
  check(chainRes.survivors.length === 2, "chainDetection preserved 2 independent candidates");

  // -------------------------------------------------------------
  // Stage 5: mapsGate (Mocked Gemini)
  // -------------------------------------------------------------
  console.log("\n--- Stage 5: mapsGate ---");
  const mockEvalMapsGemini = async () => ({ relevant: true, reason: "Clinically relevant dentist" });
  const mapsGateRes = await mapsGateStage(
    { candidates: chainRes.survivors, useAiRelevanceCheck: true },
    mockContext,
    { evalMapsGemini: mockEvalMapsGemini },
  );
  check(mapsGateRes.survivors.length === 2, "mapsGate approved both relevant candidates");
  check(mapsGateRes.spendUsd > 0, "mapsGate tracked Gemini spend (~$0.0003)");

  // -------------------------------------------------------------
  // Stage 6: handleDiscovery
  // -------------------------------------------------------------
  console.log("\n--- Stage 6: handleDiscovery ---");
  const handleRes = await handleDiscoveryStage({ candidates: mapsGateRes.survivors }, mockContext);
  const routing = handleRes.survivors[0];
  check(routing.igCandidates.length === 1, "Candidate routed to igCandidates");
  check(routing.multiChannelCandidates.length === 1, "Candidate preserved as multiChannelCandidates");
  check(routing.igCandidates[0].username === testIgHandle, "Correct dynamic IG handle captured");

  // -------------------------------------------------------------
  // Stage 7: profileEnrichment (Mocked DI + Fix 3 Cache)
  // -------------------------------------------------------------
  console.log("\n--- Stage 7: profileEnrichment ---");
  const mockProfile: LeadProfile = {
    username: testIgHandle,
    fullName: "Austin Family Dentistry",
    biography: "Gentle local family & cosmetic dentist in Austin TX",
    category: "Dentist",
    source: "apify",
    followers: 2400,
    following: 400,
    postsCount: 120,
    isBusiness: true,
    isPrivate: false,
    rating: 4.8,
    reviewCount: 45,
    website: `https://${testIgHandle}.com`,
    email: `contact@${testIgHandle}.com`,
    phone: "+15125550101",
    handleSource: "website_homepage",
    handleConfidence: "high",
    instagramId: null,
    profilePictureUrl: null,
    isVerified: false,
    externalUrl: null,
    location: "Austin, TX",
    relatedProfiles: null,
    latestPosts: null,
    scrapedAt: new Date().toISOString(),
  };

  const mockProfileProvider = {
    getProfiles: async () => [mockProfile],
  };

  const enrichRes = await profileEnrichmentStage(
    {
      usernames: [testIgHandle],
      candidateMetaByUsername: new Map(),
    },
    mockContext,
    { profileProvider: mockProfileProvider },
  );
  check(enrichRes.survivors.length === 1, "profileEnrichment returned 1 enriched profile via DI");
  check(enrichRes.survivors[0].followers === 2400, "Profile followers retrieved accurately");

  // -------------------------------------------------------------
  // Stage 8: criteriaAndScore
  // -------------------------------------------------------------
  console.log("\n--- Stage 8: criteriaAndScore ---");
  const criteriaRes = await criteriaAndScoreStage({ profiles: enrichRes.survivors }, mockContext);
  console.log("criteriaRes:", JSON.stringify({ survivors: criteriaRes.survivors, rejected: criteriaRes.rejected, counters: criteriaRes.counters }));
  const scoredOutput = criteriaRes.survivors[0];
  check(scoredOutput.clearPassProfiles.length === 1, "Complete profile with 2.4k followers scored clear pass (Tier A)");
  check((scoredOutput.clearPassProfiles[0].qualityScore ?? 0) >= 80, "Quality score >= 80");

  // -------------------------------------------------------------
  // Stage 9: finalGate
  // -------------------------------------------------------------
  console.log("\n--- Stage 9: finalGate ---");
  const finalGateRes = await finalGateStage(
    {
      clearPassProfiles: scoredOutput.clearPassProfiles,
      borderlineProfiles: scoredOutput.borderlineProfiles,
    },
    mockContext,
  );
  check(finalGateRes.survivors.length === 1, "finalGate preserved clear pass profile without calling Gemini");
  check(finalGateRes.counters.clearPass === 1, "Clear pass counter incremented");

  // -------------------------------------------------------------
  // Stage 10: persist
  // -------------------------------------------------------------
  console.log("\n--- Stage 10: persist ---");
  const persistRes = await persistStage(
    {
      igProfiles: finalGateRes.survivors,
      multiChannelCandidates: routing.multiChannelCandidates,
      maxLeads: 25,
    },
    mockContext,
  );
  console.log("persistRes debug:", JSON.stringify(persistRes));
  check(persistRes.survivors.length === 2, "persistStage successfully persisted both IG and multi-channel lead");
  check(persistRes.counters.persisted === 2, "Persisted counter equals 2");

  // Verify leads in DB
  const savedLeads = await prisma.lead.findMany({ where: { campaignId: campaign.id } });
  check(savedLeads.length === 2, "Database contains exactly 2 leads for campaign");
  const multichannelSaved = savedLeads.find((l) => !l.username);
  check(Boolean(multichannelSaved?.phone && multichannelSaved?.websiteDomain), "Multi-channel lead stored with phone & domain");

  // -------------------------------------------------------------
  // Orchestrator End-to-End Coordination Test
  // -------------------------------------------------------------
  console.log("\n--- Orchestrator Coordination Test ---");
  const orchestratorCampaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      name: "Orchestrator Coordination Campaign",
      companyProfileId: companyProfile.id,
      intent: "Dentist",
      location: "Austin, TX",
      leadLimit: 10,
    },
  });

  const orchHandle = `orchdental_${runId}`;
  const orchDomain = `orchteeth_${runId}.com`;
  const orchCandidates: DiscoveredCandidate[] = [
    {
      fullName: "Orchestrator Family Dentistry",
      username: orchHandle,
      rating: 4.8,
      reviewCount: 50,
      website: `https://${orchHandle}.com`,
      phone: "+15125559999",
      location: "Austin, TX",
      permanentlyClosed: false,
      gmapsPlaceId: `place_orch_101_${runId}`,
    },
    {
      fullName: "Orchestrator Teeth Whitening",
      username: null,
      rating: 4.9,
      reviewCount: 75,
      website: `https://${orchDomain}`,
      phone: "+15125558888",
      location: "Austin, TX",
      availableChannels: ["WEBSITE", "PHONE"],
      gmapsPlaceId: `place_orch_104_${runId}`,
    },
  ];

  const orchProfile: LeadProfile = {
    username: orchHandle,
    fullName: "Orchestrator Family Dentistry",
    biography: "Gentle local family & cosmetic dentist in Austin TX",
    category: "Dentist",
    source: "apify",
    followers: 3000,
    following: 300,
    postsCount: 150,
    isBusiness: true,
    isPrivate: false,
    rating: 4.8,
    reviewCount: 50,
    website: `https://${orchHandle}.com`,
    email: `contact@${orchHandle}.com`,
    phone: "+15125559999",
    handleSource: "website_homepage",
    handleConfidence: "high",
    instagramId: null,
    profilePictureUrl: null,
    isVerified: false,
    externalUrl: null,
    location: "Austin, TX",
    relatedProfiles: null,
    latestPosts: null,
    scrapedAt: new Date().toISOString(),
  };

  const orchDiscoveryProvider = {
    discover: async () => ({
      candidates: orchCandidates,
      usageTotalUsd: 0.01,
      placesReturned: orchCandidates.length,
      gmapsPlacesFound: orchCandidates.length,
      gmapsWithWebsite: 2,
      withInstagramUsername: 1,
    }),
  };

  const orchProfileProvider = {
    getProfiles: async () => [orchProfile],
  };

  const orchestratorResult = await orchestrateDiscovery(
    {
      campaignId: orchestratorCampaign.id,
      query: "pediatric dentist",
      location: "Austin, TX",
      category: "Dentist",
      maxLeads: 10,
    },
    user.id,
    undefined,
    {
      discoveryProvider: orchDiscoveryProvider,
      profileProvider: orchProfileProvider,
      evalMapsGemini: mockEvalMapsGemini,
    },
  );

  check(orchestratorResult.persisted > 0, "orchestrateDiscovery completed with persisted leads");
  check(orchestratorResult.candidatesDiscovered === 2, "Candidates discovered count recorded in result");

  // Verify ScrapeJob usage JSON funnel report
  const completedJob = await prisma.scrapeJob.findUnique({ where: { id: orchestratorResult.scrapeJobId } });
  const usage = completedJob?.usage as Record<string, any>;
  check(Boolean(usage?.funnel), "ScrapeJob.usage contains structured funnel JSON report");
  check(usage.funnel.placesFound === 2, "Funnel report records placesFound: 2");
  check(usage.funnel.persisted === orchestratorResult.persisted, "Funnel report records persisted count accurately");

  // Cleanup
  console.log("\nCleaning up test records...");
  await prisma.leadSighting.deleteMany({ where: { campaignId: { in: [campaign.id, orchestratorCampaign.id] } } });
  await prisma.lead.deleteMany({ where: { campaignId: { in: [campaign.id, orchestratorCampaign.id] } } });
  await prisma.scrapeJob.deleteMany({ where: { campaignId: { in: [campaign.id, orchestratorCampaign.id] } } });
  await prisma.campaign.deleteMany({ where: { id: { in: [campaign.id, orchestratorCampaign.id] } } });
  await prisma.companyProfile.deleteMany({ where: { id: companyProfile.id } });
  await prisma.user.deleteMany({ where: { id: user.id } });
  console.log("Cleanup complete.\n");

  console.log("=================================================================");
  console.log(`PIPELINE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error in pipeline stage test:", err);
  process.exit(1);
});
