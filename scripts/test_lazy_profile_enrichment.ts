/**
 * Test Suite for Lazy & Minimal Instagram Profile Enrichment:
 * 6a) Discovery with Maps data saves leads with NOT_ENRICHED and makes zero profile-scraper calls.
 * 6b) Bio-based gates skipped when not enriched, re-run after enrichment.
 * 6c) Website extractor returns instagram + other social links; SSRF and size limits still pass.
 * 6d) Enrich button path calls the actor once for N selected handles, respects the cost guard and cache.
 * 6e) Only whitelisted fields are persisted from the profile actor output.
 */

import "./preload_server_only.cjs";
import "dotenv/config";
// Test doubles (Apify mock) are only honored when NODE_ENV=test.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

import {
  extractSocialLinksFromHtml,
  isPrivateOrBlockedUrl,
  WEBSITE_EXTRACT_MAX_BYTES,
  WEBSITE_EXTRACT_TIMEOUT_MS,
  WEBSITE_EXTRACT_CONCURRENCY,
  GoogleMapsDiscoveryProvider,
} from "../src/lib/services/discovery/google-maps-discovery-provider";
import {
  normalizeInstagramProfileItem,
  INSTAGRAM_PROFILE_ACTOR_ID,
} from "../src/lib/services/scraper/instagram-profile";
import {
  enrichLeadsOnDemand,
  MAX_ENRICHMENT_BATCH_SIZE,
  ENRICHMENT_CACHE_DAYS,
} from "../src/lib/services/scraper/profile-enrichment-service";
import { findMatchedNegativeKeyword } from "../src/lib/services/discovery/negative-keywords";
import { setApifyClientForTesting } from "../src/lib/services/scraper/apify-client";
import { getPrismaClient } from "../src/lib/db/prisma";
import { setMockActorRunnerForTesting } from "../src/lib/services/scraper/apify-cost-guard";

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
  const savedAllowedActors = process.env.APIFY_ALLOWED_ACTORS;
  const savedEnrichActor = process.env.IG_ENRICHMENT_ACTOR;
  const savedEnrichmentProvider = process.env.ENRICHMENT_PROVIDER;
  delete process.env.APIFY_ALLOWED_ACTORS;
  delete process.env.ENRICHMENT_PROVIDER;
  // Legacy actor path under test; the default is instagram_scraper details.
  process.env.IG_ENRICHMENT_ACTOR = "profile_scraper";

  try {
  console.log("=== 6c. WEBSITE HTML EXTRACTOR & SSRF / SIZE LIMIT TESTS ===");
  {
    // 1. Social links extraction from HTML
    const htmlWithSocials = `
      <!DOCTYPE html>
      <html>
        <head><title>Dentist Clinic</title></head>
        <body>
          <a href="https://instagram.com/dentist_toronto">Instagram</a>
          <a href="https://www.facebook.com/torontodentalcare">Facebook</a>
          <a href="https://tiktok.com/@torontodental">TikTok</a>
          <a href="https://linkedin.com/company/toronto-dental-corp">LinkedIn</a>
          <a href="https://youtube.com/@torontodentalclinic">YouTube</a>
          <a href="https://wa.me/14165550199">WhatsApp</a>
        </body>
      </html>
    `;

    const extracted = extractSocialLinksFromHtml(htmlWithSocials);
    check(
      extracted.instagram === "dentist_toronto",
      "Extracts Instagram handle correctly",
      `Got: ${extracted.instagram}`,
    );
    check(
      extracted.facebook === "https://www.facebook.com/torontodentalcare",
      "Extracts Facebook link",
      `Got: ${extracted.facebook}`,
    );
    check(
      extracted.tiktok === "https://tiktok.com/@torontodental",
      "Extracts TikTok link",
      `Got: ${extracted.tiktok}`,
    );
    check(
      extracted.linkedin === "https://linkedin.com/company/toronto-dental-corp",
      "Extracts LinkedIn link",
      `Got: ${extracted.linkedin}`,
    );
    check(
      extracted.youtube === "https://youtube.com/@torontodentalclinic",
      "Extracts YouTube link",
      `Got: ${extracted.youtube}`,
    );
    check(
      extracted.whatsapp === "https://wa.me/14165550199",
      "Extracts WhatsApp link",
      `Got: ${extracted.whatsapp}`,
    );

    // 2. Safety limits verification
    check(
      WEBSITE_EXTRACT_MAX_BYTES === 1_048_576,
      "Safety: 1 MB payload limit enforced (1048576 bytes)",
      `Got: ${WEBSITE_EXTRACT_MAX_BYTES}`,
    );
    check(
      WEBSITE_EXTRACT_TIMEOUT_MS === 6_000,
      "Safety: 6s request timeout enforced (6000 ms)",
      `Got: ${WEBSITE_EXTRACT_TIMEOUT_MS}`,
    );
    check(
      WEBSITE_EXTRACT_CONCURRENCY === 5,
      "Safety: Concurrency 5 enforced",
      `Got: ${WEBSITE_EXTRACT_CONCURRENCY}`,
    );

    // 3. SSRF guard tests
    check(isPrivateOrBlockedUrl("http://localhost"), "SSRF: blocks http://localhost");
    check(isPrivateOrBlockedUrl("http://127.0.0.1:8080"), "SSRF: blocks 127.0.0.1 loopback");
    check(isPrivateOrBlockedUrl("http://10.0.0.5/admin"), "SSRF: blocks 10.x.x.x private class A");
    check(isPrivateOrBlockedUrl("http://192.168.1.1"), "SSRF: blocks 192.168.x.x private class C");
    check(isPrivateOrBlockedUrl("http://172.16.0.1"), "SSRF: blocks 172.16.x.x private class B");
    check(isPrivateOrBlockedUrl("http://169.254.169.254/latest/meta-data"), "SSRF: blocks AWS metadata IP");
    check(isPrivateOrBlockedUrl("ftp://example.com/file"), "SSRF: blocks non-http/https protocol");
    check(!isPrivateOrBlockedUrl("https://dentist-toronto.ca"), "SSRF: permits public https domain");
    check(!isPrivateOrBlockedUrl("http://smileclinic.com/contact"), "SSRF: permits public http domain");
  }

  console.log("\n=== 6e. MINIMIZE WHAT THE PROFILE ACTOR RETURNS (WHITELIST ENFORCEMENT) ===");
  {
    const bloatedActorItem = {
      username: "thegooddentist",
      fullName: "The Good Dentist Clinic",
      followersCount: 5420,
      followsCount: 310,
      postsCount: 142,
      biography: "Leading dental clinic in downtown Toronto. Book your smile today!",
      externalUrl: "https://thegooddentist.com",
      isBusinessAccount: true,
      businessCategoryName: "Dental Clinic",
      isPrivate: false,
      verified: true,
      // JUNK FIELDS THAT SHOULD BE DROPPED:
      latestPosts: [
        { id: "post-1", caption: "Smile bright", likesCount: 40, commentsCount: 5 },
        { id: "post-2", caption: "Clinic open", likesCount: 65, commentsCount: 12 },
      ],
      relatedProfiles: [
        { username: "otherdentist", fullName: "Other Dentist" },
      ],
      taggedPosts: [{ id: "tag-1" }],
      highlightReelCount: 5,
      comments: [{ text: "Nice clinic" }],
      images: ["https://instagram.com/p1.jpg", "https://instagram.com/p2.jpg"],
      likes: [1, 2, 3],
      extraScraperMeta: { debug: true, actorId: "apify/instagram-profile-scraper" },
    };

    const normalized = normalizeInstagramProfileItem(
      bloatedActorItem,
      new Date().toISOString(),
    );
    if (!normalized) {
      throw new Error("Expected normalized profile to be non-null");
    }

    // Check whitelisted fields preserved
    check(normalized.username === "thegooddentist", "Preserves username");
    check(normalized.fullName === "The Good Dentist Clinic", "Preserves fullName");
    check(normalized.followersCount === 5420, "Preserves followersCount");
    check(normalized.followsCount === 310, "Preserves followsCount");
    check(normalized.postsCount === 142, "Preserves postsCount");
    check(normalized.biography === "Leading dental clinic in downtown Toronto. Book your smile today!", "Preserves biography");
    check(normalized.externalUrl === "https://thegooddentist.com", "Preserves externalUrl");
    check(normalized.isBusinessAccount === true, "Preserves isBusinessAccount");
    check(normalized.businessCategoryName === "Dental Clinic", "Preserves businessCategoryName");
    check(normalized.isPrivate === false, "Preserves isPrivate");
    check(normalized.verified === true, "Preserves verified");

    // Check dropped fields
    check(normalized.latestPosts === null, "Explicitly drops latestPosts to null");
    check(normalized.relatedProfiles === null, "Explicitly drops relatedProfiles to null");
    check(!("taggedPosts" in (normalized.rawProfileData || {})), "Drops taggedPosts from rawProfileData");
    check(!("comments" in (normalized.rawProfileData || {})), "Drops comments from rawProfileData");
    check(!("images" in (normalized.rawProfileData || {})), "Drops images from rawProfileData");
    check(!("likes" in (normalized.rawProfileData || {})), "Drops likes from rawProfileData");
    check(
      (normalized.rawProfileData as Record<string, unknown>)?.enrichmentStatus === "ENRICHED",
      "Marks rawProfileData.enrichmentStatus = ENRICHED",
    );
  }

  console.log("\n=== 6b. GATES BEFORE & AFTER ENRICHMENT ===");
  {
    // Bio negative keywords gate must be skipped when NOT_ENRICHED
    const negativeKeywords = ["onlyfans", "sugar daddy", "crypto", "forex", "car wash"];

    // 1. Lead not enriched yet (bio is empty/null): passes gate
    const matchBeforeEnrich = findMatchedNegativeKeyword(null, negativeKeywords);
    check(matchBeforeEnrich === null, "Bio gate SKIPPED (returns null) when bio is null before enrichment");

    // 2. Lead enriched with spam/negative bio: caught after enrichment
    const matchAfterEnrich = findMatchedNegativeKeyword(
      "Link in bio for my exclusive OnlyFans content & VIP club!",
      negativeKeywords,
    );
    check(
      matchAfterEnrich === "onlyfans",
      "Bio gate RE-RUN after enrichment catches negative keyword 'onlyfans'",
      `Got: ${matchAfterEnrich}`,
    );

    // 3. Name & Maps Category negative keyword checked before enrichment
    const matchMapsCategory = findMatchedNegativeKeyword("Toronto Car Wash Express", negativeKeywords);
    check(
      matchMapsCategory === "car wash",
      "Maps data negative keyword catches 'car wash' from business title before enrichment",
      `Got: ${matchMapsCategory}`,
    );
  }

  console.log("\n=== 6a. GOOGLE MAPS DISCOVERY LAZY PERSISTENCE & ZERO PROFILE SCRAPER CALLS ===");
  {
    let mapsActorCallCount = 0;
    let profileActorCallCount = 0;

    setMockActorRunnerForTesting(async (actorId, input, options) => {
      if (actorId.includes("google-places") || actorId.includes("crawler-google-places")) {
        mapsActorCallCount++;
        return {
          run: { id: "mock-run-maps", status: "SUCCEEDED" } as any,
          items: [
            {
              title: "Toronto Smile Studio",
              address: "123 Yonge St, Toronto, ON M4C 1B5",
              city: "Toronto",
              phone: "+1 416-555-0100",
              website: "https://torontosmilestudio.com",
              categoryName: "Dentist",
              totalScore: 4.9,
              reviewsCount: 88,
            },
          ],
          usageTotalUsd: 0.005,
          computeUnits: 0,
          isDryRun: false,
        };
      }
      if (actorId.includes("instagram-profile")) {
        profileActorCallCount++;
        return {
          run: { id: "mock-run-profile", status: "SUCCEEDED" } as any,
          items: [],
          usageTotalUsd: 0.0026,
          computeUnits: 0,
          isDryRun: false,
        };
      }
      throw new Error(`Unexpected actor: ${actorId}`);
    });

    // Verify GoogleMapsDiscoveryProvider structure & candidate generation
    const provider = new GoogleMapsDiscoveryProvider();
    check(provider.name === "google_maps", "Provider name is google_maps");

    // Mock HTML fetch for the website:
    const originalFetch = global.fetch;
    global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("torontosmilestudio.com")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          text: async () => `
            <html>
              <body>
                <h1>Toronto Smile Studio</h1>
                <a href="https://instagram.com/torontosmilestudio">IG</a>
                <a href="https://facebook.com/torontosmilestudio">FB</a>
                <a href="https://tiktok.com/@smilestudio">TikTok</a>
              </body>
            </html>
          `,
        } as unknown as Response;
      }
      return originalFetch(url, init);
    };

    try {
      const result = await provider.discover({
        campaignId: "test-camp-lazy",
        query: "dentist",
        queries: ["dentist"],
        location: "Toronto, ON",
        limit: 5,
      });

      check(result.candidates.length === 1, "Discovered 1 candidate from Google Maps");
      const cand = result.candidates[0];
      check(cand.username === "torontosmilestudio", "Candidate handle extracted from website");
      check(
        cand.socialLinks?.facebook === "https://www.facebook.com/torontosmilestudio",
        "Discovered other social link (Facebook)",
        JSON.stringify(cand.socialLinks),
      );
      check(
        cand.socialLinks?.tiktok === "https://www.tiktok.com/@smilestudio",
        "Discovered other social link (TikTok)",
      );

      // Verify that profile actor was called ZERO times!
      check(
        profileActorCallCount === 0,
        "ZERO calls made to apify/instagram-profile-scraper during Google Maps discovery",
        `profileActorCallCount was: ${profileActorCallCount}`,
      );
      check(
        mapsActorCallCount >= 1,
        "Google Maps scraper was called for discovery",
      );
    } finally {
      global.fetch = originalFetch;
      setMockActorRunnerForTesting(null);
    }
  }

  console.log("\n=== 6d. ON-DEMAND ENRICHMENT (COST GUARD, 30-DAY CACHE, MAX 20 BATCH) ===");
  {
    const prisma = getPrismaClient();

    let testUser = await prisma.user.findFirst({ select: { id: true } });
    let createdTestUser = false;
    if (!testUser) {
      testUser = await prisma.user.create({
        data: {
          email: `test_lazy_${Date.now()}@example.com`,
          passwordHash: "test_secret_hash",
          name: "Test Lazy User",
        },
        select: { id: true },
      });
      createdTestUser = true;
    }

    const testCampaign = await prisma.campaign.create({
      data: {
        name: "Test Lazy Enrichment Campaign",
        userId: testUser.id,
        intent: "Dental clinic outreach",
        category: "Dentist",
        location: "Toronto, ON",
        status: "DRAFT",
      } as any,
    });

    const notEnrichedLead1 = await prisma.lead.create({
      data: {
        campaignId: testCampaign.id,
        userId: testUser.id,
        username: "testlazy1_" + Date.now(),
        usernameNormalized: ("testlazy1_" + Date.now()).toLowerCase(),
        profileUrl: "https://instagram.com/testlazy1",
        source: "google_maps",
        rawProfileData: {
          enrichmentStatus: "NOT_ENRICHED",
          mapsCategory: "Dentist",
          city: "Toronto",
        },
      },
    });

    const notEnrichedLead2 = await prisma.lead.create({
      data: {
        campaignId: testCampaign.id,
        userId: testUser.id,
        username: "testlazy2_" + Date.now(),
        usernameNormalized: ("testlazy2_" + Date.now()).toLowerCase(),
        profileUrl: "https://instagram.com/testlazy2",
        source: "google_maps",
        rawProfileData: {
          enrichmentStatus: "NOT_ENRICHED",
          mapsCategory: "Dentist",
          city: "Toronto",
        },
      },
    });

    let profileActorCallCount = 0;
    let lastProfileActorInput: Record<string, unknown> | null = null;

    setMockActorRunnerForTesting(async (actorId, input, options) => {
      if (actorId.includes("instagram-profile")) {
        profileActorCallCount++;
        lastProfileActorInput = input;
        const usernames = (input.usernames as string[]) || [];
        const items = usernames.map((u) => ({
          username: u,
          fullName: u === notEnrichedLead1.username ? "Dr. Smile One" : "Dr. Smile Two",
          followersCount: u === notEnrichedLead1.username ? 1200 : 50,
          followsCount: u === notEnrichedLead1.username ? 400 : 20,
          postsCount: u === notEnrichedLead1.username ? 50 : 1,
          biography: u === notEnrichedLead1.username ? "Gentle dentistry in Toronto" : "Cosmetic dentistry specialist",
          externalUrl: u === notEnrichedLead1.username ? "https://smileone.ca" : "https://smiletwo.ca",
          isBusinessAccount: true,
          businessCategoryName: u === notEnrichedLead1.username ? "Dentist" : "Cosmetic Dentist",
          isPrivate: false,
          verified: u !== notEnrichedLead1.username,
        }));
        return {
          run: { id: "mock-run-enrich", status: "SUCCEEDED" } as any,
          items,
          usageTotalUsd: usernames.length * 0.0026,
          computeUnits: 0,
          isDryRun: false,
        };
      }
      throw new Error(`Unexpected actor: ${actorId}`);
    });

    try {
      // 1. Max 20 batch size limit test
      try {
        const dummyIds = Array.from({ length: 21 }, (_, i) => `lead-${i}`);
        await enrichLeadsOnDemand({ leadIds: dummyIds, userId: testUser.id });
        check(false, "Fails to reject > 20 leads batch");
      } catch (err: any) {
        check(
          err.code === "BATCH_LIMIT_EXCEEDED" || err.message?.includes("20"),
          "Rejects batch exceeding 20 leads with BATCH_LIMIT_EXCEEDED",
          err.message,
        );
      }

      // 2. First enrichment run (Uncached): calls profile actor ONCE for the handles
      const res1 = await enrichLeadsOnDemand({
        leadIds: [notEnrichedLead1.id, notEnrichedLead2.id],
        userId: testUser.id,
      });

      check(res1.success === true, "Enrichment request succeeded");
      check(res1.enrichedCount === 2, "Enriched 2 leads", `Got: ${res1.enrichedCount}`);
      check(res1.cachedCount === 0, "Zero cached leads on first run", `Got: ${res1.cachedCount}`);
      const passingRow = res1.leads.find((row) => row.id === notEnrichedLead1.id);
      const failingRow = res1.leads.find((row) => row.id === notEnrichedLead2.id);
      check(
        passingRow?.criteriaPassed === true,
        "Profile meeting follower/post criteria is marked passed",
        JSON.stringify(passingRow?.criteriaReasons),
      );
      check(
        failingRow?.criteriaPassed === false &&
          (failingRow?.criteriaReasons ?? []).some((reason) => reason.includes("Followers")) &&
          (failingRow?.criteriaReasons ?? []).some((reason) => reason.includes("Posts")),
        "Below-criteria profile keeps its account and reports follower/post shortfall",
        JSON.stringify(failingRow),
      );
      const dbFailing = await prisma.lead.findUnique({ where: { id: notEnrichedLead2.id } });
      const dbFailingRaw = (dbFailing?.rawProfileData ?? {}) as {
        enrichmentCriteria?: { passed?: boolean; reasons?: string[] };
      };
      check(
        dbFailingRaw.enrichmentCriteria?.passed === false &&
          (dbFailing?.scoreFlags ?? []).includes("BELOW_ENRICHMENT_CRITERIA"),
        "Below-criteria status is persisted on the lead for the list UI",
        JSON.stringify(dbFailingRaw.enrichmentCriteria),
      );
      check(profileActorCallCount === 1, "Profile actor called exactly ONCE for the batch");
      check(
        Array.isArray((lastProfileActorInput as any)?.usernames) &&
          (lastProfileActorInput as any).usernames.length === 2,
        "Profile actor input received array of 2 handles",
      );

      // Verify DB lead updated with whitelisted fields & ENRICHED status
      const updatedLead1 = await prisma.lead.findUnique({ where: { id: notEnrichedLead1.id } });
      check(
        updatedLead1?.followers === 1200,
        "DB lead followers updated to 1200",
        `Got: ${updatedLead1?.followers}`,
      );
      check(
        updatedLead1?.biography === "Gentle dentistry in Toronto",
        "DB lead biography updated",
      );
      check(
        (updatedLead1?.rawProfileData as Record<string, unknown>)?.enrichmentStatus === "ENRICHED",
        "DB lead rawProfileData.enrichmentStatus updated to ENRICHED",
      );

      // 3. Second enrichment run (Within 30-day cache):
      // Must hit cache and make ZERO additional Apify calls!
      const initialCallCount = profileActorCallCount;
      const res2 = await enrichLeadsOnDemand({
        leadIds: [notEnrichedLead1.id, notEnrichedLead2.id],
        userId: testUser.id,
      });

      check(res2.cachedCount === 2, "Hits 30-day cache for both leads", `Got: ${res2.cachedCount}`);
      check(res2.apifyCostUsd === 0, "Apify cost is $0.00 on cache hit", `Got: $${res2.apifyCostUsd}`);
      check(
        profileActorCallCount === initialCallCount,
        "ZERO new Apify actor calls made on cache hit",
      );
    } finally {
      // Cleanup test data
      await prisma.lead.deleteMany({ where: { campaignId: testCampaign.id } });
      await prisma.campaign.delete({ where: { id: testCampaign.id } });
      if (createdTestUser) {
        await prisma.user.delete({ where: { id: testUser.id } });
      }
      setMockActorRunnerForTesting(null);
    }
  }
  } finally {
    if (savedAllowedActors !== undefined) {
      process.env.APIFY_ALLOWED_ACTORS = savedAllowedActors;
    } else {
      delete process.env.APIFY_ALLOWED_ACTORS;
    }
    if (savedEnrichActor !== undefined) {
      process.env.IG_ENRICHMENT_ACTOR = savedEnrichActor;
    } else {
      delete process.env.IG_ENRICHMENT_ACTOR;
    }
    if (savedEnrichmentProvider !== undefined) {
      process.env.ENRICHMENT_PROVIDER = savedEnrichmentProvider;
    } else {
      delete process.env.ENRICHMENT_PROVIDER;
    }
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
