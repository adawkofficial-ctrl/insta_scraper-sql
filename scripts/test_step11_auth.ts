import "dotenv/config";
import assert from "node:assert/strict";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";

type SafeUserResponse = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
};

type AuthResponse = {
  user: SafeUserResponse;
};

function extractCookie(response: Response, cookieName: string): string | null {
  const getSetCookie = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    const cookies = getSetCookie.call(response.headers);
    for (const c of cookies) {
      const match = c.match(new RegExp(`${cookieName}=([^;]+)`));
      if (match) return match[1];
    }
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

async function runTests() {
  console.log("=== STEP 11: Authentication & Multi-Tenancy Tests ===");
  console.log(`Testing against base URL: ${BASE_URL}`);

  const connectionString = process.env.DATABASE_URL!;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  const userAEmail = `usera_${Date.now()}@example.com`;
  const userBEmail = `userb_${Date.now()}@example.com`;
  const password = "StrongPassword123!";

  // 1. Unauthenticated requests to protected endpoints return 401
  console.log("\n[Test 1] Unauthenticated request to /api/campaigns returns 401");
  {
    const res = await fetch(`${BASE_URL}/api/campaigns`);
    assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
    const json = await res.json();
    assert.equal(json.error.code, "AUTH_REQUIRED");
    console.log("  ✓ /api/campaigns correctly rejected with 401 AUTH_REQUIRED");
  }

  // 2. Unauthenticated request to /api/dashboard/overview returns 401
  console.log("\n[Test 2] Unauthenticated request to /api/dashboard/overview returns 401");
  {
    const res = await fetch(`${BASE_URL}/api/dashboard/overview`);
    assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
    console.log("  ✓ /api/dashboard/overview correctly rejected with 401");
  }

  // 3. Register User A
  console.log("\n[Test 3] Register User A");
  let userACookie: string;
  let userAId: string;
  {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: userAEmail,
        password,
        name: "User Alpha",
      }),
    });
    assert.equal(res.status, 201, `Expected 201, got ${res.status}`);
    const data = (await res.json()) as AuthResponse;
    assert.equal(data.user.email, userAEmail);
    assert.equal(data.user.name, "User Alpha");
    userAId = data.user.id;

    const cookie = extractCookie(res, "insta_session");
    assert.ok(cookie, "Session cookie should be set upon registration");
    userACookie = `insta_session=${cookie}`;
    console.log(`  ✓ User A registered successfully: ${userAId}`);
  }

  // 4. Verify /api/auth/me for User A
  console.log("\n[Test 4] Verify /api/auth/me for User A");
  {
    const res = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Cookie: userACookie },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as SafeUserResponse;
    assert.equal(data.id, userAId);
    assert.equal(data.email, userAEmail);
    console.log("  ✓ /api/auth/me returns User A info");
  }

  // 5. Register User B
  console.log("\n[Test 5] Register User B");
  let userBCookie: string;
  let userBId: string;
  {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: userBEmail,
        password,
        name: "User Beta",
      }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as AuthResponse;
    userBId = data.user.id;

    const cookie = extractCookie(res, "insta_session");
    assert.ok(cookie, "Session cookie should be set");
    userBCookie = `insta_session=${cookie}`;
    console.log(`  ✓ User B registered successfully: ${userBId}`);
  }

  // 6. User A creates a campaign
  console.log("\n[Test 6] User A creates a campaign");
  let userACampaignId: string;
  {
    const res = await fetch(`${BASE_URL}/api/campaigns`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        name: "Alpha Exclusive Outreach",
        description: "Private to User A",
      }),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    userACampaignId = json.id;
    assert.ok(userACampaignId);
    assert.equal(json.name, "Alpha Exclusive Outreach");
    assert.equal(json.userId, userAId);
    console.log(`  ✓ User A created campaign: ${userACampaignId}`);
  }

  // 7. Verify User A can see their own campaign
  console.log("\n[Test 7] Verify User A sees campaign in list and detail");
  {
    const listRes = await fetch(`${BASE_URL}/api/campaigns`, {
      headers: { Cookie: userACookie },
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.ok(list.some((c: { id: string }) => c.id === userACampaignId));

    const getRes = await fetch(`${BASE_URL}/api/campaigns/${userACampaignId}`, {
      headers: { Cookie: userACookie },
    });
    assert.equal(getRes.status, 200);
    const detail = await getRes.json();
    assert.equal(detail.id, userACampaignId);
    console.log("  ✓ User A sees campaign in list and detail");
  }

  // 8. Verify User B CANNOT see User A's campaign in list
  console.log("\n[Test 8] Verify User B does NOT see User A's campaign in list");
  {
    const listRes = await fetch(`${BASE_URL}/api/campaigns`, {
      headers: { Cookie: userBCookie },
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    const found = list.some((c: { id: string }) => c.id === userACampaignId);
    assert.equal(found, false, "User B should NOT see User A's campaign in list");
    console.log("  ✓ User A's campaign is completely isolated from User B's list");
  }

  // 9. IDOR Test: User B attempts direct access to User A's campaign
  console.log("\n[Test 9] IDOR: User B attempts GET /api/campaigns/:id on User A's campaign");
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${userACampaignId}`, {
      headers: { Cookie: userBCookie },
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    console.log("  ✓ IDOR prevented: User B received 404 Not Found");
  }

  // 10. IDOR Test: User B attempts PATCH /api/campaigns/:id on User A's campaign
  console.log("\n[Test 10] IDOR: User B attempts PATCH on User A's campaign");
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${userACampaignId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: userBCookie,
      },
      body: JSON.stringify({ name: "Hacked by User B" }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    console.log("  ✓ IDOR prevented: User B cannot modify User A's campaign");
  }

  // 11. IDOR Test: User B attempts DELETE on User A's campaign
  console.log("\n[Test 11] IDOR: User B attempts DELETE on User A's campaign");
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${userACampaignId}`, {
      method: "DELETE",
      headers: { Cookie: userBCookie },
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    console.log("  ✓ IDOR prevented: User B cannot delete User A's campaign");
  }

  // Create child resources under User A's campaign (Lead, Template, Execution)
  console.log("\n[Setup] Creating child resources for User A");
  const userALead = await prisma.lead.create({
    data: {
      campaignId: userACampaignId,
      username: "user_a_lead",
      profileUrl: "https://instagram.com/user_a_lead",
      fullName: "Lead of User A",
    },
  });

  const userATemplate = await prisma.messageTemplate.create({
    data: {
      campaignId: userACampaignId,
      name: "Template for Alpha",
      body: "Hello {{username}}, from User A!",
    },
  });

  const userAExec = await prisma.campaignExecution.create({
    data: {
      campaignId: userACampaignId,
      status: "PREVIEW",
      totalItems: 1,
    },
  });

  const userAItem = await prisma.campaignExecutionItem.create({
    data: {
      executionId: userAExec.id,
      leadId: userALead.id,
      status: "PENDING",
      messageText: "Hello @user_a_lead!",
    },
  });
  const userAItemId = userAItem.id;
  console.log(`  ✓ Created Lead (${userALead.id}), Template (${userATemplate.id}), Execution (${userAExec.id})`);

  // 12. IDOR Test: Lead ownership
  console.log("\n[Test 12] IDOR: User B attempts to access User A's lead");
  {
    const getRes = await fetch(`${BASE_URL}/api/leads/${userALead.id}`, {
      headers: { Cookie: userBCookie },
    });
    assert.equal(getRes.status, 404);

    const patchRes = await fetch(`${BASE_URL}/api/leads/${userALead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userBCookie },
      body: JSON.stringify({ status: "CONTACTED" }),
    });
    assert.equal(patchRes.status, 404);

    const delRes = await fetch(`${BASE_URL}/api/leads/${userALead.id}`, {
      method: "DELETE",
      headers: { Cookie: userBCookie },
    });
    assert.equal(delRes.status, 404);

    const msgsRes = await fetch(`${BASE_URL}/api/leads/${userALead.id}/messages`, {
      headers: { Cookie: userBCookie },
    });
    assert.equal(msgsRes.status, 404);
    console.log("  ✓ IDOR prevented: User B cannot access/modify/delete User A's lead");
  }

  // 13. IDOR Test: Template ownership
  console.log("\n[Test 13] IDOR: User B attempts to access User A's template");
  {
    const getRes = await fetch(`${BASE_URL}/api/templates/${userATemplate.id}`, {
      headers: { Cookie: userBCookie },
    });
    assert.equal(getRes.status, 404);

    const patchRes = await fetch(`${BASE_URL}/api/templates/${userATemplate.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userBCookie },
      body: JSON.stringify({ body: "Tampered by User B" }),
    });
    assert.equal(patchRes.status, 404);

    const delRes = await fetch(`${BASE_URL}/api/templates/${userATemplate.id}`, {
      method: "DELETE",
      headers: { Cookie: userBCookie },
    });
    assert.equal(delRes.status, 404);
    console.log("  ✓ IDOR prevented: User B cannot access/modify/delete User A's template");
  }

  // 14. IDOR Test: Execution ownership
  console.log("\n[Test 14] IDOR: User B attempts to access/control User A's execution");
  {
    const getRes = await fetch(`${BASE_URL}/api/campaign-executions/${userAExec.id}`, {
      headers: { Cookie: userBCookie },
    });
    assert.equal(getRes.status, 404);

    const approveRes = await fetch(
      `${BASE_URL}/api/campaign-executions/${userAExec.id}/items/${userAItemId}/approve`,
      {
        method: "POST",
        headers: { Cookie: userBCookie },
      },
    );
    assert.equal(approveRes.status, 404);

    const cancelRes = await fetch(
      `${BASE_URL}/api/campaign-executions/${userAExec.id}/cancel`,
      {
        method: "POST",
        headers: { Cookie: userBCookie },
      },
    );
    assert.equal(cancelRes.status, 404);
    console.log("  ✓ IDOR prevented: User B cannot view/approve/cancel User A's execution");
  }

  // 15. Scraper ownership check
  console.log("\n[Test 15] Scraper: User B cannot trigger scrape on User A's campaign");
  {
    const res = await fetch(`${BASE_URL}/api/scraper/instagram/profile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userBCookie,
      },
      body: JSON.stringify({
        campaignId: userACampaignId,
        usernames: ["instagram"],
      }),
    });
    assert.equal(res.status, 404);
    console.log("  ✓ User B cannot scrape into User A's campaign");
  }

  // 16. Test message ownership check
  console.log("\n[Test 16] Test message: User B cannot send message to User A's lead");
  {
    const res = await fetch(`${BASE_URL}/api/messages/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userBCookie,
      },
      body: JSON.stringify({
        leadId: userALead.id,
        message: "Unauthorized test message",
      }),
    });
    assert.equal(res.status, 404);
    console.log("  ✓ User B cannot send test message to User A's lead");
  }

  // 17. AI Preview ownership check
  console.log("\n[Test 17] AI Preview: User B cannot preview with User A's lead/template");
  {
    const res = await fetch(`${BASE_URL}/api/messages/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userBCookie,
      },
      body: JSON.stringify({
        leadId: userALead.id,
        templateId: userATemplate.id,
      }),
    });
    assert.equal(res.status, 404);
    console.log("  ✓ User B cannot preview message using User A's resources");
  }

  // 18. Logout and session invalidation
  console.log("\n[Test 18] Logout and session invalidation");
  {
    const res = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: userACookie },
    });
    assert.equal(res.status, 200);

    const clearedCookie = extractCookie(res, "insta_session");
    // Cookie is cleared or expired
    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: {
        Cookie: clearedCookie ? `insta_session=${clearedCookie}` : "",
      },
    });
    assert.equal(meRes.status, 401);
    const meJson = await meRes.json();
    assert.equal(meJson.error.code, "AUTH_REQUIRED");
    console.log("  ✓ Logout cleared session cookie and /api/auth/me rejects with 401 AUTH_REQUIRED");
  }

  // 19. Login again as User A and verify data persists
  console.log("\n[Test 19] Re-login User A and verify data accessibility");
  {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: userAEmail,
        password,
      }),
    });
    assert.equal(loginRes.status, 200);
    const newCookie = extractCookie(loginRes, "insta_session");
    assert.ok(newCookie);

    const campRes = await fetch(`${BASE_URL}/api/campaigns/${userACampaignId}`, {
      headers: { Cookie: `insta_session=${newCookie}` },
    });
    assert.equal(campRes.status, 200);
    const camp = await campRes.json();
    assert.equal(camp.id, userACampaignId);
    console.log("  ✓ User A logged back in and accessed their campaign seamlessly");
  }

  // 20. Verify default development user exists and has access to backfilled data
  console.log("\n[Test 20] Verify development user login and backfilled data");
  {
    const devLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "dev@instascraper.local",
        password: "devpassword123",
      }),
    });
    assert.equal(devLoginRes.status, 200);
    const devCookie = extractCookie(devLoginRes, "insta_session");
    assert.ok(devCookie);

    const devCampsRes = await fetch(`${BASE_URL}/api/campaigns`, {
      headers: { Cookie: `insta_session=${devCookie}` },
    });
    assert.equal(devCampsRes.status, 200);
    const devCamps = await devCampsRes.json();
    assert.ok(devCamps.length >= 1, "Development user must have access to existing campaigns");
    console.log(`  ✓ Development user logged in and found ${devCamps.length} backfilled campaign(s)`);
  }

  // Cleanup test users created for this test run
  console.log("\n[Cleanup] Removing temporary test users and campaigns");
  await prisma.campaign.deleteMany({
    where: { userId: { in: [userAId, userBId] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [userAId, userBId] } },
  });
  console.log("  ✓ Cleanup complete");

  console.log("\n🎉 ALL STEP 11 AUTHENTICATION & MULTI-TENANCY TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
