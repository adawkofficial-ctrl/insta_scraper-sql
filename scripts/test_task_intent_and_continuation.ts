import "./preload_server_only.cjs";
import "dotenv/config";

// Disable AI relevance in mock-only continuation test to prevent intercepted RapidAPI fetch handler from returning 404 to Gemini
process.env.DISCOVERY_USE_AI_RELEVANCE = "false";

import { strict as assert } from "node:assert";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  evaluateProfileRelevance,
  decideRelevance,
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  type DiscoveryRelevancePolicy,
} from "../src/lib/services/discovery/lead-relevance";
import { runDiscovery } from "../src/lib/services/discovery/discovery-service";
import { CampaignStatus } from "../src/generated/prisma/client";
import type { LeadProfile } from "../src/lib/types";

const prisma = getPrismaClient();

function makeTestProfile(partial: Partial<LeadProfile> & { username: string }): LeadProfile {
  return {
    profileUrl: `https://instagram.com/${partial.username}`,
    instagramId: null,
    followers: null,
    following: null,
    postsCount: null,
    profilePicUrl: null,
    profilePicUrlHD: null,
    isVerified: null,
    isBusinessAccount: null,
    category: null,
    businessCategoryName: null,
    externalUrl: null,
    location: null,
    website: null,
    email: null,
    phone: null,
    ...partial,
  } as LeadProfile;
}

function checkCandidate(
  candidate: LeadProfile,
  campaign: { intent: string; location?: string | null; category?: string | null },
  policy: DiscoveryRelevancePolicy = DEFAULT_DISCOVERY_RELEVANCE_POLICY,
) {
  const relevance = evaluateProfileRelevance(
    candidate,
    {
      intent: campaign.intent,
      location: campaign.location ?? null,
      category: campaign.category ?? null,
    },
    policy,
  );
  const decision = decideRelevance(relevance, policy);
  return { decision, relevance };
}

