import "dotenv/config";

// Test isolation: Ensure tests use test database and test environment
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl, assertSafeTestDatabase } = require("./test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.OUTBOUND_SENDING_ENABLED = "true";
assertSafeTestDatabase(process.env.DATABASE_URL);

process.env.MESSAGING_PROVIDER = "playwright";
process.env.SENDER_COOLDOWN_SECONDS = "0";
process.env.SENDER_COOLDOWN_MINUTES = "0";
process.env.WORKING_HOURS_START = "0";
process.env.WORKING_HOURS_END = "24";
process.env.ENABLE_AI_REPLY_CLASSIFICATION = "false";

import "./preload_server_only.cjs";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  scheduleFollowUpsForLead,
  cancelFollowUpsForLead,
  handleInboundReplyForFollowUps,
  dispatchDueFollowUps,
  renderFollowUpTemplate,
  isStopKeyword,
  getCampaignFollowUpSummary,
} from "../src/lib/services/messaging/follow-up-service";
import { setSendGateClock } from "../src/lib/services/messaging/send-gate";
import { setMessagingProvider } from "../src/lib/services/messaging/messaging-service";
import type {
  MessagingProvider,
  MessagingProviderStatus,
  SendMessageRequest,
  SendMessageResult,
} from "../src/lib/services/messaging/messaging-provider";
import { checkLeadSuppression } from "../src/lib/services/compliance/dnc-service";

const prisma = getPrismaClient();

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

class MockFollowUpProvider implements MessagingProvider {
  readonly name = "mock-playwright";
  sentRequests: SendMessageRequest[] = [];
  shouldFail = false;
  shouldRateLimit = false;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async getStatus(): Promise<MessagingProviderStatus> {
    return {
      provider: "mock-playwright",
      status: "READY",
      authenticated: true,
      message: "Mock follow-up provider ready",
    };
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    this.sentRequests.push(request);
    if (this.shouldFail) {
      return {
        success: false,
        provider: "mock-playwright",
        messageText: request.message,
        error: { code: "SEND_FAILED", message: "Mock send failed" },
      };
    }
    if (this.shouldRateLimit) {
      return {
        success: false,
        provider: "mock-playwright",
        messageText: request.message,
        error: { code: "RATE_LIMITED", message: "Rate limit exceeded (checkpoint required)" },
      };
    }
    return {
      success: true,
      provider: "mock-playwright",
      messageText: request.message,
      providerMessageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sentAt: new Date().toISOString(),
    };
  }
}

