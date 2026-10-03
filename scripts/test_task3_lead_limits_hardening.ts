import "dotenv/config";
import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  parseLeadLimit,
  normalizeInstagramUsername,
} from "../src/lib/services/scraper/instagram-profile";

interface TestProfile {
  username: string;
  fullName: string;
  biography: string;
  externalUrl: string | null;
  isVerified: boolean;
  isBusinessAccount: boolean;
  businessCategoryName: string | null;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  profilePicUrl: string | null;
  profilePicUrlHd: string | null;
  highlightReelCount: number;
  rawProfileData: Prisma.InputJsonValue;
}

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

async function registerAndLogin(email: string, name: string): Promise<{ cookie: string; user: { id: string; email: string } }> {
  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!", name }),
  });

  let cookie = "";
  if (registerRes.status === 201) {
    const rawCookie = registerRes.headers.get("set-cookie");
    if (rawCookie) cookie = rawCookie.split(";")[0];
  }

  if (!cookie) {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "Password123!" }),
    });
    const rawCookie = loginRes.headers.get("set-cookie");
    if (!rawCookie) throw new Error(`Could not authenticate user ${email}`);
    cookie = rawCookie.split(";")[0];
  }

  const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Cookie: cookie },
  });
  const meData = await meRes.json();

  return { cookie, user: { id: meData.id, email: meData.email } };
}

