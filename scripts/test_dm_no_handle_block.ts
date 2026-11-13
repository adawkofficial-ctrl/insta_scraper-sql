/**
 * No-handle leads (status NEW) must never be queued or sent as Instagram DMs.
 *
 * Covers every outbound Instagram path:
 * 1. Single send (sendSingleMessage)
 * 2. Bulk job creation (preview/create)
 * 3. Campaign execution queue (startCampaignExecution -> bulk job creation)
 * 4. Follow-up dispatch (dispatchDueFollowUps)
 */

import "dotenv/config";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl } = require("./test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || "mock-apify-test-token";
process.env.MESSAGING_PROVIDER = "playwright";
process.env.WORKING_HOURS_START = "0";
process.env.WORKING_HOURS_END = "24";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { getPrismaClient } from "../src/lib/db/prisma";
import { CampaignStatus, FollowUpStatus, LeadStatus } from "@/generated/prisma/client";
import { sendSingleMessage, setMessagingProvider } from "../src/lib/services/messaging/messaging-service";
import { createBulkMessageJob, previewBulkMessageJob } from "../src/lib/services/messaging/bulk-messaging-service";
import { dispatchDueFollowUps } from "../src/lib/services/messaging/follow-up-service";
import { startCampaignExecution } from "../src/lib/services/execution/campaign-execution-service";
import type {
  MessagingProvider,
  MessagingProviderStatus,
  SendMessageRequest,
  SendMessageResult,
} from "../src/lib/services/messaging/messaging-provider";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` -> ${detail}` : ""}`);
    failed++;
  }
}

class NoHandleMockProvider implements MessagingProvider {
  readonly name = "mock-dm-no-handle";
  sentRequests: SendMessageRequest[] = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async getStatus(): Promise<MessagingProviderStatus> {
    return { provider: this.name, status: "READY", authenticated: true };
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    this.sentRequests.push(request);
    return {
      success: true,
      provider: this.name,
      messageText: request.message,
      providerMessageId: `mock_${Date.now()}`,
      sentAt: new Date().toISOString(),
    };
  }
}

async function runTests() {
  console.log("=== NO-HANDLE LEADS CANNOT BE QUEUED OR SENT AS INSTAGRAM DMS ===");
  const prisma = getPrismaClient();
  const mockProvider = new NoHandleMockProvider();
  setMessagingProvider(mockProvider);

  const tag = `dm_no_handle_${Date.now()}`;
  const user = await prisma.user.create({
    data: {
      email: `${tag}@example.com`,
      name: "DM No Handle Test",
      passwordHash: "hash123",
    },
  });
  const companyProfile = await prisma.companyProfile.create({
    data: { userId: user.id, name: "DM No Handle Co" },
  });

  const campaign = await prisma.campaign.create({
    data: {
      name: `${tag} campaign`,
      userId: user.id,
      companyProfileId: companyProfile.id,
      category: "Dentist",
      location: "Toronto, ON",
      leadLimit: 1,
      followUpEnabled: true,
      followUpCount: 1,
      status: CampaignStatus.DRAFT,
    },
  });
  const template = await prisma.messageTemplate.create({
    data: {
      campaignId: campaign.id,
      name: `${tag} template`,
      body: "Hi {{username}}, quick question about your business.",
    },
  });
  const lead = await prisma.lead.create({
    data: {
      campaignId: campaign.id,
      userId: user.id,
      username: null,
      instagramUsername: null,
      profileUrl: null,
      fullName: "No Handle Dental",
      email: `${tag}@example.com`,
      phone: "+14165550001",
      source: "google_maps",
      status: LeadStatus.NEW,
      availableChannels: ["EMAIL", "PHONE"],
    },
  });

  try {
    // 1. Single send
    let singleSendCode: string | null = null;
    try {
      await sendSingleMessage(
        { leadId: lead.id, campaignId: campaign.id, message: "Hello via Instagram" },
        user.id,
      );
    } catch (err) {
      singleSendCode = (err as { code?: string }).code ?? null;
    }
    check(singleSendCode === "NO_INSTAGRAM_CHANNEL", "Single send blocks no-handle lead", `code=${singleSendCode}`);
    check(mockProvider.sentRequests.length === 0, "Single send made no provider call");

    // 2. Bulk job preview + creation
    const preview = await previewBulkMessageJob(
      campaign.id,
      { templateId: template.id, leadIds: [lead.id] },
      user.id,
    );
    check(
      preview.skippedReasons.some((r) => r.leadId === lead.id && r.reason.includes("Instagram handle")),
      "Bulk preview skips no-handle lead",
    );

    let bulkJobCode: string | null = null;
    try {
      await createBulkMessageJob(
        campaign.id,
        { templateId: template.id, leadIds: [lead.id] },
        user.id,
      );
    } catch (err) {
      bulkJobCode = (err as { code?: string }).code ?? null;
    }
    check(bulkJobCode === "NO_ELIGIBLE_LEADS", "Bulk job creation rejects no-handle-only selection", `code=${bulkJobCode}`);
    const bulkItemsForLead = await prisma.bulkMessageItem.count({ where: { leadId: lead.id } });
    check(bulkItemsForLead === 0, "No bulk message item queued for no-handle lead", `count=${bulkItemsForLead}`);

    // 3. Follow-up dispatch
    const dueAt = new Date(Date.now() - 60_000);
    const followUp = await prisma.followUpMessage.create({
      data: {
        campaignId: campaign.id,
        leadId: lead.id,
        step: 1,
        status: FollowUpStatus.SCHEDULED,
        templateText: "Following up",
        renderedBody: "Following up about your business.",
        dueAt,
        idempotencyKey: `${tag}_followup_1`,
      },
    });
    mockProvider.sentRequests = [];
    await dispatchDueFollowUps({
      campaignId: campaign.id,
      leadId: lead.id,
      now: new Date(),
      messagingProvider: mockProvider,
    });
    const followUpAfter = await prisma.followUpMessage.findUnique({ where: { id: followUp.id } });
    check(
      followUpAfter?.status === FollowUpStatus.CANCELLED_MANUAL && followUpAfter?.cancelReason === "NO_INSTAGRAM_HANDLE",
      "Follow-up dispatch cancels no-handle lead",
      `status=${followUpAfter?.status} reason=${followUpAfter?.cancelReason}`,
    );
    check(mockProvider.sentRequests.length === 0, "Follow-up dispatch made no provider call");

    // 4. Campaign execution (queues through createBulkMessageJob)
    const execCampaign = await prisma.campaign.create({
      data: {
        name: `${tag} exec campaign`,
        userId: user.id,
        companyProfileId: companyProfile.id,
        category: "Dentist",
        location: "Toronto, ON",
        leadLimit: 1,
        status: CampaignStatus.DRAFT,
      },
    });
    const execLead = await prisma.lead.create({
      data: {
        campaignId: execCampaign.id,
        userId: user.id,
        username: null,
        instagramUsername: null,
        profileUrl: null,
        fullName: "No Handle Execution Dental",
        email: `${tag}_exec@example.com`,
        source: "google_maps",
        status: LeadStatus.NEW,
        availableChannels: ["EMAIL", "PHONE"],
      },
    });
    const execTemplate = await prisma.messageTemplate.create({
      data: {
        campaignId: execCampaign.id,
        name: `${tag} exec template`,
        body: "Hi {{username}}, quick question about your business.",
      },
    });
    mockProvider.sentRequests = [];
    const started = await startCampaignExecution(execCampaign.id, user.id, {
      templateId: execTemplate.id,
    });
    const executionId = started.execution.executionId;
    check(Boolean(executionId), "Campaign execution started");

    // Wait for the background worker to attempt the messaging phase.
    if (executionId) {
      const waitStart = Date.now();
      let execution = await prisma.campaignExecution.findUnique({ where: { id: executionId } });
      while (execution && execution.workerId && Date.now() - waitStart < 10_000) {
        await new Promise((r) => setTimeout(r, 250));
        execution = await prisma.campaignExecution.findUnique({ where: { id: executionId } });
      }
    }

    const execItems = await prisma.bulkMessageItem.count({ where: { leadId: execLead.id } });
    const execJobs = await prisma.bulkMessageJob.count({ where: { campaignId: execCampaign.id } });
    check(execItems === 0, "Campaign execution queued no item for no-handle lead", `items=${execItems}`);
    check(execJobs === 0, "Campaign execution created no bulk DM job for no-handle lead", `jobs=${execJobs}`);
    check(mockProvider.sentRequests.length === 0, "Campaign execution made no provider send call");
  } finally {
    setMessagingProvider(null);
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }

  console.log("\n=======================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests()
  .catch((err) => {
    console.error("Test execution threw error:", err);
    process.exit(1);
  })
  .finally(async () => {
    const prisma = getPrismaClient();
    await prisma.$disconnect();
  });