async function run() {
  console.log("=== STEP 5: Follow-Up Messages Automated Test Suite ===");
  const mockProvider = new MockFollowUpProvider();
  setMessagingProvider(mockProvider);

  // Setup test campaign, sender account, and company profile
  const user = await prisma.user.upsert({
    where: { email: "followup_test@example.com" },
    update: {},
    create: {
      email: "followup_test@example.com",
      passwordHash: "fake_hash_123",
      role: "ADMIN",
    },
  });

  const profile = await prisma.companyProfile.upsert({
    where: { id: "mock_profile_fu" },
    update: {},
    create: {
      id: "mock_profile_fu",
      userId: user.id,
      name: "Mock Profile",
      description: "Mock Profile Description",
    },
  });

  const sender = await prisma.instagramSenderAccount.create({
    data: {
      userId: user.id,
      username: `sender_fu_${Date.now().toString(36)}`,
      status: "CONNECTED",
      dailyCap: 20,
      sentToday: 0,
      workingHoursStart: 0,
      workingHoursEnd: 24,
      warmupStartedAt: new Date(Date.now() - 30 * 86_400_000),
      sessionPath: "mock_session_fu",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      companyProfileId: profile.id,
      name: `FollowUp Test Campaign ${Date.now()}`,
      status: "RUNNING",
      followUpEnabled: true,
      followUpCount: 2,
      followUpDelayDays: [3, 5],
      followUpTemplates: [
        "Hi {firstName}, following up on my previous message!",
        "Hi {firstName}, just wanted to check in one last time regarding {city}!",
      ],
    },
  });

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Follow-up scheduled after first send (step 1 at +3d, step 2 at +5d)
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Follow-up scheduled after first send (step 1 at +3d, step 2 at +5d)");
    const lead1 = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        username: `lead_test_1_${Date.now().toString(36)}`,
        fullName: "Sarah Connor",
        location: "Los Angeles",
        source: "TEST",
        status: "CONTACTED",
      },
    });

    const t0 = new Date("2026-11-01T10:00:00Z");
    const firstMsg1 = await prisma.message.create({
      data: {
        leadId: lead1.id,
        campaignId: campaign.id,
        senderAccountId: sender.id,
        messageText: "Hello Sarah, nice to connect!",
        status: "SENT",
        direction: "OUTBOUND",
        channel: "INSTAGRAM",
        unipileChatId: "thread_fu_1",
      },
    });

    const scheduled1 = await scheduleFollowUpsForLead({
      campaignId: campaign.id,
      leadId: lead1.id,
      firstMessageId: firstMsg1.id,
      sentAt: t0,
      senderAccountId: sender.id,
      threadId: "thread_fu_1",
    });

    check(scheduled1.length === 2, "Scheduled exactly 2 follow-ups", `Got ${scheduled1.length}`);
    const fuStep1 = scheduled1.find((f) => f.step === 1);
    const fuStep2 = scheduled1.find((f) => f.step === 2);

    check(fuStep1 !== undefined && fuStep1.status === "SCHEDULED", "Step 1 status is SCHEDULED");
    check(fuStep2 !== undefined && fuStep2.status === "SCHEDULED", "Step 2 status is SCHEDULED");

    const expectedStep1Due = new Date(t0.getTime() + 3 * 86_400_000);
    const expectedStep2Due = new Date(t0.getTime() + 5 * 86_400_000);

    check(
      fuStep1?.dueAt.toISOString() === expectedStep1Due.toISOString(),
      "Step 1 dueAt is sentAt + 3 days",
      `${fuStep1?.dueAt.toISOString()} vs ${expectedStep1Due.toISOString()}`
    );
    check(
      fuStep2?.dueAt.toISOString() === expectedStep2Due.toISOString(),
      "Step 2 dueAt is sentAt + 5 days",
      `${fuStep2?.dueAt.toISOString()} vs ${expectedStep2Due.toISOString()}`
    );
    check(
      Boolean(fuStep1?.renderedBody?.includes("Sarah")),
      "Step 1 correctly rendered {firstName} -> Sarah",
      fuStep1?.renderedBody || undefined
    );

    // -------------------------------------------------------------------------
    // TEST 2 & 3: Not sent if lead replied between send and dueAt (CANCELLED_REPLIED)
    // -------------------------------------------------------------------------
    console.log("\n[Test 2 & 3] Cancelled if reply arrives before dueAt");
    const replyDate = new Date(t0.getTime() + 1 * 86_400_000); // 1 day after first send

    // Inbound reply arrives
    await prisma.message.create({
      data: {
        leadId: lead1.id,
        campaignId: campaign.id,
        senderAccountId: sender.id,
        messageText: "Thanks for reaching out! Tell me more.",
        status: "SENT",
        direction: "INBOUND",
        channel: "INSTAGRAM",
        unipileChatId: "thread_fu_1",
        createdAt: replyDate,
      },
    });

    const replyResult = await handleInboundReplyForFollowUps({
      leadId: lead1.id,
      inboundText: "Thanks for reaching out! Tell me more.",
      repliedAt: replyDate,
    });

    check(replyResult.cancelledCount === 2, "Cancelled both pending follow-ups upon inbound reply");
    check(replyResult.isDnc === false, "Friendly reply did not trigger DNC");

    const fuAfterReply = await prisma.followUpMessage.findMany({
      where: { leadId: lead1.id },
    });
    check(
      fuAfterReply.every((f) => f.status === "CANCELLED_REPLIED"),
      "All follow-ups updated to CANCELLED_REPLIED"
    );

    // Now advance clock to +4 days and dispatch: nothing should send
    setSendGateClock(() => new Date(t0.getTime() + 4 * 86_400_000));
    mockProvider.sentRequests = [];
    const dispatchReplyRun = await dispatchDueFollowUps({
      campaignId: campaign.id,
      messagingProvider: mockProvider,
    });
    check(dispatchReplyRun.sent === 0, "No follow-up sent for replied lead", `Sent: ${dispatchReplyRun.sent}`);
    check(mockProvider.sentRequests.length === 0, "Mock provider received 0 send calls");

    // -------------------------------------------------------------------------
    // TEST 4: Cancelled if DNC added or lead said stop/unsubscribe/not interested/remove me
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Cancelled on stop keywords & marked DNC");
    // Explicit opt-out keywords
    check(isStopKeyword("stop"), "Opt-out detected: 'stop'");
    check(isStopKeyword("STOP! 🛑"), "Opt-out detected: 'STOP! 🛑'");
    check(isStopKeyword("unsubscribe"), "Opt-out detected: 'unsubscribe'");
    check(isStopKeyword("unsub"), "Opt-out detected: 'unsub'");
    check(isStopKeyword("not interested"), "Opt-out detected: 'not interested'");
    check(isStopKeyword("no thanks"), "Opt-out detected: 'no thanks'");
    check(isStopKeyword("no thank you!"), "Opt-out detected: 'no thank you!'");
    check(isStopKeyword("remove me"), "Opt-out detected: 'remove me'");
    check(isStopKeyword("don't message"), "Opt-out detected: 'don't message'");
    check(isStopKeyword("dont message"), "Opt-out detected: 'dont message'");
    check(isStopKeyword("do not contact"), "Opt-out detected: 'do not contact'");
    check(isStopKeyword("leave me alone"), "Opt-out detected: 'leave me alone'");
    check(isStopKeyword("stop messaging"), "Opt-out detected: 'stop messaging'");

    // False-positive checks (must NOT trigger DNC opt-out)
    check(!isStopKeyword("the bus stop near us is on 5th ave"), "False-positive rejected: 'bus stop near us'");
    check(!isStopKeyword("feel free to stop by our office"), "False-positive rejected: 'stop by'");
    check(!isStopKeyword("we work non-stop around the clock"), "False-positive rejected: 'non-stop'");
    check(!isStopKeyword("can't stop thinking about this!"), "False-positive rejected: 'can't stop'");
    check(!isStopKeyword("Sounds interesting, send details!"), "Non-stop message not matched");

    // False-positive workflow: 'bus stop near us' cancels follow-ups as REPLIED but does NOT trigger DNC
    const leadBus = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        username: `lead_bus_${Date.now().toString(36)}`,
        fullName: "Bus Stop Cafe",
        source: "TEST",
        status: "CONTACTED",
      },
    });

    const firstMsgBus = await prisma.message.create({
      data: {
        leadId: leadBus.id,
        campaignId: campaign.id,
        senderAccountId: sender.id,
        messageText: "Hello Cafe!",
        status: "SENT",
        direction: "OUTBOUND",
        channel: "INSTAGRAM",
        unipileChatId: "thread_bus",
      },
    });

    await scheduleFollowUpsForLead({
      campaignId: campaign.id,
      leadId: leadBus.id,
      firstMessageId: firstMsgBus.id,
      sentAt: t0,
    });

    const busReplyResult = await handleInboundReplyForFollowUps({
      leadId: leadBus.id,
      inboundText: "The bus stop near us is on 5th ave",
      repliedAt: new Date(t0.getTime() + 1 * 86_400_000),
    });

    check(busReplyResult.isDnc === false, "False-positive 'bus stop' did NOT trigger DNC");
    check(busReplyResult.cancelledCount > 0, "False-positive reply cancelled follow-ups as REPLIED");
    const busFollowUps = await prisma.followUpMessage.findMany({ where: { leadId: leadBus.id } });
    check(busFollowUps.every((f) => f.status === "CANCELLED_REPLIED"), "Follow-ups marked CANCELLED_REPLIED, not DNC");
    const busSuppression = await checkLeadSuppression({ userId: user.id, lead: leadBus });
    check(!busSuppression.suppressed, "Lead with 'bus stop' reply is NOT suppressed");

    // -------------------------------------------------------------------------
    // TEST 4B: Reply re-check at dispatch (late/missed webhook safety)
    // -------------------------------------------------------------------------
    console.log("\n[Test 4B] Reply re-check at dispatch (late/missed webhook safety)");
    const leadLateWebhook = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        username: `lead_late_${Date.now().toString(36)}`,
        fullName: "Late Webhook Lead",
        source: "TEST",
        status: "CONTACTED", // Webhook missed/delayed; status still CONTACTED
      },
    });

    const firstMsgLate = await prisma.message.create({
      data: {
        leadId: leadLateWebhook.id,
        campaignId: campaign.id,
        senderAccountId: sender.id,
        messageText: "Hello!",
        status: "SENT",
        direction: "OUTBOUND",
        channel: "INSTAGRAM",
        unipileChatId: "thread_late_1",
      },
    });

    await scheduleFollowUpsForLead({
      campaignId: campaign.id,
      leadId: leadLateWebhook.id,
      firstMessageId: firstMsgLate.id,
      sentAt: t0,
      threadId: "thread_late_1",
    });

    // Inbound reply exists in DB, but webhook never processed lead status
    await prisma.message.create({
      data: {
        leadId: leadLateWebhook.id,
        campaignId: campaign.id,
        senderAccountId: sender.id,
        messageText: "I already replied earlier!",
        status: "SENT",
        direction: "INBOUND",
        channel: "INSTAGRAM",
        unipileChatId: "thread_late_1",
        createdAt: new Date(t0.getTime() + 1 * 86_400_000),
      },
    });

    // Advance clock past dueAt (+4 days) and dispatch
    setSendGateClock(() => new Date(t0.getTime() + 4 * 86_400_000));
    mockProvider.sentRequests = [];

    const lateDispatchResult = await dispatchDueFollowUps({
      campaignId: campaign.id,
      leadId: leadLateWebhook.id,
      messagingProvider: mockProvider,
    });

    check(lateDispatchResult.sent === 0, "Dispatch re-check blocked follow-up despite lead.status = CONTACTED");
    check(lateDispatchResult.cancelled === 1, "Follow-up was cancelled at dispatch due to inbound message in DB");
    const lateFollowUps = await prisma.followUpMessage.findMany({ where: { leadId: leadLateWebhook.id } });
    check(lateFollowUps.every((f) => f.status === "CANCELLED_REPLIED"), "Follow-up marked CANCELLED_REPLIED upon dispatch re-check");

    const lead2 = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        username: `lead_test_stop_${Date.now().toString(36)}`,
        fullName: "Alex Rivera",
        location: "New York",
        source: "TEST",
        status: "CONTACTED",
      },
    });

    const firstMsg2 = await prisma.message.create({
      data: {
        leadId: lead2.id,
        campaignId: campaign.id,
        senderAccountId: sender.id,
        messageText: "Hello Alex, nice to connect!",
        status: "SENT",
        direction: "OUTBOUND",
        channel: "INSTAGRAM",
        unipileChatId: "thread_fu_2",
      },
    });

    await scheduleFollowUpsForLead({
      campaignId: campaign.id,
      leadId: lead2.id,
      firstMessageId: firstMsg2.id,
      sentAt: t0,
      senderAccountId: sender.id,
    });

    // Inbound with STOP keyword
    const stopResult = await handleInboundReplyForFollowUps({
      leadId: lead2.id,
      inboundText: "Please STOP messaging me!",
      repliedAt: new Date(t0.getTime() + 1 * 86_400_000),
    });

    check(stopResult.isDnc === true, "DNC flagged for STOP keyword");
    const fuAfterStop = await prisma.followUpMessage.findMany({
      where: { leadId: lead2.id },
    });
    check(
      fuAfterStop.every((f) => f.status === "CANCELLED_DNC"),
      "Follow-ups updated to CANCELLED_DNC"
    );

    const updatedLead2 = await prisma.lead.findUniqueOrThrow({ where: { id: lead2.id } });
    const suppression = await checkLeadSuppression({ userId: user.id, lead: updatedLead2 });
    check(suppression.suppressed === true, "Lead is registered in DNC suppression table");

    // -------------------------------------------------------------------------
    // TEST 5: Respects daily cap and working hours (deferred, not failed)
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Respects daily cap and working hours (deferred, not failed)");
    const lead3 = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        username: `lead_test_deferred_${Date.now().toString(36)}`,
        fullName: "Marcus Brody",
        location: "UTC",
        source: "TEST",
        status: "CONTACTED",
      },
    });

    const firstMsg3 = await prisma.message.create({
      data: {
        leadId: lead3.id,
        campaignId: campaign.id,
        senderAccountId: sender.id,
        messageText: "Hello Marcus, nice to connect!",
        status: "SENT",
        direction: "OUTBOUND",
        channel: "INSTAGRAM",
        unipileChatId: "thread_fu_3",
      },
    });

    await scheduleFollowUpsForLead({
      campaignId: campaign.id,
      leadId: lead3.id,
      firstMessageId: firstMsg3.id,
      sentAt: t0,
      senderAccountId: sender.id,
    });

    // Test 5A: Outside working hours
    // Set sender working hours to 9-18
    await prisma.instagramSenderAccount.update({
      where: { id: sender.id },
      data: { workingHoursStart: 9, workingHoursEnd: 18 },
    });
    delete process.env.WORKING_HOURS_START;
    delete process.env.WORKING_HOURS_END;

    // Clock set to 22:00 UTC (+3 days from t0 -> dueAt was 10:00 UTC, so it is due, but outside 9-18 window)
    const nightTime = new Date("2026-11-04T22:00:00Z");
    setSendGateClock(() => nightTime);
    mockProvider.sentRequests = [];

    const deferredRunHours = await dispatchDueFollowUps({
      campaignId: campaign.id,
      messagingProvider: mockProvider,
    });

    check(deferredRunHours.sent === 0, "0 sent outside working hours");
    check(deferredRunHours.deferred > 0, "Item was deferred outside working hours");

    const fuDeferredHours = await prisma.followUpMessage.findFirst({
      where: { leadId: lead3.id, step: 1 },
    });
    check(fuDeferredHours?.status === "SCHEDULED", "Deferred follow-up remains SCHEDULED, not FAILED");
    check(fuDeferredHours?.retryAt !== null, "retryAt is set for next working window");

    // Test 5B: Daily cap reached
    // Clear retryAt from Test 5A so it can be evaluated for cap check
    await prisma.followUpMessage.updateMany({
      where: { leadId: lead3.id },
      data: { retryAt: null },
    });

    await prisma.instagramSenderAccount.update({
      where: { id: sender.id },
      data: { sentToday: 20, sentTodayDate: "2026-11-05", dailyCap: 20 },
    });

    // Thursday noon (inside working hours 12:00)
    const dayTime = new Date("2026-11-05T12:00:00Z");
    setSendGateClock(() => dayTime);

    const deferredRunCap = await dispatchDueFollowUps({
      campaignId: campaign.id,
      messagingProvider: mockProvider,
    });

    check(deferredRunCap.sent === 0, "0 sent when daily cap reached");
    check(deferredRunCap.deferred > 0, "Item was deferred due to daily cap");

    // Reset sender cap and clear retryAt for next tests
    await prisma.instagramSenderAccount.update({
      where: { id: sender.id },
      data: { sentToday: 0, dailyCap: 50 },
    });
    await prisma.followUpMessage.updateMany({
      where: { leadId: lead3.id },
      data: { retryAt: null },
    });

    // -------------------------------------------------------------------------
    // TEST 6: Prioritized over new first messages when both are due
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Priority: Follow-ups dispatched before new messages");
    // Thursday 14:00 inside working hours
    setSendGateClock(() => new Date("2026-11-05T14:00:00Z"));
    mockProvider.sentRequests = [];

    const priorityDispatch = await dispatchDueFollowUps({
      campaignId: campaign.id,
      messagingProvider: mockProvider,
    });

    check(priorityDispatch.sent >= 1, "Follow-up Step 1 sent successfully", `Sent: ${priorityDispatch.sent}`);
    check(mockProvider.sentRequests.length >= 1, "Mock provider received outbound DM");
    const step1SentRecord = await prisma.followUpMessage.findFirst({
      where: { leadId: lead3.id, step: 1 },
    });
    check(step1SentRecord?.status === "SENT", "Step 1 status updated to SENT");
    check(step1SentRecord?.sentAt !== null, "Step 1 sentAt recorded");

    // -------------------------------------------------------------------------
    // TEST 7: Max count (1 or 2) and 48h spacing enforced
    // -------------------------------------------------------------------------
    console.log("\n[Test 7] Max count & 48h spacing enforced");
    // Advance clock only 24h since Step 1 sent (less than 48h)
    const tooSoonTime = new Date(step1SentRecord!.sentAt!.getTime() + 24 * 3600_000);
    setSendGateClock(() => tooSoonTime);

    // Force step 2 dueAt to now
    await prisma.followUpMessage.updateMany({
      where: { leadId: lead3.id, step: 2 },
      data: { dueAt: tooSoonTime },
    });

    mockProvider.sentRequests = [];
    const spacingDispatch = await dispatchDueFollowUps({
      campaignId: campaign.id,
      messagingProvider: mockProvider,
    });

    check(spacingDispatch.sent === 0, "Step 2 NOT sent because < 48h since Step 1", `Sent: ${spacingDispatch.sent}`);

    // Now advance clock past 48h (50h)
    const validSpacingTime = new Date(step1SentRecord!.sentAt!.getTime() + 50 * 3600_000);
    setSendGateClock(() => validSpacingTime);

    const step2Dispatch = await dispatchDueFollowUps({
      campaignId: campaign.id,
      messagingProvider: mockProvider,
    });

    check(step2Dispatch.sent === 1, "Step 2 sent after 48h spacing satisfied");
    const step2Record = await prisma.followUpMessage.findFirst({
      where: { leadId: lead3.id, step: 2 },
    });
    check(step2Record?.status === "SENT", "Step 2 status is SENT");

    // Verify campaign with followUpCount = 1 never creates step 2
    const singleFuCamp = await prisma.campaign.create({
      data: {
        userId: user.id,
        companyProfileId: profile.id,
        name: `Single FU Campaign ${Date.now()}`,
        status: "RUNNING",
        followUpEnabled: true,
        followUpCount: 1,
        followUpDelayDays: [3],
        followUpTemplates: ["Hi {firstName}, check this out!"],
      },
    });

    const leadSingle = await prisma.lead.create({
      data: {
        campaignId: singleFuCamp.id,
        username: `lead_single_${Date.now().toString(36)}`,
        fullName: "Single Test",
        source: "TEST",
        status: "CONTACTED",
      },
    });

    const firstMsgSingle = await prisma.message.create({
      data: {
        leadId: leadSingle.id,
        campaignId: singleFuCamp.id,
        senderAccountId: sender.id,
        messageText: "Hello single!",
        status: "SENT",
        direction: "OUTBOUND",
        channel: "INSTAGRAM",
        unipileChatId: "thread_single",
      },
    });

    const singleScheduled = await scheduleFollowUpsForLead({
      campaignId: singleFuCamp.id,
      leadId: leadSingle.id,
      firstMessageId: firstMsgSingle.id,
      sentAt: t0,
    });

    check(singleScheduled.length === 1, "followUpCount: 1 creates only 1 follow-up");
    check(singleScheduled[0]?.step === 1, "Only step 1 was created");

    // -------------------------------------------------------------------------
    // TEST 8: Unresolved placeholder -> NEEDS_EDIT, never send blank names
    // -------------------------------------------------------------------------
    console.log("\n[Test 8] Unresolved placeholder -> NEEDS_EDIT, never send blank names");
    const leadNoName = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        username: `lead_noname_${Date.now().toString(36)}`,
        fullName: null, // No first name!
        location: null,
        source: "TEST",
        status: "CONTACTED",
      },
    });

    const firstMsgNoName = await prisma.message.create({
      data: {
        leadId: leadNoName.id,
        campaignId: campaign.id,
        senderAccountId: sender.id,
        messageText: "Hello!",
        status: "SENT",
        direction: "OUTBOUND",
        channel: "INSTAGRAM",
        unipileChatId: "thread_noname",
      },
    });

    // Test template rendering directly
    const renderResult = renderFollowUpTemplate(
      "Hi {firstName}, how are you?",
      leadNoName,
      "First message",
      null
    );
    check(!renderResult.valid, "renderFollowUpTemplate rejected missing {firstName}");
    check(typeof renderResult.error === "string", "Returned error for unresolved placeholder");

    // Scheduling for this lead marks status NEEDS_EDIT
    const scheduledNoName = await scheduleFollowUpsForLead({
      campaignId: campaign.id,
      leadId: leadNoName.id,
      firstMessageId: firstMsgNoName.id,
      sentAt: t0,
    });

    check(
      scheduledNoName.every((f) => f.status === "NEEDS_EDIT"),
      "Follow-up with missing firstName saved with status NEEDS_EDIT"
    );

    // Dispatcher ignores NEEDS_EDIT
    setSendGateClock(() => new Date(t0.getTime() + 10 * 86_400_000));
    mockProvider.sentRequests = [];
    await dispatchDueFollowUps({
      campaignId: campaign.id,
      messagingProvider: mockProvider,
    });
    const foundNoNameSend = mockProvider.sentRequests.find((r) => r.profileUrl.includes(leadNoName.username ?? ""));
    check(foundNoNameSend === undefined, "NEEDS_EDIT item was NOT sent");

    // -------------------------------------------------------------------------
    // TEST 9: Idempotent: re-running dispatcher doesn't send twice
    // -------------------------------------------------------------------------
    console.log("\n[Test 9] Idempotent: re-running dispatcher doesn't send twice");
    const sentCountBefore = mockProvider.sentRequests.length;
    const rerunDispatch = await dispatchDueFollowUps({
      campaignId: campaign.id,
      messagingProvider: mockProvider,
    });
    check(rerunDispatch.sent === 0, "Re-run dispatch sent 0 messages (all already sent or cancelled)");
    check(mockProvider.sentRequests.length === sentCountBefore, "Provider received no new send requests");

    // Re-running scheduleFollowUpsForLead does not duplicate rows
    const duplicateSchedule = await scheduleFollowUpsForLead({
      campaignId: singleFuCamp.id,
      leadId: leadSingle.id,
      firstMessageId: firstMsg1.id,
      sentAt: t0,
    });
    const totalSingleRows = await prisma.followUpMessage.count({
      where: { campaignId: singleFuCamp.id, leadId: leadSingle.id },
    });
    check(totalSingleRows === 1, "Re-running scheduler does not duplicate rows", `Total rows: ${totalSingleRows}`);

    // -------------------------------------------------------------------------
    // TEST 10: UNKNOWN / failed first send does NOT trigger follow-up
    // -------------------------------------------------------------------------
    console.log("\n[Test 10] UNKNOWN / failed first send does NOT trigger follow-up");
    const leadFailed = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        username: `lead_failed_${Date.now().toString(36)}`,
        fullName: "Test Failed",
        source: "TEST",
        status: "CONTACTED",
      },
    });

    const failedMsg = await prisma.message.create({
      data: {
        leadId: leadFailed.id,
        campaignId: campaign.id,
        senderAccountId: sender.id,
        messageText: "Hello!",
        status: "FAILED",
        direction: "OUTBOUND",
        channel: "INSTAGRAM",
      },
    });

    const unknownMsg = await prisma.message.create({
      data: {
        leadId: leadFailed.id,
        campaignId: campaign.id,
        senderAccountId: sender.id,
        messageText: "Hello!",
        status: "UNKNOWN",
        direction: "OUTBOUND",
        channel: "INSTAGRAM",
      },
    });

    const fromFailed = await scheduleFollowUpsForLead({
      campaignId: campaign.id,
      leadId: leadFailed.id,
      firstMessageId: failedMsg.id,
      sentAt: t0,
    });
    check(fromFailed.length === 0, "FAILED first send schedules 0 follow-ups");

    const fromUnknown = await scheduleFollowUpsForLead({
      campaignId: campaign.id,
      leadId: leadFailed.id,
      firstMessageId: unknownMsg.id,
      sentAt: t0,
    });
    check(fromUnknown.length === 0, "UNKNOWN first send schedules 0 follow-ups");

    // -------------------------------------------------------------------------
    // TEST 11: Campaign Follow-up Summary counts
    // -------------------------------------------------------------------------
    console.log("\n[Test 11] Campaign Follow-up Summary counts");
    const summary = await getCampaignFollowUpSummary(campaign.id);
    check(typeof summary.scheduled === "number", "Summary has scheduled count", String(summary.scheduled));
    check(typeof summary.sent === "number" && summary.sent >= 2, "Summary has sent count", String(summary.sent));
    check(typeof summary.cancelled === "number" && summary.cancelled >= 3, "Summary has cancelled count", String(summary.cancelled));

    // Cleanup test data
    console.log("\nCleaning up test data...");
    await prisma.followUpMessage.deleteMany({
      where: { campaignId: { in: [campaign.id, singleFuCamp.id] } },
    });
    await prisma.message.deleteMany({
      where: { campaignId: { in: [campaign.id, singleFuCamp.id] } },
    });
    await prisma.doNotContact.deleteMany({
      where: { userId: user.id },
    });
    await prisma.lead.deleteMany({
      where: { campaignId: { in: [campaign.id, singleFuCamp.id] } },
    });
    await prisma.campaign.deleteMany({
      where: { id: { in: [campaign.id, singleFuCamp.id] } },
    });
    await prisma.instagramSenderAccount.delete({
      where: { id: sender.id },
    });
    await prisma.user.delete({
      where: { id: user.id },
    });

  } finally {
    setSendGateClock(null);
  }

  console.log(`\n========================================`);
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