async function runTests() {
  console.log("=================================================================");
  console.log(" TASK: Intent Relevance Matching & Auto-Continuation Test Suite ");
  console.log("=================================================================\n");

  process.env.SPARIOR_MAX_REQUESTS_PER_RUN = "20";
  process.env.SPARIOR_MONTHLY_REQUEST_LIMIT = "100000";
  process.env.SPARIOR_REQUEST_DELAY_MS = "0";

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: unknown) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      failed++;
    }
  }

  const clientIntent =
    "businesses needing website redesign, web development, digital marketing, website maintenance, web design";

  // --- PART 1: Intent Matching on Real Client Flagged Mismatched Profiles ---
  console.log("--- PART 1: Intent Matching on Real Client Flagged Mismatches ---");

  await test("1.1 Flagged airline account (@united) rejected with IRRELEVANT_INTENT", async () => {
    const candidate = makeTestProfile({
      username: "united",
      fullName: "United Airlines",
      biography: "Fly the Friendly Skies ✈️ Sharing our journey and connecting people across the world.",
      category: "Airline",
      followersCount: 1200000,
    });

    const { decision, relevance } = checkCandidate(
      candidate,
      { intent: clientIntent, location: "United States", category: null },
      { ...DEFAULT_DISCOVERY_RELEVANCE_POLICY, requireLocationMatch: false },
    );

    assert.equal(decision.relevant, false, "Expected @united to be rejected");
    assert.equal(decision.reason, "IRRELEVANT_INTENT");
    assert.equal(relevance.intentMatch, "NOT_MATCHED");
  });

  await test("1.2 Flagged F1 motorsport account (@alpinef1team) rejected with IRRELEVANT_INTENT", async () => {
    const candidate = makeTestProfile({
      username: "alpinef1team",
      fullName: "BWT Alpine Formula One Team",
      biography: "Official Instagram account of the BWT Alpine F1 Team. Racing in the FIA Formula One World Championship.",
      category: "Sports Team",
      followersCount: 3400000,
    });

    const { decision, relevance } = checkCandidate(
      candidate,
      { intent: clientIntent, location: "United States", category: null },
      { ...DEFAULT_DISCOVERY_RELEVANCE_POLICY, requireLocationMatch: false },
    );

    assert.equal(decision.relevant, false, "Expected @alpinef1team to be rejected");
    assert.equal(decision.reason, "IRRELEVANT_INTENT");
  });

  await test("1.3 Flagged NGO/global body (@unitednations) rejected with IRRELEVANT_INTENT", async () => {
    const candidate = makeTestProfile({
      username: "unitednations",
      fullName: "United Nations",
      biography: "Peace, dignity and equality on a healthy planet. Official UN updates and global humanitarian action.",
      category: "Non-Governmental Organization",
      followersCount: 11000000,
    });

    const { decision, relevance } = checkCandidate(
      candidate,
      { intent: clientIntent, location: "United States", category: null },
      { ...DEFAULT_DISCOVERY_RELEVANCE_POLICY, requireLocationMatch: false },
    );

    assert.equal(decision.relevant, false, "Expected @unitednations to be rejected");
    assert.equal(decision.reason, "IRRELEVANT_INTENT");
  });

  await test("1.4 Flagged Spanish political creator (@divergentedigitaloficial) rejected with IRRELEVANT_INTENT", async () => {
    const candidate = makeTestProfile({
      username: "divergentedigitaloficial",
      fullName: "Divergente Digital",
      biography: "Canal de opinion y debate politico en YouTube y Spotify. Analisis de actualidad social y noticias de España.",
      category: "Creator",
      followersCount: 45000,
    });

    const { decision, relevance } = checkCandidate(
      candidate,
      { intent: clientIntent, location: "United States", category: null },
      { ...DEFAULT_DISCOVERY_RELEVANCE_POLICY, requireLocationMatch: false },
    );

    assert.equal(decision.relevant, false, "Expected @divergentedigitaloficial to be rejected");
    assert.equal(decision.reason, "IRRELEVANT_INTENT");
  });

  await test("1.5 Flagged TV/Drama channel (@arydigital.tv) rejected with IRRELEVANT_INTENT", async () => {
    const candidate = makeTestProfile({
      username: "arydigital.tv",
      fullName: "ARY Digital",
      biography: "Watch your favorite dramas and entertainment shows. Subscribe to our YouTube channel for full episodes.",
      category: "TV Channel",
      followersCount: 8900000,
    });

    const { decision, relevance } = checkCandidate(
      candidate,
      { intent: clientIntent, location: "United States", category: null },
      { ...DEFAULT_DISCOVERY_RELEVANCE_POLICY, requireLocationMatch: false },
    );

    assert.equal(decision.relevant, false);
    assert.ok(
      decision.reason === "IRRELEVANT_INTENT" || decision.reason === "IRRELEVANT_LOCATION_NATIONAL_SCALE",
      `Expected rejection reason IRRELEVANT_INTENT or IRRELEVANT_LOCATION_NATIONAL_SCALE, got: ${decision.reason}`,
    );
  });

  // --- PART 2: Legitimate Valid Leads Still Pass ---
  console.log("\n--- PART 2: Legitimate Target Leads Still Pass ---");

  await test("2.1 Legitimate web design agency (@austin_web_design) passes with MATCHED", async () => {
    const candidate = makeTestProfile({
      username: "austin_web_design",
      fullName: "Austin Web Studio",
      biography: "Custom responsive websites, WordPress redesign services & digital marketing for growing businesses in Texas.",
      category: "Web Designer",
      followersCount: 3200,
    });

    const { decision, relevance } = checkCandidate(
      candidate,
      { intent: clientIntent, location: "United States", category: null },
      { ...DEFAULT_DISCOVERY_RELEVANCE_POLICY, requireLocationMatch: false },
    );

    assert.equal(decision.relevant, true, "Expected web design agency to be accepted");
    assert.equal(relevance.intentMatch, "MATCHED");
  });

  await test("2.2 Full-stack web development agency passes with MATCHED", async () => {
    const candidate = makeTestProfile({
      username: "apexwebtech",
      fullName: "Apex Web Technologies",
      biography: "Full stack web development, website revamp, maintenance & SEO solutions for small to mid-size brands.",
      category: "Internet Company",
      followersCount: 4500,
    });

    const { decision, relevance } = checkCandidate(
      candidate,
      { intent: clientIntent, location: "United States", category: null },
      { ...DEFAULT_DISCOVERY_RELEVANCE_POLICY, requireLocationMatch: false },
    );

    assert.equal(decision.relevant, true);
    assert.equal(relevance.intentMatch, "MATCHED");
  });

  await test("2.3 Configurable strictness levels behave as expected", async () => {
    const candidate = makeTestProfile({
      username: "creative_marketing_hub",
      fullName: "Creative Studio",
      biography: "Digital branding and social media agency helping companies elevate their online presence.",
      category: "Marketing Agency",
      followersCount: 5000,
    });

    const policyPermissive: DiscoveryRelevancePolicy = {
      ...DEFAULT_DISCOVERY_RELEVANCE_POLICY,
      intentStrictness: "permissive",
      requireLocationMatch: false,
    };
    const { decision: decisionPermissive } = checkCandidate(
      candidate,
      { intent: clientIntent, location: null, category: null },
      policyPermissive,
    );
    assert.equal(decisionPermissive.relevant, true, "Expected permissive strictness to accept marketing agency");

    const policyStrict: DiscoveryRelevancePolicy = {
      ...DEFAULT_DISCOVERY_RELEVANCE_POLICY,
      intentStrictness: "strict",
      requireLocationMatch: false,
    };
    const { relevance: relStrict } = checkCandidate(
      candidate,
      { intent: "website redesign services and WordPress website developers only", location: null, category: null },
      policyStrict,
    );
    assert.equal(relStrict.intentMatch, "NOT_MATCHED", "Strict policy requires higher threshold of matching terms");
  });

  // --- PART 3: Auto-Continuation in Discovery Job ---
  console.log("\n--- PART 3: Auto-Continuation in Discovery Job ---");

  await test("3.1 Single discovery job auto-continues through keywords until requestedLimit=5 is met", async () => {
    const testUser = await prisma.user.create({
      data: {
        email: `auto_cont_${Date.now()}@example.com`,
        passwordHash: "dummy",
      },
    });

    const campaign = await prisma.campaign.create({
      data: {
        userId: testUser.id,
        name: "Auto-Continuation Test Campaign",
        intent: "keyword_one, keyword_two, keyword_three",
        status: CampaignStatus.DRAFT,
      } as any,
    });

    const prevProvider = process.env.SCRAPER_PROVIDER;
    const prevKey = process.env.SPARIOR_API_KEY;
    const prevHost = process.env.SPARIOR_API_HOST;

    process.env.SCRAPER_PROVIDER = "sparior";
    process.env.SPARIOR_API_KEY = "mock_key";
    process.env.SPARIOR_API_HOST = "mock_host";

    const executedSearches: string[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("search")) {
        const parsedUrl = new URL(urlStr);
        const search =
          parsedUrl.searchParams.get("query") ??
          parsedUrl.searchParams.get("search") ??
          "";
        executedSearches.push(search);

        if (search.includes("keyword_one")) {
          return new Response(
            JSON.stringify({
              data: {
                items: [
                  { username: "cand_kw1_userA", is_private: false },
                  { username: "cand_kw1_userB", is_private: false },
                ],
                next_cursor: null,
                has_more: false,
              },
            }),
            { status: 200 },
          );
        }

        if (search.includes("keyword_two")) {
          return new Response(
            JSON.stringify({
              data: {
                items: [
                  { username: "cand_kw2_userC", is_private: false },
                  { username: "cand_kw2_userD", is_private: false },
                  { username: "cand_kw2_userE", is_private: false },
                ],
                next_cursor: null,
                has_more: false,
              },
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({ data: { items: [], next_cursor: null, has_more: false } }),
          { status: 200 },
        );
      }

      if (urlStr.includes("profile")) {
        const username = urlStr.split("username=")[1]?.split("&")[0] ?? "unknown";
        return new Response(
          JSON.stringify({
            data: {
              id: "profile_" + username,
              username,
              full_name: username,
              biography: "keyword_one keyword_two keyword_three professional services",
              follower_count: 2500,
              is_private: false,
            },
          }),
          { status: 200 },
        );
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await runDiscovery(
        {
          campaignId: campaign.id,
          query: "keyword_one, keyword_two, keyword_three",
          location: null,
          category: null,
          maxLeads: 5,
        },
        testUser.id,
      );

      assert.equal(result.persisted, 5, `Expected 5 persisted leads, got ${result.persisted}`);

      const savedLeads = await prisma.lead.findMany({
        where: { campaignId: campaign.id },
      });
      assert.equal(savedLeads.length, 5);

      const job = await prisma.scrapeJob.findUnique({
        where: { id: result.scrapeJobId },
      });
      assert.ok(job);
      assert.equal(job.stopReason, "completed");
      assert.ok(result.notice?.includes("DISCOVERY_COMPLETED: Saved 5 new leads"));
    } finally {
      globalThis.fetch = originalFetch;
      process.env.SCRAPER_PROVIDER = prevProvider;
      process.env.SPARIOR_API_KEY = prevKey;
      process.env.SPARIOR_API_HOST = prevHost;
    }
  });

  await test("3.2 When search options genuinely exhausted, reports clear partial reason without crashing", async () => {
    const testUser = await prisma.user.create({
      data: {
        email: `exhaust_${Date.now()}@example.com`,
        passwordHash: "dummy",
      },
    });

    const campaign = await prisma.campaign.create({
      data: {
        userId: testUser.id,
        name: "Exhausted Test Campaign",
        intent: "niche_rare_term",
        status: CampaignStatus.DRAFT,
      } as any,
    });

    const prevProvider = process.env.SCRAPER_PROVIDER;
    const prevKey = process.env.SPARIOR_API_KEY;
    const prevHost = process.env.SPARIOR_API_HOST;

    process.env.SCRAPER_PROVIDER = "sparior";
    process.env.SPARIOR_API_KEY = "mock_key";
    process.env.SPARIOR_API_HOST = "mock_host";

    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("search")) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                { username: "rare_candidate_1", is_private: false },
                { username: "rare_candidate_2", is_private: false },
              ],
              next_cursor: null,
              has_more: false,
            },
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("profile")) {
        const username = urlStr.split("username=")[1]?.split("&")[0] ?? "unknown";
        return new Response(
          JSON.stringify({
            data: {
              id: "profile_" + username,
              username,
              biography: "niche_rare_term specialist",
              follower_count: 1000,
              is_private: false,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await runDiscovery(
        {
          campaignId: campaign.id,
          query: "niche_rare_term",
          location: null,
          category: null,
          maxLeads: 5,
        },
        testUser.id,
      );

      assert.equal(result.persisted, 2);
      assert.ok(result.notice?.includes("PARTIAL_RESULTS"));
      assert.ok(
        result.notice?.includes("Reason: all search options exhausted"),
        `Expected notice to explain exhaustion, got: ${result.notice}`,
      );

      const job = await prisma.scrapeJob.findUnique({
        where: { id: result.scrapeJobId },
      });
      const usage = job?.usage as Record<string, unknown>;
      assert.equal(usage?.stopReason, "all_keywords_exhausted");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.SCRAPER_PROVIDER = prevProvider;
      process.env.SPARIOR_API_KEY = prevKey;
      process.env.SPARIOR_API_HOST = prevHost;
    }
  });

  // --- PART 4: Re-Run Protection ---
  console.log("\n--- PART 4: Re-Run Protection Against Duplicate Processing ---");

  await test("4.1 A manual second discover click skips already seen candidates without re-enrichment", async () => {
    const testUser = await prisma.user.create({
      data: {
        email: `rerun_${Date.now()}@example.com`,
        passwordHash: "dummy",
      },
    });

    const campaign = await prisma.campaign.create({
      data: {
        userId: testUser.id,
        name: "Re-run Protection Campaign",
        intent: "consulting firm",
        status: CampaignStatus.DRAFT,
      } as any,
    });

    const prevProvider = process.env.SCRAPER_PROVIDER;
    const prevKey = process.env.SPARIOR_API_KEY;
    const prevHost = process.env.SPARIOR_API_HOST;

    process.env.SCRAPER_PROVIDER = "sparior";
    process.env.SPARIOR_API_KEY = "mock_key";
    process.env.SPARIOR_API_HOST = "mock_host";

    const enrichedUsernames: string[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("search")) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                { username: "seen_consultant_1", is_private: false },
                { username: "seen_consultant_2", is_private: false },
              ],
              next_cursor: null,
              has_more: false,
            },
          }),
          { status: 200 },
        );
      }

      if (urlStr.includes("profile")) {
        const username = urlStr.split("username=")[1]?.split("&")[0] ?? "unknown";
        enrichedUsernames.push(username);
        return new Response(
          JSON.stringify({
            data: {
              id: "profile_" + username,
              username,
              biography: "consulting firm professional",
              follower_count: 1500,
              is_private: false,
            },
          }),
          { status: 200 },
        );
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const run1 = await runDiscovery(
        {
          campaignId: campaign.id,
          query: "consulting firm",
          location: null,
          category: null,
          maxLeads: 2,
        },
        testUser.id,
      );

      assert.equal(run1.persisted, 2);
      assert.equal(enrichedUsernames.length, 2);
      assert.deepEqual(enrichedUsernames, ["seen_consultant_1", "seen_consultant_2"]);

      enrichedUsernames.length = 0;

      const run2 = await runDiscovery(
        {
          campaignId: campaign.id,
          query: "consulting firm",
          location: null,
          category: null,
          maxLeads: 4,
        },
        testUser.id,
      );

      assert.equal(
        enrichedUsernames.length,
        0,
        `Expected 0 enrichments in re-run, but enriched: ${enrichedUsernames.join(", ")}`,
      );
      assert.equal(run2.existingSkipped, 2, "Expected 2 existing/previously seen candidates to be skipped");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.SCRAPER_PROVIDER = prevProvider;
      process.env.SPARIOR_API_KEY = prevKey;
      process.env.SPARIOR_API_HOST = prevHost;
    }
  });

  console.log("\n=================================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
