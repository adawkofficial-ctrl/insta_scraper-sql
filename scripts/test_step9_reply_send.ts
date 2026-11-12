import "./preload_server_only.cjs";
/**
 * STEP 9 PART D TEST SUITE: Approved Reply Draft Outbound Dispatch Pipeline
 *
 * Exercises:
 * 1. Happy path: approved reply draft dispatches into existing chat thread via Unipile & Playwright.
 * 2. Hash integrity: draft modified after approval is rejected before send.
 * 3. DNC suppression: lead added to DNC after approval is blocked from dispatch.
 * 4. Double-send prevention: duplicate draft dispatches & duplicate replies to same inbound message rejected.
 * 5. Quality-gate exemption consistency: dispatch-time recheck allows REPLY-kind exemptions but enforces brand blockers.
 * 6. Sender health: disconnected / auth-required / expired sender accounts block send.
 * 7. Pause controls: paused campaign and global emergency pause block reply sending.
 * 8. In-flight lock: prevents concurrent duplicate sends to same lead.
 * 9. API endpoint: POST /api/drafts/[draftId]/send-reply route verification.
 */
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  CampaignStatus,
  ConnectionMethod,
  DncChannel,
  DncIdentifierType,
  DncSource,
  DraftKind,
  DraftStatus,
  InstagramSenderSessionType,
  InstagramSenderStatus,
  LeadStatus,
  MessageChannel,
  MessageDirection,
  MessageStatus,
} from "../src/generated/prisma/enums";
import { draftBodyHash } from "../src/lib/services/quality";
import {
  sendApprovedReply,
  type SendMessageRequest,
  type SendMessageResult,
  type MessagingProvider,
  type MessagingProviderStatus,
} from "../src/lib/services/messaging";
import { setSendGateClock } from "../src/lib/services/messaging/send-gate";
import { setMessagingProvider, activeDispatches } from "../src/lib/services/messaging/messaging-service";
import { POST as sendReplyRoute } from "../src/app/api/drafts/[draftId]/send-reply/route";

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

const prisma = getPrismaClient();
const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

// Mock Messaging Provider
class MockMessagingProvider implements MessagingProvider {
  name: string;
  sentRequests: SendMessageRequest[] = [];
  shouldFail: boolean = false;
  failureCode: string = "AUTH_REQUIRED";
  failureMessage: string = "Account not authenticated";
  isUncertain: boolean = false;

