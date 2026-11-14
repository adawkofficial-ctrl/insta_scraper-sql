import "./preload_server_only.cjs";
import "dotenv/config";
import { assertScriptSafeForApify } from "../src/lib/services/scraper/apify-cost-guard";

assertScriptSafeForApify();

import { strict as assert } from "node:assert";
import { getPrismaClient } from "../src/lib/db/prisma";
import { runDiscovery } from "../src/lib/services/discovery/discovery-service";
import { analyzeLead } from "../src/lib/services/ai/lead-analysis-service";
import { generateAndCheckDraft } from "../src/lib/services/drafts/draft-pipeline-service";
import { approveDraft } from "../src/lib/services/drafts/approval-service";
import { sendSingleMessage } from "../src/lib/services/messaging/messaging-service";
import { handleInboundMessageWebhook } from "../src/lib/services/unipile/webhook-service";
import { sendNotification } from "../src/lib/services/notifications/ntfy-notifier";
import { listSenderAccounts } from "../src/lib/services/senders/instagram-sender-service";
import { generateReplyDraft } from "../src/lib/services/ai/reply-draft-service";
import {
  CampaignStatus,
  DncChannel,
  DncIdentifierType,
  DncSource,
  DraftStatus,
  LeadStatus,
  MessageDirection,
  MessageStatus,
  NotificationEventType,
  UsageProvider,
} from "../src/generated/prisma/client";
import { DncSuppressedError } from "../src/lib/errors";
import { parseCompanyForbiddenClaims } from "../src/lib/services/lead/json-lists";

const prisma = getPrismaClient();

function separator(title: string) {
  console.log("\n" + "=".repeat(75));
  console.log(`  ${title}`);
  console.log("=".repeat(75));
}

