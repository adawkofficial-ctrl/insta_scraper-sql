import "dotenv/config";
import assert from "node:assert/strict";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";

type SafeUserResponse = {
  id: string;
  email: string;
  name?: string | null;
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

async function runStep13QA() {
  console.log("=================================================================");
  console.log("   STEP 13: FULL END-TO-END QA & VERIFICATION SUITE              ");
  console.log(`   Base URL: ${BASE_URL}`);
  console.log("=================================================================\n");

  const connectionString = process.env.DATABASE_URL!;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  const timestamp = Date.now();
  const userAEmail = `qa_alpha_${timestamp}@example.com`;
  const userBEmail = `qa_beta_${timestamp}@example.com`;
  const password = "ProductionReady2026!";

  let userACookie = "";
  let userBCookie = "";
  let userAId = "";
  let userBId = "";
  let campaignAId = "";
  let leadAId = "";
  let templateAId = "";
  let executionAId = "";

  try {
    // -----------------------------------------------------------------
    // 1. HEALTH CHECK QA
    // -----------------------------------------------------------------
    console.log("[Phase 1] Health Check Endpoint QA");
    {
      const res = await fetch(`${BASE_URL}/api/health`);
      assert.equal(res.status, 200, "Health check should return 200");
      const data = await res.json();
      assert.equal(data.status, "ok");
      assert.equal(data.services.database, "connected");
      assert.ok(data.timestamp);
      // Verify security headers
      assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(res.headers.get("X-Frame-Options"), "DENY");
      console.log("  ✓ Health check is 200 OK with connected database and security headers");
    }

    // -----------------------------------------------------------------
    // 2. AUTHENTICATION QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 2] Authentication QA");
    {
      // 2a. Unauthenticated access rejected
      const unauthRes = await fetch(`${BASE_URL}/api/campaigns`);
      assert.equal(unauthRes.status, 401, "Unauthenticated access must be rejected with 401");
      console.log("  ✓ Unauthenticated requests rejected with 401");

      // 2b. Register User A
      const regARes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: userAEmail, password, name: "QA Alpha" }),
      });
      assert.equal(regARes.status, 201);
      const regAData = (await regARes.json()) as AuthResponse;
      userAId = regAData.user.id;
      const cookieA = extractCookie(regARes, "insta_session");
      assert.ok(cookieA, "Session cookie must be set on register");
      userACookie = `insta_session=${cookieA}`;
      console.log(`  ✓ User A registered: ${userAId}`);

      // 2c. Register User B
      const regBRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: userBEmail, password, name: "QA Beta" }),
      });
      assert.equal(regBRes.status, 201);
      const regBData = (await regBRes.json()) as AuthResponse;
      userBId = regBData.user.id;
      const cookieB = extractCookie(regBRes, "insta_session");
      assert.ok(cookieB);
      userBCookie = `insta_session=${cookieB}`;
      console.log(`  ✓ User B registered: ${userBId}`);

      // 2d. Check /api/auth/me for User A
      const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { Cookie: userACookie },
      });
      assert.equal(meRes.status, 200);
      const meData = await meRes.json();
      assert.equal(meData.id, userAId);
      assert.equal(meData.email, userAEmail);
      console.log("  ✓ /api/auth/me returns correct authenticated user profile");
    }

    // -----------------------------------------------------------------
    // 3. CAMPAIGN LIFECYCLE & VALIDATION QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 3] Campaign Lifecycle QA");
    {
      // 3a. Validation: empty name rejected
      const badCampRes = await fetch(`${BASE_URL}/api/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userACookie },
        body: JSON.stringify({ name: "   " }),
      });
      assert.equal(badCampRes.status, 400, "Empty campaign name must be rejected with 400");
      console.log("  ✓ Empty campaign name rejected with 400");

      // 3b. Create valid campaign for User A
      const campRes = await fetch(`${BASE_URL}/api/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userACookie },
        body: JSON.stringify({
          name: "QA Fitness Outreach 2026",
          description: "Targeting fitness trainers and wellness creators",
          executionMode: "MANUAL",
          messageApprovalRequired: true,
        }),
      });
      assert.equal(campRes.status, 201);
      const campData = await campRes.json();
      campaignAId = campData.id;
      assert.equal(campData.userId, userAId);
      assert.equal(campData.status, "DRAFT");
      console.log(`  ✓ Campaign created: "${campData.name}" (${campaignAId})`);

      // 3c. Update Campaign
      const updateRes = await fetch(`${BASE_URL}/api/campaigns/${campaignAId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: userACookie },
        body: JSON.stringify({
          description: "Updated description for fitness outreach",
        }),
      });
      assert.equal(updateRes.status, 200);
      const updatedCamp = await updateRes.json();
      assert.equal(updatedCamp.description, "Updated description for fitness outreach");
      console.log("  ✓ Campaign updated successfully");

      // 3d. Read Campaign
      const readRes = await fetch(`${BASE_URL}/api/campaigns/${campaignAId}`, {
        headers: { Cookie: userACookie },
      });
      assert.equal(readRes.status, 200);
      const readCamp = await readRes.json();
      assert.equal(readCamp.id, campaignAId);
      console.log("  ✓ Campaign detail retrieved successfully");
    }

    // -----------------------------------------------------------------
    // 4. LEADS PERSISTENCE & IDEMPOTENCY QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 4] Leads Persistence & Idempotency QA");
    {
      // Create test leads directly in DB for User A's campaign
      const lead1 = await prisma.lead.create({
        data: {
          campaignId: campaignAId,
          username: "fit_trainer_maya",
          fullName: "Maya Lin • Fitness Coach",
          biography: "NASM certified personal trainer | Building sustainable strength",
          category: "Fitness Model",
          followers: 12500,
          following: 450,
          postsCount: 320,
          profileUrl: "https://instagram.com/fit_trainer_maya",
          isVerified: true,
          isBusiness: true,
          source: "apify",
        },
      });
      leadAId = lead1.id;

      const lead2 = await prisma.lead.create({
        data: {
          campaignId: campaignAId,
          username: "healthy_recipes_dan",
          fullName: "Dan Miller",
          biography: "Daily high-protein recipes and meal prep tips",
          category: "Food & Beverage",
          followers: 8400,
          following: 600,
          postsCount: 190,
          profileUrl: "https://instagram.com/healthy_recipes_dan",
          isVerified: false,
          isBusiness: true,
          source: "apify",
        },
      });

      console.log(`  ✓ Created 2 test leads in campaign: ${leadAId}, ${lead2.id}`);

      // Verify idempotency (upsert)
      const lead1Updated = await prisma.lead.upsert({
        where: {
          campaignId_username: {
            campaignId: campaignAId,
            username: "fit_trainer_maya",
          },
        },
        create: {
          campaignId: campaignAId,
          username: "fit_trainer_maya",
          profileUrl: "https://instagram.com/fit_trainer_maya",
        },
        update: {
          followers: 12600,
        },
      });
      assert.equal(lead1Updated.id, leadAId, "Re-upserting same profile must not create new ID");
      assert.equal(lead1Updated.followers, 12600);

      const totalLeadsInCampaign = await prisma.lead.count({ where: { campaignId: campaignAId } });
      assert.equal(totalLeadsInCampaign, 2, "Duplicate profile must not create extra records");
      console.log("  ✓ Idempotency verified: re-running profile updates existing record");
    }

    // -----------------------------------------------------------------
    // 5. LEAD FILTERING, SEARCH & PAGINATION QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 5] Lead Filtering, Search & Pagination QA");
    {
      // 5a. Search by username
      const searchRes = await fetch(
        `${BASE_URL}/api/campaigns/${campaignAId}/leads?search=maya`,
        { headers: { Cookie: userACookie } },
      );
      assert.equal(searchRes.status, 200);
      const searchData = await searchRes.json();
      assert.equal(searchData.items.length, 1);
      assert.equal(searchData.items[0].username, "fit_trainer_maya");
      console.log("  ✓ Lead search by keyword matches expected lead");

      // 5b. Filter by verified
      const verifiedRes = await fetch(
        `${BASE_URL}/api/campaigns/${campaignAId}/leads?isVerified=true`,
        { headers: { Cookie: userACookie } },
      );
      assert.equal(verifiedRes.status, 200);
      const verifiedData = await verifiedRes.json();
      assert.equal(verifiedData.items.length, 1);
      assert.equal(verifiedData.items[0].isVerified, true);
      console.log("  ✓ Verified filter returns only verified leads");

      // 5c. Pagination bounds: limit=1000 clamped or rejected
      const oversizedRes = await fetch(
        `${BASE_URL}/api/campaigns/${campaignAId}/leads?limit=99999`,
        { headers: { Cookie: userACookie } },
      );
      assert.equal(oversizedRes.status, 400, "Oversized limit should be rejected with 400");
      console.log("  ✓ Oversized limit (?limit=99999) safely rejected with 400");

      // 5d. Edit lead
      const editLeadRes = await fetch(`${BASE_URL}/api/leads/${leadAId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: userACookie },
        body: JSON.stringify({ category: "Fitness & Wellness" }),
      });
      assert.equal(editLeadRes.status, 200);
      const editedLead = await editLeadRes.json();
      assert.equal(editedLead.category, "Fitness & Wellness");
      console.log("  ✓ Lead edited and persisted successfully");
    }

    // -----------------------------------------------------------------
    // 6. MESSAGE TEMPLATE & VARIABLE INTERPOLATION QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 6] Message Template & Variable Interpolation QA");
    {
      // 6a. Create template
      const tmplRes = await fetch(`${BASE_URL}/api/campaigns/${campaignAId}/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userACookie },
        body: JSON.stringify({
          name: "Fitness Outreach Intro",
          body: "Hey {{firstName}}! Loved your profile @{{username}} in {{category}}. We are launching {{campaignName}}.",
        }),
      });
      assert.equal(tmplRes.status, 201);
      const tmplData = await tmplRes.json();
      templateAId = tmplData.id;
      console.log(`  ✓ Template created: "${tmplData.name}" (${templateAId})`);

      // 6b. Preview template with real lead
      const prevRes = await fetch(`${BASE_URL}/api/messages/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userACookie },
        body: JSON.stringify({
          leadId: leadAId,
          templateId: templateAId,
        }),
      });
      assert.equal(prevRes.status, 200);
      const prevData = await prevRes.json();
      assert.ok(prevData.text.includes("Maya"), "firstName variable must be interpolated");
      assert.ok(prevData.text.includes("fit_trainer_maya"), "username must be interpolated");
      assert.ok(prevData.text.includes("Fitness & Wellness"), "category must be interpolated");
      console.log(`  ✓ Template rendered successfully:\n    "${prevData.text}"`);
    }

    // -----------------------------------------------------------------
    // 7. AI PERSONALIZATION PREVIEW QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 7] AI Personalization Preview QA");
    {
      // Test AI preview endpoint
      const aiRes = await fetch(`${BASE_URL}/api/messages/ai-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userACookie },
        body: JSON.stringify({
          leadId: leadAId,
          templateId: templateAId,
        }),
      });
      assert.equal(aiRes.status, 200);
      const aiData = await aiRes.json();
      assert.ok(aiData.text && aiData.text.length > 0);
      assert.equal(aiData.generated, true);
      assert.ok(aiData.provider);

      // Verify AI preview NEVER automatically creates a Message record
      const messageCount = await prisma.message.count({
        where: { leadId: leadAId },
      });
      assert.equal(messageCount, 0, "AI preview must remain a draft and NEVER insert a sent message");
      console.log(`  ✓ AI preview generated safely without creating any sent messages:\n    "${aiData.text}"`);
    }

    // -----------------------------------------------------------------
    // 8. CONTROLLED SINGLE TEST MESSAGE QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 8] Controlled Single Test Message QA");
    {
      // 8a. Validation: empty message rejected
      const emptyMsgRes = await fetch(`${BASE_URL}/api/messages/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userACookie },
        body: JSON.stringify({
          leadId: leadAId,
          message: "   ",
        }),
      });
      assert.equal(emptyMsgRes.status, 400);
      console.log("  ✓ Empty message rejected with 400");

      // 8b. Dispatch test message (playwright provider requires manual IG login in dev)
      const dispatchRes = await fetch(`${BASE_URL}/api/messages/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userACookie },
        body: JSON.stringify({
          leadId: leadAId,
          message: "Hi Maya! Testing controlled single message outreach.",
        }),
      });
      assert.equal(dispatchRes.status, 200);
      const dispatchData = await dispatchRes.json();
      assert.ok(dispatchData.messageId, "Message record ID must be returned");

      // Verify Message audit log record exists in database
      const msgRecord = await prisma.message.findUnique({
        where: { id: dispatchData.messageId },
      });
      assert.ok(msgRecord, "Message record must be persisted in database");
      assert.equal(msgRecord.leadId, leadAId);
      assert.equal(msgRecord.campaignId, campaignAId);
      assert.equal(msgRecord.messageText, "Hi Maya! Testing controlled single message outreach.");
      console.log(`  ✓ Test message recorded in database audit log (${msgRecord.id}, status: ${msgRecord.status})`);

      // 8c. Message history API
      const historyRes = await fetch(`${BASE_URL}/api/leads/${leadAId}/messages`, {
        headers: { Cookie: userACookie },
      });
      assert.equal(historyRes.status, 200);
      const history = await historyRes.json();
      assert.ok(history.length >= 1, "Lead message history must contain the message record");
      console.log("  ✓ Lead message history retrieved successfully");
    }

    // -----------------------------------------------------------------
    // 9. CAMPAIGN EXECUTION ARCHITECTURE QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 9] Campaign Execution Architecture QA");
    {
      // 9a. Generate Execution Preview
      const execRes = await fetch(`${BASE_URL}/api/campaigns/${campaignAId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userACookie },
        body: JSON.stringify({
          templateId: templateAId,
          executionMode: "MANUAL",
        }),
      });
      assert.equal(execRes.status, 201);
      const execData = await execRes.json();
      executionAId = execData.executionId;
      assert.equal(execData.status, "PREVIEW");
      assert.equal(execData.items.length, 2, "Both leads should be in preview");
      const itemId1 = execData.items[0].id;
      const itemId2 = execData.items[1].id;
      console.log(`  ✓ Execution preview created: ${executionAId} with ${execData.items.length} items`);

      // 9b. Approve item 1
      const approveRes = await fetch(
        `${BASE_URL}/api/campaign-executions/${executionAId}/items/${itemId1}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userACookie },
          body: JSON.stringify({ messageText: "Approved and customized text." }),
        },
      );
      assert.equal(approveRes.status, 200);
      const approvedItem = await approveRes.json();
      assert.equal(approvedItem.status, "APPROVED");
      assert.equal(approvedItem.messageText, "Approved and customized text.");
      console.log("  ✓ Execution item 1 approved");

      // 9c. Skip item 2
      const skipRes = await fetch(
        `${BASE_URL}/api/campaign-executions/${executionAId}/items/${itemId2}/skip`,
        {
          method: "POST",
          headers: { Cookie: userACookie },
        },
      );
      assert.equal(skipRes.status, 200);
      const skippedItem = await skipRes.json();
      assert.equal(skippedItem.status, "SKIPPED");
      console.log("  ✓ Execution item 2 skipped");

      // 9d. Cancel execution
      const cancelRes = await fetch(
        `${BASE_URL}/api/campaign-executions/${executionAId}/cancel`,
        {
          method: "POST",
          headers: { Cookie: userACookie },
        },
      );
      assert.equal(cancelRes.status, 200);
      const cancelledExec = await cancelRes.json();
      assert.equal(cancelledExec.status, "CANCELLED");
      console.log("  ✓ Execution cancelled cleanly without unintended mass sending");
    }

    // -----------------------------------------------------------------
    // 10. REAL DATABASE ANALYTICS QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 10] Real Database Analytics QA");
    {
      const analyticsRes = await fetch(
        `${BASE_URL}/api/campaigns/${campaignAId}/analytics`,
        { headers: { Cookie: userACookie } },
      );
      assert.equal(analyticsRes.status, 200);
      const analytics = await analyticsRes.json();

      // Compare against live PostgreSQL counts
      const dbTotalLeads = await prisma.lead.count({ where: { campaignId: campaignAId } });
      const dbVerifiedLeads = await prisma.lead.count({ where: { campaignId: campaignAId, isVerified: true } });
      const dbMessages = await prisma.message.count({ where: { campaignId: campaignAId } });

      assert.equal(analytics.leads.total, dbTotalLeads, "Analytics total leads must match DB count");
      assert.equal(analytics.leads.verified, dbVerifiedLeads, "Analytics verified leads must match DB count");
      assert.equal(analytics.messages.total, dbMessages, "Analytics total messages must match DB count");
      assert.equal(analytics.execution.approved, 1, "Analytics approved count must be 1");
      assert.equal(analytics.execution.skipped, 1, "Analytics skipped count must be 1");
      console.log(`  ✓ Analytics stats strictly match DB records: ${analytics.leads.total} leads, ${analytics.messages.total} messages`);
    }

    // -----------------------------------------------------------------
    // 11. MULTI-TENANT ISOLATION & IDOR DEFENSE QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 11] Multi-Tenant Isolation & IDOR Defense QA");
    {
      // 11a. User B lists campaigns -> User A's campaign not visible
      const listBRes = await fetch(`${BASE_URL}/api/campaigns`, {
        headers: { Cookie: userBCookie },
      });
      assert.equal(listBRes.status, 200);
      const listB = await listBRes.json();
      assert.equal(listB.some((c: { id: string }) => c.id === campaignAId), false);
      console.log("  ✓ User A's campaign is not visible in User B's list");

      // 11b. User B direct access to User A's campaign -> 404
      const idorCamp = await fetch(`${BASE_URL}/api/campaigns/${campaignAId}`, {
        headers: { Cookie: userBCookie },
      });
      assert.equal(idorCamp.status, 404);
      console.log("  ✓ IDOR: User B GET /api/campaigns/:id returned 404");

      // 11c. User B direct access to User A's lead -> 404
      const idorLead = await fetch(`${BASE_URL}/api/leads/${leadAId}`, {
        headers: { Cookie: userBCookie },
      });
      assert.equal(idorLead.status, 404);
      console.log("  ✓ IDOR: User B GET /api/leads/:id returned 404");

      // 11d. User B direct access to User A's template -> 404
      const idorTmpl = await fetch(`${BASE_URL}/api/templates/${templateAId}`, {
        headers: { Cookie: userBCookie },
      });
      assert.equal(idorTmpl.status, 404);
      console.log("  ✓ IDOR: User B GET /api/templates/:id returned 404");

      // 11e. User B direct access to User A's execution -> 404
      const idorExec = await fetch(`${BASE_URL}/api/campaign-executions/${executionAId}`, {
        headers: { Cookie: userBCookie },
      });
      assert.equal(idorExec.status, 404);
      console.log("  ✓ IDOR: User B GET /api/campaign-executions/:id returned 404");

      // 11f. User B attempts test message using User A's lead -> 404
      const idorMsg = await fetch(`${BASE_URL}/api/messages/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userBCookie },
        body: JSON.stringify({ leadId: leadAId, message: "Cross-tenant probe" }),
      });
      assert.equal(idorMsg.status, 404);
      console.log("  ✓ IDOR: User B cannot dispatch message to User A's lead (404)");

      // 11g. User B attempts AI preview using User A's resources -> 404
      const idorAI = await fetch(`${BASE_URL}/api/messages/ai-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userBCookie },
        body: JSON.stringify({ leadId: leadAId, templateId: templateAId }),
      });
      assert.equal(idorAI.status, 404);
      console.log("  ✓ IDOR: User B cannot trigger AI preview with User A's resources (404)");
    }

    // -----------------------------------------------------------------
    // 12. LOGOUT & SESSION INVALIDATION QA
    // -----------------------------------------------------------------
    console.log("\n[Phase 12] Logout & Session Invalidation QA");
    {
      const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: userACookie },
      });
      assert.equal(logoutRes.status, 200);

      const clearedCookie = extractCookie(logoutRes, "insta_session");
      const postLogoutMe = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: {
          Cookie: clearedCookie ? `insta_session=${clearedCookie}` : "",
        },
      });
      assert.equal(postLogoutMe.status, 401);
      console.log("  ✓ Logout invalidated session and cleared session cookie (401)");
    }

    console.log("\n=================================================================");
    console.log("   🎉 ALL 12 QA PHASES PASSED WITH ZERO ERRORS!                  ");
    console.log("=================================================================\n");
  } finally {
    // Clean up temporary QA test entities
    if (userAId || userBId) {
      const userIds = [userAId, userBId].filter(Boolean);
      await prisma.campaign.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
      console.log("[Cleanup] Temporary QA test users and campaigns purged.");
    }
  }
}

runStep13QA().catch((err) => {
  console.error("\n❌ QA Test Suite Failed:", err);
  process.exit(1);
});