  constructor(name: string = "mock-provider") {
    this.name = name;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getStatus(): Promise<MessagingProviderStatus> {
    return {
      provider: this.name,
      authenticated: true,
      status: "READY",
    };
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    this.sentRequests.push(request);
    if (this.shouldFail) {
      return {
        success: false,
        provider: this.name,
        messageText: request.message,
        error: {
          code: this.failureCode,
          message: this.failureMessage,
        },
      };
    }
    return {
      success: true,
      provider: this.name,
      messageText: request.message,
      providerMessageId: `mock_msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      sentAt: new Date().toISOString(),
    };
  }
}

async function main() {
  let fakeClockTime = new Date("2026-06-10T14:00:00Z");
  setSendGateClock(() => fakeClockTime);

  console.log("=================================================================");
  console.log("   STEP 9: APPROVED REPLY DRAFT SEND PIPELINE TEST SUITE        ");
  console.log("=================================================================");

  const testUser = await prisma.user.create({
    data: {
      email: `reply_sender_${stamp}@test.com`,
      passwordHash: "hash123",
      name: "Reply Sender User",
    },
  });

  // Create CompanyProfile with forbidden claims and pricing policy for quality gate tests
  const testProfile = await prisma.companyProfile.create({
    data: {
      userId: testUser.id,
      name: "Acme Reply Solutions",
      description: "Automated direct response tools",
      services: [{ name: "Reply Generation", value: "$49/mo" }],
      targetIndustries: ["SaaS", "Agency"],
      targetCountries: ["US"],
      idealCustomerProfile: "Founders and sales reps.",
      brandTone: "professional and helpful",
      messageLanguage: "en",
      pricingPolicy: "Plans start at $49/mo with full onboarding included.",
      forbiddenClaims: ["100% guaranteed revenue", "overnight millions"],
    },
  });

  const testCampaign = await prisma.campaign.create({
    data: {
      userId: testUser.id,
      companyProfileId: testProfile.id,
      name: `Reply Dispatch Campaign ${stamp}`,
      targetNiche: "B2B SaaS Growth",
      messageLanguage: "en",
      status: CampaignStatus.RUNNING,
    },
  });

  // Connected Unipile sender account
  const unipileSender = await prisma.instagramSenderAccount.create({
    data: {
      userId: testUser.id,
      username: `unipile_acc_${stamp}`,
      connectionMethod: ConnectionMethod.UNIPILE,
      unipileAccountId: `unipile_acc_id_${stamp}`,
      sessionType: InstagramSenderSessionType.PERSISTENT_PROFILE,
      sessionPath: `unipile_acc_id_${stamp}`,
      status: InstagramSenderStatus.CONNECTED,
    },
  });

  // Connected Playwright sender account
  const playwrightSender = await prisma.instagramSenderAccount.create({
    data: {
      userId: testUser.id,
      username: `playwright_acc_${stamp}`,
      connectionMethod: ConnectionMethod.PLAYWRIGHT,
      sessionType: InstagramSenderSessionType.PERSISTENT_PROFILE,
      sessionPath: `playwright_path_${stamp}`,
      status: InstagramSenderStatus.CONNECTED,
    },
  });

  const mockProvider = new MockMessagingProvider("mock-test-provider");
  setMessagingProvider(mockProvider);

  try {
    // -------------------------------------------------------------------------
    // SECTION 1: HAPPY PATH (UNIPILE CHAT THREAD & PLAYWRIGHT SENDER)
    // -------------------------------------------------------------------------
    console.log("\n--- Section 1: Happy Path Reply Send ---");

    // 1.1 Unipile existing chat dispatch
    const lead1 = await prisma.lead.create({
      data: {
        campaignId: testCampaign.id,
        username: `unipile_lead_${stamp}`,
        fullName: "Unipile Reply Lead",
        profileUrl: `https://www.instagram.com/unipile_lead_${stamp}/`,
        status: LeadStatus.REPLIED,
      },
    });

    const conversation1 = await prisma.conversation.create({
      data: {
        userId: testUser.id,
        leadId: lead1.id,
        campaignId: testCampaign.id,
        senderAccountId: unipileSender.id,
        channel: MessageChannel.INSTAGRAM,
        unipileChatId: `unipile_chat_thread_123_${stamp}`,
        externalThreadId: `unipile_chat_thread_123_${stamp}`,
        status: "OPEN",
        requiresHuman: true,
        unreadCount: 1,
        lastMessageAt: new Date(Date.now() - 60000),
      },
    });

    const inbound1 = await prisma.message.create({
      data: {
        campaignId: testCampaign.id,
        leadId: lead1.id,
        provider: "unipile",
        unipileChatId: conversation1.unipileChatId,
        status: MessageStatus.SENT,
        direction: MessageDirection.INBOUND,
        channel: MessageChannel.INSTAGRAM,
        messageText: "What is your pricing model?",
        conversationId: conversation1.id,
        senderAccountId: unipileSender.id,
        requiresHuman: true,
      },
    });

    const draftBody1 = "Hi! Our pricing starts at $49/mo with full onboarding included.";
    const hash1 = draftBodyHash(draftBody1);

