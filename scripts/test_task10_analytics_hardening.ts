/* eslint-disable */
import "dotenv/config";
import {
  PrismaClient,
  CampaignStatus,
  CampaignExecutionStatus,
  CampaignExecutionPhase,
  BulkMessageJobStatus,
  BulkMessageItemStatus,
  ScrapeJobStatus,
  MessageStatus,
} from "../src/generated/prisma/client";
import "./preload_server_only.cjs";
import { getPrismaClient } from "../src/lib/db/prisma";
import { getCampaignAnalytics } from "../src/lib/services/analytics/analytics-service";
import { classifyMessagingError } from "../src/lib/services/messaging/error-classifier";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";
const prisma = getPrismaClient();

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name} ${detail ? `(${detail})` : ""}`);
    failed++;
  }
}

async function getOrCreateUser(
  email: string,
  name: string,
): Promise<{ cookie: string; user: { id: string; email: string } }> {
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
  const meData = await meRes.json();
  const user = meData.user || meData;

  return { cookie, user };
}

async function runTests() {
  console.log("\n=======================================================");
  console.log("TASK 10 — ANALYTICS & REPORTING HARDENING TESTS");
  console.log("=======================================================\n");

  const ts = Date.now();
  const userA = await getOrCreateUser(`task10_user_a_${ts}@example.com`, "Task10 User A");
  const userB = await getOrCreateUser(`task10_user_b_${ts}@example.com`, "Task10 User B");

  // -------------------------------------------------------------
  // Test 1: Empty Campaign Analytics & Empty States
  // -------------------------------------------------------------
  console.log("\n--- Suite 1: Empty Campaign Analytics ---");
  const emptyCampaign = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: `Empty Campaign ${ts}`,
      status: CampaignStatus.DRAFT,
      leadLimit: 50,
    } as any,
  });

  const emptyAnalytics = await getCampaignAnalytics(emptyCampaign.id, userA.user.id);
  assert(emptyAnalytics.leads.total === 0, "Empty campaign total leads is 0");
  assert(emptyAnalytics.leadLimit.current === 0, "Lead limit current is 0");
  assert(emptyAnalytics.leadLimit.remainingCapacity === 50, "Remaining capacity equals limit (50)");
  assert(emptyAnalytics.leadLimit.isAtCapacity === false, "isAtCapacity is false");
  assert(emptyAnalytics.emptyStates.hasLeads === false, "emptyStates.hasLeads is false");
  assert(emptyAnalytics.emptyStates.hasDiscovery === false, "emptyStates.hasDiscovery is false");
  assert(emptyAnalytics.emptyStates.hasMessaging === false, "emptyStates.hasMessaging is false");
  assert(emptyAnalytics.emptyStates.hasExecution === false, "emptyStates.hasExecution is false");
  assert(emptyAnalytics.messaging.sentRate === 0, "sentRate is 0 when no messages sent");
  assert(emptyAnalytics.discovery.enrichmentRate === 0, "enrichmentRate is 0 when 0 discovered");

  // -------------------------------------------------------------
  // Test 2: Populated Campaign with Leads, Discovery, Messaging
  // -------------------------------------------------------------
  console.log("\n--- Suite 2: Populated Campaign Data Consistency ---");
  const activeCampaign = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: `Active Analytics Campaign ${ts}`,
      status: CampaignStatus.RUNNING,
      leadLimit: 10,
      intent: "Fitness Coaches",
      location: "Austin, TX",
      category: "Fitness",
    } as any,
  });

  // Create 12 leads (exceeds limit of 10 to test clamping)
  const leads: any[] = [];
  for (let i = 1; i <= 12; i++) {
    const isVerified = i <= 4;
    const isBusiness = i % 2 === 0;
    const lead = await prisma.lead.create({
      data: {
        campaignId: activeCampaign.id,
        username: `coach_${i}_${ts}`,
        profileUrl: `https://instagram.com/coach_${i}_${ts}`,
        fullName: `Coach Number ${i}`,
        biography: i <= 8 ? `Official coach ${i} bio` : null,
        isVerified,
        verified: isVerified,
        isBusiness,
        isBusinessAccount: isBusiness,
        externalUrl: i % 3 === 0 ? `https://coach${i}.com` : null,
        profilePictureUrl: i <= 10 ? `https://img.cdn/coach${i}.jpg` : null,
        category: i % 2 === 0 ? "Fitness Trainer" : "Wellness Consultant",
      },
    });
    leads.push(lead);
  }

  // Create Discovery ScrapeJob
  const scrapeStarted = new Date(Date.now() - 120000);
  const scrapeCompleted = new Date(Date.now() - 60000);
  await prisma.scrapeJob.create({
    data: {
      campaignId: activeCampaign.id,
      status: ScrapeJobStatus.COMPLETED,
      provider: "apify",
      query: "fitness trainer",
      location: "Austin, TX",
      category: "Fitness",
      requestedLimit: 20,
      candidatesDiscovered: 15,
      candidatesEnriched: 12,
      candidatesSkipped: 3,
      processedCount: 12,
      startedAt: scrapeStarted,
      completedAt: scrapeCompleted,
    },
  });

  // Create Message Template
  const template = await prisma.messageTemplate.create({
    data: {
      campaignId: activeCampaign.id,
      name: "Outreach Template",
      body: "Hey {{firstName}}!",
    },
  });

  // Create BulkMessageJob with items in distinct states
  const bulkJob = await prisma.bulkMessageJob.create({
    data: {
      campaignId: activeCampaign.id,
      userId: userA.user.id,
      templateId: template.id,
      status: BulkMessageJobStatus.RUNNING,
      total: 10,
      sent: 5,
      failed: 2,
      skipped: 1,
      startedAt: new Date(Date.now() - 50000),
    },
  });

  // 5 SENT, 2 FAILED, 1 UNKNOWN, 1 SKIPPED, 1 CANCELLED
  // Item 1-5: SENT
  for (let i = 0; i < 5; i++) {
    await prisma.bulkMessageItem.create({
      data: {
        jobId: bulkJob.id,
        leadId: leads[i].id,
        status: BulkMessageItemStatus.SENT,
        renderedMessage: `Hey ${leads[i].fullName}!`,
        completedAt: new Date(),
      },
    });
  }

  // Item 6-7: FAILED (one RATE_LIMITED, one AUTH_REQUIRED)
  await prisma.bulkMessageItem.create({
    data: {
      jobId: bulkJob.id,
      leadId: leads[5].id,
      status: BulkMessageItemStatus.FAILED,
      renderedMessage: `Hey ${leads[5].fullName}!`,
      errorCode: "RATE_LIMITED",
      errorMessage: "Instagram error: Rate limit reached, action blocked",
      completedAt: new Date(),
    },
  });
  await prisma.bulkMessageItem.create({
    data: {
      jobId: bulkJob.id,
      leadId: leads[6].id,
      status: BulkMessageItemStatus.FAILED,
      renderedMessage: `Hey ${leads[6].fullName}!`,
      errorCode: "AUTH_REQUIRED",
      errorMessage: "Session expired: Please login again to continue",
      completedAt: new Date(),
    },
  });

  // Item 8: UNKNOWN
  await prisma.bulkMessageItem.create({
    data: {
      jobId: bulkJob.id,
      leadId: leads[7].id,
      status: BulkMessageItemStatus.UNKNOWN,
      renderedMessage: `Hey ${leads[7].fullName}!`,
      errorMessage: "Browser connection terminated before dispatch confirmation",
    },
  });

  // Item 9: SKIPPED
  await prisma.bulkMessageItem.create({
    data: {
      jobId: bulkJob.id,
      leadId: leads[8].id,
      status: BulkMessageItemStatus.SKIPPED,
      renderedMessage: `Hey ${leads[8].fullName}!`,
      errorMessage: "Lead does not allow direct messaging",
    },
  });

  // Item 10: CANCELLED
  await prisma.bulkMessageItem.create({
    data: {
      jobId: bulkJob.id,
      leadId: leads[9].id,
      status: BulkMessageItemStatus.CANCELLED,
      renderedMessage: `Hey ${leads[9].fullName}!`,
      errorMessage: "Job cancelled by operator",
    },
  });

  // Create message attempts to test distinct attempts and error taxonomy
  const msgLead5 = await prisma.message.create({
    data: {
      campaignId: activeCampaign.id,
      leadId: leads[5].id,
      status: MessageStatus.FAILED,
      messageText: "Test outreach",
      errorCode: "RATE_LIMITED",
      errorMessage: "Please wait before performing this action again",
    },
  });
  await prisma.messageAttempt.create({
    data: {
      userId: userA.user.id,
      messageId: msgLead5.id,
      leadId: leads[5].id,
      campaignId: activeCampaign.id,
      attemptNumber: 1,
      status: MessageStatus.FAILED,
      messageText: "Test outreach",
      errorCode: "RATE_LIMITED",
      errorMessage: "Please wait before performing this action again",
    },
  });

  // Attempt on lead 6
  const msgLead6 = await prisma.message.create({
    data: {
      campaignId: activeCampaign.id,
      leadId: leads[6].id,
      status: MessageStatus.FAILED,
      messageText: "Test outreach",
      errorCode: "AUTH_REQUIRED",
      errorMessage: "Checkpoint required: user needs to verify login",
    },
  });
  await prisma.messageAttempt.create({
    data: {
      userId: userA.user.id,
      messageId: msgLead6.id,
      leadId: leads[6].id,
      campaignId: activeCampaign.id,
      attemptNumber: 1,
      status: MessageStatus.FAILED,
      messageText: "Test outreach",
      errorCode: "AUTH_REQUIRED",
      errorMessage: "Checkpoint required: user needs to verify login",
    },
  });

  // CampaignExecution record
  const execution = await prisma.campaignExecution.create({
    data: {
      campaignId: activeCampaign.id,
      userId: userA.user.id,
      status: CampaignExecutionStatus.RUNNING,
      phase: CampaignExecutionPhase.MESSAGING,
      totalItems: 10,
      processedItems: 8,
      successfulItems: 5,
      failedItems: 2,
      startedAt: new Date(Date.now() - 40000),
      bulkMessageJobId: bulkJob.id,
    },
  });

  // Now query analytics via service
  const analytics = await getCampaignAnalytics(activeCampaign.id, userA.user.id);

  // -------------------------------------------------------------
  // Test 3: Lead Demographics & Characteristics
  // -------------------------------------------------------------
  console.log("\n--- Suite 3: Lead Demographics & Limit Clamping ---");
  assert(analytics.leads.total === 12, "Lead total is exactly 12");
  assert(analytics.leads.verified === 4, "Verified leads count is 4 (leads 1-4)");
  assert(analytics.leads.business === 6, "Business accounts count is 6 (even leads)");
  assert(analytics.leads.nonBusiness === 6, "Non-business accounts count is 6 (odd leads)");
  assert(analytics.leads.withBio === 8, "Leads with bio is 8");
  assert(analytics.leads.withExternalUrl === 4, "Leads with external URL is 4 (multiples of 3)");
  assert(analytics.leads.withProfilePic === 10, "Leads with profile pic is 10");

  // Lead Limit & Capacity Clamping
  assert(analytics.leadLimit.limit === 10, "Configured lead limit is 10");
  assert(analytics.leadLimit.current === 12, "Current leads is 12");
  assert(analytics.leadLimit.remainingCapacity === 0, "Remaining capacity clamped to 0 (never negative)");
  assert(analytics.leadLimit.isAtCapacity === true, "isAtCapacity is true");

  // -------------------------------------------------------------
  // Test 4: Distinct Lead Counting (No Duplicate Inflations)
  // -------------------------------------------------------------
  console.log("\n--- Suite 4: Distinct Lead Count Protection ---");
  // Multiple attempts or multiple messages for same lead must not inflate total lead count
  const leadTotalFromDb = await prisma.lead.count({ where: { campaignId: activeCampaign.id } });
  assert(analytics.leads.total === leadTotalFromDb, "Total leads strictly equals SELECT count(*)");

  // -------------------------------------------------------------
  // Test 5: Discovery Funnel & Durations
  // -------------------------------------------------------------
  console.log("\n--- Suite 5: Discovery Funnel ---");
  assert(analytics.discovery.totalJobs === 1, "Total scrape jobs is 1");
  assert(analytics.discovery.completedJobs === 1, "Completed scrape jobs is 1");
  assert(analytics.discovery.candidatesDiscovered === 15, "Candidates discovered is 15");
  assert(analytics.discovery.candidatesEnriched === 12, "Candidates enriched is 12");
  assert(analytics.discovery.candidatesSkipped === 3, "Candidates skipped is 3");
  assert(analytics.discovery.leadsSaved === 12, "Leads saved is 12");
  assert(analytics.discovery.enrichmentRate === 80, "Enrichment rate is 80% (12/15)");
  assert(analytics.discovery.saveRate === 100, "Save rate is 100% (12/12)");
  assert(analytics.discovery.recentJobs[0].query === "fitness trainer", "Discovery query matches");
  assert(analytics.discovery.recentJobs[0].location === "Austin, TX", "Discovery location matches");
  assert(analytics.discovery.recentJobs[0].category === "Fitness", "Discovery category matches");
  assert(typeof analytics.discovery.recentJobs[0].durationSeconds === "number", "Job duration in seconds calculated");

  // -------------------------------------------------------------
  // Test 6: Messaging Analytics & Distinct Statuses
  // -------------------------------------------------------------
  console.log("\n--- Suite 6: Messaging Analytics & Delivery States ---");
  assert(analytics.messaging.sent === 5, "Messaging sent count is 5");
  assert(analytics.messaging.failed === 2, "Messaging failed count is 2");
  assert(analytics.messaging.unknown === 1, "Messaging unknown count is 1");
  assert(analytics.messaging.skipped === 1, "Messaging skipped count is 1");
  assert(analytics.messaging.cancelled === 1, "Messaging cancelled count is 1");
  assert(analytics.messaging.totalTargeted === 10, "Messaging total targeted is 10");

  // Verify UNKNOWN is distinct and NOT classified as SENT or FAILED
  assert(analytics.messaging.unknown !== analytics.messaging.sent, "UNKNOWN is distinct from SENT");
  assert(analytics.messaging.unknown !== analytics.messaging.failed, "UNKNOWN is distinct from FAILED");
  assert(
    analytics.messaging.sent + analytics.messaging.failed + analytics.messaging.unknown === 8,
    "Confirmed attempted sum is 8 (5 sent + 2 failed + 1 unknown)",
  );
  assert(
    analytics.messaging.sentRate === Math.round((5 / 8) * 100),
    "Sent rate correctly calculated against attempted denominator (5/8 = 63%)",
  );

  // -------------------------------------------------------------
  // Test 7: Authoritative Execution Engine Metrics
  // -------------------------------------------------------------
  console.log("\n--- Suite 7: Authoritative Execution State ---");
  assert(analytics.execution.status === CampaignExecutionStatus.RUNNING, "Execution status is RUNNING");
  assert(analytics.execution.phase === CampaignExecutionPhase.MESSAGING, "Execution phase is MESSAGING");
  assert(analytics.execution.overallProgress === 80, "Overall progress is 80% (8/10)");
  assert(typeof analytics.durations.totalExecutionDurationSeconds === "number", "Execution duration calculated");
  assert(analytics.durations.totalExecutionDurationSeconds! >= 0, "Execution duration is non-negative");

  // -------------------------------------------------------------
  // Test 8: Safe Failure Taxonomy (No Leaked Secrets)
  // -------------------------------------------------------------
  console.log("\n--- Suite 8: Failure Taxonomy & Secret Redaction ---");
  assert(analytics.failures.totalFailures >= 2, "Total failures tracked");
  const categories = analytics.failures.categories.map((c) => c.category);
  assert(categories.includes("RATE_LIMITED"), "Taxonomy includes RATE_LIMITED category");
  assert(categories.includes("AUTH_REQUIRED"), "Taxonomy includes AUTH_REQUIRED category");

  // Verify error classification security
  const sensitiveError = "Error with cookie sessionid=abcd1234secret; Bearer eyJhbGciOi at C:\\app\\src\\auth.ts:42";
  const classified = classifyMessagingError(sensitiveError);
  assert(!JSON.stringify(classified).includes("abcd1234secret"), "Secret cookie redacted from classified error");
  assert(!JSON.stringify(classified).includes("eyJhbGciOi"), "Token redacted from classified error");
  assert(!JSON.stringify(classified).includes("C:\\app"), "Filesystem path redacted from classified error");

  // -------------------------------------------------------------
  // Test 9: HTTP Analytics Endpoint (REST API)
  // -------------------------------------------------------------
  console.log("\n--- Suite 9: HTTP GET /api/campaigns/[id]/analytics ---");
  const apiRes = await fetch(`${BASE_URL}/api/campaigns/${activeCampaign.id}/analytics`, {
    headers: { Cookie: userA.cookie },
  });
  assert(apiRes.status === 200, "Analytics API returns 200 OK for owner");
  const apiData = await apiRes.json();
  assert(apiData.campaign.id === activeCampaign.id, "API response contains campaign ID");
  assert(apiData.summary.totalLeads === 12, "API summary matches 12 leads");
  assert(apiData.messaging.sent === 5, "API messaging sent matches 5");
  assert(apiData.messaging.unknown === 1, "API messaging unknown matches 1");

  // -------------------------------------------------------------
  // Test 10: Multi-Tenant IDOR Protection
  // -------------------------------------------------------------
  console.log("\n--- Suite 10: IDOR Protection ---");
  const idorRes = await fetch(`${BASE_URL}/api/campaigns/${activeCampaign.id}/analytics`, {
    headers: { Cookie: userB.cookie },
  });
  assert(idorRes.status === 404 || idorRes.status === 403, "User B gets 404/403 accessing User A analytics");
  const idorData = await idorRes.json();
  assert(!idorData.summary, "Zero metrics leaked in unauthorized response");
  assert(!idorData.leads, "Zero leads leaked in unauthorized response");

  // -------------------------------------------------------------
  // Test 11: Export API (CSV and JSON)
  // -------------------------------------------------------------
  console.log("\n--- Suite 11: Campaign Analytics Export ---");
  // CSV Export
  const csvRes = await fetch(`${BASE_URL}/api/campaigns/${activeCampaign.id}/analytics/export?format=csv`, {
    headers: { Cookie: userA.cookie },
  });
  assert(csvRes.status === 200, "CSV export returns 200 OK");
  assert(csvRes.headers.get("content-type")?.includes("text/csv") === true, "Content-Type is text/csv");
  const csvText = await csvRes.text();
  assert(csvText.includes("CAMPAIGN ANALYTICS SUMMARY"), "CSV contains Summary header");
  assert(csvText.includes("Total Leads,12"), "CSV contains correct Total Leads");
  assert(csvText.includes("Messages Sent,5"), "CSV contains correct Messages Sent");
  assert(csvText.includes("MESSAGE DISPATCH LOG"), "CSV contains Dispatch Log header");

  // JSON Export
  const jsonRes = await fetch(`${BASE_URL}/api/campaigns/${activeCampaign.id}/analytics/export?format=json`, {
    headers: { Cookie: userA.cookie },
  });
  assert(jsonRes.status === 200, "JSON export returns 200 OK");
  const jsonExport = await jsonRes.json();
  assert(jsonExport.campaign.id === activeCampaign.id, "JSON export contains campaign id");
  assert(jsonExport.summary.totalLeads === 12, "JSON export summary contains 12 leads");
  assert(Array.isArray(jsonExport.messages), "JSON export contains messages array");

  // IDOR on Export
  const idorExportRes = await fetch(`${BASE_URL}/api/campaigns/${activeCampaign.id}/analytics/export?format=csv`, {
    headers: { Cookie: userB.cookie },
  });
  assert(idorExportRes.status === 404 || idorExportRes.status === 403, "User B blocked from exporting User A data");

  // -------------------------------------------------------------
  // Test 12: Terminal States (PARTIAL, FAILED, CANCELLED)
  // -------------------------------------------------------------
  console.log("\n--- Suite 12: Terminal Execution States Preservation ---");

  // Partial Campaign
  const partialCampaign = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: `Partial Campaign ${ts}`,
      status: CampaignStatus.PARTIAL,
    } as any,
  });
  await prisma.campaignExecution.create({
    data: {
      campaignId: partialCampaign.id,
      userId: userA.user.id,
      status: CampaignExecutionStatus.PARTIAL,
      phase: CampaignExecutionPhase.FINALIZING,
      totalItems: 20,
      processedItems: 15,
      successfulItems: 12,
      failedItems: 3,
      startedAt: new Date(Date.now() - 30000),
      completedAt: new Date(),
    },
  });
  const partialAnalytics = await getCampaignAnalytics(partialCampaign.id, userA.user.id);
  assert(partialAnalytics.execution.status === CampaignExecutionStatus.PARTIAL, "Execution status is PARTIAL");
  assert(partialAnalytics.execution.overallProgress === 75, "Overall progress preserved at 75%");
  assert(partialAnalytics.execution.successfulItems === 12, "Successful items preserved (12)");

  // Failed Campaign
  const failedCampaign = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: `Failed Campaign ${ts}`,
      status: CampaignStatus.FAILED,
    } as any,
  });
  await prisma.campaignExecution.create({
    data: {
      campaignId: failedCampaign.id,
      userId: userA.user.id,
      status: CampaignExecutionStatus.FAILED,
      errorCode: "RATE_LIMITED",
      errorMessage: "Instagram rate limit reached during outreach",
      totalItems: 10,
      processedItems: 4,
      successfulItems: 2,
      failedItems: 2,
      startedAt: new Date(Date.now() - 60000),
      completedAt: new Date(),
    },
  });
  const failedAnalytics = await getCampaignAnalytics(failedCampaign.id, userA.user.id);
  assert(failedAnalytics.execution.status === CampaignExecutionStatus.FAILED, "Execution status is FAILED");
  assert(failedAnalytics.execution.errorCode === "RATE_LIMITED", "Error code preserved");
  assert(failedAnalytics.execution.successfulItems === 2, "Successful items preserved despite failure (2)");

  // Cancelled Campaign
  const cancelledCampaign = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: `Cancelled Campaign ${ts}`,
      status: CampaignStatus.CANCELLED,
    } as any,
  });
  await prisma.campaignExecution.create({
    data: {
      campaignId: cancelledCampaign.id,
      userId: userA.user.id,
      status: CampaignExecutionStatus.CANCELLED,
      totalItems: 10,
      processedItems: 3,
      successfulItems: 3,
      failedItems: 0,
      startedAt: new Date(Date.now() - 20000),
      cancelledAt: new Date(),
    },
  });
  const cancelledAnalytics = await getCampaignAnalytics(cancelledCampaign.id, userA.user.id);
  assert(cancelledAnalytics.execution.status === CampaignExecutionStatus.CANCELLED, "Execution status is CANCELLED");
  assert(cancelledAnalytics.execution.successfulItems === 3, "Historical successful items preserved on cancellation");

  // -------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------
  console.log("\n--- Cleaning Up Test Fixtures ---");
  await prisma.campaign.deleteMany({
    where: {
      id: {
        in: [emptyCampaign.id, activeCampaign.id, partialCampaign.id, failedCampaign.id, cancelledCampaign.id],
      },
    },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [userA.user.id, userB.user.id] } },
  });
  await prisma.$disconnect();

  console.log("\n=======================================================");
  console.log(`TASK 10 TESTS COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
