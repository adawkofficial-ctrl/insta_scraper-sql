import fs from "node:fs";
import path from "node:path";

// Test doubles (Apify mock) are only honored when NODE_ENV=test.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// Ensure test database isolation before loading any server code
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl } = require("./test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.DATABASE_URL_TEST = getTestDatabaseUrl();
process.env.APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || "mock-apify-token";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { GoogleMapsDiscoveryProvider } from "../src/lib/services/discovery/google-maps-discovery-provider";
import { setApifyClientForTesting } from "../src/lib/services/scraper/apify-client";
import { setMockActorRunnerForTesting } from "../src/lib/services/scraper/apify-cost-guard";
import { setMockWaterfallRunnerForTesting } from "../src/lib/services/discovery/handle-discovery-waterfall";
import {
  freeRulesStage,
  chainDetectionStage,
  mapsGateStage,
  handleDiscoveryStage,
  type PipelineStageContext,
} from "../src/lib/services/discovery/pipeline";
import type { DiscoveredCandidate } from "../src/lib/services/discovery/discovery-provider";

async function main() {
  const fixtureArg = process.argv[2] || "scripts/fixtures/gmaps_toronto_sample.json";
  const fixturePath = path.resolve(process.cwd(), fixtureArg);
  const rawItems: any[] = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

  // Mock Apify actor run to return fixture items
  setApifyClientForTesting({
    call: async () => ({ defaultDatasetId: "mock-dataset-toronto" }),
    dataset: () => ({
      listItems: async () => ({ items: rawItems }),
    }),
  } as any);

  setMockActorRunnerForTesting(async () => {
    return {
      run: { id: "mock-run-toronto", defaultDatasetId: "mock-dataset-toronto" } as any,
      items: rawItems,
      usageTotalUsd: 0,
      computeUnits: 0,
      isDryRun: true,
    };
  });

  setMockWaterfallRunnerForTesting(async () => {
    return {
      handle: null,
      handleSource: null,
      handleConfidence: null,
      stepsAttempted: ["maps"],
      candidates: [],
      socialLinks: {},
    };
  });

  // Search area: Toronto/Scarborough
  const testRunId = `replay_${Date.now()}`;
  const provider = new GoogleMapsDiscoveryProvider();
  const discoveryResult = await provider.discover({
    query: "Dentist",
    location: "Toronto/Scarborough",
    category: "Dentist",
    limit: 20,
    campaignId: testRunId,
    userId: testRunId,
    isDryRun: true,
  });

  const candidates: DiscoveredCandidate[] = discoveryResult.candidates || [];

  const mockContext: PipelineStageContext = {
    campaign: {
      id: testRunId,
      userId: testRunId,
      intent: "Dentist",
      location: "Toronto/Scarborough",
      category: "Dentist",
      minRating: 4.0,
      minReviews: 10,
      excludeChains: true,
      companyProfile: null,
    },
    jobId: `job_${testRunId}`,
    userId: testRunId,
    requestedLimit: 25,
    existingLeadCount: 0,
    remainingCapacity: 25,
    criteria: {} as any,
    caches: {
      seenCandidates: new Set<string>(),
      existingUsernames: new Set<string>(),
      existingPlaceIds: new Set<string>(),
      existingDomains: new Set<string>(),
      existingPhones: new Set<string>(),
    },
  };

  // Track results per place title
  const decisions = new Map<
    string,
    { decision: string; stage: string; fields: string }
  >();

  // Check which places survived discovery
  const survivorMap = new Map<string, DiscoveredCandidate>();
  for (const c of candidates) {
    if (c.fullName) survivorMap.set(c.fullName, c);
  }

  for (const raw of rawItems) {
    const title = raw.title || raw.name || "Unknown";
    if (!survivorMap.has(title)) {
      decisions.set(title, {
        decision: "REJECTED:LOCATION_MISMATCH",
        stage: "fetchPlaces",
        fields: `city=${raw.city}, street="${raw.street}", state="${raw.state}", countryCode="${raw.countryCode}"`,
      });
    }
  }

  // If any survived discovery, run them through downstream stages
  if (candidates.length > 0) {
    const freeRes = await freeRulesStage({ candidates }, mockContext);
    for (const rej of freeRes.rejected) {
      decisions.set(rej.id, {
        decision: `REJECTED:${rej.reason}`,
        stage: "freeRules",
        fields: rej.detail || "",
      });
    }

    const chainRes = await chainDetectionStage({ candidates: freeRes.survivors }, mockContext);
    for (const rej of chainRes.rejected) {
      decisions.set(rej.id, {
        decision: `REJECTED:${rej.reason}`,
        stage: "chainDetection",
        fields: rej.detail || "",
      });
    }

    const mockEvalMapsGemini = async () => ({ relevant: true, reason: "Clinically relevant dentist" });
    const mapsRes = await mapsGateStage(
      { candidates: chainRes.survivors, useAiRelevanceCheck: false },
      mockContext,
      { evalMapsGemini: mockEvalMapsGemini },
    );
    for (const rej of mapsRes.rejected) {
      decisions.set(rej.id, {
        decision: `REJECTED:${rej.reason}`,
        stage: "mapsGate",
        fields: rej.detail || "",
      });
    }

    const handleRes = await handleDiscoveryStage({ candidates: mapsRes.survivors }, mockContext);
    const routing = handleRes.survivors[0];

    for (const c of routing.igCandidates) {
      decisions.set(c.fullName || c.username || "unknown", {
        decision: "SAVED_IG_READY",
        stage: "persist",
        fields: `username=${c.username}, phone=${c.phone}`,
      });
    }

    for (const c of routing.multiChannelCandidates) {
      decisions.set(c.fullName || "unknown", {
        decision: "SAVED_CONTACT_ONLY",
        stage: "persist",
        fields: `phone=${c.phone}, website=${c.website}`,
      });
    }
  }

  // Print ONE line per place
  const histogram: Record<string, number> = {};
  for (const raw of rawItems) {
    const title = raw.title || raw.name || "Unknown";
    const res = decisions.get(title) || {
      decision: "REJECTED:UNKNOWN",
      stage: "unknown",
      fields: "",
    };
    histogram[res.decision] = (histogram[res.decision] || 0) + 1;
    console.log(`${title} | ${res.decision} | ${res.stage} | ${res.fields}`);
  }

  console.log("\nReason Histogram:");
  for (const [k, v] of Object.entries(histogram)) {
    console.log(`  ${k}: ${v}`);
  }
}

main().catch((err) => {
  console.error("Replay error:", err);
  process.exit(1);
});