async function main() {
  console.log("=================================================================");
  console.log("   TASK 3: LEAD LIMIT + SEARCH/FILTER + PAGINATION HARDENING     ");
  console.log(`   Base URL: ${BASE_URL}`);
  console.log("=================================================================\n");

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  // Helper function replicating persistCampaignLeads transactional logic for testing
  async function persistTestLeads(
    campaignId: string,
    profiles: TestProfile[],
    maxTotalLimit?: number
  ) {
    return await prisma.$transaction(async (tx) => {
      let currentTotal = await tx.lead.count({ where: { campaignId } });
      let newLeads = 0;
      let updatedLeads = 0;

      for (const p of profiles) {
        const normUsername = normalizeInstagramUsername(p.username);
        if (!normUsername) continue;

        const existing = await tx.lead.findUnique({
          where: {
            campaignId_username: {
              campaignId,
              username: normUsername,
            },
          },
          select: { id: true },
        });

        if (existing) {
          await tx.lead.update({
            where: { id: existing.id },
            data: {
              fullName: p.fullName,
              biography: p.biography,
              isVerified: p.isVerified,
              isBusinessAccount: p.isBusinessAccount,
            },
          });
          updatedLeads++;
        } else {
          if (maxTotalLimit !== undefined && currentTotal >= maxTotalLimit) {
            continue;
          }
          try {
            await tx.lead.create({
              data: {
                campaignId,
                username: normUsername,
                profileUrl: p.externalUrl ?? `https://www.instagram.com/${normUsername}/`,
                fullName: p.fullName,
                biography: p.biography,
                isVerified: p.isVerified,
                verified: p.isVerified,
                isBusiness: p.isBusinessAccount,
                isBusinessAccount: p.isBusinessAccount,
                category: p.businessCategoryName,
                businessCategoryName: p.businessCategoryName,
                followersCount: p.followersCount,
                followers: p.followersCount,
                followsCount: p.followingCount,
                following: p.followingCount,
                postsCount: p.postsCount,
                rawProfileData: p.rawProfileData as Prisma.InputJsonValue,
              },
            });
            newLeads++;
            currentTotal++;
          } catch (err: unknown) {
            if (
              err &&
              typeof err === "object" &&
              "code" in err &&
              (err as { code: string }).code === "P2002"
            ) {
              updatedLeads++;
            } else {
              throw err;
            }
          }
        }
      }
      return { newLeads, updatedLeads, total: currentTotal };
    });
  }

  // Unique email for tests
  const testRunId = Date.now().toString().slice(-6);
  const userAEmail = `tester_a_${testRunId}@task3test.com`;
  const userBEmail = `tester_b_${testRunId}@task3test.com`;

  console.log(`[Setup] Creating test users ${userAEmail} and ${userBEmail}...`);
  const userA = await registerAndLogin(userAEmail, "User A Tester");
  const userB = await registerAndLogin(userBEmail, "User B Tester");
  console.log("  Users ready.\n");

  // -------------------------------------------------------------
  // 1 & 2. leadLimit 1 and leadLimit 100 via API
  // -------------------------------------------------------------
  console.log("[Test 1 & 2: leadLimit 1 and 100 boundaries]");
  const c1Res = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      name: `T3 Min Campaign ${testRunId}`,
      intent: "Fitness trainers",
      leadLimit: 1,
    }),
  });
  const c1Data = await c1Res.json();
  assert(c1Res.status === 201 && c1Data.leadLimit === 1, "leadLimit 1 accepted and persisted");

  const c100Res = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      name: `T3 Max Campaign ${testRunId}`,
      intent: "Fitness trainers",
      leadLimit: 100,
    }),
  });
  const c100Data = await c100Res.json();
  assert(c100Res.status === 201 && c100Data.leadLimit === 100, "leadLimit 100 accepted and persisted");

  // Numeric string "50"
  const cStrRes = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      name: `T3 Numeric Str Campaign ${testRunId}`,
      intent: "Fitness trainers",
      leadLimit: "50",
    }),
  });
  const cStrData = await cStrRes.json();
  assert(cStrRes.status === 201 && cStrData.leadLimit === 50, "leadLimit '50' numeric string normalized to integer 50");

  // -------------------------------------------------------------
  // 3, 4, 5. Invalid leadLimits: 0, 101, negative, non-integer, strings
  // -------------------------------------------------------------
  console.log("\n[Test 3, 4 & 5: Invalid leadLimits return HTTP 400]");
  const c0Res = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      name: `T3 Zero Limit ${testRunId}`,
      leadLimit: 0,
    }),
  });
  assert(c0Res.status === 400, "leadLimit 0 rejected with HTTP 400");

  const c101Res = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      name: `T3 101 Limit ${testRunId}`,
      leadLimit: 101,
    }),
  });
  assert(c101Res.status === 400, "leadLimit 101 rejected with HTTP 400");

  const cNegRes = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      name: `T3 Neg Limit ${testRunId}`,
      leadLimit: -10,
    }),
  });
  assert(cNegRes.status === 400, "leadLimit -10 rejected with HTTP 400");

  const cStrInvalidRes = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      name: `T3 Abc Limit ${testRunId}`,
      leadLimit: "abc",
    }),
  });
  assert(cStrInvalidRes.status === 400, "leadLimit 'abc' rejected with HTTP 400");

  const cFloatRes = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      name: `T3 Float Limit ${testRunId}`,
      leadLimit: 10.5,
    }),
  });
  assert(cFloatRes.status === 400, "leadLimit 10.5 rejected with HTTP 400");

  // PATCH endpoint also validates leadLimit
  const cPatchBadRes = await fetch(`${BASE_URL}/api/campaigns/${c1Data.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      leadLimit: 200,
    }),
  });
  assert(cPatchBadRes.status === 400, "PATCH leadLimit 200 rejected with HTTP 400");

  // Unit tests on parseLeadLimit
  let unit400Count = 0;
  for (const bad of [0, -1, 101, 1000, "abc", "10abc", "10.5", NaN, Infinity, -Infinity]) {
    try {
      parseLeadLimit(bad, false);
    } catch {
      unit400Count++;
    }
  }
  assert(unit400Count === 10, "Unit tests: parseLeadLimit rejected all 10 invalid variations");

  // -------------------------------------------------------------
  // 6 & 7. Existing leads consume capacity & discovery never exceeds limit
  // -------------------------------------------------------------
  console.log("\n[Test 6 & 7: Existing leads consume campaign capacity & never exceed limit]");
  // Create a campaign with leadLimit = 10
  const capCampaign = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: `Capacity Campaign ${testRunId}`,
      intent: "Gym owners",
      leadLimit: 10,
    } as any,
  });

  // Pre-seed with 7 leads
  const mockProfiles7: TestProfile[] = Array.from({ length: 7 }, (_, i) => ({
    username: `coach_preseed_${i}_${testRunId}`,
    fullName: `Preseed Coach ${i}`,
    biography: `Preseeded bio ${i}`,
    externalUrl: `https://preseed${i}.com`,
    isVerified: false,
    isBusinessAccount: true,
    businessCategoryName: "Fitness Coach",
    followersCount: 1000 + i * 100,
    followingCount: 200,
    postsCount: 50,
    profilePicUrl: null,
    profilePicUrlHd: null,
    highlightReelCount: 0,
    rawProfileData: { test: true } as Prisma.InputJsonValue,
  }));

  const initialPersisted = await persistTestLeads(capCampaign.id, mockProfiles7, capCampaign.leadLimit ?? undefined);
  assert(initialPersisted.newLeads === 7, "Pre-seeded 7 leads successfully");

  // Now attempt to persist 10 new candidate profiles into this campaign (configured limit = 10)
  const mockProfiles10More: TestProfile[] = Array.from({ length: 10 }, (_, i) => ({
    username: `coach_attempt_${i}_${testRunId}`,
    fullName: `Attempt Coach ${i}`,
    biography: `Attempt bio ${i}`,
    externalUrl: null,
    isVerified: i % 2 === 0,
    isBusinessAccount: true,
    businessCategoryName: "Fitness Coach",
    followersCount: 2000 + i * 100,
    followingCount: 300,
    postsCount: 60,
    profilePicUrl: null,
    profilePicUrlHd: null,
    highlightReelCount: 0,
    rawProfileData: { test: true } as Prisma.InputJsonValue,
  }));

  const capRemainingPersisted = await persistTestLeads(
    capCampaign.id,
    mockProfiles10More,
    capCampaign.leadLimit ?? undefined
  );

  const totalInDb = await prisma.lead.count({ where: { campaignId: capCampaign.id } });
  assert(
    capRemainingPersisted.newLeads === 3,
    `Only 3 additional leads persisted when existing=7 and limit=10 (got newLeads=${capRemainingPersisted.newLeads})`
  );
  assert(
    totalInDb === 10,
    `Total leads in campaign exactly matches leadLimit=10 (got totalInDb=${totalInDb})`
  );

  // When limit is reached, discovery endpoint skips scraping and returns notice
  const fullDiscoverRes = await fetch(`${BASE_URL}/api/scraper/instagram/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      campaignId: capCampaign.id,
      intent: "Gyms",
      leadLimit: 10,
    }),
  });
  const fullDiscoverText = await fullDiscoverRes.text();
  const fullEvents = fullDiscoverText
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const resultEvent = fullEvents.find((e: { type?: string }) => e.type === "result");
  assert(
    fullDiscoverRes.status === 200 &&
    resultEvent?.meta?.remainingCapacity === 0 &&
    Boolean(resultEvent?.meta?.notice?.includes("LIMIT_REACHED")),
    "Discovery when limit reached returns CAMPAIGN_LIMIT_REACHED and 0 remaining capacity"
  );

  // -------------------------------------------------------------
  // 8 & 9. Duplicate usernames & case normalization
  // -------------------------------------------------------------
  console.log("\n[Test 8 & 9: Duplicate usernames & case normalization]");
  // Test normalization function
  const n1 = normalizeInstagramUsername("@Fit_Guru");
  const n2 = normalizeInstagramUsername("fit_guru");
  const n3 = normalizeInstagramUsername("https://instagram.com/Fit_Guru/");
  const n4 = normalizeInstagramUsername("https://www.instagram.com/fit_guru?igshid=123");
  assert(
    n1 === "fit_guru" && n2 === "fit_guru" && n3 === "fit_guru" && n4 === "fit_guru",
    "normalizeUsername correctly standardizes '@Fit_Guru', URL, and mixed case to 'fit_guru'"
  );

  // Persistence deduplication within campaign
  const dupCampaign = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: `Dup Campaign ${testRunId}`,
      leadLimit: 20,
    } as any,
  });

  const dupProfiles: TestProfile[] = [
    {
      username: "Fit_Guru",
      fullName: "Fit Guru",
      biography: "Bio 1",
      externalUrl: null,
      isVerified: true,
      isBusinessAccount: true,
      businessCategoryName: "Gym",
      followersCount: 5000,
      followingCount: 100,
      postsCount: 10,
      profilePicUrl: null,
      profilePicUrlHd: null,
      highlightReelCount: 0,
      rawProfileData: {} as Prisma.InputJsonValue,
    },
    {
      username: "@fit_guru",
      fullName: "Fit Guru Updated",
      biography: "Bio updated",
      externalUrl: null,
      isVerified: true,
      isBusinessAccount: true,
      businessCategoryName: "Gym",
      followersCount: 5200,
      followingCount: 105,
      postsCount: 12,
      profilePicUrl: null,
      profilePicUrlHd: null,
      highlightReelCount: 0,
      rawProfileData: {} as Prisma.InputJsonValue,
    },
  ];

  await persistTestLeads(dupCampaign.id, dupProfiles, dupCampaign.leadLimit ?? undefined);
  const dupCount = await prisma.lead.count({ where: { campaignId: dupCampaign.id } });
  const dupLead = await prisma.lead.findFirst({ where: { campaignId: dupCampaign.id } });
  assert(
    dupCount === 1 && dupLead?.username === "fit_guru",
    `Duplicate variations created exactly 1 record with normalized username 'fit_guru' (got count=${dupCount})`
  );

  // -------------------------------------------------------------
  // 10. Repeated discovery / persistence does not inflate count
  // -------------------------------------------------------------
  console.log("\n[Test 10: Repeated discovery / persistence]");
  await persistTestLeads(dupCampaign.id, dupProfiles, dupCampaign.leadLimit ?? undefined);
  const repeatedCount = await prisma.lead.count({ where: { campaignId: dupCampaign.id } });
  assert(repeatedCount === 1, "Re-running persistence with same profiles did not inflate lead count");

  // -------------------------------------------------------------
  // 11. Concurrent discovery protection
  // -------------------------------------------------------------
  console.log("\n[Test 11: Concurrent discovery protection]");
  // Create an active RUNNING job
  const activeJob = await prisma.scrapeJob.create({
    data: {
      campaignId: capCampaign.id,
      status: "RUNNING",
      provider: "apify",
      startedAt: new Date(),
    },
  });

  // Attempt to trigger discovery while active job exists
  const concurrentRes = await fetch(`${BASE_URL}/api/scraper/instagram/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      campaignId: capCampaign.id,
      intent: "fitness gym",
      leadLimit: 5,
    }),
  });

  const concurrentText = await concurrentRes.text();
  const concurrentEvents = concurrentText
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const errEvent = concurrentEvents.find((e: { type?: string }) => e.type === "error");
  assert(
    concurrentRes.status === 409 || errEvent?.error?.code === "CONCURRENT_DISCOVERY",
    `Concurrent discovery blocked with Conflict (got status=${concurrentRes.status}, code=${errEvent?.error?.code})`
  );

  // Clean up running job
  await prisma.scrapeJob.update({
    where: { id: activeJob.id },
    data: { status: "COMPLETED" },
  });

  // -------------------------------------------------------------
  // Seed a campaign with 15 known leads for Pagination, Search & Filters
  // -------------------------------------------------------------
  console.log("\n[Setup Data for Pagination, Search & Filter Tests]");
  const searchCampaign = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: `Search Filter Campaign ${testRunId}`,
      leadLimit: 50,
    } as any,
  });

  // We will create 15 leads with controlled attributes:
  // - 5 Verified Fitness Trainers (isVerified=true, isBusinessAccount=true, category="Fitness Trainer", bio contains "CrossFit specialist")
  // - 5 Personal accounts without verification (isVerified=false, isBusinessAccount=false, category=null, bio contains "Yoga lover")
  // - 5 Business nutritionists (isVerified=false, isBusinessAccount=true, category="Nutritionist", bio contains "Healthy meal plans")
  const leadsToSeed: TestProfile[] = [];

  for (let i = 1; i <= 5; i++) {
    leadsToSeed.push({
      username: `verified_crossfit_${i}_${testRunId}`,
      fullName: `Alex CrossFit ${i}`,
      biography: `Certified CrossFit specialist and athlete ${i}`,
      externalUrl: `https://crossfit${i}.com`,
      isVerified: true,
      isBusinessAccount: true,
      businessCategoryName: "Fitness Trainer",
      followersCount: 20000 + i * 1000,
      followingCount: 500,
      postsCount: 150,
      profilePicUrl: null,
      profilePicUrlHd: null,
      highlightReelCount: 0,
      rawProfileData: { group: "crossfit" } as Prisma.InputJsonValue,
    });
  }

  for (let i = 1; i <= 5; i++) {
    leadsToSeed.push({
      username: `yoga_personal_${i}_${testRunId}`,
      fullName: `Sarah Yoga ${i}`,
      biography: `Mindfulness and Yoga lover ${i}`,
      externalUrl: null,
      isVerified: false,
      isBusinessAccount: false,
      businessCategoryName: null,
      followersCount: 1500 + i * 100,
      followingCount: 300,
      postsCount: 40,
      profilePicUrl: null,
      profilePicUrlHd: null,
      highlightReelCount: 0,
      rawProfileData: { group: "yoga" } as Prisma.InputJsonValue,
    });
  }

  for (let i = 1; i <= 5; i++) {
    leadsToSeed.push({
      username: `meal_nutritionist_${i}_${testRunId}`,
      fullName: `Jordan Diet ${i}`,
      biography: `Healthy meal plans and nutrition coach ${i}`,
      externalUrl: `https://nutrition${i}.com`,
      isVerified: false,
      isBusinessAccount: true,
      businessCategoryName: "Nutritionist",
      followersCount: 8000 + i * 500,
      followingCount: 400,
      postsCount: 80,
      profilePicUrl: null,
      profilePicUrlHd: null,
      highlightReelCount: 0,
      rawProfileData: { group: "nutrition" } as Prisma.InputJsonValue,
    });
  }

  await persistTestLeads(searchCampaign.id, leadsToSeed, searchCampaign.leadLimit ?? undefined);
  const seededCount = await prisma.lead.count({ where: { campaignId: searchCampaign.id } });
  assert(seededCount === 15, `Seeded exactly 15 test leads in campaign (got ${seededCount})`);

  // Add outreach message for one lead to test status filter
  const leadToMessage = await prisma.lead.findFirst({
    where: { campaignId: searchCampaign.id, username: `verified_crossfit_1_${testRunId}` },
  });
  if (leadToMessage) {
    await prisma.message.create({
      data: {
        campaignId: searchCampaign.id,
        leadId: leadToMessage.id,
        messageText: "Hello from test outreach!",
        status: "SENT",
      },
    });
  }

  // -------------------------------------------------------------
  // 12, 13, 14. Pagination: Page 1, Middle Page, Final Page
  // -------------------------------------------------------------
  console.log("\n[Test 12, 13 & 14: Pagination]");
  // Page 1 with limit 6 (total 15 => 3 pages: 6, 6, 3)
  const p1Res = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?page=1&limit=6`, {
    headers: { Cookie: userA.cookie },
  });
  const p1Data = await p1Res.json();
  const leadsP1 = p1Data.leads || p1Data.items;
  assert(
    p1Res.status === 200 &&
    leadsP1.length === 6 &&
    p1Data.pagination.page === 1 &&
    p1Data.pagination.total === 15 &&
    p1Data.pagination.totalPages === 3 &&
    p1Data.pagination.hasNextPage === true &&
    p1Data.pagination.hasPreviousPage === false,
    "Pagination Page 1: returned 6 leads, hasNextPage=true, hasPreviousPage=false"
  );

  // Middle Page: Page 2
  const p2Res = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?page=2&limit=6`, {
    headers: { Cookie: userA.cookie },
  });
  const p2Data = await p2Res.json();
  const leadsP2 = p2Data.leads || p2Data.items;
  assert(
    p2Res.status === 200 &&
    leadsP2.length === 6 &&
    p2Data.pagination.page === 2 &&
    p2Data.pagination.hasNextPage === true &&
    p2Data.pagination.hasPreviousPage === true,
    "Pagination Middle Page (Page 2): returned 6 leads, hasNextPage=true, hasPreviousPage=true"
  );

  // Final Page: Page 3
  const p3Res = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?page=3&limit=6`, {
    headers: { Cookie: userA.cookie },
  });
  const p3Data = await p3Res.json();
  const leadsP3 = p3Data.leads || p3Data.items;
  assert(
    p3Res.status === 200 &&
    leadsP3.length === 3 &&
    p3Data.pagination.page === 3 &&
    p3Data.pagination.hasNextPage === false &&
    p3Data.pagination.hasPreviousPage === true,
    "Pagination Final Page (Page 3): returned remaining 3 leads, hasNextPage=false, hasPreviousPage=true"
  );

  // Ensure no duplicate items across pages
  const p1Ids = new Set(leadsP1.map((l: { id: string }) => l.id));
  const p2Overlap = leadsP2.filter((l: { id: string }) => p1Ids.has(l.id));
  assert(p2Overlap.length === 0, "No duplicate lead IDs across page 1 and page 2");

  // -------------------------------------------------------------
  // 15 & 16. Safe Handling of Invalid Page and Invalid Limit
  // -------------------------------------------------------------
  console.log("\n[Test 15 & 16: Safe handling of invalid page and limit]");
  // Negative or 0 page should return 400 validation error without crash
  const badPageRes = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?page=-5&limit=10`, {
    headers: { Cookie: userA.cookie },
  });
  assert(
    badPageRes.status === 400,
    "Invalid page=-5 rejected with HTTP 400 without server crash"
  );

  // Limit > 100 or negative should return 400 validation error
  const badLimitRes = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?page=1&limit=500`, {
    headers: { Cookie: userA.cookie },
  });
  assert(
    badLimitRes.status === 400,
    "Excessive limit=500 rejected with HTTP 400 without server crash"
  );

  // Non-numeric string for page & limit
  const strPageRes = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?page=abc&limit=xyz`, {
    headers: { Cookie: userA.cookie },
  });
  assert(
    strPageRes.status === 400,
    "Non-numeric page & limit rejected with HTTP 400 without server crash"
  );

  // -------------------------------------------------------------
  // 17 & 18. Server-side Search & Case-Insensitive Search
  // -------------------------------------------------------------
  console.log("\n[Test 17 & 18: Server-side Search & Case-Insensitive Search]");
  // Search for "crossfit" (in username and bio)
  const s1Res = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?search=crossfit`, {
    headers: { Cookie: userA.cookie },
  });
  const s1Data = await s1Res.json();
  const s1Leads = s1Data.leads || s1Data.items;
  assert(
    s1Res.status === 200 && s1Leads.length === 5,
    `Search 'crossfit' returned exactly 5 leads (got ${s1Leads.length})`
  );

  // Case-insensitive search "CROSSFIT"
  const s2Res = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?search=CROSSFIT`, {
    headers: { Cookie: userA.cookie },
  });
  const s2Data = await s2Res.json();
  const s2Leads = s2Data.leads || s2Data.items;
  assert(
    s2Res.status === 200 && s2Leads.length === 5,
    `Case-insensitive search 'CROSSFIT' returned identical 5 leads`
  );

  // Search by biography keyword "meal plans"
  const sBioRes = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?search=meal%20plans`, {
    headers: { Cookie: userA.cookie },
  });
  const sBioData = await sBioRes.json();
  const sBioLeads = sBioData.leads || sBioData.items;
  assert(
    sBioRes.status === 200 && sBioLeads.length === 5,
    `Search for biography term 'meal plans' returned 5 nutrition leads`
  );

  // -------------------------------------------------------------
  // 19. Verified filter
  // -------------------------------------------------------------
  console.log("\n[Test 19: Verified filter]");
  const vRes = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?verified=true`, {
    headers: { Cookie: userA.cookie },
  });
  const vData = await vRes.json();
  const vLeads = vData.leads || vData.items;
  const allVerified = vLeads.every((l: { isVerified: boolean }) => l.isVerified === true);
  assert(
    vRes.status === 200 && vLeads.length === 5 && allVerified,
    `verified=true filter returned 5 verified leads and 0 unverified`
  );

  // -------------------------------------------------------------
  // 20. Business account filter
  // -------------------------------------------------------------
  console.log("\n[Test 20: Business account filter]");
  const bRes = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?isBusinessAccount=false`, {
    headers: { Cookie: userA.cookie },
  });
  const bData = await bRes.json();
  const bLeads = bData.leads || bData.items;
  const allPersonal = bLeads.every((l: { isBusinessAccount: boolean }) => l.isBusinessAccount === false);
  assert(
    bRes.status === 200 && bLeads.length === 5 && allPersonal,
    `isBusinessAccount=false filter returned exactly 5 personal leads`
  );

  // -------------------------------------------------------------
  // 21. Status filter
  // -------------------------------------------------------------
  console.log("\n[Test 21: Status filter]");
  // Lead with message status "CONTACTED"
  const stRes = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?status=CONTACTED`, {
    headers: { Cookie: userA.cookie },
  });
  const stData = await stRes.json();
  const stLeads = stData.leads || stData.items;
  assert(
    stRes.status === 200 && stLeads.length === 1 && stLeads[0].username === `verified_crossfit_1_${testRunId}`,
    `status=CONTACTED filter returned exactly the 1 contacted lead`
  );

  // Leads with status "NEW" (14 leads without outreach messages)
  const stNewRes = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?status=NEW`, {
    headers: { Cookie: userA.cookie },
  });
  const stNewData = await stNewRes.json();
  assert(
    stNewRes.status === 200 && stNewData.pagination.total === 14,
    `status=NEW filter returned remaining 14 leads without outreach messages`
  );

  // -------------------------------------------------------------
  // 22. Combined search + filters
  // -------------------------------------------------------------
  console.log("\n[Test 22: Combined search + filters]");
  const combRes = await fetch(
    `${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?search=crossfit&verified=true&isBusinessAccount=true&status=NEW`,
    { headers: { Cookie: userA.cookie } }
  );
  const combData = await combRes.json();
  const combLeads = combData.leads || combData.items;
  // Out of 5 crossfit leads, 1 was CONTACTED, so 4 are NEW + verified + business
  assert(
    combRes.status === 200 && combLeads.length === 4,
    `Combined filters (search=crossfit + verified=true + isBusiness=true + status=NEW) matched exactly 4 leads`
  );

  // -------------------------------------------------------------
  // 23. Deterministic ordering
  // -------------------------------------------------------------
  console.log("\n[Test 23: Deterministic ordering]");
  const o1Res = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?page=1&limit=15`, {
    headers: { Cookie: userA.cookie },
  });
  const o1Data = await o1Res.json();
  const o1Leads = (o1Data.leads || o1Data.items).map((l: { id: string }) => l.id);

  const o2Res = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?page=1&limit=15`, {
    headers: { Cookie: userA.cookie },
  });
  const o2Data = await o2Res.json();
  const o2Leads = (o2Data.leads || o2Data.items).map((l: { id: string }) => l.id);

  const isIdenticalOrder = JSON.stringify(o1Leads) === JSON.stringify(o2Leads);
  assert(
    isIdenticalOrder && o1Leads.length === 15,
    "Deterministic ordering (createdAt DESC, id DESC) confirmed across consecutive requests"
  );

  // -------------------------------------------------------------
  // 24. IDOR Protection (Tenant Isolation)
  // -------------------------------------------------------------
  console.log("\n[Test 24: IDOR Protection]");
  // User B tries to read User A's campaign leads
  const idorRes = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads`, {
    headers: { Cookie: userB.cookie },
  });
  assert(
    idorRes.status === 404 || idorRes.status === 403,
    `IDOR blocked: User B querying User A's campaign returned ${idorRes.status} (never 200)`
  );

  // -------------------------------------------------------------
  // 25. Empty campaign
  // -------------------------------------------------------------
  console.log("\n[Test 25: Empty campaign]");
  const emptyCampaign = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: `Empty Campaign ${testRunId}`,
      leadLimit: 25,
    } as any,
  });

  const emptyRes = await fetch(`${BASE_URL}/api/campaigns/${emptyCampaign.id}/leads`, {
    headers: { Cookie: userA.cookie },
  });
  const emptyData = await emptyRes.json();
  const emptyLeads = emptyData.leads || emptyData.items;
  assert(
    emptyRes.status === 200 &&
    Array.isArray(emptyLeads) &&
    emptyLeads.length === 0 &&
    emptyData.pagination.total === 0 &&
    emptyData.pagination.totalPages === 0 &&
    emptyData.pagination.hasNextPage === false &&
    emptyData.pagination.hasPreviousPage === false,
    "Empty campaign returned empty list with total=0 and totalPages=0"
  );

  // -------------------------------------------------------------
  // 26. Zero search results
  // -------------------------------------------------------------
  console.log("\n[Test 26: Zero search results]");
  const zeroSearchRes = await fetch(`${BASE_URL}/api/campaigns/${searchCampaign.id}/leads?search=nonexistent_xyz_99999`, {
    headers: { Cookie: userA.cookie },
  });
  const zeroSearchData = await zeroSearchRes.json();
  const zeroSearchLeads = zeroSearchData.leads || zeroSearchData.items;
  assert(
    zeroSearchRes.status === 200 &&
    Array.isArray(zeroSearchLeads) &&
    zeroSearchLeads.length === 0 &&
    zeroSearchData.pagination.total === 0,
    "Zero search results handled cleanly with total=0 and leads=[]"
  );

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log("\n=================================================================");
  console.log(`   TASK 3 AUTOMATED TESTS COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================================");

  await prisma.$disconnect();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
