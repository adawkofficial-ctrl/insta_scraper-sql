import "./preload_server_only.cjs";
import "dotenv/config";

import { strict as assert } from "node:assert";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  extractDiscoveryKeywords,
  buildPerKeywordSearchQueries,
  buildDiscoverySearchTerm,
} from "../src/lib/services/discovery/discovery-query";
import { SpariorDiscoveryProvider } from "../src/lib/services/scraper/sparior/sparior-discovery-provider";
import { SpariorClient } from "../src/lib/services/scraper/sparior/sparior-client";
import { runDiscovery } from "../src/lib/services/discovery/discovery-service";
import { CampaignStatus, LeadStatus } from "../src/generated/prisma/client";

const prisma = getPrismaClient();

async function runTests() {
  console.log("=================================================================");
  console.log(" TASK: Sparior Discovery Query Construction & Per-Keyword Search ");
  process.env.SPARIOR_MONTHLY_REQUEST_LIMIT = "100000";
  process.env.SPARIOR_QUOTA_RESERVE = "5";

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

  // --- Test 1: Query construction for Healthcare/Rawalpindi campaign ---
  await test("1. Healthcare/Rawalpindi campaign produces short distinct per-keyword queries, not one combined string", async () => {
    const rawIntent =
      "hospitals, medical centers, healthcare clinics, private, diagnostic technology";
    const category = "Healthcare";
    const location = "Rawalpindi";

    // Old construction concatenated all tokens into 1 long string:
    const oldQuery = buildDiscoverySearchTerm({
      query: rawIntent,
      category,
      location,
    });
    console.log(`     Old query: "${oldQuery}"`);
    assert.equal(
      oldQuery,
      "hospitals medical centers healthcare clinics private diagnostic technology Rawalpindi",
    );

    // New extraction splits into discrete keyword phrases:
    const keywords = extractDiscoveryKeywords({
      query: rawIntent,
      category,
    });
    console.log(`     Extracted keywords:`, keywords);
    assert.deepEqual(keywords, [
      "hospitals",
      "medical centers",
      "healthcare clinics",
      "private",
      "diagnostic technology",
    ]);

    // New per-keyword search queries append location to each individual keyword:
    const searchQueries = buildPerKeywordSearchQueries({
      query: rawIntent,
      category,
      location,
    });
    console.log(`     New per-keyword search queries:`, searchQueries);

    assert.equal(searchQueries.length, 5);
    assert.equal(searchQueries[0], "hospitals Rawalpindi");
    assert.equal(searchQueries[1], "medical centers Rawalpindi");
    assert.equal(searchQueries[2], "healthcare clinics Rawalpindi");
    assert.equal(searchQueries[3], "private Rawalpindi");
    assert.equal(searchQueries[4], "diagnostic technology Rawalpindi");

    // Verify none of them is the 8+ term combined phrase
    for (const q of searchQueries) {
      assert.ok(
        q.split(" ").length <= 4,
        `Expected short search query, got: "${q}"`,
      );
    }
  });

  // --- Test 2: Conjunctions and phrase handling ---
  await test("2. Conjunctions ('and', '&') and short phrases are cleanly partitioned", async () => {
    const queries = buildPerKeywordSearchQueries({
      query: "fitness gyms and fitness businesses",
      category: "Fitness",
      location: "Rawalpindi",
    });

    assert.ok(queries.includes("fitness gyms Rawalpindi"));
    assert.ok(queries.includes("fitness businesses Rawalpindi"));
    assert.equal(queries.length, 2);

    const singlePhrase = buildPerKeywordSearchQueries({
      query: "fitness trainer",
      location: "New York",
    });
    assert.deepEqual(singlePhrase, ["fitness trainer New York"]);
  });

  // --- Test 3: 3 Keywords produce 3 Sparior search calls, merged and deduped ---
  await test("3. Campaign with 3 keywords produces 3 separate Sparior calls with distinct queries; results merged and deduped", async () => {
    const executedSearchCalls: string[] = [];

    const mockFetch: typeof fetch = async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes("search")) {
        const parsedUrl = new URL(urlStr);
        const searchParam =
          parsedUrl.searchParams.get("query") ??
          parsedUrl.searchParams.get("search") ??
          "";
        executedSearchCalls.push(searchParam);

        if (searchParam.startsWith("hospital")) {
          return new Response(
            JSON.stringify({
              data: {
                items: [
                  { username: "rawalpindi_hospital", is_private: false },
                  { username: "shared_clinic", is_private: false },
                ],
                next_cursor: null,
                has_more: false,
              },
            }),
            { status: 200 },
          );
        }

        if (searchParam.startsWith("clinic")) {
          return new Response(
            JSON.stringify({
              data: {
                items: [
                  { username: "shared_clinic", is_private: false }, // Duplicate candidate!
                  { username: "metro_clinic", is_private: false },
                ],
                next_cursor: null,
                has_more: false,
              },
            }),
            { status: 200 },
          );
        }

        if (searchParam.startsWith("diagnostic")) {
          return new Response(
            JSON.stringify({
              data: {
                items: [
                  { username: "shifa_diagnostic", is_private: false },
                ],
                next_cursor: null,
                has_more: false,
              },
            }),
            { status: 200 },
          );
        }
      }

      return new Response("Not found", { status: 404 });
    };

    const client = new SpariorClient({
      apiKey: "test-key",
      apiHost: "test.host",
      baseUrl: "https://test.host",
      fetchFn: mockFetch,
    });

    const testUser = await prisma.user.create({
      data: {
        email: `kw_test3_${Date.now()}@example.com`,
        passwordHash: "hash123",
      },
    });

    const provider = new SpariorDiscoveryProvider(client);
    const result = await provider.discover({
      query: "hospital, clinic, diagnostic",
      location: "Rawalpindi",
      limit: 20,
      userId: testUser.id,
    });

    // 1. Verify 3 separate Sparior calls were made with distinct short queries
    assert.equal(executedSearchCalls.length, 3);
    assert.equal(executedSearchCalls[0], "hospital Rawalpindi");
    assert.equal(executedSearchCalls[1], "clinic Rawalpindi");
    assert.equal(executedSearchCalls[2], "diagnostic Rawalpindi");

    // 2. Results merged and deduped (shared_clinic should appear only ONCE)
    const usernames = result.candidates.map((c) => c.username);
    assert.equal(usernames.length, 4);
    assert.deepEqual(usernames, [
      "rawalpindi_hospital",
      "shared_clinic",
      "metro_clinic",
      "shifa_diagnostic",
    ]);

    // 3. Per-keyword stats match
    assert.ok(result.keywordStats);
    assert.equal(result.keywordStats.length, 3);

    // Keyword 1: 2 raw items, 2 candidates
    assert.equal(result.keywordStats[0].query, "hospital Rawalpindi");
    assert.equal(result.keywordStats[0].candidatesCount, 2);
    assert.equal(result.keywordStats[0].rawCount, 2);

    // Keyword 2: 2 raw items, 1 new candidate (shared_clinic was already seen)
    assert.equal(result.keywordStats[1].query, "clinic Rawalpindi");
    assert.equal(result.keywordStats[1].candidatesCount, 1);
    assert.equal(result.keywordStats[1].rawCount, 2);

    // Keyword 3: 1 raw item, 1 candidate
    assert.equal(result.keywordStats[2].query, "diagnostic Rawalpindi");
    assert.equal(result.keywordStats[2].candidatesCount, 1);
    assert.equal(result.keywordStats[2].rawCount, 1);

    // Total candidate sum: 2 + 1 + 1 = 4
    const totalFromKeywords = result.keywordStats.reduce(
      (sum, k) => sum + k.candidatesCount,
      0,
    );
    assert.equal(totalFromKeywords, result.candidates.length);
  });

  // --- Test 4: Budget cap limits requests and skipped keywords are recorded and rotated ---
  await test("4. SPARIOR_MAX_REQUESTS_PER_RUN budget cap limits calls, logs skipped queries, and rotates keywords next run", async () => {
    const prevMax = process.env.SPARIOR_MAX_REQUESTS_PER_RUN;
    process.env.SPARIOR_MAX_REQUESTS_PER_RUN = "2";

    const executedCalls: string[] = [];
    const mockFetch: typeof fetch = async (url) => {
      const parsedUrl = new URL(url.toString());
      const search =
        parsedUrl.searchParams.get("query") ??
        parsedUrl.searchParams.get("search") ??
        "";
      executedCalls.push(search);
      return new Response(
        JSON.stringify({
          data: {
            items: [{ username: `cand_${search.replace(/\s+/g, "_")}`, is_private: false }],
            next_cursor: null,
            has_more: false,
          },
        }),
        { status: 200 },
      );
    };

    const client = new SpariorClient({
      apiKey: "test-key",
      apiHost: "test.host",
      baseUrl: "https://test.host",
      fetchFn: mockFetch,
    });

    try {
      const testUser = await prisma.user.create({
        data: {
          email: `kw_budget_${Date.now()}@example.com`,
          passwordHash: "hash",
        },
      });

      const campaign = await prisma.campaign.create({
        data: {
          userId: testUser.id,
          name: "Keyword Budget Campaign",
          intent: "alpha, beta, gamma",
          status: CampaignStatus.DRAFT,
        } as any,
      });

      const provider = new SpariorDiscoveryProvider(client);

      // Run 1: 3 keywords, but maxRequests = 2
      const run1 = await provider.discover({
        query: "alpha, beta, gamma",
        campaignId: campaign.id,
        userId: testUser.id,
        limit: 10,
      });

      assert.equal(executedCalls.length, 2);
      assert.deepEqual(executedCalls, ["alpha", "beta"]);
      assert.equal(run1.requestsUsed, 2);
      assert.equal(run1.stopReason, "max_requests");
      assert.deepEqual(run1.executedQueries, ["alpha", "beta"]);
      assert.deepEqual(run1.skippedQueries, ["gamma"]);
      assert.equal(run1.nextKeywordIndex, 2);

      // Record mock scrapeJob to simulate rotation persistence
      await prisma.scrapeJob.create({
        data: {
          campaignId: campaign.id,
          provider: "sparior",
          usage: {
            nextKeywordIndex: run1.nextKeywordIndex,
            executedQueries: run1.executedQueries,
            skippedQueries: run1.skippedQueries,
          },
        },
      });

      // Run 2: Next run should rotate and start from index 2 ("gamma")!
      executedCalls.length = 0;
      const run2 = await provider.discover({
        query: "alpha, beta, gamma",
        campaignId: campaign.id,
        userId: testUser.id,
        limit: 10,
      });

      assert.equal(executedCalls.length, 2);
      // "gamma" was skipped last time, so it runs FIRST in run 2!
      assert.deepEqual(executedCalls, ["gamma", "alpha"]);
      assert.deepEqual(run2.executedQueries, ["gamma", "alpha"]);
      assert.deepEqual(run2.skippedQueries, ["beta"]);
      assert.equal(run2.nextKeywordIndex, 1);
    } finally {
      process.env.SPARIOR_MAX_REQUESTS_PER_RUN = prevMax;
    }
  });

  // --- Test 5: End-to-end runDiscovery with 3 keywords and ScrapeJob funnel metrics ---
  await test("5. End-to-end runDiscovery with 3 keywords records per-keyword metrics in ScrapeJob usage", async () => {
    const testUser = await prisma.user.create({
      data: {
        email: `e2e_kw_${Date.now()}@example.com`,
        passwordHash: "hash123",
      },
    });

    const campaign = await prisma.campaign.create({
      data: {
        userId: testUser.id,
        name: "E2E 3-Keyword Healthcare Campaign",
        intent: "hospital, clinics, diagnostic center",
        location: "Rawalpindi",
        category: null,
        status: CampaignStatus.DRAFT,
      } as any,
    });

    const prevProvider = process.env.SCRAPER_PROVIDER;
    const prevApiKey = process.env.SPARIOR_API_KEY;
    const prevApiHost = process.env.SPARIOR_API_HOST;

    process.env.SCRAPER_PROVIDER = "sparior";
    process.env.SPARIOR_API_KEY = "mock-key";
    process.env.SPARIOR_API_HOST = "mock-host";

    const executedQueries: string[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("search")) {
        const parsedUrl = new URL(urlStr);
        const search =
          parsedUrl.searchParams.get("query") ??
          parsedUrl.searchParams.get("search") ??
          "";
        executedQueries.push(search);

        if (search.startsWith("hospital")) {
          return new Response(
            JSON.stringify({
              data: {
                items: [
                  {
                    username: "rawalpindi_general_hospital",
                    user: {
                      username: "rawalpindi_general_hospital",
                      id: "1001",
                      full_name: "Rawalpindi General Hospital",
                      biography: "Premier healthcare hospital in Rawalpindi",
                      follower_count: 5000,
                      is_private: false,
                    },
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }

        if (search.startsWith("clinics")) {
          return new Response(
            JSON.stringify({
              data: {
                items: [
                  {
                    username: "rawalpindi_general_hospital", // duplicate
                    user: {
                      username: "rawalpindi_general_hospital",
                      id: "1001",
                      full_name: "Rawalpindi General Hospital",
                      biography: "Premier healthcare hospital in Rawalpindi",
                      follower_count: 5000,
                      is_private: false,
                    },
                  },
                  {
                    username: "al_shifa_clinic_rwp",
                    user: {
                      username: "al_shifa_clinic_rwp",
                      id: "1002",
                      full_name: "Al Shifa Medical Clinic",
                      biography: "Healthcare clinic located in Rawalpindi",
                      follower_count: 3200,
                      is_private: false,
                    },
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }

        if (search.startsWith("diagnostic")) {
          return new Response(
            JSON.stringify({
              data: {
                items: [
                  {
                    username: "islamabad_rwp_diagnostics",
                    user: {
                      username: "islamabad_rwp_diagnostics",
                      id: "1003",
                      full_name: "RWP Diagnostic Lab",
                      biography: "Diagnostic and pathology center Rawalpindi",
                      follower_count: 2100,
                      is_private: false,
                    },
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
      }

      if (urlStr.includes("profile")) {
        const username = urlStr.split("username=")[1]?.split("&")[0] ?? "unknown";
        return new Response(
          JSON.stringify({
            data: {
              id: "profile_" + username,
              username,
              full_name: username.replace(/_/g, " "),
              biography: "Healthcare clinic diagnostic hospital Rawalpindi",
              follower_count: 3000,
              is_private: false,
              public_email: `${username}@example.com`,
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
          query: "hospital, clinics, diagnostic center",
          location: "Rawalpindi",
          category: null,
          maxLeads: 10,
        },
        testUser.id,
      );

      // Verify 3 distinct queries were executed
      assert.equal(executedQueries.length, 3);
      assert.ok(executedQueries.includes("hospital Rawalpindi"));
      assert.ok(executedQueries.includes("clinics Rawalpindi"));
      assert.ok(executedQueries.includes("diagnostic center Rawalpindi"));

      // Verify leads persisted in DB (3 unique leads, duplicate rawalpindi_general_hospital deduped)
      const leads = await prisma.lead.findMany({
        where: { campaignId: campaign.id },
      });
      assert.equal(leads.length, 3);
      const leadUsernames = leads.map((l) => l.username).sort();
      assert.deepEqual(leadUsernames, [
        "al_shifa_clinic_rwp",
        "islamabad_rwp_diagnostics",
        "rawalpindi_general_hospital",
      ]);

      // Verify ScrapeJob usage funnel includes keywordStats
      const job = await prisma.scrapeJob.findUnique({
        where: { id: result.scrapeJobId },
      });
      assert.ok(job);
      const usage = job.usage as Record<string, unknown>;
      assert.ok(usage);
      assert.ok(Array.isArray(usage.keywordStats));
      assert.equal((usage.keywordStats as unknown[]).length, 3);
      assert.equal(usage.newLeadsCreated, 3);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.SCRAPER_PROVIDER = prevProvider;
      process.env.SPARIOR_API_KEY = prevApiKey;
      process.env.SPARIOR_API_HOST = prevApiHost;
    }
  });

  console.log("-----------------------------------------------------------------");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("-----------------------------------------------------------------");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