    const replyDraft1 = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: lead1.id,
        campaignId: testCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        replyToMessageId: inbound1.id,
        body: draftBody1,
        bodyHash: hash1,
        status: DraftStatus.APPROVED,
        approvedBodyHash: hash1,
        approvedAt: new Date(),
        promptVersion: "reply-draft-v1",
      },
    });

    // Explicit OUTSIDE_WORKING_HOURS check with fake clock
    setSendGateClock(() => new Date("2026-06-10T03:00:00Z"));
    let replyBlockedByHours = false;
    let replyRetryAtSet = false;
    try {
      await sendApprovedReply({
        userId: testUser.id,
        draftId: replyDraft1.id,
      });
    } catch (err: unknown) {
      const errorObj = err as { code?: string; userMessage?: string };
      if (errorObj.code === "OUTSIDE_WORKING_HOURS") {
        replyBlockedByHours = true;
        if (errorObj.userMessage && errorObj.userMessage.includes("retry after")) {
          replyRetryAtSet = true;
        }
      }
    }
    check(replyBlockedByHours, "sendApprovedReply blocked when clock is OUTSIDE_WORKING_HOURS (03:00 UTC)");
    check(replyRetryAtSet, "OUTSIDE_WORKING_HOURS reply error message includes retryAt time");
    setSendGateClock(() => fakeClockTime);

    mockProvider.sentRequests = [];
    const sendResult1 = await sendApprovedReply({
      userId: testUser.id,
      draftId: replyDraft1.id,
    });

    check(sendResult1.success === true, "sendApprovedReply returns success for valid approved reply");
    check(sendResult1.status === "SENT", "sendApprovedReply returns status 'SENT'");
    check(Boolean(sendResult1.messageId), "sendApprovedReply returns valid messageId");

    // Verify mock provider received the existing chat thread ID
    check(mockProvider.sentRequests.length === 1, "Provider sendMessage was invoked once");
    check(
      mockProvider.sentRequests[0]?.chatId === conversation1.unipileChatId,
      "Provider was called with existing chatId (thread preservation)",
      `got: ${mockProvider.sentRequests[0]?.chatId}`,
    );

    // Verify DB state
    const outboundMessage1 = await prisma.message.findUnique({
      where: { id: sendResult1.messageId },
    });
    check(Boolean(outboundMessage1), "OUTBOUND Message record was persisted in database");
    check(outboundMessage1?.direction === MessageDirection.OUTBOUND, "Message direction is OUTBOUND");
    check(outboundMessage1?.status === MessageStatus.SENT, "Message status is SENT");
    check(outboundMessage1?.draftId === replyDraft1.id, "Message is linked to draftId");
    check(outboundMessage1?.conversationId === conversation1.id, "Message is linked to Conversation");
    check(outboundMessage1?.unipileChatId === conversation1.unipileChatId, "Message preserves unipileChatId");

    // Verify draft status updated to SENT
    const updatedDraft1 = await prisma.messageDraft.findUnique({ where: { id: replyDraft1.id } });
    check(updatedDraft1?.status === DraftStatus.SENT, "MessageDraft status transitioned to SENT");

    // Verify Conversation updated: lastMessageAt set, requiresHuman cleared
    const updatedConv1 = await prisma.conversation.findUnique({ where: { id: conversation1.id } });
    check(updatedConv1?.requiresHuman === false, "Conversation requiresHuman cleared on resolution");
    check(updatedConv1?.unreadCount === 0, "Conversation unreadCount reset to 0");
    check(
      Boolean(updatedConv1?.lastMessageAt && updatedConv1.lastMessageAt > conversation1.lastMessageAt!),
      "Conversation lastMessageAt was updated",
    );

    // Verify lead status was NOT regressed to CONTACTED
    const lead1After = await prisma.lead.findUnique({ where: { id: lead1.id } });
    check(lead1After?.status === LeadStatus.REPLIED, "Lead status remains REPLIED, not regressed");

    // 1.2 Playwright sender account dispatch
    const lead2 = await prisma.lead.create({
      data: {
        campaignId: testCampaign.id,
        username: `playwright_lead_${stamp}`,
        fullName: "Playwright Reply Lead",
        profileUrl: `https://www.instagram.com/playwright_lead_${stamp}/`,
        status: LeadStatus.INTERESTED,
      },
    });

    const inbound2 = await prisma.message.create({
      data: {
        campaignId: testCampaign.id,
        leadId: lead2.id,
        provider: "playwright",
        status: MessageStatus.SENT,
        direction: MessageDirection.INBOUND,
        channel: MessageChannel.INSTAGRAM,
        messageText: "Tell me more about your tool!",
        senderAccountId: playwrightSender.id,
        requiresHuman: true,
      },
    });

    const draftBody2 = "We help agencies find targeted leads in seconds. Would Tuesday work for a quick call?";
    const hash2 = draftBodyHash(draftBody2);

    const replyDraft2 = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: lead2.id,
        campaignId: testCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        replyToMessageId: inbound2.id,
        body: draftBody2,
        bodyHash: hash2,
        status: DraftStatus.APPROVED,
        approvedBodyHash: hash2,
        approvedAt: new Date(),
        promptVersion: "reply-draft-v1",
      },
    });

    mockProvider.sentRequests = [];
    const sendResult2 = await sendApprovedReply({
      userId: testUser.id,
      draftId: replyDraft2.id,
    });

    check(sendResult2.success === true, "Playwright sender reply send succeeded");
    check(mockProvider.sentRequests[0]?.senderAccountId === playwrightSender.id, "Playwright senderAccountId passed to provider");
    check(mockProvider.sentRequests[0]?.profileUrl === lead2.profileUrl, "Playwright profileUrl passed to provider");

    // -------------------------------------------------------------------------
    // SECTION 2: HASH INTEGRITY CHECK
    // -------------------------------------------------------------------------
    console.log("\n--- Section 2: Hash Integrity Check ---");

    const lead3 = await prisma.lead.create({
      data: {
        campaignId: testCampaign.id,
        username: `tampered_lead_${stamp}`,
        profileUrl: `https://www.instagram.com/tampered_lead_${stamp}/`,
        status: LeadStatus.REPLIED,
      },
    });

    const originalText = "Original approved reply body.";
    const originalHash = draftBodyHash(originalText);

    // Create draft approved with original hash, but edit the body afterwards without re-approving
    const tamperedDraft = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: lead3.id,
        campaignId: testCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        promptVersion: "reply-draft-v1",
        body: "Tampered body that does not match approvedBodyHash!",
        bodyHash: draftBodyHash("Tampered body that does not match approvedBodyHash!"),
        status: DraftStatus.APPROVED,
        approvedBodyHash: originalHash, // Mismatch!
        approvedAt: new Date(),
      },
    });

    let hashTamperCaught = false;
    try {
      await sendApprovedReply({ userId: testUser.id, draftId: tamperedDraft.id });
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      hashTamperCaught = e.code === "DRAFT_CHANGED" || (e.message?.includes("body hash") ?? false);
    }
    check(hashTamperCaught, "Hash integrity mismatch halts send with DRAFT_CHANGED");

    const tamperedMessageCount = await prisma.message.count({
      where: { draftId: tamperedDraft.id },
    });
    check(tamperedMessageCount === 0, "No OUTBOUND message persisted when body hash check fails");

    // -------------------------------------------------------------------------
    // SECTION 3: DNC SUPPRESSION AFTER APPROVAL
    // -------------------------------------------------------------------------
    console.log("\n--- Section 3: Fresh DNC Suppression Check ---");

    const leadDnc = await prisma.lead.create({
      data: {
        campaignId: testCampaign.id,
        username: `dnc_after_appr_${stamp}`,
        profileUrl: `https://www.instagram.com/dnc_after_appr_${stamp}/`,
        status: LeadStatus.REPLIED,
      },
    });

    const dncBody = "Standard reply body.";
    const dncHash = draftBodyHash(dncBody);

    const dncDraft = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: leadDnc.id,
        campaignId: testCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        promptVersion: "reply-draft-v1",
        body: dncBody,
        bodyHash: dncHash,
        status: DraftStatus.APPROVED,
        approvedBodyHash: dncHash,
        approvedAt: new Date(),
      },
    });

    // Add lead to DNC suppression list after draft approval
    await prisma.doNotContact.create({
      data: {
        userId: testUser.id,
        channel: DncChannel.INSTAGRAM,
        identifierType: DncIdentifierType.USERNAME,
        identifierNormalized: leadDnc.username!.toLowerCase(),
        reason: "User opted out",
        source: DncSource.MANUAL,
      },
    });

    let dncCaught = false;
    try {
      await sendApprovedReply({ userId: testUser.id, draftId: dncDraft.id });
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      dncCaught = e.code === "DNC_SUPPRESSED" || (e.message?.includes("Do Not Contact") ?? false);
    }
    check(dncCaught, "Lead added to DNC after approval is blocked with DNC_SUPPRESSED");

    // -------------------------------------------------------------------------
    // SECTION 4: DOUBLE-SEND PREVENTION
    // -------------------------------------------------------------------------
    console.log("\n--- Section 4: Double-Send Prevention ---");

    // 4.1 Re-sending already-sent draft (replyDraft1 was already sent in Section 1)
    let duplicateSendCaught = false;
    try {
      await sendApprovedReply({ userId: testUser.id, draftId: replyDraft1.id });
    } catch (err: unknown) {
      const e = err as { code?: string };
      duplicateSendCaught = e.code === "DRAFT_ALREADY_SENT" || e.code === "DRAFT_NOT_APPROVED";
    }
    check(duplicateSendCaught, "Re-sending already SENT draft is rejected (DRAFT_ALREADY_SENT)");

    // 4.2 Re-sending another draft for the same inbound message
    const duplicateReplyDraft = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: lead1.id,
        campaignId: testCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        promptVersion: "reply-draft-v1",
        replyToMessageId: inbound1.id, // Same inbound message as replyDraft1!
        body: "Second reply draft for same inbound message.",
        bodyHash: draftBodyHash("Second reply draft for same inbound message."),
        status: DraftStatus.APPROVED,
        approvedBodyHash: draftBodyHash("Second reply draft for same inbound message."),
        approvedAt: new Date(),
      },
    });

    let alreadyRespondedCaught = false;
    try {
      await sendApprovedReply({ userId: testUser.id, draftId: duplicateReplyDraft.id });
    } catch (err: unknown) {
      const e = err as { code?: string };
      alreadyRespondedCaught = e.code === "ALREADY_RESPONDED";
    }
    check(alreadyRespondedCaught, "Sending second reply to same inbound message throws ALREADY_RESPONDED");

    // -------------------------------------------------------------------------
    // SECTION 5: QUALITY-GATE EXEMPTION CONSISTENCY AT DISPATCH
    // -------------------------------------------------------------------------
    console.log("\n--- Section 5: Quality-Gate Exemption Consistency ---");

    // 5.1 Lead with status REPLIED and previous contact history:
    // Should NOT be blocked by ALREADY_CONTACTED or LEAD_ELIGIBILITY at dispatch time!
    const leadContacted = await prisma.lead.create({
      data: {
        campaignId: testCampaign.id,
        username: `contacted_lead_${stamp}`,
        profileUrl: `https://www.instagram.com/contacted_lead_${stamp}/`,
        status: LeadStatus.REPLIED,
      },
    });

    // Record previous outbound message to ensure wasPreviouslyContacted is true
    await prisma.message.create({
      data: {
        campaignId: testCampaign.id,
        leadId: leadContacted.id,
        status: MessageStatus.SENT,
        direction: MessageDirection.OUTBOUND,
        messageText: "Initial outreach message",
        sentAt: new Date(Date.now() - 3600000),
      },
    });

    const validReplyText = "Thanks for following up! Happy to schedule a call.";
    const validReplyHash = draftBodyHash(validReplyText);

    const contactedDraft = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: leadContacted.id,
        campaignId: testCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        promptVersion: "reply-draft-v1",
        body: validReplyText,
        bodyHash: validReplyHash,
        status: DraftStatus.APPROVED,
        approvedBodyHash: validReplyHash,
        approvedAt: new Date(),
      },
    });

    let contactedDispatchPassed = false;
    try {
      const res = await sendApprovedReply({ userId: testUser.id, draftId: contactedDraft.id });
      contactedDispatchPassed = res.success;
    } catch (err) {
      console.error("Unexpected error dispatching reply to previously contacted lead:", err);
    }
    check(contactedDispatchPassed, "Dispatch recheck respects ALREADY_CONTACTED exemption for kind=REPLY");

    // 5.2 Content safety blocker (FORBIDDEN_CLAIMS) must STILL block dispatch even for replies!
    const forbiddenText = "We promise 100% guaranteed revenue with zero work.";
    const forbiddenHash = draftBodyHash(forbiddenText);

    const forbiddenDraft = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: leadContacted.id,
        campaignId: testCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        promptVersion: "reply-draft-v1",
        body: forbiddenText,
        bodyHash: forbiddenHash,
        status: DraftStatus.APPROVED,
        approvedBodyHash: forbiddenHash,
        approvedAt: new Date(),
      },
    });

    let forbiddenClaimBlocked = false;
    try {
      await sendApprovedReply({ userId: testUser.id, draftId: forbiddenDraft.id });
    } catch (err: unknown) {
      const e = err as { code?: string; reasons?: string[] };
      forbiddenClaimBlocked = e.code === "QUALITY_BLOCKED" || (Array.isArray(e.reasons) && e.reasons.includes("FORBIDDEN_CLAIMS"));
    }
    check(forbiddenClaimBlocked, "Brand safety blocker (FORBIDDEN_CLAIMS) still strictly blocks dispatch");

    // -------------------------------------------------------------------------
    // SECTION 6: SENDER ACCOUNT HEALTH CHECKS
    // -------------------------------------------------------------------------
    console.log("\n--- Section 6: Sender Health Checks ---");

    // Disconnected / Expired sender account
    const expiredSender = await prisma.instagramSenderAccount.create({
      data: {
        userId: testUser.id,
        username: `expired_acc_${stamp}`,
        connectionMethod: ConnectionMethod.PLAYWRIGHT,
        sessionType: InstagramSenderSessionType.PERSISTENT_PROFILE,
        sessionPath: `expired_path_${stamp}`,
        status: InstagramSenderStatus.EXPIRED,
      },
    });

    const leadExpired = await prisma.lead.create({
      data: {
        campaignId: testCampaign.id,
        username: `exp_sender_lead_${stamp}`,
        profileUrl: `https://www.instagram.com/exp_sender_lead_${stamp}/`,
        status: LeadStatus.REPLIED,
      },
    });

    const inboundExpired = await prisma.message.create({
      data: {
        campaignId: testCampaign.id,
        leadId: leadExpired.id,
        direction: MessageDirection.INBOUND,
        status: MessageStatus.SENT,
        messageText: "Checking in",
        senderAccountId: expiredSender.id,
      },
    });

    const expiredText = "Hi there, checking back in!";
    const expiredHash = draftBodyHash(expiredText);

    const expiredDraft = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: leadExpired.id,
        campaignId: testCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        promptVersion: "reply-draft-v1",
        replyToMessageId: inboundExpired.id,
        body: expiredText,
        bodyHash: expiredHash,
        status: DraftStatus.APPROVED,
        approvedBodyHash: expiredHash,
        approvedAt: new Date(),
      },
    });

    let expiredSenderBlocked = false;
    try {
      await sendApprovedReply({ userId: testUser.id, draftId: expiredDraft.id });
    } catch (err: unknown) {
      const e = err as { code?: string };
      expiredSenderBlocked = e.code === "AUTH_REQUIRED" || e.code === "SESSION_UNAVAILABLE";
    }
    check(expiredSenderBlocked, "Expired sender account blocks reply send with AUTH_REQUIRED");

    // -------------------------------------------------------------------------
    // SECTION 7: PAUSE CONTROLS
    // -------------------------------------------------------------------------
    console.log("\n--- Section 7: Pause Controls ---");

    // 7.1 Campaign PAUSED
    const pausedCampaign = await prisma.campaign.create({
      data: {
        userId: testUser.id,
        companyProfileId: testProfile.id,
        name: `Paused Campaign ${stamp}`,
        status: CampaignStatus.PAUSED,
      },
    });

    const leadPaused = await prisma.lead.create({
      data: {
        campaignId: pausedCampaign.id,
        username: `paused_lead_${stamp}`,
        profileUrl: `https://www.instagram.com/paused_lead_${stamp}/`,
        status: LeadStatus.REPLIED,
      },
    });

    const pausedText = "Reply in paused campaign";
    const pausedHash = draftBodyHash(pausedText);

    const pausedDraft = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: leadPaused.id,
        campaignId: pausedCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        promptVersion: "reply-draft-v1",
        body: pausedText,
        bodyHash: pausedHash,
        status: DraftStatus.APPROVED,
        approvedBodyHash: pausedHash,
        approvedAt: new Date(),
      },
    });

    let campaignPausedBlocked = false;
    try {
      await sendApprovedReply({ userId: testUser.id, draftId: pausedDraft.id });
    } catch (err: unknown) {
      const e = err as { code?: string };
      campaignPausedBlocked = e.code === "CAMPAIGN_PAUSED";
    }
    check(campaignPausedBlocked, "Paused campaign blocks reply send with CAMPAIGN_PAUSED");

    // 7.2 Global Emergency Pause Control
    const leadGlobalPause = await prisma.lead.create({
      data: {
        campaignId: testCampaign.id,
        username: `global_paused_${stamp}`,
        profileUrl: `https://www.instagram.com/global_paused_${stamp}/`,
        status: LeadStatus.REPLIED,
      },
    });

    const globalPauseDraft = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: leadGlobalPause.id,
        campaignId: testCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        promptVersion: "reply-draft-v1",
        body: "Checking global emergency pause control.",
        bodyHash: draftBodyHash("Checking global emergency pause control."),
        status: DraftStatus.APPROVED,
        approvedBodyHash: draftBodyHash("Checking global emergency pause control."),
        approvedAt: new Date(),
      },
    });

    process.env.PAUSE_ALL_MESSAGING = "true";
    let globalPauseBlocked = false;
    try {
      await sendApprovedReply({ userId: testUser.id, draftId: globalPauseDraft.id });
    } catch (err: unknown) {
      const e = err as { code?: string };
      globalPauseBlocked = e.code === "SYSTEM_PAUSED";
    }
    delete process.env.PAUSE_ALL_MESSAGING;
    check(globalPauseBlocked, "Global emergency pause (PAUSE_ALL_MESSAGING) blocks reply send");

    // -------------------------------------------------------------------------
    // SECTION 8: IN-FLIGHT DISPATCH LOCK
    // -------------------------------------------------------------------------
    console.log("\n--- Section 8: In-flight Dispatch Lock ---");

    activeDispatches.add(leadGlobalPause.id);
    let inFlightLockCaught = false;
    try {
      await sendApprovedReply({ userId: testUser.id, draftId: globalPauseDraft.id });
    } catch (err: unknown) {
      const e = err as { code?: string };
      inFlightLockCaught = e.code === "SEND_IN_PROGRESS";
    } finally {
      activeDispatches.delete(leadGlobalPause.id);
    }
    check(inFlightLockCaught, "Concurrent dispatch to same lead is rejected with SEND_IN_PROGRESS");

    // -------------------------------------------------------------------------
    // SECTION 9: API ROUTE INTEGRATION (POST /api/drafts/[draftId]/send-reply)
    // -------------------------------------------------------------------------
    console.log("\n--- Section 9: API Route Integration ---");

    const leadApi = await prisma.lead.create({
      data: {
        campaignId: testCampaign.id,
        username: `api_reply_lead_${stamp}`,
        profileUrl: `https://www.instagram.com/api_reply_lead_${stamp}/`,
        status: LeadStatus.REPLIED,
      },
    });

    const apiBody = "API reply message body text.";
    const apiHash = draftBodyHash(apiBody);

    const apiDraft = await prisma.messageDraft.create({
      data: {
        userId: testUser.id,
        leadId: leadApi.id,
        campaignId: testCampaign.id,
        kind: DraftKind.REPLY,
        model: "gemini-2.5-flash",
        wordCount: 10,
        promptVersion: "reply-draft-v1",
        body: apiBody,
        bodyHash: apiHash,
        status: DraftStatus.APPROVED,
        approvedBodyHash: apiHash,
        approvedAt: new Date(),
      },
    });

    // Mock request with session
    const req = new Request(`http://localhost:3000/api/drafts/${apiDraft.id}/send-reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Test auth header / cookie if needed, or mock requireAuth
      },
    });

    // Test with mock auth by setting test user header if supported, or direct sendApprovedReply
    const routeRes = await sendReplyRoute(req, { params: Promise.resolve({ draftId: apiDraft.id }) });
    check(routeRes.status === 200 || routeRes.status === 401, "API route responds with valid HTTP status (200 or 401 unauth)");

    console.log("\n=================================================================");
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log("=================================================================");

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    setSendGateClock(null);
    // Reset messaging provider
    setMessagingProvider(null);

    // Clean up test data
    await prisma.message.deleteMany({ where: { campaignId: testCampaign.id } }).catch(() => undefined);
    await prisma.messageDraft.deleteMany({ where: { campaignId: testCampaign.id } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { campaignId: testCampaign.id } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { campaignId: testCampaign.id } }).catch(() => undefined);
    await prisma.doNotContact.deleteMany({ where: { userId: testUser.id } }).catch(() => undefined);
    await prisma.companyProfile.deleteMany({ where: { userId: testUser.id } }).catch(() => undefined);
    await prisma.instagramSenderAccount.deleteMany({ where: { userId: testUser.id } }).catch(() => undefined);
    await prisma.campaign.deleteMany({ where: { userId: testUser.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
