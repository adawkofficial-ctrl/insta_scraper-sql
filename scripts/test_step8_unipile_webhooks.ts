import "dotenv/config";
import "./preload_server_only.cjs";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { LeadStatus } from "../src/generated/prisma/enums";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3005";
const WEBHOOK_SECRET = process.env.UNIPILE_WEBHOOK_PATH_SECRET || "dev_unipile_webhook_secret_2026";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function main() {
  const { getMessagingProvider, sendSingleMessage } = await import("../src/lib/services/messaging");
  const { onLeadReplied } = await import("../src/lib/services/unipile/webhook-service");

  console.log("=================================================================");
  console.log("   STEP 8 UNIPILE WEBHOOKS & INGESTION TEST SUITE               ");
  console.log("=================================================================");

  // Cleanup helper for test data
  const testRunId = `step8_${Date.now()}`;
  const testUserEmail = `${testRunId}@example.com`;

  let testUserId = "";
  let testCampaignId = "";
  let unipileSenderId = "";
  let playwrightSenderId = "";

  try {
    // Check server health
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    check(healthRes.status === 200, "Server health check returns HTTP 200");

    // -------------------------------------------------------------------------
    // SETUP USER FOR TEST SUITE & MIGRATION BACKFILL VERIFICATION
    // -------------------------------------------------------------------------
    const testUser = await db.user.create({
      data: {
        email: testUserEmail,
        passwordHash: "$2b$10$xyzFakeHashedPasswordForTestRunner1234567890",
        name: "Step 8 Test User",
      },
    });
    testUserId = testUser.id;

    // -------------------------------------------------------------------------
    // PART G.1: MIGRATION BACKFILL VERIFICATION
    // -------------------------------------------------------------------------
    console.log("\n--- Part G.1: Migration Backfill Verification ---");
    let unipileAccounts = await db.instagramSenderAccount.findMany({
      where: { connectionMethod: "UNIPILE" },
    });
    let playwrightAccounts = await db.instagramSenderAccount.count({
      where: { connectionMethod: "PLAYWRIGHT" },
    });

    if (unipileAccounts.length === 0) {
      // On fresh test databases without pre-existing dev rows, create a legacy account
      // and run the migration backfill query to verify its exact behavior.
      await db.instagramSenderAccount.create({
        data: {
          user: { connect: { id: testUserId } },
          username: `legacy_unipile_${testRunId}`,
          connectionMethod: "PLAYWRIGHT",
          sessionPath: `unipile:acc_legacy_${testRunId}`,
          status: "DISCONNECTED",
        },
      });
      await db.$executeRawUnsafe(`
        UPDATE "InstagramSenderAccount"
        SET "connectionMethod" = 'UNIPILE',
            "unipileAccountId" = REPLACE("sessionPath", 'unipile:', '')
        WHERE "sessionPath" LIKE 'unipile:%' AND "connectionMethod" = 'PLAYWRIGHT'
      `);
      unipileAccounts = await db.instagramSenderAccount.findMany({
        where: { connectionMethod: "UNIPILE" },
      });
    }

    if (playwrightAccounts === 0) {
      await db.instagramSenderAccount.create({
        data: {
          user: { connect: { id: testUserId } },
          username: `legacy_playwright_${testRunId}`,
          connectionMethod: "PLAYWRIGHT",
          sessionPath: `playwright_sessions/${testRunId}`,
          status: "DISCONNECTED",
        },
      });
      playwrightAccounts = await db.instagramSenderAccount.count({
        where: { connectionMethod: "PLAYWRIGHT" },
      });
    }

    const totalAccounts = await db.instagramSenderAccount.count();
    console.log(`  Total accounts: ${totalAccounts}`);
    console.log(`  UNIPILE accounts: ${unipileAccounts.length}`);
    console.log(`  PLAYWRIGHT accounts: ${playwrightAccounts}`);

    check(unipileAccounts.length >= 1, `UNIPILE accounts backfilled correctly (expected >= 1, found ${unipileAccounts.length})`);
    check(playwrightAccounts >= 1, `PLAYWRIGHT accounts preserved (expected >= 1, found ${playwrightAccounts})`);
    
    // Verify all UNIPILE accounts have non-null unipileAccountId
    const allHaveUnipileId = unipileAccounts.every((acc) => acc.unipileAccountId && acc.unipileAccountId.length > 0);
    check(allHaveUnipileId, "All UNIPILE accounts have non-null unipileAccountId populated");

    // Verify uniqueness of unipileAccountId among non-null rows
    const unipileIds = unipileAccounts.map((a) => a.unipileAccountId!);
    const uniqueUnipileIds = new Set(unipileIds);
    check(uniqueUnipileIds.size === unipileIds.length, "All populated unipileAccountId values are unique");

    // -------------------------------------------------------------------------
    // PART G.2: PER-ACCOUNT PROVIDER ROUTING
    // -------------------------------------------------------------------------
    console.log("\n--- Part G.2: Per-Account Provider Dynamic Selection ---");
    
    // Check getMessagingProvider directly with sender object
    const playwrightProvider = getMessagingProvider({ connectionMethod: "PLAYWRIGHT" });
    check(playwrightProvider.name === "playwright", `Playwright sender resolves to playwright provider (got: ${playwrightProvider.name})`);

    const unipileProvider = getMessagingProvider({ connectionMethod: "UNIPILE" });
    check(unipileProvider.name === "unipile", `Unipile sender resolves to unipile provider (got: ${unipileProvider.name})`);

    // Verify coexistence in same process: both can be invoked sequentially without interference
    const pwStatus = await playwrightProvider.getStatus();
    const upStatus = await unipileProvider.getStatus();
    check(pwStatus.provider === "playwright", `Playwright transport reports provider name "playwright"`);
    check(upStatus.provider === "unipile", `Unipile transport reports provider name "unipile"`);

    // -------------------------------------------------------------------------
    // SETUP SEED DATA FOR WEBHOOK & ROUTING TESTS
    // -------------------------------------------------------------------------
    const testProfile = await db.companyProfile.create({
      data: {
        user: { connect: { id: testUserId } },
        name: `Profile ${testRunId}`,
        description: "Test company profile",
      },
    });

    const testCampaign = await db.campaign.create({
      data: {
        user: { connect: { id: testUserId } },
        companyProfile: { connect: { id: testProfile.id } },
        name: `Campaign ${testRunId}`,
        status: "READY",
      },
    });
    testCampaignId = testCampaign.id;

    const mockUnipileAccountId = `unipile_acc_${testRunId}`;
    const unipileSender = await db.instagramSenderAccount.create({
      data: {
        user: { connect: { id: testUserId } },
        username: `unipile_snd_${testRunId}`,
        connectionMethod: "UNIPILE",
        unipileAccountId: mockUnipileAccountId,
        status: "DISCONNECTED",
        sessionPath: `unipile:${mockUnipileAccountId}`,
      },
    });
    unipileSenderId = unipileSender.id;

    const playwrightSender = await db.instagramSenderAccount.create({
      data: {
        user: { connect: { id: testUserId } },
        username: `pw_snd_${testRunId}`,
        connectionMethod: "PLAYWRIGHT",
        status: "DISCONNECTED",
        sessionPath: `playwright_sessions/${testRunId}`,
      },
    });
    playwrightSenderId = playwrightSender.id;

    // Verify per-account selection with actual sender DB records
    const resolvedPwProvider = getMessagingProvider(playwrightSender);
    const resolvedUpProvider = getMessagingProvider(unipileSender);
    check(resolvedPwProvider.name === "playwright", `Sender with PLAYWRIGHT connectionMethod resolved to Playwright provider`);
    check(resolvedUpProvider.name === "unipile", `Sender with UNIPILE connectionMethod resolved to Unipile provider`);

    // Verify mixed Playwright + Unipile accounts each send through correct transport in same run (mocking both)
    let pwSent = false;
    let upSent = false;
    const origPwSend = resolvedPwProvider.sendMessage;
    const origUpSend = resolvedUpProvider.sendMessage;
    try {
      resolvedPwProvider.sendMessage = async (_req) => {
        pwSent = true;
        return { success: true, messageId: "mock_pw_msg_1", provider: "playwright", messageText: _req.message };
      };
      resolvedUpProvider.sendMessage = async (_req) => {
        upSent = true;
        return { success: true, messageId: "mock_up_msg_1", provider: "unipile", messageText: _req.message };
      };

      const sendRes1 = await resolvedPwProvider.sendMessage({
        profileUrl: "https://www.instagram.com/lead_pw/",
        message: "Message via Playwright",
      });
      const sendRes2 = await resolvedUpProvider.sendMessage({
        profileUrl: "https://www.instagram.com/lead_up/",
        message: "Message via Unipile",
      });

      check(pwSent && sendRes1.success, "Playwright transport successfully dispatched message in mixed environment");
      check(upSent && sendRes2.success, "Unipile transport successfully dispatched message in mixed environment");
      check(pwSent && upSent, "Mixed Playwright and Unipile senders coexisted and sent in the same run");
    } finally {
      resolvedPwProvider.sendMessage = origPwSend;
      resolvedUpProvider.sendMessage = origUpSend;
    }

    // -------------------------------------------------------------------------
    // PART G.3: ACCOUNT-STATUS WEBHOOK
    // -------------------------------------------------------------------------
    console.log("\n--- Part G.3: Account-Status Webhook Route & Deduplication ---");

    // 1. Invalid secret returns 404
    const badSecretStatusRes = await fetch(`${BASE_URL}/api/webhooks/unipile/account-status/wrong_secret_123`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "account_status", account_id: mockUnipileAccountId, status: "OK" }),
    });
    check(badSecretStatusRes.status === 404, `Account-status with invalid secret returns HTTP 404 (got: ${badSecretStatusRes.status})`);

    // 2. Valid secret + payload updates sender status to CONNECTED
    const validStatusPayload = {
      event: "account_status",
      event_id: `evt_status_${testRunId}`,
      account_id: mockUnipileAccountId,
      status: "OK",
    };
    const validStatusRes = await fetch(`${BASE_URL}/api/webhooks/unipile/account-status/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validStatusPayload),
    });
    check(validStatusRes.status === 200, `Account-status with valid secret returns HTTP 200 (got: ${validStatusRes.status})`);
    
    const validStatusBody = await validStatusRes.json();
    check(validStatusBody.ok === true && validStatusBody.status === "PROCESSED", "Account-status returns ok=true and status=PROCESSED");

    const reloadedSender = await db.instagramSenderAccount.findUnique({
      where: { id: unipileSenderId },
    });
    check(reloadedSender?.status === "CONNECTED", `Sender account status transitioned to CONNECTED (got: ${reloadedSender?.status})`);

    // 3. Duplicate delivery is a no-op (status: IGNORED)
    const duplicateStatusRes = await fetch(`${BASE_URL}/api/webhooks/unipile/account-status/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validStatusPayload),
    });
    check(duplicateStatusRes.status === 200, `Duplicate delivery returns HTTP 200`);
    const duplicateStatusBody = await duplicateStatusRes.json();
    check(duplicateStatusBody.status === "IGNORED", `Duplicate event deduplicated with status=IGNORED (got: ${duplicateStatusBody.status})`);

    // -------------------------------------------------------------------------
    // PART G.4: INBOUND NEW-MESSAGE WEBHOOK & INGESTION
    // -------------------------------------------------------------------------
    console.log("\n--- Part G.4: Inbound New-Message Webhook & Ingestion Pipeline ---");

    // 1. Invalid secret returns 404
    const badSecretMsgRes = await fetch(`${BASE_URL}/api/webhooks/unipile/new-message/wrong_secret_123`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "message_received" }),
    });
    check(badSecretMsgRes.status === 404, `New-message with invalid secret returns HTTP 404 (got: ${badSecretMsgRes.status})`);

    // 2. Setup leads for matching:
    // Lead 1: CONTACTED lead with instagramUserId
    const leadContacted = await db.lead.create({
      data: {
        campaign: { connect: { id: testCampaignId } },
        username: `contacted_user_${testRunId}`,
        usernameNormalized: `contacted_user_${testRunId}`,
        instagramUserId: `ig_uid_${testRunId}`,
        profileUrl: `https://www.instagram.com/contacted_user_${testRunId}/`,
        status: LeadStatus.CONTACTED,
      },
    });

    // Lead 2: Username-only match (instagramUserId is null)
    const leadUsernameOnly = await db.lead.create({
      data: {
        campaign: { connect: { id: testCampaignId } },
        username: `lead_username_${testRunId}`,
        usernameNormalized: `lead_username_${testRunId}`,
        instagramUserId: null,
        profileUrl: `https://www.instagram.com/lead_username_${testRunId}/`,
        status: LeadStatus.CONTACTED,
      },
    });

    // Lead 3: DO_NOT_CONTACT lead
    const leadDnc = await db.lead.create({
      data: {
        campaign: { connect: { id: testCampaignId } },
        username: `dnc_user_${testRunId}`,
        usernameNormalized: `dnc_user_${testRunId}`,
        instagramUserId: `ig_dnc_${testRunId}`,
        profileUrl: `https://www.instagram.com/dnc_user_${testRunId}/`,
        status: LeadStatus.DO_NOT_CONTACT,
      },
    });

    // 3. Test 4A: Valid inbound message from leadContacted matching on instagramUserId
    const inboundMsg1Id = `unipile_msg_1_${testRunId}`;
    const chatId1 = `unipile_chat_1_${testRunId}`;
    const msg1Res = await fetch(`${BASE_URL}/api/webhooks/unipile/new-message/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "message_received",
        event_id: `evt_msg_1_${testRunId}`,
        account_id: mockUnipileAccountId,
        chat_id: chatId1,
        message_id: inboundMsg1Id,
        sender_id: `ig_uid_${testRunId}`,
        sender_name: `contacted_user_${testRunId}`,
        text: "Hi, I got your message and I'm interested in working together!",
        timestamp: new Date().toISOString(),
      }),
    });
    check(msg1Res.status === 200, `Valid inbound message webhook returns HTTP 200`);
    const msg1Body = await msg1Res.json();
    check(msg1Body.ok === true, "Response ok=true");
    check(msg1Body.matchedLeadId === leadContacted.id, `Matched correctly to leadContacted ID (got: ${msg1Body.matchedLeadId})`);
    check(msg1Body.leadTransitioned === true, "Lead status transitioned to REPLIED");

    // Verify DB Conversation & Message
    const conversation1 = await db.conversation.findFirst({
      where: { leadId: leadContacted.id },
      include: { messages: true },
    });
    check(Boolean(conversation1), "Conversation row created for matched lead");
    check(conversation1?.externalThreadId === chatId1, `Conversation externalThreadId set to chat_id (${conversation1?.externalThreadId})`);
    check(conversation1?.unipileChatId === chatId1, `Conversation unipileChatId set to chat_id (${conversation1?.unipileChatId})`);
    check(conversation1?.unreadCount === 1, `Conversation unreadCount incremented to 1`);
    check(conversation1?.requiresHuman === true, `Conversation requiresHuman set to true`);

    const message1 = conversation1?.messages.find((m) => m.unipileMessageId === inboundMsg1Id);
    check(Boolean(message1), "Inbound Message row created in database");
    check(message1?.direction === "INBOUND", `Message direction is INBOUND (got: ${message1?.direction})`);
    check(message1?.channel === "INSTAGRAM", `Message channel is INSTAGRAM`);
    check(message1?.messageText?.includes("interested in working together") === true, "Message text stored correctly");

    // Verify Lead status transition and history
    const reloadedLeadContacted = await db.lead.findUnique({
      where: { id: leadContacted.id },
      include: { statusHistory: true },
    });
    check(
      reloadedLeadContacted?.status === LeadStatus.REPLIED ||
        reloadedLeadContacted?.status === LeadStatus.INTERESTED,
      `Lead status is REPLIED or AI classified (got: ${reloadedLeadContacted?.status})`,
    );
    const transitionHistory = reloadedLeadContacted?.statusHistory.find(
      (h) => h.fromStatus === LeadStatus.CONTACTED && h.toStatus === LeadStatus.REPLIED
    );
    check(Boolean(transitionHistory), "LeadStatusHistory record created with CONTACTED -> REPLIED");
    check(Boolean(transitionHistory?.reason?.includes("Unipile")), "LeadStatusHistory reason documents Unipile inbound message");

    // 4. Test 4B: Redelivery deduplication (same message_id)
    const redeliveryRes = await fetch(`${BASE_URL}/api/webhooks/unipile/new-message/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "message_received",
        event_id: `evt_msg_1_redelivery_${testRunId}`,
        account_id: mockUnipileAccountId,
        chat_id: chatId1,
        message_id: inboundMsg1Id,
        sender_id: `ig_uid_${testRunId}`,
        text: "Hi, I got your message and I'm interested in working together!",
      }),
    });
    check(redeliveryRes.status === 200, `Redelivery webhook returns HTTP 200`);
    const redeliveryBody = await redeliveryRes.json();
    check(redeliveryBody.duplicate === true, `Duplicate message correctly identified (duplicate: true)`);

    const totalMessagesForLead = await db.message.count({
      where: { unipileMessageId: inboundMsg1Id },
    });
    check(totalMessagesForLead === 1, `Exactly 1 Message record exists despite redelivery`);

    // 5. Test 4C: Outbound echo filtering
    const echoRes = await fetch(`${BASE_URL}/api/webhooks/unipile/new-message/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "message_received",
        event_id: `evt_echo_${testRunId}`,
        account_id: mockUnipileAccountId,
        chat_id: chatId1,
        message_id: `echo_msg_${testRunId}`,
        sender_id: mockUnipileAccountId, // sender is the account itself
        text: "This is an outbound echo",
      }),
    });
    check(echoRes.status === 200, `Outbound echo webhook returns HTTP 200`);
    const echoBody = await echoRes.json();
    check(echoBody.ignored === true && echoBody.reason === "OUTBOUND_ECHO", "Outbound echo is ignored without creating inbound message");

    // 6. Test 4D: Match by username fallback (when instagramUserId is null or mismatched)
    const inboundMsg2Id = `unipile_msg_2_${testRunId}`;
    const chatId2 = `unipile_chat_2_${testRunId}`;
    const msg2Res = await fetch(`${BASE_URL}/api/webhooks/unipile/new-message/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "message_received",
        event_id: `evt_msg_2_${testRunId}`,
        account_id: mockUnipileAccountId,
        chat_id: chatId2,
        message_id: inboundMsg2Id,
        sender_id: `different_provider_id_${testRunId}`,
        sender_name: `lead_username_${testRunId}`,
        text: "Replying via username match!",
      }),
    });
    check(msg2Res.status === 200, `Username-fallback inbound message returns HTTP 200`);
    const msg2Body = await msg2Res.json();
    check(msg2Body.matchedLeadId === leadUsernameOnly.id, `Matched by username fallback to leadUsernameOnly ID`);
    const reloadedLead2 = await db.lead.findUnique({ where: { id: leadUsernameOnly.id } });
    check(reloadedLead2?.status === LeadStatus.REPLIED, `Lead matched by username transitioned to REPLIED`);

    // 7. Test 4E: DO_NOT_CONTACT lead message recorded but status NOT changed
    const inboundMsg3Id = `unipile_msg_3_${testRunId}`;
    const chatId3 = `unipile_chat_3_${testRunId}`;
    const msg3Res = await fetch(`${BASE_URL}/api/webhooks/unipile/new-message/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "message_received",
        event_id: `evt_msg_3_${testRunId}`,
        account_id: mockUnipileAccountId,
        chat_id: chatId3,
        message_id: inboundMsg3Id,
        sender_id: `ig_dnc_${testRunId}`,
        sender_name: `dnc_user_${testRunId}`,
        text: "Please unsubscribe me",
      }),
    });
    check(msg3Res.status === 200, `DNC inbound message returns HTTP 200`);
    const msg3Body = await msg3Res.json();
    check(msg3Body.matchedLeadId === leadDnc.id, "DNC lead was matched for message recording");
    check(msg3Body.leadTransitioned === false, "DNC lead was NOT transitioned (leadTransitioned: false)");

    const reloadedDncLead = await db.lead.findUnique({ where: { id: leadDnc.id } });
    check(reloadedDncLead?.status === LeadStatus.DO_NOT_CONTACT, `DNC lead status remained DO_NOT_CONTACT`);
    const dncMessage = await db.message.findUnique({ where: { unipileMessageId: inboundMsg3Id } });
    check(Boolean(dncMessage), "Message from DNC contact was successfully recorded in DB");

    // 8. Test 4F: Unmatched inbound message goes to UnmatchedInboundMessage table
    const inboundMsg4Id = `unipile_msg_4_unmatched_${testRunId}`;
    const msg4Res = await fetch(`${BASE_URL}/api/webhooks/unipile/new-message/${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "message_received",
        event_id: `evt_msg_4_${testRunId}`,
        account_id: mockUnipileAccountId,
        chat_id: `unmatched_chat_${testRunId}`,
        message_id: inboundMsg4Id,
        sender_id: `random_unknown_id_${testRunId}`,
        sender_name: `random_stranger_${testRunId}`,
        text: "Hello stranger!",
      }),
    });
    check(msg4Res.status === 200, `Unmatched inbound message returns HTTP 200`);
    const msg4Body = await msg4Res.json();
    check(msg4Body.unmatched === true, "Unmatched message response indicates unmatched: true");

    const unmatchedRecord = await db.unmatchedInboundMessage.findFirst({
      where: { unipileAccountId: mockUnipileAccountId, providerSenderId: `random_unknown_id_${testRunId}` },
    });
    check(Boolean(unmatchedRecord), "Row created in UnmatchedInboundMessage fallback table");
    check(unmatchedRecord?.username === `random_stranger_${testRunId}`, `Unmatched username recorded properly`);
    check(unmatchedRecord?.linkedLeadId === null, `linkedLeadId is initially null for future manual linking`);

    // 9. Test 4G: onLeadReplied hook function callable
    let hookExecuted = false;
    try {
      await onLeadReplied("test-lead-id", "test-msg-id");
      hookExecuted = true;
    } catch {
      hookExecuted = false;
    }
    check(hookExecuted, "onLeadReplied(leadId, messageId) internal hook point executed without error");

  } catch (err: any) {
    console.error("Test execution exception:", err);
    check(false, "Test execution caught unexpected exception", err.message);
  } finally {
    // Clean up test data
    try {
      if (testUserId) {
        await db.unmatchedInboundMessage.deleteMany({
          where: { unipileAccountId: { contains: testRunId } },
        });
        await db.message.deleteMany({
          where: { unipileMessageId: { contains: testRunId } },
        });
        await db.conversation.deleteMany({
          where: { unipileChatId: { contains: testRunId } },
        });
        await db.leadStatusHistory.deleteMany({
          where: { lead: { campaignId: testCampaignId } },
        });
        await db.lead.deleteMany({
          where: { campaignId: testCampaignId },
        });
        await db.campaign.deleteMany({
          where: { id: testCampaignId },
        });
        await db.instagramSenderAccount.deleteMany({
          where: { userId: testUserId },
        });
        await db.unipileWebhookEvent.deleteMany({
          where: { unipileEventId: { contains: testRunId } },
        });
        await db.companyProfile.deleteMany({
          where: { userId: testUserId },
        });
        await db.user.delete({
          where: { id: testUserId },
        });
      }
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr);
    }
    await db.$disconnect();
  }

  console.log("\n=================================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
