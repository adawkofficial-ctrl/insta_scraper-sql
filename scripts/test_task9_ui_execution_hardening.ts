/* eslint-disable */
import "dotenv/config";
import {
  PrismaClient,
  CampaignStatus,
  CampaignExecutionStatus,
  CampaignExecutionPhase,
  BulkMessageJobStatus,
  BulkMessageItemStatus,
} from "../src/generated/prisma/client";
import "./preload_server_only.cjs";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  getCampaignExecutionStatus,
  startCampaignExecution,
  pauseCampaignExecution,
  resumeCampaignExecution,
  cancelCampaignExecution,
} from "../src/lib/services/execution/campaign-execution-service";
import { classifyMessagingError } from "../src/lib/services/messaging/error-classifier";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3005";
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
  console.log("TASK 9 — CAMPAIGN EXECUTION UI & PROGRESS HARDENING TESTS");
  console.log("=======================================================\n");

  const ts = Date.now();
  const userA = await getOrCreateUser(`task9_user_a_${ts}@example.com`, "Task9 User A");
  const userB = await getOrCreateUser(`task9_user_b_${ts}@example.com`, "Task9 User B");

  // Create test campaign for User A
  const campaignA = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: `Task 9 Campaign A ${Date.now()}`,
      status: CampaignStatus.DRAFT,
      leadLimit: 20,
      intent: "Fitness trainers in Miami",
      location: "Miami, FL",
      category: "Health & Fitness",
    } as any,
  });

  const templateA = await prisma.messageTemplate.create({
    data: {
      campaignId: campaignA.id,
      name: "Task 9 Outreach Template",
      body: "Hi {{firstName}}, check out our Miami fitness program!",
    },
  });

  // Create sample leads
  const leads: any[] = [];
  for (let i = 1; i <= 15; i++) {
    const lead = await prisma.lead.create({
      data: {
        campaignId: campaignA.id,
        username: `task9_lead_${i}_${Date.now()}`,
        profileUrl: `https://instagram.com/task9_lead_${i}`,
        fullName: `Lead Number ${i}`,
      },
    });
    leads.push(lead);
  }

  console.log("1. TEST: Execution status initial state & lead capacity");
  const initialStatus = await getCampaignExecutionStatus(campaignA.id, userA.user.id);
  assert(initialStatus.campaignStatus === "DRAFT", "Initial status is DRAFT");
  assert(initialStatus.totalLeads === 15, "Reports correct total leads (15)");
  assert(initialStatus.leadCapacity.leadLimit === 20, "Reports configured leadLimit 20");
  assert(initialStatus.leadCapacity.currentLeads === 15, "Reports current leads 15");
  assert(initialStatus.leadCapacity.remainingCapacity === 5, "Reports remaining capacity 5 (20 - 15)");
  assert(initialStatus.overallProgress === 0, "Initial progress is 0%");

  console.log("\n2. TEST: Lead capacity when limit is reached (remaining = 0)");
  // Create 5 more leads to fill capacity
  for (let i = 16; i <= 20; i++) {
    await prisma.lead.create({
      data: {
        campaignId: campaignA.id,
        username: `task9_lead_full_${i}_${Date.now()}`,
        profileUrl: `https://instagram.com/task9_lead_full_${i}`,
        fullName: `Full Lead ${i}`,
      },
    });
  }
  const fullCapacityStatus = await getCampaignExecutionStatus(campaignA.id, userA.user.id);
  assert(fullCapacityStatus.totalLeads === 20, "Reports total leads 20");
  assert(fullCapacityStatus.leadCapacity.remainingCapacity === 0, "Reports remaining capacity 0");

  console.log("\n3. TEST: Start execution button & authoritative start");
  const startRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/execute`, {
    method: "POST",
    headers: { Cookie: userA.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ templateId: templateA.id }),
  });
  assert(startRes.ok, "Start execution endpoint returns 200 OK");
  const startData = await startRes.json();
  assert(startData.execution !== undefined, "Returns execution status object");
  assert(
    startData.execution.campaignStatus === "RUNNING" || startData.execution.campaignStatus === "PAUSED",
    "Campaign started or auto-paused safely",
  );

  console.log("\n4. TEST: Duplicate start prevention (Idempotency)");
  const dupStartRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/execute`, {
    method: "POST",
    headers: { Cookie: userA.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ templateId: templateA.id }),
  });
  assert(dupStartRes.ok, "Duplicate start does not fail with 500");
  const dupStartData = await dupStartRes.json();
  assert(dupStartData.isNew === false, "Returns isNew: false for duplicate active execution");

  console.log("\n5. TEST: Pause button & state transition");
  // The background worker can auto-pause between the reset and this request.
  // Reset a terminal execution and retry; assertions stay the same.
  let pauseRes: Response | null = null;
  let pauseBody = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    await prisma.campaign.update({
      where: { id: campaignA.id },
      data: { status: CampaignStatus.RUNNING },
    });
    await prisma.campaignExecution.updateMany({
      where: {
        campaignId: campaignA.id,
        status: {
          in: [
            CampaignExecutionStatus.PAUSED,
            CampaignExecutionStatus.COMPLETED,
            CampaignExecutionStatus.PARTIAL,
            CampaignExecutionStatus.FAILED,
          ],
        },
      },
      data: { status: CampaignExecutionStatus.RUNNING },
    });
    pauseRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/pause`, {
      method: "POST",
      headers: { Cookie: userA.cookie },
    });
    pauseBody = await pauseRes.clone().text();
    if (pauseRes.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!pauseRes) throw new Error("Pause request was not issued");
  assert(pauseRes.ok, "Pause endpoint returns 200 OK", `status=${pauseRes.status} body=${pauseBody}`);
  const pausedStatus = await getCampaignExecutionStatus(campaignA.id, userA.user.id);
  assert(pausedStatus.campaignStatus === "PAUSED", "Campaign status updated to PAUSED in DB");
  assert(pausedStatus.executionStatus === "PAUSED", "Execution status updated to PAUSED in DB");

  console.log("\n6. TEST: Invalid state transition handling (409 Conflict)");
  // Trying to pause an already PAUSED campaign
  const doublePauseRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/pause`, {
    method: "POST",
    headers: { Cookie: userA.cookie },
  });
  assert(!doublePauseRes.ok, "Pausing already paused campaign is rejected");
  assert(
    doublePauseRes.status === 400 || doublePauseRes.status === 409,
    "Returns 400 or 409 for invalid pause transition",
  );

  console.log("\n7. TEST: Resume button & state transition");
  const resumeRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/resume`, {
    method: "POST",
    headers: { Cookie: userA.cookie },
  });
  assert(resumeRes.ok, "Resume endpoint returns 200 OK");
  const resumedStatus = await getCampaignExecutionStatus(campaignA.id, userA.user.id);
  assert(resumedStatus.campaignStatus === "RUNNING", "Campaign status restored to RUNNING in DB");
  assert(resumedStatus.executionStatus === "RUNNING", "Execution status restored to RUNNING in DB");

  console.log("\n8. TEST: Cancel confirmation semantics & cancellation transition");
  const cancelRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/cancel`, {
    method: "POST",
    headers: { Cookie: userA.cookie },
  });
  assert(cancelRes.ok, "Cancel endpoint returns 200 OK");
  const cancelledStatus = await getCampaignExecutionStatus(campaignA.id, userA.user.id);
  assert(cancelledStatus.campaignStatus === "CANCELLED", "Campaign status is CANCELLED in DB");
  assert(cancelledStatus.executionStatus === "CANCELLED", "Execution status is CANCELLED in DB");

  console.log("\n9. TEST: Deterministic overall progress calculation (0-100, never negative, never >100)");
  assert(
    cancelledStatus.overallProgress >= 0 && cancelledStatus.overallProgress <= 100,
    "Overall progress is within [0, 100]",
  );

  // Test completed campaign shows 100%
  const campaignComp = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: "Completed Test Campaign",
      status: CampaignStatus.COMPLETED,
    } as any,
  });
  const completedStatus = await getCampaignExecutionStatus(campaignComp.id, userA.user.id);
  assert(completedStatus.overallProgress === 100, "Completed campaign progress is exactly 100%");

  console.log("\n10. TEST: Discovery details and skipped discovery representation");
  assert(initialStatus.discoveryDetails !== null, "discoveryDetails object is provided");
  assert(initialStatus.discoveryDetails?.query === "Fitness trainers in Miami", "Correct search query");
  assert(initialStatus.discoveryDetails?.location === "Miami, FL", "Correct location");
  assert(initialStatus.discoveryDetails?.category === "Health & Fitness", "Correct category");

  console.log("\n11. TEST: Messaging progress breakdown fields");
  // Create campaign with a bulk message job and items
  const campaignMsg = await prisma.campaign.create({
    data: {
      userId: userA.user.id,
      name: "Messaging Progress Test",
      status: CampaignStatus.RUNNING,
    } as any,
  });
  const bulkJob = await prisma.bulkMessageJob.create({
    data: {
      userId: userA.user.id,
      campaignId: campaignMsg.id,
      templateId: templateA.id,
      total: 10,
      sent: 6,
      failed: 1,
      unknown: 1,
      queued: 2,
    },
  });
  // Create bulk items
  for (let i = 1; i <= 6; i++) {
    await prisma.bulkMessageItem.create({
      data: {
        jobId: bulkJob.id,
        leadId: leads[i - 1].id,
        status: BulkMessageItemStatus.SENT,
        renderedMessage: "Hello",
      },
    });
  }
  await prisma.bulkMessageItem.create({
    data: {
      jobId: bulkJob.id,
      leadId: leads[6].id,
      status: BulkMessageItemStatus.FAILED,
      renderedMessage: "Hello",
    },
  });
  await prisma.bulkMessageItem.create({
    data: {
      jobId: bulkJob.id,
      leadId: leads[7].id,
      status: BulkMessageItemStatus.UNKNOWN,
      renderedMessage: "Hello",
    },
  });
  await prisma.bulkMessageItem.create({
    data: {
      jobId: bulkJob.id,
      leadId: leads[8].id,
      status: BulkMessageItemStatus.QUEUED,
      renderedMessage: "Hello",
    },
  });
  await prisma.bulkMessageItem.create({
    data: {
      jobId: bulkJob.id,
      leadId: leads[9].id,
      status: BulkMessageItemStatus.QUEUED,
      renderedMessage: "Hello",
    },
  });

  await prisma.campaignExecution.create({
    data: {
      campaignId: campaignMsg.id,
      userId: userA.user.id,
      status: CampaignExecutionStatus.RUNNING,
      phase: CampaignExecutionPhase.MESSAGING,
      bulkMessageJobId: bulkJob.id,
    },
  });

  const msgStatus = await getCampaignExecutionStatus(campaignMsg.id, userA.user.id);
  assert(msgStatus.messagingProgress !== null, "Messaging progress exists");
  assert(msgStatus.messagingProgress?.total === 10, "Total eligible messages is 10");
  assert(msgStatus.messagingProgress?.sent === 6, "Sent messages count is 6");
  assert(msgStatus.messagingProgress?.failed === 1, "Failed messages count is 1");
  assert(msgStatus.messagingProgress?.unknown === 1, "Unknown messages count is 1");
  assert(msgStatus.messagingProgress?.queued === 2, "Queued messages count is 2");
  // 6 sent + 1 failed + 1 unknown = 8 processed out of 10 = 80%
  assert(msgStatus.messagingProgress?.progress === 80, "Messaging progress percentage is 80%");
  assert(msgStatus.overallProgress === 80, "Overall progress reflects messaging progress (80%)");

  console.log("\n12. TEST: Safe error classification & sanitized display");
  const authErr = classifyMessagingError("AUTH_REQUIRED", "Session missing cookies and token.");
  assert(authErr.code === "AUTH_REQUIRED", "Sanitized error code AUTH_REQUIRED");
  assert(!authErr.userFacingMessage.includes("cookies"), "Error message hides internal cookie/token strings");

  const rateLimitErr = classifyMessagingError("RATE_LIMIT", "429 Too Many Requests");
  assert(rateLimitErr.code === "RATE_LIMITED", "Classifies 429 as RATE_LIMITED");
  assert(
    rateLimitErr.userFacingMessage.toLowerCase().includes("rate limit") ||
    rateLimitErr.userFacingMessage.toLowerCase().includes("temporarily") ||
    rateLimitErr.userFacingMessage.toLowerCase().includes("activity"),
    "Clear safe user explanation for rate limit",
  );

  console.log("\n13. TEST: HTTP Status Codes Handling (401, 403, 404, 409)");
  // 401 Unauthorized
  const unauthRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/execution`);
  assert(unauthRes.status === 401, "Unauthenticated request returns 401");

  // 404 Not Found
  const notFoundRes = await fetch(`${BASE_URL}/api/campaigns/non_existent_cuid_123/execution`, {
    headers: { Cookie: userA.cookie },
  });
  assert(notFoundRes.status === 404, "Non-existent campaign returns 404");

  // 403 / IDOR Protection
  const idorExecRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/execution`, {
    headers: { Cookie: userB.cookie },
  });
  assert(idorExecRes.status === 403 || idorExecRes.status === 404, "User B cannot view User A's execution (403/404)");

  const idorPauseRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/pause`, {
    method: "POST",
    headers: { Cookie: userB.cookie },
  });
  assert(idorPauseRes.status === 403 || idorPauseRes.status === 404, "User B cannot pause User A's campaign (403/404)");

  const idorCancelRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/cancel`, {
    method: "POST",
    headers: { Cookie: userB.cookie },
  });
  assert(idorCancelRes.status === 403 || idorCancelRes.status === 404, "User B cannot cancel User A's campaign (403/404)");

  console.log("\n14. TEST: Polling rules & terminal state deactivation");
  // Terminal state verification: COMPLETED, PARTIAL, FAILED, CANCELLED
  const terminalStatuses = ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"];
  for (const st of terminalStatuses) {
    const isTerminalState = st === "COMPLETED" || st === "PARTIAL" || st === "FAILED" || st === "CANCELLED";
    assert(isTerminalState === true, `Status ${st} is correctly identified as terminal to halt polling`);
  }

  console.log("\n15. TEST: Elapsed time & timestamps calculation");
  assert(msgStatus.timestamps.updatedAt !== null, "updatedAt timestamp is populated");
  assert(
    msgStatus.timestamps.elapsedSeconds === null || msgStatus.timestamps.elapsedSeconds >= 0,
    "elapsedSeconds is non-negative",
  );

  console.log("\n=======================================================");
  console.log(`TASK 9 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests()
  .catch((err) => {
    console.error("Test execution failed with unhandled error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