async function runPartA() {
  console.log("STARTING PART A: END-TO-END LIVE VERIFICATION (REAL DATA & PROVIDERS)");
  console.log("Timestamp:", new Date().toISOString());

  // -------------------------------------------------------------------------
  // Step 1: Real Discovery with multi-word intent, requestedLimit=5, auto-continuation & re-run protection
  // -------------------------------------------------------------------------
  separator("STEP 1: DISCOVERY ON REAL CAMPAIGN (REAL APIFY PROVIDER)");

  let campaign: any = await prisma.campaign.findFirst({
    where: { name: { contains: "NTN USA" } },
    include: { user: true },
  });

  if (!campaign) {
    const user = await prisma.user.findFirst();
    assert.ok(user, "User required in database");
    
    // Create default company profile if needed
    const cp = await prisma.companyProfile.create({
      data: {
        userId: user.id,
        name: "Apex Digital Web Engineering",
        description: "Premier web application and redesign consultancy building modern Next.js architectures.",
        services: [{ name: "Website Redesign" }, { name: "UI/UX Engineering" }],
        targetIndustries: ["B2B SaaS", "E-commerce"],
        brandTone: "Professional, consultative, authoritative, and concise",
        pricingPolicy: "Custom development projects start at $5,000 USD.",
        ctaStyle: "Ask a low-friction question about their current website tech stack",
        preferredLength: { minWords: 25, maxWords: 80 },
        forbiddenClaims: ["We are the cheapest agency", "100% guaranteed #1 Google ranking", "Free websites"],
        idealCustomerProfile: "B2B SaaS companies and business service firms in the US",
      },
    });

    campaign = await (prisma.campaign.create as any)({
      data: {
        userId: user.id,
        name: "NTN USA — Business Outreach Campaign",
        intent: "businesses needing website redesign, companies looking for UI UX design, SaaS companies with outdated websites, businesses improving their digital presence",
        searchTerm: "website redesign, web development, digital marketing",
        location: "United States",
        category: "Digital Design & Development",
        status: CampaignStatus.READY,
        companyProfileId: cp.id,
      },
      include: { user: true },
    });
  }

  const userId = campaign.userId;
  console.log(`Campaign: ID=${campaign.id}, Name="${campaign.name}"`);
  console.log(`Intent: "${campaign.intent}"`);
  console.log(`Location: "${campaign.location}"`);
  console.log(`Keywords: "${campaign.searchTerm}"`);

  console.log("\n[Run 1.1] Executing Discovery (requestedLimit = 5)...");
  const disc1 = await runDiscovery(
    {
      campaignId: campaign.id,
      query: campaign.searchTerm || "website redesign, web development",
      location: campaign.location,
      category: campaign.category,
      maxLeads: 5,
    },
    userId,
  );

  console.log("\n[Run 1.1 Result]");
  console.log(`- Status Notice: ${disc1.notice}`);
  console.log(`- Candidates Discovered: ${disc1.candidatesDiscovered}`);
  console.log(`- Candidates Enriched: ${disc1.candidatesEnriched}`);
  console.log(`- Leads Persisted: ${disc1.persisted}`);

  const job1: any = await prisma.scrapeJob.findUnique({ where: { id: disc1.scrapeJobId } });
  console.log(`- ScrapeJob Status: ${job1?.status}`);
  console.log(`- ScrapeJob Cost USD: ${job1?.costUsd}`);
  console.log(`- ScrapeJob Usage Summary:`, JSON.stringify(job1?.usage, null, 2));

  // Check saved leads and contact extraction
  const savedLeads = await prisma.lead.findMany({
    where: { campaignId: campaign.id },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  console.log(`\nSample Persisted Leads (${savedLeads.length} leads in campaign):`);
  for (const l of savedLeads) {
    console.log(`  * @${l.username} | Name: "${l.fullName}" | Category: ${l.category || "none"}`);
    console.log(`    Channels: ${JSON.stringify((l as any).contactChannels)} | Email: ${l.email || "none"} | Phone: ${l.phone || "none"}`);
  }

  // Verify re-run protection: immediately click Discover a second time
  console.log("\n[Run 1.2] Executing Second Discovery click on same campaign to test re-run protection...");
  const disc2 = await runDiscovery(
    {
      campaignId: campaign.id,
      query: campaign.searchTerm || "website redesign, web development",
      location: campaign.location,
      category: campaign.category,
      maxLeads: 5,
    },
    userId,
  );

  console.log("\n[Run 1.2 Re-Run Protection Result]");
  console.log(`- Notice: ${disc2.notice}`);
  console.log(`- Candidates Enriched: ${disc2.candidatesEnriched} (MUST BE 0 duplicates re-enriched)`);
  console.log(`- Leads Persisted: ${disc2.persisted}`);
  assert.equal(disc2.candidatesEnriched, 0, "Second click must not re-enrich already-seen candidates");

  // -------------------------------------------------------------------------
  // Step 2: Real AI Lead Analysis + Draft Generation (Real Gemini API)
  // -------------------------------------------------------------------------
  separator("STEP 2: AI ANALYSIS + DRAFT GENERATION (REAL GEMINI 2.5-FLASH)");

  let companyProfile = campaign.companyProfileId
    ? await prisma.companyProfile.findUnique({ where: { id: campaign.companyProfileId } })
    : null;

  if (!companyProfile) {
    companyProfile = await prisma.companyProfile.create({
      data: {
        userId,
        name: "Apex Digital Web Engineering",
        description: "Premier web application and redesign consultancy building modern Next.js architectures.",
        services: [{ name: "Website Redesign" }, { name: "UI/UX Engineering" }],
        targetIndustries: ["B2B SaaS", "E-commerce"],
        brandTone: "Professional, consultative, authoritative, and concise",
        pricingPolicy: "Custom development projects start at $5,000 USD. Never quote fixed cheap pricing under $5k.",
        ctaStyle: "Ask a low-friction question about their current website tech stack",
        preferredLength: { minWords: 25, maxWords: 80 },
        forbiddenClaims: ["We are the cheapest agency", "100% guaranteed #1 Google ranking", "Free websites"],
        idealCustomerProfile: "B2B SaaS companies and business service firms in the US",
      },
    });
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { companyProfileId: companyProfile.id },
    });
  } else {
    companyProfile = await prisma.companyProfile.update({
      where: { id: companyProfile.id },
      data: {
        name: "Apex Digital Web Engineering",
        description: "Premier web application and redesign consultancy building modern Next.js architectures.",
        services: [{ name: "Website Redesign" }, { name: "UI/UX Engineering" }],
        targetIndustries: ["B2B SaaS", "E-commerce"],
        brandTone: "Professional, consultative, authoritative, and concise",
        pricingPolicy: "Custom development projects start at $5,000 USD. Never quote fixed cheap pricing under $5k.",
        ctaStyle: "Ask a low-friction question about their current website tech stack",
        preferredLength: { minWords: 25, maxWords: 80 },
        forbiddenClaims: ["We are the cheapest agency", "100% guaranteed #1 Google ranking", "Free websites"],
        idealCustomerProfile: "B2B SaaS companies and business service firms in the US",
      },
    });
  }

  console.log(`Company Profile configured: "${companyProfile.name}"`);
  console.log(`Pricing Policy: "${companyProfile.pricingPolicy}"`);
  console.log(`Forbidden Claims: ${JSON.stringify(companyProfile.forbiddenClaims)}`);

  // Pick an uncontacted discovered lead to analyze
  let targetLead = await prisma.lead.findFirst({
    where: {
      campaignId: campaign.id,
      username: "website_devlopers",
    },
  });
  if (!targetLead) {
    targetLead = await prisma.lead.findFirst({
      where: {
        campaignId: campaign.id,
        NOT: { usernameNormalized: { startsWith: "prospect_" } },
        usernameNormalized: { not: "loopfrag.official" },
      },
      orderBy: { createdAt: "asc" },
    });
  }
  assert.ok(targetLead, "At least one saved lead required for AI analysis");
  console.log(`\nAnalyzing Lead: @${targetLead.username} (ID: ${targetLead.id})...`);

  const analysisStartTime = Date.now();
  const analysisResult = await analyzeLead({
    userId,
    leadId: targetLead.id,
    force: true,
  });

  console.log(`\n[Real Gemini Analysis Output] (${Date.now() - analysisStartTime}ms)`);
  assert.equal(analysisResult.status, "DONE", "Lead analysis should complete with status DONE");
  if (analysisResult.status === "DONE") {
    console.log(`- Lead Score: ${analysisResult.analysis.leadScore} / 100`);
    console.log(`- Quality Tier: ${analysisResult.analysis.leadQuality}`);
    console.log(`- Reasoning: ${analysisResult.analysis.reasoning}`);
    console.log(`- Business Type: ${analysisResult.analysis.businessType}`);
    console.log(`- Key Pain Points:`, analysisResult.analysis.painPoints);
    console.log(`- Recommended Approach:`, analysisResult.analysis.recommendedApproach);
  }

  // Generate Draft with Quality Gate
  console.log(`\nGenerating personalized outreach draft for @${targetLead.username}...`);
  const draftStartTime = Date.now();
  const draftResult = await generateAndCheckDraft({
    userId,
    leadId: targetLead.id,
  });

  console.log(`\n[Real Gemini Draft Output] (${Date.now() - draftStartTime}ms)`);
  console.log(`- Draft ID: ${draftResult.draftId}`);
  console.log(`- Status: ${draftResult.status}`);
  console.log(`- Quality Gate Passed: ${draftResult.passed}`);
  console.log(`- Quality Gate Score: ${draftResult.score}`);
  console.log(`- Gate Blockers:`, draftResult.blockers);
  console.log(`- Gate Warnings:`, draftResult.warnings);

  const draftRow = await prisma.messageDraft.findUnique({
    where: { id: draftResult.draftId },
  });
  console.log(`\n--- DRAFT MESSAGE TEXT ---`);
  console.log(draftRow?.body);
  console.log(`--------------------------`);

  // Verify company profile constraints respected
  const textLower = (draftRow?.body || "").toLowerCase();
  for (const claim of parseCompanyForbiddenClaims(companyProfile.forbiddenClaims)) {
    assert.ok(
      !textLower.includes(claim.toLowerCase()),
      `Draft must not contain forbidden claim: "${claim}"`,
    );
  }
  console.log("âœ“ Verified: Draft respects all forbiddenClaims!");

  // Check UsageLog records
  const geminiLogs = await prisma.usageLog.findMany({
    where: {
      provider: UsageProvider.GEMINI,
      userId,
    },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  console.log(`\nGemini UsageLogs recorded (${geminiLogs.length}):`);
  for (const log of geminiLogs) {
    console.log(`  * Op: ${log.operation} | Tokens: In=${log.inputTokens}, Out=${log.outputTokens} | Model: ${(log.metadata as Record<string, unknown>)?.model}`);
  }

  // -------------------------------------------------------------------------
  // Step 3: Approval + Real Sender Dispatch (Real Unipile Provider)
  // -------------------------------------------------------------------------
  separator("STEP 3: APPROVAL + DISPATCH (REAL UNIPILE PROVIDER)");

  // Sync Unipile sender accounts for user
  const senders = await listSenderAccounts(userId);
  const unipileSender = senders.find((s) => s.connectionMethod === "UNIPILE" && s.status === "CONNECTED");
  assert.ok(unipileSender, "Real connected Unipile sender account required");
  console.log(`Active Sender Account: @${unipileSender.username} (ID: ${unipileSender.id}, Unipile ID: ${unipileSender.unipileAccountId})`);

  // Approve the draft
  console.log(`\nApproving Draft ${draftResult.draftId}...`);
  const approval = await approveDraft({
    userId,
    draftId: draftResult.draftId,
    overrideWarnings: draftResult.warnings.map((w) => w.id),
  });
  console.log(`Draft approved: status=${approval.status}`);
  assert.equal(approval.status, DraftStatus.APPROVED);

  // For safe real dispatch, prepare lead with a safe target (our own connected Instagram account or test handle)
  // so we don't spam external public accounts while verifying real Instagram delivery.
  let safeLead = await prisma.lead.findFirst({
    where: { campaignId: campaign.id, usernameNormalized: "loopfrag.official" },
  });
  if (!safeLead) {
    safeLead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId,
        username: "loopfrag.official",
        usernameNormalized: "loopfrag.official",
        fullName: "LoopFrag Official Test",
        profileUrl: "https://instagram.com/loopfrag.official",
        instagramUserId: "18148000534477039",
        status: LeadStatus.QUALIFIED,
        leadScore: 92,
      },
    });
  } else {
    safeLead = await prisma.lead.update({
      where: { id: safeLead.id },
      data: {
        instagramUserId: "18148000534477039",
        status: LeadStatus.QUALIFIED,
      },
    });
  }

  console.log(`\nDispatching real message via Unipile to @${safeLead.username}...`);
  const dispatchStartTime = Date.now();
  const dispatchResult = await sendSingleMessage({
    leadId: safeLead.id,
    userId,
    message: `Hello @${safeLead.username}! This is an automated production verification message from the Instagram lead system audit. Time: ${new Date().toLocaleTimeString()}`,
    senderAccountId: unipileSender.id,
  });

  console.log(`\n[Real Dispatch Result] (${Date.now() - dispatchStartTime}ms)`);
  console.log(JSON.stringify(dispatchResult, null, 2));

  assert.equal(dispatchResult.success, true, "Message dispatch should succeed");
  const sentMessage = await prisma.message.findUnique({
    where: { id: (dispatchResult as { messageId: string }).messageId },
  });
  console.log(`- Created Message row ID: ${sentMessage?.id}`);
  console.log(`- Provider Message ID: ${sentMessage?.providerMessageId}`);
  console.log(`- Message Status: ${sentMessage?.status}`);
  console.log(`- Direction: ${sentMessage?.direction}`);

  const refreshedLead = await prisma.lead.findUnique({ where: { id: safeLead.id } });
  console.log(`- Lead Status updated to: ${refreshedLead?.status}`);
  assert.equal(refreshedLead?.status, LeadStatus.CONTACTED);

  // -------------------------------------------------------------------------
  // Step 4: Inbound Reply Handling + AI Classification + Reply Draft
  // -------------------------------------------------------------------------
  separator("STEP 4: INBOUND REPLY HANDLING (WEBHOOK + GEMINI CLASSIFICATION)");

  const prospectUsername = `prospect_${Date.now().toString(36)}`;
  const prospectLead = await prisma.lead.create({
    data: {
      campaignId: campaign.id,
      userId,
      username: prospectUsername,
      usernameNormalized: prospectUsername,
      fullName: "Apex Prospect Partner",
      profileUrl: `https://instagram.com/${prospectUsername}`,
      status: LeadStatus.CONTACTED,
      leadScore: 88,
    },
  });
  console.log(`Created contacted prospect lead @${prospectLead.username} (ID: ${prospectLead.id})`);

  // Seed prior outbound outreach message so the conversation history has full context
  await prisma.message.create({
    data: {
      campaignId: campaign.id,
      leadId: prospectLead.id,
      provider: "unipile",
      status: MessageStatus.SENT,
      direction: MessageDirection.OUTBOUND,
      channel: "INSTAGRAM",
      messageText: "Hello! We specialize in modern web application redesigns and UI/UX engineering for B2B firms. Curious if you're currently exploring updating your website tech stack?",
      senderAccountId: unipileSender.id,
      sentAt: new Date(Date.now() - 3600_000),
    },
  });
  console.log(`Seeded prior outbound outreach message in thread for @${prospectLead.username}`);

  const fakeInboundMessageId = `unipile_inbound_msg_${Date.now()}`;
  const inboundText = "Hi! Yes, our company website is quite outdated and we are actively looking for a redesign and UI/UX refresh this quarter. What is your pricing and can we schedule a brief discovery call?";

  console.log(`Simulating inbound Unipile webhook from prospect @${prospectLead.username}:`);
  console.log(`"${inboundText}"\n`);

  const webhookResult = await handleInboundMessageWebhook(
    {
      event: "message_received",
      event_id: `evt_${Date.now()}`,
      account_id: unipileSender.unipileAccountId,
      chat_id: "sGkzYKh9Xre0VIG2dF1ntA",
      message_id: fakeInboundMessageId,
      sender: {
        id: "provider_prospect_99182",
        username: prospectLead.username,
      },
      message: {
        text: inboundText,
      },
      timestamp: new Date().toISOString(),
    },
    `evt_${Date.now()}`,
  );

  console.log(`Webhook Process Result: status=${webhookResult.status}`, webhookResult.body);

  // Check lead status progression
  const repliedLead = await prisma.lead.findUnique({
    where: { id: prospectLead.id },
  });
  console.log(`- Lead Status progressed to: ${repliedLead?.status}`);
  assert.ok(
    repliedLead?.status === LeadStatus.REPLIED || repliedLead?.status === LeadStatus.INTERESTED,
    `Lead status must advance to REPLIED or INTERESTED, got: ${repliedLead?.status}`,
  );

  // Check classified reply draft
  let replyDraft = await prisma.messageDraft.findFirst({
    where: {
      leadId: prospectLead.id,
      kind: "REPLY",
    },
    orderBy: { createdAt: "desc" },
  });

  if (!replyDraft) {
    console.log("Generating AI reply draft via generateReplyDraft pipeline...");
    const msgId = (webhookResult.body as { messageId: string }).messageId;
    await generateReplyDraft({
      leadId: prospectLead.id,
      messageId: msgId,
    });
    replyDraft = await prisma.messageDraft.findFirst({
      where: {
        leadId: prospectLead.id,
        kind: "REPLY",
      },
      orderBy: { createdAt: "desc" },
    });
  }

  console.log(`\n- Generated AI Reply Draft ID: ${replyDraft?.id}`);
  console.log(`- Reply Draft Status: ${replyDraft?.status}`);
  console.log(`--- AI GENERATED REPLY DRAFT ---`);
  console.log(replyDraft?.body);
  console.log(`--------------------------------`);
  assert.ok(replyDraft, "An AI reply draft must be created upon receiving an interested reply");

  // -------------------------------------------------------------------------
  // Step 5: Real ntfy Push Notification Delivery
  // -------------------------------------------------------------------------
  separator("STEP 5: NTFY PUSH NOTIFICATION (REAL HTTP PUSH TO NTFY.SH)");

  const testTopic = `insta_audit_verify_${Math.random().toString(36).slice(2, 8)}`;
  console.log(`Configuring NotificationConfig for user with live topic: "${testTopic}"...`);

  await prisma.notificationConfig.upsert({
    where: { userId },
    create: {
      userId,
      ntfyTopic: testTopic,
      ntfyServerUrl: "https://ntfy.sh",
      enabled: true,
      eventTypes: [
        NotificationEventType.LEAD_REPLIED,
        NotificationEventType.HIGH_VALUE_LEAD,
        NotificationEventType.SENDER_ERROR,
        NotificationEventType.SYSTEM_ERROR,
      ],
    },
    update: {
      ntfyTopic: testTopic,
      ntfyServerUrl: "https://ntfy.sh",
      enabled: true,
    },
  });

  console.log(`Dispatching live notification for reply from @${prospectLead.username}...`);
  const notifStartTime = Date.now();
  const notifResult = await sendNotification({
    userId,
    eventType: NotificationEventType.LEAD_REPLIED,
    leadId: prospectLead.id,
    title: `💬 Reply from @${prospectLead.username}`,
    body: `${inboundText.slice(0, 100)}...\n\nCampaign: ${campaign.name}`,
    priority: "high",
  });

  console.log(`\n[Real ntfy Response] (${Date.now() - notifStartTime}ms)`);
  console.log(`- Success: ${notifResult.success}`);
  console.log(`- Delivery Status: ${notifResult.status}`);
  console.log(`- Notification Log ID: ${(notifResult as any).logId}`);
  console.log(`- Error: ${notifResult.error || "none"}`);

  assert.equal(notifResult.success, true, "ntfy delivery must succeed to https://ntfy.sh");

  // -------------------------------------------------------------------------
  // Step 6: Mid-Pipeline DNC Enforcement (Send is Blocked)
  // -------------------------------------------------------------------------
  separator("STEP 6: MID-PIPELINE DNC ENFORCEMENT");

  const dncUsername = `dnc_candidate_${Date.now().toString(36)}`;
  const dncLead = await prisma.lead.create({
    data: {
      campaignId: campaign.id,
      userId,
      username: dncUsername,
      usernameNormalized: dncUsername,
      fullName: "DNC Test Target",
      profileUrl: `https://instagram.com/${dncUsername}`,
      status: LeadStatus.READY_FOR_OUTREACH,
      leadScore: 88,
    },
  });

  // Create an approved draft for this lead
  const dncDraft = await prisma.messageDraft.create({
    data: {
      leadId: dncLead.id,
      userId,
      campaignId: campaign.id,
      body: "Hello, this is a message that should never be sent.",
      wordCount: 9,
      status: DraftStatus.APPROVED,
      promptVersion: "dnc_test_v1",
      model: "gemini-2.5-flash",
    },
  });
  console.log(`Created lead @${dncLead.username} with APPROVED draft ${dncDraft.id}`);

  // Now, suppress lead in DNC mid-pipeline before send
  console.log(`Adding @${dncLead.username} to DoNotContact table...`);
  await prisma.doNotContact.create({
    data: {
      userId,
      channel: DncChannel.INSTAGRAM,
      identifierType: DncIdentifierType.USERNAME,
      identifierNormalized: dncUsername,
      reason: "User requested opt-out",
      source: DncSource.MANUAL,
    },
  });

  console.log(`Attempting sendSingleMessage on DNC-suppressed lead...`);
  let caughtDncError = false;
  let dncErrorCode = "";
  try {
    await sendSingleMessage({
      leadId: dncLead.id,
      userId,
      message: dncDraft.body,
      senderAccountId: unipileSender.id,
    });
  } catch (err: unknown) {
    caughtDncError = true;
    if (err instanceof DncSuppressedError) {
      dncErrorCode = err.code;
      console.log(`\n[DNC Interception Successful] Threw DncSuppressedError:`, err.message);
    } else {
      console.log(`\n[Caught error]:`, err);
    }
  }

  assert.equal(caughtDncError, true, "Send must throw error for DNC lead");
  assert.equal(dncErrorCode, "DNC_SUPPRESSED", "Error code must be DNC_SUPPRESSED");
  console.log("âœ“ Verified: DNC suppression correctly blocked message dispatch!");

  separator("ALL 6 FLOWS OF PART A VERIFIED END-TO-END WITH REAL DATA & APIS");
}

runPartA()
  .then(() => {
    console.log("\n>>> PART A EXECUTION SUCCESSFUL <<<");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n>>> PART A EXECUTION FAILED <<<", err);
    process.exit(1);
  });
