import "./preload_server_only.cjs";
import "dotenv/config";

import { strict as assert } from "node:assert";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  mapSpariorProfileToLeadProfile,
  mapSpariorSearchItem,
  normalizeEmail,
  normalizeUsername,
  normalizeWebsite,
  parseNumber,
} from "../src/lib/services/scraper/sparior/sparior-mappers";
import { SpariorClient } from "../src/lib/services/scraper/sparior/sparior-client";
import {
  checkSpariorBudget,
  getSpariorUsageSummary,
} from "../src/lib/services/scraper/sparior/sparior-budget";
import { SpariorDiscoveryProvider } from "../src/lib/services/scraper/sparior/sparior-discovery-provider";
import { SpariorProfileProvider } from "../src/lib/services/scraper/sparior/sparior-profile-provider";
import {
  getProfileProvider,
  getScraperProvider,
} from "../src/lib/services/scraper";
import { getDiscoveryProvider as getDiscoveryServiceDiscoveryProvider } from "../src/lib/services/discovery/discovery-service";
import { runDiscovery } from "../src/lib/services/discovery/discovery-service";
import {
  CampaignStatus,
  LeadStatus,
  UsageProvider,
  DncChannel,
  DncIdentifierType,
  DncSource,
} from "../src/generated/prisma/client";
import { AppError } from "../src/lib/errors";

const prisma = getPrismaClient();

