import "dotenv/config";
import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  normalizeInstagramProfileItem,
  extractActorError,
} from "../src/lib/services/scraper/instagram-profile";

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

async function registerAndLogin(email: string, name: string): Promise<string> {
  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!", name }),
  });

  if (registerRes.status === 201) {
    const cookie = registerRes.headers.get("set-cookie");
    if (cookie) return cookie.split(";")[0];
  }

  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!" }),
  });

  const cookie = loginRes.headers.get("set-cookie");
  if (!cookie) throw new Error(`Could not authenticate user ${email}`);
  return cookie.split(";")[0];
}

async function main() {
  console.log("=================================================================");
  console.log("   TASK 2: RICH INSTAGRAM PROFILE DATA & LEADS DIRECTORY TEST   ");
  console.log(`   Base URL: ${BASE_URL}`);
  console.log("=================================================================\n");

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  // -------------------------------------------------------------
  // 1. Profile Response Normalization Unit Tests
  // -------------------------------------------------------------
  console.log("[1. Profile Response Normalization]");
  const fullRawApifyItem = {
    id: "1234567890",
    username: "EliteFitnessCoach",
    url: "https://www.instagram.com/elitefitnesscoach/",
    fullName: "Alex Rivera | Elite Fitness",
    biography: "Transforming busy professionals into peak athletes 🏋️‍♂️ DM for 1-on-1 coaching.",
    followersCount: 45200,
    followsCount: 650,
    postsCount: 380,
    isBusinessAccount: true,
    businessCategoryName: "Fitness Trainer",
    verified: true,
    externalUrl: "https://elitefitnesscoach.example.com",
    profilePicUrl: "https://instagram.example.com/pic-standard.jpg",
    profilePicUrlHD: "https://instagram.example.com/pic-hd.jpg",
    locationName: "Rawalpindi, Pakistan",
    highlightReelCount: 14,
    isPrivate: false,
    joinedRecently: false,
    hasChannel: true,
    latestPosts: [
      {
        id: "post-1",
        shortCode: "Cx9988",
        url: "https://www.instagram.com/p/Cx9988/",
        caption: "Chest & Shoulders breakdown! Save for later.",
        likesCount: 1200,
        commentsCount: 45,
        displayUrl: "https://instagram.example.com/p1.jpg",
      },
    ],
    relatedProfiles: [
      {
        username: "rival_gym",
        full_name: "Rival Gym",
        profile_pic_url: "https://instagram.example.com/rival.jpg",
        is_verified: false,
      },
    ],
  };

  const normalized = normalizeInstagramProfileItem(fullRawApifyItem, new Date().toISOString());
  assert(normalized !== null, "Full profile item normalizes successfully");
  assert(normalized?.username === "elitefitnesscoach", "Username normalized to lowercase");
  assert(normalized?.fullName === "Alex Rivera | Elite Fitness", "Full name preserved");
  assert(normalized?.followers === 45200 && normalized?.followersCount === 45200, "Followers and followersCount populated");
  assert(normalized?.following === 650 && normalized?.followsCount === 650, "Following and followsCount populated");
  assert(normalized?.postsCount === 380, "postsCount populated");
  assert(normalized?.isVerified === true && normalized?.verified === true, "Verified flags populated");
  assert(normalized?.isBusiness === true && normalized?.isBusinessAccount === true, "Business flags populated");
  assert(normalized?.category === "Fitness Trainer" && normalized?.businessCategoryName === "Fitness Trainer", "Category populated");
  assert(normalized?.externalUrl === "https://elitefitnesscoach.example.com", "External URL preserved");
  assert(normalized?.profilePictureUrl === "https://instagram.example.com/pic-hd.jpg", "HD profile image preferred over standard");
  assert(normalized?.profilePicUrlHD === "https://instagram.example.com/pic-hd.jpg", "profilePicUrlHD stored");
  assert(normalized?.profilePicUrl === "https://instagram.example.com/pic-standard.jpg", "profilePicUrl stored");
  assert(normalized?.rawProfileData !== null && typeof normalized?.rawProfileData === "object", "rawProfileData stored as structured object");
  assert(normalized?.rawProfileData?.["highlightReelCount"] === 14, "rawProfileData contains highlightReelCount");
  assert(normalized?.latestPosts?.length === 1, "latestPosts normalized");
  assert(normalized?.relatedProfiles?.length === 1, "relatedProfiles normalized");

  // -------------------------------------------------------------
  // 2. Missing Optional Fields
  // -------------------------------------------------------------
  console.log("\n[2. Missing Optional Fields]");
  const minimalItem = {
    username: "MinimalUser",
    url: "https://www.instagram.com/minimaluser/",
  };
  const minimalNorm = normalizeInstagramProfileItem(minimalItem, new Date().toISOString());
  assert(minimalNorm !== null, "Minimal profile normalizes without errors");
  assert(minimalNorm?.username === "minimaluser", "Username extracted");
  assert(minimalNorm?.biography === null, "Missing biography is null");
  assert(minimalNorm?.followers === null && minimalNorm?.followersCount === null, "Missing followers is null");
  assert(minimalNorm?.profilePictureUrl === null, "Missing profile picture is null");
  assert(minimalNorm?.category === null, "Missing category is null");

  // -------------------------------------------------------------
  // 3. Actor Error Items
  // -------------------------------------------------------------
  console.log("\n[3. Actor Error Items]");
  const errorItem1 = {
    username: "deleted_user_123",
    error: "not_found",
    errorDescription: "Profile not found or disabled",
  };
  assert(normalizeInstagramProfileItem(errorItem1, new Date().toISOString()) === null, "Error item returns null from normalizer");
  const extracted1 = extractActorError(errorItem1);
  assert(extracted1 !== null && extracted1.username === "deleted_user_123", "extractActorError captures username");
  assert(Boolean(extracted1?.reason.includes("not_found")), "extractActorError captures reason");

  const errorItem2 = {
    username: "private_error_456",
    errorDescription: "Cannot access profile",
  };
  assert(normalizeInstagramProfileItem(errorItem2, new Date().toISOString()) === null, "errorDescription-only item returns null");

  // -------------------------------------------------------------
  // 4. HD Profile Image Fallback
  // -------------------------------------------------------------
  console.log("\n[4. HD Profile Image Fallback]");
  const standardOnlyItem = {
    username: "StandardPicUser",
    profilePicUrl: "https://instagram.example.com/only-standard.jpg",
  };
  const standardNorm = normalizeInstagramProfileItem(standardOnlyItem, new Date().toISOString());
  assert(standardNorm?.profilePictureUrl === "https://instagram.example.com/only-standard.jpg", "Falls back to standard image when HD missing");

  // -------------------------------------------------------------
  // 5. Database Persistence & Deduplication
  // -------------------------------------------------------------
  console.log("\n[5. Database Persistence & Deduplication]");
  const userAEmail = `task2_tester_a_${Date.now()}@example.com`;
  const userACookie = await registerAndLogin(userAEmail, "Tester A");

  const userBEmail = `task2_tester_b_${Date.now()}@example.com`;
  const userBCookie = await registerAndLogin(userBEmail, "Tester B");

  // Create Campaign for User A
  const campRes = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userACookie },
    body: JSON.stringify({
      name: "Task 2 Test Campaign",
      description: "Testing rich profile data and leads directory",
      intent: "Fitness gym owners",
      location: "Rawalpindi",
      category: "Fitness",
      leadLimit: 15,
    }),
  });
  const campData = await campRes.json();
  const campaignId = campData.id;
  assert(campRes.status === 201 && !!campaignId, "Campaign created for User A");

  // Persist normalized rich profile directly via Prisma upsert
  const leadDataToPersist = {
    profileUrl: normalized!.profileUrl,
    instagramId: normalized!.instagramId,
    fullName: normalized!.fullName,
    biography: normalized!.biography,
    followers: normalized!.followers,
    following: normalized!.following,
    followersCount: normalized!.followersCount,
    followsCount: normalized!.followsCount,
    postsCount: normalized!.postsCount,
    profilePictureUrl: normalized!.profilePictureUrl,
    profilePicUrl: normalized!.profilePicUrl,
    profilePicUrlHD: normalized!.profilePicUrlHD,
    isVerified: normalized!.isVerified,
    verified: normalized!.verified,
    isBusiness: normalized!.isBusiness,
    isBusinessAccount: normalized!.isBusinessAccount,
    category: normalized!.category,
    businessCategoryName: normalized!.businessCategoryName,
    externalUrl: normalized!.externalUrl,
    location: normalized!.location,
    relatedProfiles: (normalized!.relatedProfiles ?? Prisma.DbNull) as Prisma.InputJsonValue,
    latestPosts: (normalized!.latestPosts ?? Prisma.DbNull) as Prisma.InputJsonValue,
    rawProfileData: (normalized!.rawProfileData ?? Prisma.DbNull) as Prisma.InputJsonValue,
    source: "apify",
    scrapedAt: new Date(normalized!.scrapedAt),
  };

  const leadInDb = await prisma.lead.upsert({
    where: { campaignId_username: { campaignId, username: normalized!.username! } },
    create: {
      campaignId,
      username: normalized!.username!,
      ...leadDataToPersist,
    },
    update: leadDataToPersist,
  });

  assert(leadInDb !== null, "Lead persisted into database");
  assert(leadInDb?.followersCount === 45200, "DB column followersCount stored");
  assert(leadInDb?.followsCount === 650, "DB column followsCount stored");
  assert(leadInDb?.verified === true, "DB column verified stored");
  assert(leadInDb?.isBusinessAccount === true, "DB column isBusinessAccount stored");
  assert(leadInDb?.businessCategoryName === "Fitness Trainer", "DB column businessCategoryName stored");
  assert(leadInDb?.profilePicUrlHD === "https://instagram.example.com/pic-hd.jpg", "DB column profilePicUrlHD stored");
  assert(leadInDb?.rawProfileData !== null, "DB column rawProfileData stored");

  // Re-persist same username (duplicate test)
  await prisma.lead.upsert({
    where: { campaignId_username: { campaignId, username: normalized!.username! } },
    create: {
      campaignId,
      username: normalized!.username!,
      ...leadDataToPersist,
    },
    update: leadDataToPersist,
  });

  const countAfterDuplicate = await prisma.lead.count({
    where: { campaignId, username: "elitefitnesscoach" },
  });
  assert(countAfterDuplicate === 1, "Duplicate username does not create second lead record");

  // -------------------------------------------------------------
  // 6. Profile Refresh Without Overwriting Messaging State
  // -------------------------------------------------------------
  console.log("\n[6. Profile Refresh Without Overwriting Messaging State]");
  if (leadInDb) {
    // Create a sent message for this lead
    await prisma.message.create({
      data: {
        campaignId,
        leadId: leadInDb.id,
        messageText: "Hello! We loved your fitness content.",
        status: "SENT",
        provider: "playwright",
        sentAt: new Date(),
      },
    });

    // Re-scrape with updated follower count and biography
    const updatedLeadData = {
      ...leadDataToPersist,
      followersCount: 52000,
      followers: 52000,
      biography: "Updated Bio: Over 50K athletes coached!",
    };
    await prisma.lead.upsert({
      where: { campaignId_username: { campaignId, username: normalized!.username! } },
      create: {
        campaignId,
        username: normalized!.username!,
        ...updatedLeadData,
      },
      update: updatedLeadData,
    });

    const refreshedLead = await prisma.lead.findUnique({
      where: { id: leadInDb.id },
      include: { messages: true },
    });
    assert(refreshedLead?.followersCount === 52000, "Profile followers count updated on re-scrape");
    assert(refreshedLead?.biography === "Updated Bio: Over 50K athletes coached!", "Biography updated on re-scrape");
    assert(refreshedLead?.messages.length === 1, "Message history preserved after re-scrape");
    assert(refreshedLead?.messages[0].status === "SENT", "Message status remain SENT after re-scrape");
  }

  // -------------------------------------------------------------
  // 7. Leads API Returns Rich Profile Fields
  // -------------------------------------------------------------
  console.log("\n[7. Leads API Returns Rich Profile Fields]");
  const leadsApiRes = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/leads?page=1&limit=10`, {
    headers: { Cookie: userACookie },
  });
  assert(leadsApiRes.status === 200, "GET /api/campaigns/[id]/leads returns 200");
  const leadsJson = await leadsApiRes.json();
  assert(leadsJson.items.length >= 1, "API returned leads list");
  const firstApiLead = leadsJson.items[0];
  assert("followersCount" in firstApiLead, "API response contains followersCount");
  assert("followsCount" in firstApiLead, "API response contains followsCount");
  assert("profilePicUrlHD" in firstApiLead, "API response contains profilePicUrlHD");
  assert("verified" in firstApiLead, "API response contains verified");
  assert("businessCategoryName" in firstApiLead, "API response contains businessCategoryName");
  assert("rawProfileData" in firstApiLead, "API response contains rawProfileData");

  // -------------------------------------------------------------
  // 8. Campaign Authorization & 9. Tenant Isolation
  // -------------------------------------------------------------
  console.log("\n[8. Authorization & 9. Tenant Isolation]");
  const anonRes = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/leads`);
  assert(anonRes.status === 401, "Anonymous request returns 401 Unauthorized");

  const userBRes = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/leads`, {
    headers: { Cookie: userBCookie },
  });
  assert(userBRes.status === 404, "User B request to User A campaign returns 404 Not Found");

  // -------------------------------------------------------------
  // 10. Server-side Search by Username, FullName, Biography
  // -------------------------------------------------------------
  console.log("\n[10. Server-side Search Filtering]");
  // Insert a second lead with unique biography
  const secondLeadItem = {
    username: "CrossfitAlpha",
    url: "https://www.instagram.com/crossfitalpha/",
    fullName: "Marcus Vance",
    biography: "Kettlebell master and Olympic lifting enthusiast in Islamabad.",
    followersCount: 15000,
    isBusinessAccount: true,
    businessCategoryName: "Gym",
  };
  const secondNorm = normalizeInstagramProfileItem(secondLeadItem, new Date().toISOString());
  if (secondNorm) {
    await prisma.lead.create({
      data: {
        campaignId,
        username: secondNorm.username,
        profileUrl: secondNorm.profileUrl,
        fullName: secondNorm.fullName,
        biography: secondNorm.biography,
        followers: secondNorm.followers,
        followersCount: secondNorm.followersCount,
        category: secondNorm.category,
        businessCategoryName: secondNorm.businessCategoryName,
        isBusiness: secondNorm.isBusiness,
        isBusinessAccount: secondNorm.isBusinessAccount,
      },
    });
  }

  // Search by username
  const searchUsernameRes = await fetch(
    `${BASE_URL}/api/campaigns/${campaignId}/leads?search=crossfit`,
    { headers: { Cookie: userACookie } },
  );
  const searchUserJson = await searchUsernameRes.json();
  assert(searchUserJson.items.length === 1 && searchUserJson.items[0].username === "crossfitalpha", "Search by username works");

  // Search by fullName
  const searchNameRes = await fetch(
    `${BASE_URL}/api/campaigns/${campaignId}/leads?search=Marcus`,
    { headers: { Cookie: userACookie } },
  );
  const searchNameJson = await searchNameRes.json();
  assert(searchNameJson.items.length === 1 && searchNameJson.items[0].fullName === "Marcus Vance", "Search by fullName works");

  // Search by biography
  const searchBioRes = await fetch(
    `${BASE_URL}/api/campaigns/${campaignId}/leads?search=Kettlebell`,
    { headers: { Cookie: userACookie } },
  );
  const searchBioJson = await searchBioRes.json();
  assert(searchBioJson.items.length === 1 && searchBioJson.items[0].username === "crossfitalpha", "Search by biography works");

  // -------------------------------------------------------------
  // 11. Pagination
  // -------------------------------------------------------------
  console.log("\n[11. Pagination]");
  const page1Res = await fetch(
    `${BASE_URL}/api/campaigns/${campaignId}/leads?page=1&limit=1`,
    { headers: { Cookie: userACookie } },
  );
  const page1Json = await page1Res.json();
  assert(page1Json.pagination.total === 2, "Pagination total is 2");
  assert(page1Json.pagination.totalPages === 2, "Pagination totalPages is 2");
  assert(page1Json.items.length === 1, "Page 1 limit 1 returns exactly 1 item");

  // -------------------------------------------------------------
  // 12. Empty State
  // -------------------------------------------------------------
  console.log("\n[12. Empty State]");
  const emptyCampRes = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userACookie },
    body: JSON.stringify({ name: "Empty Leads Campaign" }),
  });
  const emptyCamp = await emptyCampRes.json();
  const emptyLeadsRes = await fetch(`${BASE_URL}/api/campaigns/${emptyCamp.id}/leads`, {
    headers: { Cookie: userACookie },
  });
  const emptyLeadsJson = await emptyLeadsRes.json();
  assert(emptyLeadsJson.pagination.total === 0, "Empty campaign returns 0 leads");
  assert(emptyLeadsJson.items.length === 0, "Empty campaign returns empty items array");

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================\n");

  await prisma.$disconnect();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
