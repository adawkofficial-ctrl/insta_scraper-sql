/* eslint-disable */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";

const BASE_URL = "http://localhost:3001";

async function runTests() {
  console.log("==================================================");
  console.log("   STEP 7: MESSAGING ARCHITECTURE TEST SUITE      ");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string) {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      failed++;
    }
  }

  const connectionString = process.env.DATABASE_URL!;
  const prisma = createPrismaClient();

  // Fetch or create a test campaign and lead
  let testLead = await prisma.lead.findFirst({
    where: { profileUrl: { not: "" } },
  });

  if (!testLead) {
    const camp = await prisma.campaign.create({
      data: { name: "Messaging Test Campaign", status: "DRAFT", userId: "dev_default_user_001" } as any,
    });
    testLead = await prisma.lead.create({
      data: {
        campaignId: camp.id,
        username: "test_recipient_1",
        profileUrl: "https://www.instagram.com/test_recipient_1/",
        fullName: "Test Recipient",
      },
    });
  }

  // 1. Check GET /api/messaging/status (Verify AUTH_REQUIRED when no session exists)
  {
    const res = await fetch(`${BASE_URL}/api/messaging/status`);
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      (json.provider === "unipile" || json.provider === "playwright") &&
      json.authenticated === false &&
      json.status === "AUTH_REQUIRED",
      "GET /api/messaging/status returns AUTH_REQUIRED when unauthenticated",
    );
  }


  // 2. Test Invalid leadId (404)
  {
    const res = await fetch(`${BASE_URL}/api/messages/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadId: "non-existent-lead-id-9999",
        message: "Hello world",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 404 && json.error?.code === "LEAD_NOT_FOUND",
      "POST /api/messages/test rejects non-existent lead with 404 LEAD_NOT_FOUND",
    );
  }

  // 3. Test Empty message (400)
  {
    const res = await fetch(`${BASE_URL}/api/messages/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadId: testLead.id,
        message: "   ",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 400 && json.error?.code === "EMPTY_MESSAGE",
      "POST /api/messages/test rejects empty message with 400 EMPTY_MESSAGE",
    );
  }

  // 4. Test Missing profile URL on lead
  {
    // Create temporary lead without profileUrl and without a handle
    const noUrlLead = await prisma.lead.create({
      data: {
        campaignId: testLead.campaignId,
        username: null,
        profileUrl: "",
      },
    });

    const res = await fetch(`${BASE_URL}/api/messages/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadId: noUrlLead.id,
        message: "Hello without url",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 400 && json.error?.code === "MISSING_PROFILE_URL",
      "POST /api/messages/test rejects lead with missing profileUrl (400)",
    );

    // Clean up temporary lead
    await prisma.lead.delete({ where: { id: noUrlLead.id } });
  }

  // 5. Send ONE test message & verify structured failure due to AUTH_REQUIRED
  let recordedMessageId = "";
  {
    const res = await fetch(`${BASE_URL}/api/messages/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadId: testLead.id,
        message: "Hello, this is a controlled test message.",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      json.success === false &&
      json.status === "FAILED" &&
      json.messageId &&
      json.error?.code === "AUTH_REQUIRED",
      "POST /api/messages/test records message and reports AUTH_REQUIRED failure safely",
    );
    recordedMessageId = json.messageId;
  }

  // 6. Verify Message record in PostgreSQL database via Prisma
  {
    const dbMessage = await prisma.message.findUnique({
      where: { id: recordedMessageId },
    });
    assert(
      Boolean(
        dbMessage &&
        dbMessage.leadId === testLead.id &&
        dbMessage.status === "FAILED" &&
        dbMessage.messageText === "Hello, this is a controlled test message." &&
        dbMessage.errorMessage?.includes("Instagram browser profile directory does not exist or has not been authenticated"),
      ),
      "Message record created in PostgreSQL with status FAILED and sanitized error message",
    );
  }

  // 7. Verify Message History API (GET /api/leads/[leadId]/messages)
  {
    const res = await fetch(`${BASE_URL}/api/leads/${testLead.id}/messages`);
    const history = (await res.json()) as any[];
    assert(
      res.status === 200 &&
      Array.isArray(history) &&
      history.some((m) => m.id === recordedMessageId && m.status === "FAILED"),
      "GET /api/leads/[leadId]/messages returns lead message history (newest first)",
    );
  }

  // 8. Verify Message History 404 for invalid lead
  {
    const res = await fetch(`${BASE_URL}/api/leads/non-existent-lead-9999/messages`);
    const json = (await res.json()) as any;
    assert(
      res.status === 404 && json.error?.code === "LEAD_NOT_FOUND",
      "GET /api/leads/[leadId]/messages returns 404 for missing lead",
    );
  }

  await prisma.$disconnect();

  console.log("\n==================================================");
  console.log(`TOTAL CHECKS: ${passed + failed}`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