async function runStep3Tests() {
  console.log("==================================================");
  console.log("Running STEP 3 Verification Suite: Sparior Pro Provider");
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

  // --- Test 1: Mapper normalization & tolerance ---
  await test("1. Mapper normalization & tolerance (numbers, email, website, malformed)", async () => {
    // Normalization functions
    assert.equal(normalizeUsername("@Fit_Coach.NYC"), "fit_coach.nyc");
    assert.equal(normalizeUsername(""), null);
    assert.equal(normalizeUsername("invalid!user"), null);

    assert.equal(normalizeEmail(" TEST@Example.COM "), "test@example.com");
    assert.equal(normalizeEmail("not-an-email"), null);

    assert.equal(normalizeWebsite("fitcoach.com"), "https://fitcoach.com");
    assert.equal(normalizeWebsite("http://fitcoach.com"), "http://fitcoach.com");

    assert.equal(parseNumber("15.4K"), 15400);
    assert.equal(parseNumber("1.2M"), 1200000);
    assert.equal(parseNumber("2,500"), 2500);
    assert.equal(parseNumber(450), 450);
    assert.equal(parseNumber(null), null);

    // Profile mapping
    const sampleProfileRaw = {
      id: "12345",
      username: "athlete_jane",
      full_name: "Jane Doe",
      bio: "CrossFit Coach",
      follower_count: "25K",
      following_count: 500,
      media_count: 150,
      is_verified: true,
      is_business: true,
      is_private: false,
      public_email: "jane@crossfit.example",
      public_phone_number: "+1987654321",
      external_url: "crossfitjane.example",
      city_name: "Austin, TX",
    };

    const mapped = mapSpariorProfileToLeadProfile(sampleProfileRaw);
    assert.ok(mapped);
    assert.equal(mapped.username, "athlete_jane");
    assert.equal(mapped.instagramId, "12345");
    assert.equal(mapped.fullName, "Jane Doe");
    assert.equal(mapped.biography, "CrossFit Coach");
    assert.equal(mapped.followers, 25000);
    assert.equal(mapped.following, 500);
    assert.equal(mapped.postsCount, 150);
    assert.equal(mapped.isVerified, true);
    assert.equal(mapped.isBusiness, true);
    assert.equal(mapped.isPrivate, false);
    assert.equal(mapped.email, "jane@crossfit.example");
    assert.equal(mapped.phone, "+1987654321");
    assert.equal(mapped.website, "https://crossfitjane.example");
    assert.equal(mapped.location, "Austin, TX");
    assert.equal(mapped.source, "sparior");
    assert.ok(mapped.raw); // in memory only

    // Malformed search item
    const malformed = mapSpariorSearchItem({ some_bad_key: 123 });
    assert.equal(malformed.isMalformed, true);
    assert.equal(malformed.candidate, null);

    // Private search item
    const privateItem = mapSpariorSearchItem({
      username: "secret_user",
      is_private: true,
    });
    assert.equal(privateItem.isMalformed, false);
    assert.equal(privateItem.isPrivate, true);
  });

  // --- Test 2: SpariorClient success & header parsing ---
  await test("2. SpariorClient success & rate limit headers parsing", async () => {
    const mockHeaders = new Headers({
      "x-ratelimit-requests-limit": "10000",
      "x-ratelimit-requests-remaining": "9950",
      "x-ratelimit-requests-reset": "3600",
      "content-type": "application/json",
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          data: {
            items: [{ username: "coach_dan", is_private: false }],
            next_cursor: "cur_123",
          },
        }),
        { status: 200, headers: mockHeaders },
      );
    };

    const client = new SpariorClient({
      apiKey: "test-rapidapi-key-abcdef1234567890",
      apiHost: "test.rapidapi.com",
      baseUrl: "https://test.rapidapi.com",
      fetchFn: mockFetch,
    });

    const result = await client.search("fitness");
    assert.equal(result.rateLimits.limit, 10000);
    assert.equal(result.rateLimits.remaining, 9950);
    assert.ok(result.rateLimits.resetAt instanceof Date);
    assert.equal(result.retries, 0);
  });

  // --- Test 3: SpariorClient retry on 500/429 then success ---
  await test("3. SpariorClient retry on 500/429 then success", async () => {
    let callCount = 0;
    const mockFetch: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Internal Server Error", { status: 500 });
      }
      if (callCount === 2) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(
        JSON.stringify({
          data: { id: "101", username: "success_user" },
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

    const result = await client.getProfile("success_user");
    assert.equal(callCount, 3);
    assert.equal(result.retries, 2);
  });

  // --- Test 4: SpariorClient 401 fail-fast without retry ---
  await test("4. SpariorClient 401 fail-fast without retry", async () => {
    let callCount = 0;
    const mockFetch: typeof fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ message: "Invalid API key" }), {
        status: 401,
      });
    };

    const client = new SpariorClient({
      apiKey: "invalid-key",
      apiHost: "test.host",
      baseUrl: "https://test.host",
      fetchFn: mockFetch,
    });

    let caughtError: AppError | null = null;
    try {
      await client.getProfile("test_user");
    } catch (err) {
      if (err instanceof AppError) caughtError = err;
    }

    assert.ok(caughtError);
    assert.equal(caughtError.code, "PROVIDER_AUTH_FAILED");
    assert.equal(caughtError.status, 401);
    assert.equal(callCount, 1); // No retries on 401
  });

  // --- Test 5: SpariorClient quota exhausted detection ---
  await test("5. SpariorClient quota exhausted response throws PROVIDER_QUOTA_EXHAUSTED", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          message: "You have exceeded the MONTHLY quota for Requests on your current plan.",
        }),
        { status: 429 },
      );
    };

    const client = new SpariorClient({
      apiKey: "test-key",
      apiHost: "test.host",
      baseUrl: "https://test.host",
      fetchFn: mockFetch,
    });

    let caughtError: AppError | null = null;
    try {
      await client.search("fitness");
    } catch (err) {
      if (err instanceof AppError) caughtError = err;
    }

    assert.ok(caughtError);
    assert.equal(caughtError.code, "PROVIDER_QUOTA_EXHAUSTED");
  });

  // --- Test 6: SpariorClient timeout handling ---
  await test("6. SpariorClient timeout handling", async () => {
    const mockFetch: typeof fetch = async (_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abortError = new Error("The operation was aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });
    };

    const client = new SpariorClient({
      apiKey: "test-key",
      apiHost: "test.host",
      baseUrl: "https://test.host",
      fetchFn: mockFetch,
      timeoutMs: 50,
    });

    let caughtError: AppError | null = null;
    try {
      await client.search("fitness");
    } catch (err) {
      if (err instanceof AppError) caughtError = err;
    }

    assert.ok(caughtError);
    assert.equal(caughtError.code, "NETWORK_ERROR");
  });

  // --- Test 7: Secret redaction in errors ---
  await test("7. Secret key never appears in thrown errors or sanitized output", async () => {
    const SECRET_KEY = "rapidapi-secret-key-1234567890abcdef";
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          error: `Failed with x-rapidapi-key=${SECRET_KEY}`,
        }),
        { status: 500 },
      );
    };

    const client = new SpariorClient({
      apiKey: SECRET_KEY,
      apiHost: "test.host",
      baseUrl: "https://test.host",
      fetchFn: mockFetch,
    });

    let thrownMessage = "";
    try {
      await client.search("fitness");
    } catch (err: unknown) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    assert.ok(!thrownMessage.includes(SECRET_KEY));
  });

  // --- Test 8: SpariorDiscoveryProvider multi-page & stop reason ---
  await test("8. SpariorDiscoveryProvider multi-page pagination & caps", async () => {
    let callIdx = 0;
    const mockFetch: typeof fetch = async () => {
      callIdx++;
      if (callIdx === 1) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                { username: "user_page1_a", is_private: false },
                { username: "user_page1_b", is_private: false },
              ],
              next_cursor: "page_2_cursor",
              has_more: true,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            items: [
              { username: "user_page2_a", is_private: false },
              { username: "user_page2_b", is_private: false },
            ],
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

    const usageUser = await prisma.user.create({
      data: {
        email: `sparior_profile_test_${Date.now()}@example.com`,
        passwordHash: "hash123",
      },
    });
    const provider = new SpariorDiscoveryProvider(client);
    const result = await provider.discover({
      query: "fitness",
      limit: 10,
      userId: usageUser.id,
    });

    assert.equal(result.candidates.length, 4);
    assert.equal(callIdx, 2);
  });

  // --- Test 9: Budget guard check & override ---
  await test("9. Sparior budget guard check & override", async () => {
    // Soft limit override test: when overrideBudget: true, passes through
    await checkSpariorBudget({ overrideBudget: true });
    assert.ok(true);
  });

  // --- Test 10: UsageLog verification & summary ---
  await test("10. UsageLog recording & getSpariorUsageSummary metrics", async () => {
    const testUser = await prisma.user.create({
      data: {
        email: `sparior_test_${Date.now()}@example.com`,
        passwordHash: "hash123",
      },
    });

    // Create 2 usage log entries
    await prisma.usageLog.create({
      data: {
        userId: testUser.id,
        provider: UsageProvider.SPARIOR,
        operation: "search",
        requestCount: 1,
        itemsReturned: 5,
        quotaRemaining: 9500,
      },
    });
    await prisma.usageLog.create({
      data: {
        userId: testUser.id,
        provider: UsageProvider.SPARIOR,
        operation: "profile",
        requestCount: 1,
        itemsReturned: 1,
        quotaRemaining: 9499,
      },
    });

    const summary = await getSpariorUsageSummary({ userId: testUser.id });
    assert.equal(summary.requests, 2);
    assert.equal(summary.profiles, 6);
    assert.equal(summary.latestQuotaRemaining, 9499);
    assert.equal(summary.profilesPerRequest, 3);
  });

  // --- Test 11: End-to-end discovery run with Sparior, DNC suppression, and funnel ---
  await test("11. End-to-end discovery run with Sparior source, DNC filtering, and ScrapeJob.usage", async () => {
    const testUser = await prisma.user.create({
      data: {
        email: `discovery_sparior_${Date.now()}@example.com`,
        passwordHash: "hash123",
      },
    });

    const campaign = await prisma.campaign.create({
      data: {
        userId: testUser.id,
        name: "Sparior Fitness Campaign",
        intent: "Fitness trainer NYC",
        status: CampaignStatus.DRAFT,
      } as any,
    });

    // Add DNC record for "charlie_dnc"
    await prisma.doNotContact.create({
      data: {
        userId: testUser.id,
        channel: DncChannel.INSTAGRAM,
        identifierType: DncIdentifierType.USERNAME,
        identifierNormalized: "charlie_dnc",
        reason: "Opted out",
        source: DncSource.MANUAL,
      },
    });

    // Configure SCRAPER_PROVIDER = "sparior" in process.env
    const prevProvider = process.env.SCRAPER_PROVIDER;
    const prevApiKey = process.env.SPARIOR_API_KEY;
    const prevApiHost = process.env.SPARIOR_API_HOST;

    process.env.SCRAPER_PROVIDER = "sparior";
    process.env.SPARIOR_API_KEY = "mock-key";
    process.env.SPARIOR_API_HOST = "mock-host";

    // Mock fetch for Sparior HTTP calls
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("search")) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  username: "anna_fitness",
                  user: {
                    username: "anna_fitness",
                    id: "9001",
                    full_name: "Anna NYC",
                    biography: "Certified fitness trainer in New York City",
                    follower_count: 5000,
                    media_count: 80,
                    is_private: false,
                    is_verified: true,
                    public_email: "anna@fitness.example",
                    external_url: "https://annafit.example",
                  },
                },
                {
                  username: "charlie_dnc",
                  user: {
                    username: "charlie_dnc",
                    id: "9002",
                    full_name: "Charlie Coach",
                    biography: "NYC Fitness Coach",
                    follower_count: 4000,
                    media_count: 50,
                    is_private: false,
                  },
                },
              ],
              next_cursor: null,
            },
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("profile")) {
        // Return the profile for the REQUESTED username so enrichment does not
        // silently replace charlie_dnc with anna_fitness (which would bypass the
        // DNC check under test).
        const isCharlie = urlStr.includes("charlie_dnc");
        return new Response(
          JSON.stringify({
            data: isCharlie
              ? {
                  id: "9002",
                  username: "charlie_dnc",
                  full_name: "Charlie Coach",
                  biography: "Fitness Coach in New York City",
                  follower_count: 4000,
                  media_count: 50,
                  is_private: false,
                }
              : {
                  id: "9001",
                  username: "anna_fitness",
                  full_name: "Anna NYC",
                  biography: "Certified fitness trainer in New York City",
                  follower_count: 5000,
                  media_count: 80,
                  is_private: false,
                  public_email: "anna@fitness.example",
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
          query: "fitness trainer",
          location: "New York",
          category: null,
          maxLeads: 5,
        },
        testUser.id,
      );

      // Verify leads persisted
      const leads = await prisma.lead.findMany({
        where: { campaignId: campaign.id },
      });

      // anna_fitness should be created, charlie_dnc should be skipped by DNC
      assert.equal(leads.length, 1);
      assert.equal(leads[0].username, "anna_fitness");
      assert.equal(leads[0].source, "sparior");
      assert.equal(leads[0].status, LeadStatus.NEW);
      assert.equal(leads[0].email, "anna@fitness.example");

      // Verify ScrapeJob usage funnel
      const job = await prisma.scrapeJob.findUnique({
        where: { id: result.scrapeJobId },
      });
      assert.ok(job);
      assert.equal(job.provider, "sparior");
      assert.equal(job.stopReason, "completed");

      const usage = job.usage as Record<string, unknown>;
      assert.ok(usage);
      assert.equal(usage.newLeadsCreated, 1);
      assert.equal(usage.dncSkipped, 1);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.SCRAPER_PROVIDER = prevProvider;
      process.env.SPARIOR_API_KEY = prevApiKey;
      process.env.SPARIOR_API_HOST = prevApiHost;
    }
  });

  // --- Test 12: Provider factory selection ---
  await test("12. Provider factory selection by SCRAPER_PROVIDER env", async () => {
    const prev = process.env.SCRAPER_PROVIDER;
    const prevDisc = process.env.DISCOVERY_PROVIDER;

    try {
      process.env.DISCOVERY_PROVIDER = "instagram_search";
      process.env.SCRAPER_PROVIDER = "apify";
      const apifyDisc = getDiscoveryServiceDiscoveryProvider();
      assert.equal(apifyDisc.name, "apify");

      const apifyScraper = getScraperProvider();
      assert.equal(apifyScraper.name, "apify");

      process.env.SCRAPER_PROVIDER = "sparior";
      const spariorDisc = getDiscoveryServiceDiscoveryProvider();
      assert.equal(spariorDisc.name, "sparior");

      const spariorScraper = getScraperProvider();
      assert.equal(spariorScraper.name, "sparior");

      process.env.SCRAPER_PROVIDER = "invalid_provider";
      assert.throws(() => {
        getDiscoveryServiceDiscoveryProvider();
      });
    } finally {
      process.env.SCRAPER_PROVIDER = prev;
      process.env.DISCOVERY_PROVIDER = prevDisc;
    }
  });

  console.log("--------------------------------------------------");
  console.log(`STEP 3 Tests: ${passed} passed, ${failed} failed`);
  console.log("--------------------------------------------------");

  if (failed > 0) {
    process.exit(1);
  }
}

runStep3Tests().catch((err) => {
  console.error("Suite execution failed:", err);
  process.exit(1);
});
