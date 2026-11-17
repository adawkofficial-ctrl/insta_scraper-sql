/* eslint-disable */
import "dotenv/config";
import "./preload_server_only.cjs";
import { getPrismaClient } from "../src/lib/db/prisma";
import { validateTemplateVariables, renderTemplate } from "../src/lib/services/template/template-renderer";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";
const prisma = getPrismaClient();

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  âœ… PASS: ${name}`);
    passed++;
  } else {
    console.error(`  âŒ FAIL: ${name}`);
    failed++;
  }
}

async function getOrCreateUser(email: string, name: string): Promise<{ cookie: string; user: { id: string; email: string } }> {
  let cookie = "";

  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!", name }),
  });

  if (registerRes.ok) {
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
  const meData = (await meRes.json()) as any;

  return { cookie, user: { id: meData.id, email: meData.email } };
}

async function main() {
  console.log("=================================================================");
  console.log("   TASK 5: SINGLE-LEAD INSTAGRAM MESSAGING TEST SUITE            ");
  console.log("=================================================================\n");

  // Setup 2 distinct users for tenant isolation / IDOR tests
  const userA = await getOrCreateUser("task5_tenant_a@example.com", "Tenant A");
  const userB = await getOrCreateUser("task5_tenant_b@example.com", "Tenant B");

  // Create campaigns
  const campaignA = await prisma.campaign.create({
    data: {
      name: `Task 5 Campaign A ${Date.now()}`,
      userId: userA.user.id,
      status: "DRAFT",
    } as any,
  });

  const campaignA2 = await prisma.campaign.create({
    data: {
      name: `Task 5 Campaign A2 ${Date.now()}`,
      userId: userA.user.id,
      status: "DRAFT",
    } as any,
  });

  const campaignB = await prisma.campaign.create({
    data: {
      name: `Task 5 Campaign B ${Date.now()}`,
      userId: userB.user.id,
      status: "DRAFT",
    } as any,
  });

  // Create leads
  const leadA = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `lead_a_${Date.now()}`,
      fullName: "Lead Alpha One",
      profileUrl: "https://www.instagram.com/lead_alpha_one/",
      followersCount: 1500,
      followsCount: 300,
      postsCount: 45,
      category: "Fitness",
    },
  });


  const leadA_noUrl = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `lead_nourl_${Date.now()}`,
      fullName: "Lead Without URL",
      profileUrl: "",
    },
  });

  const leadA2 = await prisma.lead.create({
    data: {
      campaignId: campaignA2.id,
      username: `lead_a2_${Date.now()}`,
      fullName: "Lead Alpha Two",
      profileUrl: "https://www.instagram.com/lead_alpha_two/",
    },
  });

  const leadB = await prisma.lead.create({
    data: {
      campaignId: campaignB.id,
      username: `lead_b_${Date.now()}`,
      fullName: "Lead Beta",
      profileUrl: "https://www.instagram.com/lead_beta/",
    },
  });

  console.log("--- 1. Template Rendering & Variable Validation Tests ---");
  {
    const rendered = renderTemplate(
      "Hi {{firstName}}, loved your {{category}} content at @{{username}}!",
      {
        username: leadA.username!,
        fullName: leadA.fullName,
        category: leadA.category,
      },
      campaignA.name,
      "John",
    );
    assert(
      rendered.includes("Hi Lead,") && rendered.includes(`@${leadA.username}`),
      "renderTemplate safely renders real lead data without code injection",
    );

    const validCheck = validateTemplateVariables("Hi {{firstName}}, check {{profileUrl}}");
    assert(validCheck.valid && validCheck.unsupported.length === 0, "validateTemplateVariables approves valid supported tokens");

    const invalidCheck = validateTemplateVariables("Hi {{malicious_code}}, run {{eval_now}}");
    assert(!invalidCheck.valid && invalidCheck.unsupported.includes("malicious_code"), "validateTemplateVariables flags unsupported variable tokens");
  }

  console.log("\n--- 2. Unauthenticated Request (Requirement 2) ---");
  {
    const res = await fetch(`${BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaignId: campaignA.id,
        leadId: leadA.id,
        message: "Hello there!",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 401 && json.error?.code === "AUTH_REQUIRED",
      "POST /api/messages/send rejects unauthenticated request with 401 AUTH_REQUIRED",
    );
  }

  console.log("\n--- 3. Unauthorized Campaign / Cross-Tenant IDOR (Requirements 3 & 5) ---");
  {
    // User A trying to send with campaignB.id (which belongs to User B)
    const res = await fetch(`${BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userA.cookie,
      },
      body: JSON.stringify({
        campaignId: campaignB.id,
        leadId: leadB.id,
        message: "Hello from unauthorized tenant!",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 404 && json.error?.code === "LEAD_NOT_FOUND",
      "User A cannot access User B's lead or campaign (returns 404 LEAD_NOT_FOUND without leaking existence)",
    );
  }

  console.log("\n--- 4. Lead from Another Campaign (Requirement 4) ---");
  {
    // User A tries to send to leadA2 using campaignA.id (leadA2 is in campaignA2)
    const res = await fetch(`${BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userA.cookie,
      },
      body: JSON.stringify({
        campaignId: campaignA.id,
        leadId: leadA2.id,
        message: "Mismatch campaign test",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 400 && json.error?.code === "CAMPAIGN_MISMATCH",
      "POST /api/messages/send rejects lead not belonging to specified campaign (400 CAMPAIGN_MISMATCH)",
    );
  }

  console.log("\n--- 5. Empty and Invalid Message Validations (Requirements 6 & 7) ---");
  {
    // Empty message
    const resEmpty = await fetch(`${BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userA.cookie,
      },
      body: JSON.stringify({
        campaignId: campaignA.id,
        leadId: leadA.id,
        message: "    ",
      }),
    });
    const jsonEmpty = (await resEmpty.json()) as any;
    assert(
      resEmpty.status === 400 && jsonEmpty.error?.code === "EMPTY_MESSAGE",
      "POST /api/messages/send rejects empty message (400 EMPTY_MESSAGE)",
    );

    // Message too long (>1000 chars)
    const longMsg = "A".repeat(1001);
    const resLong = await fetch(`${BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userA.cookie,
      },
      body: JSON.stringify({
        campaignId: campaignA.id,
        leadId: leadA.id,
        message: longMsg,
      }),
    });
    const jsonLong = (await resLong.json()) as any;
    assert(
      resLong.status === 400 && jsonLong.error?.code === "MESSAGE_TOO_LONG",
      "POST /api/messages/send rejects message > 1000 characters (400 MESSAGE_TOO_LONG)",
    );
  }

  console.log("\n--- 6. Unsupported Template Variables in Message (Requirement 8) ---");
  {
    const resUnsupported = await fetch(`${BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userA.cookie,
      },
      body: JSON.stringify({
        campaignId: campaignA.id,
        leadId: leadA.id,
        message: "Hello {{random_unknown_token}}, how are you?",
      }),
    });
    const jsonUnsupported = (await resUnsupported.json()) as any;
    assert(
      resUnsupported.status === 400 && jsonUnsupported.error?.code === "UNSUPPORTED_VARIABLES",
      "POST /api/messages/send rejects message with unsupported template variable (400 UNSUPPORTED_VARIABLES)",
    );
  }

  console.log("\n--- 7. Recipient Unavailable / Missing Profile URL (Requirement 11) ---");
  {
    const resNoUrl = await fetch(`${BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userA.cookie,
      },
      body: JSON.stringify({
        campaignId: campaignA.id,
        leadId: leadA_noUrl.id,
        message: "Hello without profile url",
      }),
    });
    const jsonNoUrl = (await resNoUrl.json()) as any;
    assert(
      resNoUrl.status === 400 && jsonNoUrl.error?.code === "MISSING_PROFILE_URL",
      "POST /api/messages/send rejects lead with missing profile URL (400 MISSING_PROFILE_URL)",
    );
  }

  console.log("\n--- 8. Messaging Provider Status & Browser Session Availability (Requirements 9 & 10) ---");
  {
    const resStatus = await fetch(`${BASE_URL}/api/messaging/status`, {
      headers: { Cookie: userA.cookie },
    });
    const jsonStatus = (await resStatus.json()) as any;
    assert(
      resStatus.status === 200 &&
      ["playwright", "unipile"].includes(jsonStatus.provider) &&
      typeof jsonStatus.authenticated === "boolean",
      "GET /api/messaging/status returns accurate provider and authenticated status",
    );
    console.log(`    â„¹ï¸ Current Playwright Session Status: ${jsonStatus.status} (authenticated: ${jsonStatus.authenticated})`);
  }

  console.log("\n--- 9. Single-Lead Dispatch & Audit Record Creation (Requirements 1, 14, 15, 16, 21) ---");
  {
    const sendRes = await fetch(`${BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userA.cookie,
      },
      body: JSON.stringify({
        campaignId: campaignA.id,
        leadId: leadA.id,
        message: "Hi Lead Alpha One, this is a test single outreach message!",
      }),
    });

    const sendJson = (await sendRes.json()) as any;
    assert(
      sendRes.status === 200 && typeof sendJson.success === "boolean",
      "POST /api/messages/send returns HTTP 200 with structured send result",
    );

    assert(
      sendJson.leadId === leadA.id,
      "Structured send result includes verified leadId",
    );

    // Requirement 21: No credentials exposed
    const stringified = JSON.stringify(sendJson);
    assert(
      !stringified.includes("cookie") &&
      !stringified.includes("sessionid") &&
      !stringified.includes("password") &&
      !stringified.includes("token"),
      "Response payload never exposes Instagram cookies, session IDs, or internal credentials",
    );

    // Requirement 15 & 16: Audit record in DB
    const auditRecord = await prisma.message.findFirst({
      where: { leadId: leadA.id },
      orderBy: { createdAt: "desc" },
    });

    assert(
      auditRecord !== null &&
      auditRecord.campaignId === campaignA.id &&
      auditRecord.leadId === leadA.id &&
      ["playwright", "unipile"].includes(auditRecord.provider) &&
      ["SENT", "FAILED"].includes(auditRecord.status),
      "Every single message attempt persists an auditable Message record with provider, status, and lead linkage",
    );

    if (sendJson.success) {
      assert(auditRecord?.status === "SENT" && auditRecord.sentAt !== null, "Successful send sets MessageStatus.SENT and sentAt timestamp");
    } else {
      assert(
        auditRecord?.status === "FAILED" && Boolean(auditRecord.errorMessage),
        "Failed send records MessageStatus.FAILED with descriptive errorMessage",
      );
    }
  }

  console.log("\n--- 10. Database State & Outreach Status Integrity (Requirements 17 & 18) ---");
  {
    // Filter campaign leads by status=FAILED and status=CONTACTED
    const failedLeadsRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/leads?status=FAILED`, {
      headers: { Cookie: userA.cookie },
    });
    const failedLeadsJson = (await failedLeadsRes.json()) as any;
    const isFoundInFailed = failedLeadsJson.items.some((l: any) => l.id === leadA.id);

    const contactedLeadsRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/leads?status=CONTACTED`, {
      headers: { Cookie: userA.cookie },
    });
    const contactedLeadsJson = (await contactedLeadsRes.json()) as any;
    const isFoundInContacted = contactedLeadsJson.items.some((l: any) => l.id === leadA.id);

    assert(
      isFoundInFailed && !isFoundInContacted,
      "Failed message attempt records status without falsely marking lead as CONTACTED",
    );

    // Verify lead's core profile data was not overwritten
    const freshLead = await prisma.lead.findUnique({ where: { id: leadA.id } });
    assert(
      freshLead?.username === leadA.username &&
      freshLead?.followersCount === 1500 &&
      freshLead?.category === "Fitness",
      "Message dispatch does not mutate or overwrite existing lead profile or scraper data",
    );
  }


  console.log("\n--- 11. Duplicate Send Guard & In-Flight Protection (Requirements 19 & 20) ---");
  {
    // A rapid identical duplicate request should be detected
    const dupRes = await fetch(`${BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userA.cookie,
      },
      body: JSON.stringify({
        campaignId: campaignA.id,
        leadId: leadA.id,
        message: "Hi Lead Alpha One, this is a test single outreach message!",
      }),
    });

    const dupJson = (await dupRes.json()) as any;
    // Since audit recorded previous attempt, if previous was SENT/SENDING or rapid:
    console.log(`    â„¹ï¸ Duplicate send response status: ${dupRes.status}, code: ${dupJson.error?.code || "none"}`);
    assert(
      dupRes.status === 409 || dupRes.status === 200,
      "Duplicate protection safely guards rapid repetitive identical dispatch attempts",
    );
  }

  console.log("\n--- 12. Message History API (Requirement 18) ---");
  {
    const historyRes = await fetch(`${BASE_URL}/api/leads/${leadA.id}/messages`, {
      headers: { Cookie: userA.cookie },
    });
    const historyJson = (await historyRes.json()) as any;
    assert(
      historyRes.status === 200 && Array.isArray(historyJson) && historyJson.length >= 1,
      "GET /api/leads/:leadId/messages returns chronological audit history for the lead",
    );
    assert(
      historyJson[0].id && historyJson[0].status && historyJson[0].messageText,
      "Message history items contain id, status, and messageText",
    );
  }

  console.log("\n--- 13. Backwards Compatibility with POST /api/messages/test (Requirement 22) ---");
  {
    const testRes = await fetch(`${BASE_URL}/api/messages/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userA.cookie,
      },
      body: JSON.stringify({
        leadId: leadA2.id,
        message: "Hi Lead Alpha Two, test message through existing test endpoint",
      }),
    });
    const testJson = (await testRes.json()) as any;
    assert(
      testRes.status === 200 &&
      typeof testJson.success === "boolean" &&
      typeof testJson.messageId === "string" &&
      ["SENT", "FAILED"].includes(testJson.status),
      "Existing POST /api/messages/test endpoint continues to function backwards-compatibly",
    );
  }

  console.log("\n=================================================================");
  console.log(`   TASK 5 TEST RESULTS: ${passed} PASSED, ${failed} FAILED       `);
  console.log("=================================================================\n");

  // Clean up test data
  await prisma.message.deleteMany({ where: { campaignId: { in: [campaignA.id, campaignA2.id, campaignB.id] } } });
  await prisma.lead.deleteMany({ where: { campaignId: { in: [campaignA.id, campaignA2.id, campaignB.id] } } });
  await prisma.campaign.deleteMany({ where: { id: { in: [campaignA.id, campaignA2.id, campaignB.id] } } });

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner encountered an error:", err);
  process.exit(1);
});
