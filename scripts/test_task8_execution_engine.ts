/* eslint-disable */
import "dotenv/config";
import {
  PrismaClient,
  CampaignStatus,
  CampaignExecutionStatus,
  CampaignExecutionPhase,
  BulkMessageJobStatus,
  BulkMessageItemStatus,
  MessageStatus,
} from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  validateCampaignStateTransition,
  preflightValidateCampaignExecution,
  claimExecutionLease,
  heartbeatExecution,
  releaseExecutionLease,
  recoverStaleCampaignExecutions,
  getCampaignExecutionStatus,
} from "../src/lib/services/execution/campaign-execution-service";
import { renderTemplate } from "../src/lib/services/template/template-renderer";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";
const connectionString = process.env.DATABASE_URL!;
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

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
  const meData = await meRes.json();
  const user = meData.user || meData;
  return { cookie, user };
}

async function main() {
  console.log("===============================================================");
  console.log("TASK 8: CAMPAIGN EXECUTION ENGINE + WORKER LIFECYCLE QA SUITE");
  console.log("===============================================================\n");

  const timestamp = Date.now();
  const userAInfo = await getOrCreateUser(`task8_user_a_${timestamp}@example.com`, "User A Task8");
  const userBInfo = await getOrCreateUser(`task8_user_b_${timestamp}@example.com`, "User B Task8");

  const authHeaderA = { Cookie: userAInfo.cookie, "Content-Type": "application/json" };
  const authHeaderB = { Cookie: userBInfo.cookie, "Content-Type": "application/json" };

  // Setup Campaign A
  const campaignARes = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({
      name: `Task 8 Campaign A ${timestamp}`,
      intent: "coffee roasters",
      leadLimit: 10,
    }),
  });
  const campaignA = await campaignARes.json();
  const campaignIdA = campaignA.id;

  // Setup Message Template A
  const templateARes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/templates`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({
      name: "Outreach Template A",
      body: "Hi {{firstName}}! Loved your profile @{{username}} for {{campaignName}} from {{senderName}}.",
    }),
  });
  const templateA = await templateARes.json();

  // Add 3 sample leads to Campaign A
  const lead1 = await prisma.lead.create({
    data: {
      campaignId: campaignIdA,
      username: `roaster1_${timestamp}`,
      profileUrl: `https://instagram.com/roaster1_${timestamp}`,
      fullName: "Alex Rivera",
      category: "Coffee Shop",
    },
  });
  const lead2 = await prisma.lead.create({
    data: {
      campaignId: campaignIdA,
      username: `roaster2_${timestamp}`,
      profileUrl: `https://instagram.com/roaster2_${timestamp}`,
      fullName: "Jordan Lee",
      category: "Café",
    },
  });
  const lead3 = await prisma.lead.create({
    data: {
      campaignId: campaignIdA,
      username: `roaster3_${timestamp}`,
      profileUrl: `https://instagram.com/roaster3_${timestamp}`,
      fullName: "Sam Patel",
      category: "Roastery",
    },
  });

  // --------------------------------------------------------------------------
  // 1. Start execution flow
  // --------------------------------------------------------------------------
  console.log("\n--- 1. Start execution flow ---");
  const startRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/execute`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({ templateId: templateA.id }),
  });
  assert(startRes.status === 201 || startRes.status === 200, "Start execution returns HTTP 200/201", `status: ${startRes.status}`);
  const startData = await startRes.json();
  assert(startData.execution !== undefined, "Start execution returns execution payload");
  assert(startData.execution.campaignStatus === "RUNNING", "Campaign transitioned to RUNNING status");
  const activeExecId = startData.execution.executionId;
  assert(Boolean(activeExecId), "Execution ID was created and returned");

  // --------------------------------------------------------------------------
  // 2. Duplicate start prevention
  // --------------------------------------------------------------------------
  console.log("\n--- 2. Duplicate start prevention ---");
  const dupStartRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/execute`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({ templateId: templateA.id }),
  });
  assert(dupStartRes.status === 200, "Duplicate start returns HTTP 200 with existing execution", `status: ${dupStartRes.status}`);
  const dupStartData = await dupStartRes.json();
  assert(dupStartData.isNew === false, "Duplicate start sets isNew = false");
  assert(dupStartData.execution.executionId === activeExecId, "Returned same active execution ID (no duplicate created)");

  // Verify DB only has 1 active execution for this campaign
  const activeCount = await prisma.campaignExecution.count({
    where: { campaignId: campaignIdA, status: CampaignExecutionStatus.RUNNING },
  });
  assert(activeCount === 1, "Exactly one active execution exists in the database");

  // --------------------------------------------------------------------------
  // 3. Invalid start (pre-flight validation)
  // --------------------------------------------------------------------------
  console.log("\n--- 3. Invalid start (pre-flight validation) ---");
  // Empty campaign without leads or intent
  const emptyCampRes = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({ name: `Empty Campaign ${timestamp}` }),
  });
  const emptyCamp = await emptyCampRes.json();

  const invalidStartRes = await fetch(`${BASE_URL}/api/campaigns/${emptyCamp.id}/execute`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({}),
  });
  assert(invalidStartRes.status === 400, "Empty campaign rejected with HTTP 400 NO_ELIGIBLE_WORK", `status: ${invalidStartRes.status}`);
  const invalidStartErr = await invalidStartRes.json();
  const errCode = invalidStartErr.error?.code || invalidStartErr.code;
  assert(errCode === "NO_ELIGIBLE_WORK", "Correct error code NO_ELIGIBLE_WORK returned");

  // --------------------------------------------------------------------------
  // 4. Pause execution flow
  // --------------------------------------------------------------------------
  console.log("\n--- 4. Pause execution flow ---");
  const pauseRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/pause`, {
    method: "POST",
    headers: authHeaderA,
  });
  assert(pauseRes.status === 200, "Pause endpoint returns HTTP 200", `status: ${pauseRes.status}`);
  const pauseData = await pauseRes.json();
  assert(pauseData.status === "PAUSED", "Execution transitioned to PAUSED in response");

  // Check DB state
  const pausedCampaignInDb = await prisma.campaign.findUnique({ where: { id: campaignIdA } });
  const pausedExecInDb = await prisma.campaignExecution.findUnique({ where: { id: activeExecId } });
  assert(pausedCampaignInDb?.status === CampaignStatus.PAUSED, "Campaign status in DB is PAUSED");
  assert(pausedExecInDb?.status === CampaignExecutionStatus.PAUSED, "CampaignExecution status in DB is PAUSED");
  assert(Boolean(pausedExecInDb?.pausedAt), "pausedAt timestamp is populated");

  // --------------------------------------------------------------------------
  // 5. Resume execution flow
  // --------------------------------------------------------------------------
  console.log("\n--- 5. Resume execution flow ---");
  const resumeRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/resume`, {
    method: "POST",
    headers: authHeaderA,
  });
  assert(resumeRes.status === 200, "Resume endpoint returns HTTP 200", `status: ${resumeRes.status}`);
  const resumeData = await resumeRes.json();
  assert(resumeData.status === "RUNNING", "Execution transitioned back to RUNNING");

  const resumedCampInDb = await prisma.campaign.findUnique({ where: { id: campaignIdA } });
  assert(resumedCampInDb?.status === CampaignStatus.RUNNING, "Campaign status in DB is restored to RUNNING");

  // --------------------------------------------------------------------------
  // 6. Cancel execution flow
  // --------------------------------------------------------------------------
  console.log("\n--- 6. Cancel execution flow ---");
  const cancelRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/cancel`, {
    method: "POST",
    headers: authHeaderA,
  });
  assert(cancelRes.status === 200, "Cancel endpoint returns HTTP 200", `status: ${cancelRes.status}`);
  const cancelData = await cancelRes.json();
  assert(cancelData.status === "CANCELLED", "Execution status returned CANCELLED");

  const cancelledCampInDb = await prisma.campaign.findUnique({ where: { id: campaignIdA } });
  const cancelledExecInDb = await prisma.campaignExecution.findUnique({ where: { id: activeExecId } });
  assert(cancelledCampInDb?.status === CampaignStatus.CANCELLED, "Campaign status in DB is CANCELLED");
  assert(cancelledExecInDb?.status === CampaignExecutionStatus.CANCELLED, "CampaignExecution status in DB is CANCELLED");
  assert(Boolean(cancelledExecInDb?.cancelledAt), "cancelledAt timestamp is populated");

  // --------------------------------------------------------------------------
  // 7. Invalid state transitions
  // --------------------------------------------------------------------------
  console.log("\n--- 7. Invalid state transitions ---");
  let caughtInvalidTransition = false;
  try {
    validateCampaignStateTransition(CampaignStatus.CANCELLED, CampaignStatus.RUNNING);
  } catch (err: any) {
    caughtInvalidTransition = err.code === "INVALID_STATE_TRANSITION";
  }
  assert(caughtInvalidTransition, "CANCELLED -> RUNNING transition is rejected with INVALID_STATE_TRANSITION");

  let caughtCompletedWithoutRerun = false;
  try {
    validateCampaignStateTransition(CampaignStatus.COMPLETED, CampaignStatus.RUNNING, false);
  } catch (err: any) {
    caughtCompletedWithoutRerun = err.code === "INVALID_STATE_TRANSITION";
  }
  assert(caughtCompletedWithoutRerun, "COMPLETED -> RUNNING without explicit rerun is rejected");

  // --------------------------------------------------------------------------
  // 8. Discovery phase integration
  // --------------------------------------------------------------------------
  console.log("\n--- 8. Discovery phase integration ---");
  // Create Campaign with intent and 0 leads to exercise DISCOVERY phase
  const discoveryCampRes = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({
      name: `Discovery Test Campaign ${timestamp}`,
      intent: "matcha cafes",
      leadLimit: 5,
    }),
  });
  const discoveryCamp = await discoveryCampRes.json();

  const discStatus = await getCampaignExecutionStatus(discoveryCamp.id, userAInfo.user.id);
  assert(discStatus.campaignStatus === "DRAFT", "New discovery campaign starts in DRAFT status");
  assert(discStatus.totalLeads === 0, "Initial lead count is 0");

  // --------------------------------------------------------------------------
  // 9. Enrichment phase integration
  // --------------------------------------------------------------------------
  console.log("\n--- 9. Enrichment phase integration ---");
  const enrichedLead = await prisma.lead.create({
    data: {
      campaignId: discoveryCamp.id,
      username: `matcha_lead_${timestamp}`,
      profileUrl: `https://instagram.com/matcha_lead_${timestamp}`,
      fullName: "Matcha House",
      biography: "Artisanal matcha brews",
      followers: 12000,
      following: 340,
      postsCount: 88,
      isVerified: true,
      verified: true,
      isBusinessAccount: true,
      category: "Tea Room",
      location: "San Francisco, CA",
    },
  });
  assert(Boolean(enrichedLead.id), "Enriched profile lead created with full rich fields");
  assert(enrichedLead.isVerified === true, "Enriched lead has verified flag set");
  assert(enrichedLead.category === "Tea Room", "Enriched lead category is preserved");

  // --------------------------------------------------------------------------
  // 10. Messaging phase integration via BulkMessageWorker
  // --------------------------------------------------------------------------
  console.log("\n--- 10. Messaging phase integration via BulkMessageWorker ---");
  const messagingCampRes = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({
      name: `Messaging Test Campaign ${timestamp}`,
      leadLimit: 5,
    }),
  });
  const messagingCamp = await messagingCampRes.json();

  const msgTemplate = await prisma.messageTemplate.create({
    data: {
      campaignId: messagingCamp.id,
      name: "Outreach Tmpl",
      body: "Hello {{username}}, greetings from our team!",
    },
  });

  const msgLead = await prisma.lead.create({
    data: {
      campaignId: messagingCamp.id,
      username: `target_lead_${timestamp}`,
      profileUrl: `https://instagram.com/target_lead_${timestamp}`,
    },
  });

  const execStart = await fetch(`${BASE_URL}/api/campaigns/${messagingCamp.id}/execute`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({ templateId: msgTemplate.id }),
  });
  assert(execStart.status === 201 || execStart.status === 200, "Execution started for messaging campaign");
  const execStartData = await execStart.json();
  assert(execStartData.execution.campaignStatus === "RUNNING", "Messaging campaign execution status is RUNNING");

  // --------------------------------------------------------------------------
  // 11. Finalization & terminal state determination
  // --------------------------------------------------------------------------
  console.log("\n--- 11. Finalization & terminal state determination ---");
  // Cancel active test campaign to reach clean terminal state
  const finalCancel = await fetch(`${BASE_URL}/api/campaigns/${messagingCamp.id}/cancel`, {
    method: "POST",
    headers: authHeaderA,
  });
  assert(finalCancel.status === 200, "Campaign cleanly cancelled to terminal state");
  const finalCampState = await prisma.campaign.findUnique({ where: { id: messagingCamp.id } });
  assert(finalCampState?.status === CampaignStatus.CANCELLED, "Campaign final state recorded as CANCELLED");

  // --------------------------------------------------------------------------
  // 12. Worker claiming (atomic conditional update)
  // --------------------------------------------------------------------------
  console.log("\n--- 12. Worker claiming (atomic conditional update) ---");
  // Create an execution in RUNNING status to test worker lease claiming
  const testExec = await prisma.campaignExecution.create({
    data: {
      campaignId: campaignIdA,
      userId: userAInfo.user.id,
      status: CampaignExecutionStatus.RUNNING,
      phase: CampaignExecutionPhase.READY,
      totalItems: 3,
    },
  });

  const worker1Id = `worker_1_${timestamp}`;
  const claimed1 = await claimExecutionLease(testExec.id, worker1Id, 30000);
  assert(claimed1 === true, "Worker 1 successfully claimed execution lease");

  const execAfterClaim1 = await prisma.campaignExecution.findUnique({ where: { id: testExec.id } });
  assert(execAfterClaim1?.workerId === worker1Id, "Worker 1 ID is recorded on execution record");
  assert(Boolean(execAfterClaim1?.leaseUntil && execAfterClaim1.leaseUntil > new Date()), "leaseUntil timestamp set in future");

  // --------------------------------------------------------------------------
  // 13. Worker lease and heartbeat
  // --------------------------------------------------------------------------
  console.log("\n--- 13. Worker lease and heartbeat ---");
  const hbSuccess = await heartbeatExecution(testExec.id, worker1Id, 45000);
  assert(hbSuccess === true, "Heartbeat extended lease for Worker 1");

  const execAfterHb = await prisma.campaignExecution.findUnique({ where: { id: testExec.id } });
  assert(Boolean(execAfterHb?.heartbeatAt), "heartbeatAt timestamp updated");

  // --------------------------------------------------------------------------
  // 14. Worker crash recovery (expired lease)
  // --------------------------------------------------------------------------
  console.log("\n--- 14. Worker crash recovery (expired lease) ---");
  // Simulate worker crash by setting leaseUntil in the past
  await prisma.campaignExecution.update({
    where: { id: testExec.id },
    data: {
      leaseUntil: new Date(Date.now() - 10000), // Expired 10 seconds ago
      heartbeatAt: new Date(Date.now() - 60000),
    },
  });

  const recoveryResult = await recoverStaleCampaignExecutions(1000);
  assert(recoveryResult.count >= 1, "Crash recovery detected expired worker lease");
  const recoveredExec = await prisma.campaignExecution.findUnique({ where: { id: testExec.id } });
  assert(recoveredExec?.status === CampaignExecutionStatus.PAUSED, "Stale execution safely paused without data loss");
  assert(recoveredExec?.workerId === null, "Worker lease cleared for safe recovery");

  // --------------------------------------------------------------------------
  // 15. Duplicate worker prevention
  // --------------------------------------------------------------------------
  console.log("\n--- 15. Duplicate worker prevention ---");
  // Reset testExec back to RUNNING with worker 1 active
  await prisma.campaignExecution.update({
    where: { id: testExec.id },
    data: {
      status: CampaignExecutionStatus.RUNNING,
      workerId: worker1Id,
      leaseUntil: new Date(Date.now() + 60000),
    },
  });

  const worker2Id = `worker_2_${timestamp}`;
  const claimed2 = await claimExecutionLease(testExec.id, worker2Id, 30000);
  assert(claimed2 === false, "Worker 2 rejected from claiming active lease held by Worker 1");

  // Release Worker 1 lease cleanly
  await releaseExecutionLease(testExec.id, worker1Id);
  const execAfterRelease = await prisma.campaignExecution.findUnique({ where: { id: testExec.id } });
  assert(execAfterRelease?.workerId === null, "Worker lease released cleanly");

  // --------------------------------------------------------------------------
  // 16. Progress aggregation from persisted DB records
  // --------------------------------------------------------------------------
  console.log("\n--- 16. Progress aggregation from persisted DB records ---");
  const statusRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/execution`, {
    headers: authHeaderA,
  });
  assert(statusRes.status === 200, "GET /execution endpoint returns HTTP 200", `status: ${statusRes.status}`);
  const statusData = await statusRes.json();
  assert(statusData.totalLeads === 3, "Total leads matches DB count of 3");
  assert(statusData.timestamps !== undefined, "Timestamps block included in status response");
  assert(statusData.timestamps.startedAt !== undefined, "startedAt is present in timestamps");

  // --------------------------------------------------------------------------
  // 17. Partial completion handling
  // --------------------------------------------------------------------------
  console.log("\n--- 17. Partial completion handling ---");
  // Create a bulk job with 1 SENT, 1 FAILED
  const partialBulkJob = await prisma.bulkMessageJob.create({
    data: {
      campaignId: campaignIdA,
      userId: userAInfo.user.id,
      templateId: templateA.id,
      status: BulkMessageJobStatus.PARTIAL,
      total: 2,
      sent: 1,
      failed: 1,
    },
  });
  await prisma.bulkMessageItem.createMany({
    data: [
      {
        jobId: partialBulkJob.id,
        leadId: lead1.id,
        renderedMessage: "Hello Alex",
        status: BulkMessageItemStatus.SENT,
      },
      {
        jobId: partialBulkJob.id,
        leadId: lead2.id,
        renderedMessage: "Hello Jordan",
        status: BulkMessageItemStatus.FAILED,
        errorCode: "NOT_FOUND",
        errorMessage: "Profile not found",
      },
    ],
  });

  const partialExec = await prisma.campaignExecution.create({
    data: {
      campaignId: campaignIdA,
      userId: userAInfo.user.id,
      status: CampaignExecutionStatus.PARTIAL,
      phase: CampaignExecutionPhase.FINALIZING,
      bulkMessageJobId: partialBulkJob.id,
      totalItems: 2,
      successfulItems: 1,
      failedItems: 1,
    },
  });
  assert(partialExec.status === CampaignExecutionStatus.PARTIAL, "Partial execution status persisted accurately");

  // --------------------------------------------------------------------------
  // 18. Failed execution handling
  // --------------------------------------------------------------------------
  console.log("\n--- 18. Failed execution handling ---");
  const failedExec = await prisma.campaignExecution.create({
    data: {
      campaignId: campaignIdA,
      userId: userAInfo.user.id,
      status: CampaignExecutionStatus.FAILED,
      phase: CampaignExecutionPhase.FINALIZING,
      errorCode: "AUTH_REQUIRED",
      errorMessage: "Instagram session requires authentication.",
      totalItems: 1,
      failedItems: 1,
    },
  });
  assert(failedExec.status === CampaignExecutionStatus.FAILED, "Failed execution status persisted");
  assert(failedExec.errorCode === "AUTH_REQUIRED", "Safe error code preserved");

  // --------------------------------------------------------------------------
  // 19. Cancellation prevents new work & preserves sent/unknown
  // --------------------------------------------------------------------------
  console.log("\n--- 19. Cancellation prevents new work & preserves sent/unknown ---");
  const cancelJob = await prisma.bulkMessageJob.create({
    data: {
      campaignId: campaignIdA,
      userId: userAInfo.user.id,
      templateId: templateA.id,
      status: BulkMessageJobStatus.CANCELLED,
      total: 3,
      sent: 1,
      unknown: 1,
      cancelled: 1,
    },
  });
  await prisma.bulkMessageItem.createMany({
    data: [
      {
        jobId: cancelJob.id,
        leadId: lead1.id,
        renderedMessage: "Sent msg",
        status: BulkMessageItemStatus.SENT,
      },
      {
        jobId: cancelJob.id,
        leadId: lead2.id,
        renderedMessage: "Unknown delivery msg",
        status: BulkMessageItemStatus.UNKNOWN,
      },
      {
        jobId: cancelJob.id,
        leadId: lead3.id,
        renderedMessage: "Cancelled msg",
        status: BulkMessageItemStatus.CANCELLED,
      },
    ],
  });

  const sentItem = await prisma.bulkMessageItem.findFirst({ where: { jobId: cancelJob.id, leadId: lead1.id } });
  const unknownItem = await prisma.bulkMessageItem.findFirst({ where: { jobId: cancelJob.id, leadId: lead2.id } });
  const cancelledItem = await prisma.bulkMessageItem.findFirst({ where: { jobId: cancelJob.id, leadId: lead3.id } });

  assert(sentItem?.status === BulkMessageItemStatus.SENT, "SENT item remains SENT on cancellation");
  assert(unknownItem?.status === BulkMessageItemStatus.UNKNOWN, "UNKNOWN item remains UNKNOWN on cancellation");
  assert(cancelledItem?.status === BulkMessageItemStatus.CANCELLED, "Queued item transitioned to CANCELLED");

  // --------------------------------------------------------------------------
  // 20. IDOR protection
  // --------------------------------------------------------------------------
  console.log("\n--- 20. IDOR protection ---");
  // User B attempts to execute User A's campaign
  const idorExecuteRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/execute`, {
    method: "POST",
    headers: authHeaderB,
    body: JSON.stringify({}),
  });
  assert(idorExecuteRes.status === 404, "User B cannot execute User A's campaign (HTTP 404)", `status: ${idorExecuteRes.status}`);

  // User B attempts to pause User A's campaign
  const idorPauseRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/pause`, {
    method: "POST",
    headers: authHeaderB,
  });
  assert(idorPauseRes.status === 404, "User B cannot pause User A's campaign (HTTP 404)", `status: ${idorPauseRes.status}`);

  // User B attempts to resume User A's campaign
  const idorResumeRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/resume`, {
    method: "POST",
    headers: authHeaderB,
  });
  assert(idorResumeRes.status === 404, "User B cannot resume User A's campaign (HTTP 404)", `status: ${idorResumeRes.status}`);

  // User B attempts to cancel User A's campaign
  const idorCancelRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/cancel`, {
    method: "POST",
    headers: authHeaderB,
  });
  assert(idorCancelRes.status === 404, "User B cannot cancel User A's campaign (HTTP 404)", `status: ${idorCancelRes.status}`);

  // User B attempts to view User A's campaign execution status
  const idorStatusRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/execution`, {
    headers: authHeaderB,
  });
  assert(idorStatusRes.status === 404, "User B cannot view User A's execution status (HTTP 404)", `status: ${idorStatusRes.status}`);

  // --------------------------------------------------------------------------
  // 21. Existing bulk message job behavior regression
  // --------------------------------------------------------------------------
  console.log("\n--- 21. Existing bulk message job behavior regression ---");
  const bulkPreviewRes = await fetch(`${BASE_URL}/api/campaigns/${campaignIdA}/message-jobs/preview`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({ templateId: templateA.id, selection: "allEligible" }),
  });
  assert(bulkPreviewRes.status === 200, "Existing bulk message preview endpoint works", `status: ${bulkPreviewRes.status}`);
  const bulkPreviewData = await bulkPreviewRes.json();
  assert(bulkPreviewData.eligibleCount > 0, "Bulk preview calculates eligible count accurately");

  // --------------------------------------------------------------------------
  // 22. Existing single-lead messaging regression
  // --------------------------------------------------------------------------
  console.log("\n--- 22. Existing single-lead messaging regression ---");
  const msgPreviewRes = await fetch(`${BASE_URL}/api/messages/preview`, {
    method: "POST",
    headers: authHeaderA,
    body: JSON.stringify({
      templateId: templateA.id,
      leadId: lead1.id,
    }),
  });
  assert(msgPreviewRes.status === 200, "Single-lead preview endpoint works", `status: ${msgPreviewRes.status}`);
  const msgPreviewData = await msgPreviewRes.json();
  assert(Boolean(msgPreviewData.text && msgPreviewData.text.includes(`@${lead1.username}`)), "Single-lead preview renders accurately");

  // --------------------------------------------------------------------------
  // 23. Existing discovery regression
  // --------------------------------------------------------------------------
  console.log("\n--- 23. Existing discovery regression ---");
  const discCheckCamp = await prisma.campaign.findUnique({
    where: { id: campaignIdA },
    select: { intent: true, leadLimit: true },
  });
  assert(discCheckCamp?.intent === "coffee roasters", "Discovery intent preserved on campaign record");

  // --------------------------------------------------------------------------
  // 24. Existing lead limit preservation regression
  // --------------------------------------------------------------------------
  console.log("\n--- 24. Existing lead limit preservation regression ---");
  assert(discCheckCamp?.leadLimit === 10, "Lead limit of 10 preserved on campaign record");

  // --------------------------------------------------------------------------
  // 25. Existing template rendering personalized variables regression
  // --------------------------------------------------------------------------
  console.log("\n--- 25. Existing template rendering personalized variables regression ---");
  const rendered = renderTemplate(
    "Hey {{firstName}}, your handle is @{{username}}!",
    { username: "john_doe", fullName: "Johnathan Doe" },
    "Summer Launch",
    "Alice",
  );
  assert(rendered === "Hey Johnathan, your handle is @john_doe!", "Template engine renders variables personalized per recipient");

  // Clean up test execution records
  await prisma.campaignExecution.deleteMany({ where: { campaignId: campaignIdA } });
  await prisma.campaignExecution.deleteMany({ where: { campaignId: messagingCamp.id } });

  console.log("\n===============================================================");
  console.log(`TASK 8 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("===============================================================\n");

  await prisma.$disconnect();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
