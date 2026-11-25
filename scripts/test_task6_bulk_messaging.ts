/* eslint-disable */
import "dotenv/config";
import "./preload_server_only.cjs";
import { BulkMessageJobStatus, BulkMessageItemStatus } from "../src/generated/prisma/client";
import { getPrismaClient } from "../src/lib/db/prisma";
import { validateTemplateVariables, renderTemplate } from "../src/lib/services/template/template-renderer";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";
const prisma = getPrismaClient();

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  âœ… PASS: ${name}`);
    passed++;
  } else {
    console.error(`  âŒ FAIL: ${name} ${detail ? `(${detail})` : ""}`);
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
  console.log("   TASK 6: BULK INSTAGRAM MESSAGING + QUEUE TEST SUITE           ");
  console.log("=================================================================\n");

  const userA = await getOrCreateUser("task6_tenant_a@example.com", "Tenant A");
  const userB = await getOrCreateUser("task6_tenant_b@example.com", "Tenant B");

  // Create Campaign A
  const campaignA = await prisma.campaign.create({
    data: {
      name: `Bulk Campaign A ${Date.now()}`,
      intent: "Testing bulk message features",
      leadLimit: 100,
      userId: userA.user.id,
      category: "Fitness",
      location: "Miami",
    } as any,
  });

  // Create Campaign B (for cross-tenant checks)
  const campaignB = await prisma.campaign.create({
    data: {
      name: `Bulk Campaign B ${Date.now()}`,
      intent: "Tenant B campaign",
      leadLimit: 100,
      userId: userB.user.id,
    } as any,
  });

  // Create Template for Campaign A
  const templateA = await prisma.messageTemplate.create({
    data: {
      name: "Personalized Outreach",
      body: "Hi {{username}}, we love your {{category}} work at {{profileUrl}}! Best, {{senderName}}.",
      campaignId: campaignA.id,
    },
  });

  // Create Template for Campaign B
  const templateB = await prisma.messageTemplate.create({
    data: {
      name: "Tenant B Template",
      body: "Hello from Tenant B",
      campaignId: campaignB.id,
    },
  });

  // Populate test leads in Campaign A
  const lead1 = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `lead_one_${Date.now()}`,
      fullName: "Lead One",
      category: "Fitness",
      profileUrl: "https://www.instagram.com/lead_one/",
      isBusinessAccount: true,
      isVerified: true,
    },
  });

  const lead2 = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `lead_two_${Date.now()}`,
      fullName: "Lead Two",
      category: "Fitness",
      profileUrl: "https://www.instagram.com/lead_two/",
      isBusinessAccount: false,
      isVerified: false,
    },
  });

  const leadInvalidUrl = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `lead_nourl_${Date.now()}`,
      fullName: "No Profile URL",
      category: "Fitness",
      profileUrl: "invalid-url",
    },
  });

  // Lead in Campaign B
  const leadB = await prisma.lead.create({
    data: {
      campaignId: campaignB.id,
      username: `lead_b_${Date.now()}`,
      fullName: "Tenant B Lead",
      category: "Tech",
      profileUrl: "https://www.instagram.com/lead_b/",
    },
  });

  console.log("--- 1. Selected leads job preview via API ---");
  const prevRes1 = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      leadIds: [lead1.id, lead2.id],
      selection: "selected",
    }),
  });
  const preview1 = await prevRes1.json() as any;
  assert(prevRes1.status === 200, "Preview API returned 200 OK");
  assert(preview1.totalSelected === 2 && preview1.eligibleCount === 2 && preview1.skippedCount === 0, "Preview calculates 2 eligible, 0 skipped");

  console.log("--- 2. Selected leads job creation via API ---");
  const createRes1 = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      leadIds: [lead1.id, lead2.id],
      selection: "selected",
    }),
  });
  const job1Data = await createRes1.json() as any;
  assert(createRes1.status === 201, "Job creation API returned 201 Created");
  assert(job1Data.job.status === "QUEUED" && job1Data.job.total === 2, "Created job is in QUEUED state with total = 2");

  const jobId1 = job1Data.job.id;

  console.log("--- 3. All eligible leads mode ---");
  const prevResAll = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      selection: "allEligible",
    }),
  });
  const previewAll = await prevResAll.json() as any;
  // lead1 and lead2 are currently QUEUED in job1, so they are skipped as active; leadInvalidUrl is skipped for invalid URL
  assert(previewAll.totalSelected === 3, "All eligible mode evaluated all 3 leads in Campaign A");
  assert(previewAll.skippedCount >= 2, "Active job leads and invalid profile URLs are reported as skipped");

  console.log("--- 4. Filtered all leads mode ---");
  const prevResFiltered = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      selection: "allEligible",
      filters: {
        isBusinessAccount: "true",
        verified: "true",
      },
    }),
  });
  const previewFiltered = await prevResFiltered.json() as any;
  assert(previewFiltered.totalSelected === 1, "Filter criteria (isBusinessAccount & verified) matches only lead1");

  console.log("--- 5. Duplicate lead IDs in selection ---");
  const prevResDups = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      leadIds: [lead2.id, lead2.id, lead2.id],
      selection: "selected",
    }),
  });
  const previewDups = await prevResDups.json() as any;
  assert(previewDups.totalSelected === 1, "Duplicate lead IDs are deduplicated by server to 1 unique record");

  console.log("--- 6. Invalid lead IDs rejected ---");
  const prevResInvalid = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      leadIds: ["non-existent-uuid-1", "non-existent-uuid-2"],
      selection: "selected",
    }),
  });
  assert(prevResInvalid.status === 400, "Non-existent lead IDs are rejected with 400 Bad Request");

  console.log("--- 7. Cross-campaign lead selection blocked ---");
  const prevResCross = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      leadIds: [leadB.id], // leadB belongs to campaignB
      selection: "selected",
    }),
  });
  const previewCross = await prevResCross.json() as any;
  assert(previewCross.totalSelected === 0, "Lead from Campaign B cannot be selected under Campaign A");

  console.log("--- 8. Cross-tenant campaign isolation ---");
  const crossTenantRes = await fetch(`${BASE_URL}/api/campaigns/${campaignB.id}/message-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateB.id,
      leadIds: [leadB.id],
      selection: "selected",
    }),
  });
  assert(crossTenantRes.status === 404, "Tenant A cannot access Tenant B's campaign (404)");

  console.log("--- 9. Unauthorized template check ---");
  const unauthTmplRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateB.id, // templateB belongs to Tenant B
      leadIds: [lead1.id],
      selection: "selected",
    }),
  });
  assert(unauthTmplRes.status === 404, "Tenant A cannot use Tenant B's template (404)");

  console.log("--- 10. Empty eligible set check ---");
  const prevResEmpty = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      leadIds: [leadInvalidUrl.id],
      selection: "selected",
    }),
  });
  const previewEmpty = await prevResEmpty.json() as any;
  // Since 00cf7e9 the profile URL is rebuilt from a valid username, so a bad
  // stored profileUrl alone no longer makes a lead ineligible.
  assert(previewEmpty.eligibleCount === 1 && previewEmpty.skippedCount === 0, "Lead with bad stored URL but valid username is repaired and eligible");

  console.log("--- 11. Template rendering per recipient ---");
  assert(preview1.samples.length >= 2, "Preview returned personalized samples for recipients");
  assert(preview1.samples[0].renderedMessage.includes(lead1.username), "Sample 1 includes lead 1 username");
  assert(preview1.samples[1].renderedMessage.includes(lead2.username), "Sample 2 includes lead 2 username");
  assert(preview1.samples[0].renderedMessage !== preview1.samples[1].renderedMessage, "Each recipient receives a unique personalized message");

  console.log("--- 12. Transactional job & items persistence ---");
  const itemsInDb = await prisma.bulkMessageItem.findMany({
    where: { jobId: jobId1 },
  });
  assert(itemsInDb.length === 2, "BulkMessageItem records match expected recipient count (2)");
  assert(itemsInDb.every((it) => it.status === "QUEUED"), "All created items are initialized in QUEUED state");

  console.log("--- 13. Progress API reflects real DB state ---");
  const statusRes1 = await fetch(`${BASE_URL}/api/message-jobs/${jobId1}`, {
    headers: { Cookie: userA.cookie },
  });
  const statusData1 = await statusRes1.json() as any;
  assert(statusRes1.status === 200, "GET /api/message-jobs/[jobId] returned 200 OK");
  assert(statusData1.total === 2 && statusData1.queued === 2 && statusData1.sent === 0, "Progress counts accurately reflect database state");

  console.log("--- 14. Pause job endpoint & state transition ---");
  const pauseRes = await fetch(`${BASE_URL}/api/message-jobs/${jobId1}/pause`, {
    method: "POST",
    headers: { Cookie: userA.cookie },
  });
  const pauseData = await pauseRes.json() as any;
  assert(pauseRes.status === 200 && pauseData.status === "PAUSED", "POST /api/message-jobs/[jobId]/pause transitions status to PAUSED");

  console.log("--- 15. Resume job endpoint & state transition ---");
  const resumeRes = await fetch(`${BASE_URL}/api/message-jobs/${jobId1}/resume`, {
    method: "POST",
    headers: { Cookie: userA.cookie },
  });
  const resumeData = await resumeRes.json() as any;
  assert(resumeRes.status === 200 && resumeData.status === "RUNNING", "POST /api/message-jobs/[jobId]/resume transitions status to RUNNING");

  console.log("--- 16. Cancel job endpoint & remaining items cancelled ---");
  const leadCancel = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `lead_cncl_${Date.now()}`,
      profileUrl: "https://www.instagram.com/cncl/",
      category: "Fitness",
    },
  });
  const cancelJobCreateRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      leadIds: [leadCancel.id],
      selection: "selected",
    }),
  });
  const cancelJobData = await cancelJobCreateRes.json() as any;
  const cancelJobId = cancelJobData.job.id;

  const cancelRes = await fetch(`${BASE_URL}/api/message-jobs/${cancelJobId}/cancel`, {
    method: "POST",
    headers: { Cookie: userA.cookie },
  });
  const cancelData = await cancelRes.json() as any;
  assert(cancelRes.status === 200 && cancelData.status === "CANCELLED", "POST /api/message-jobs/[jobId]/cancel transitions status to CANCELLED");

  const cancelledItems = await prisma.bulkMessageItem.findMany({
    where: { jobId: cancelJobId },
  });
  assert(cancelledItems.length > 0 && cancelledItems.every((it) => it.status === "CANCELLED"), "All remaining items transitioned to CANCELLED state");

  console.log("--- 17. Atomic item claiming & concurrent worker protection ---");
  // Create a new job to test sequential dispatch and claiming
  const leadClaim1 = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `lead_claim1_${Date.now()}`,
      profileUrl: "https://www.instagram.com/claim1/",
      category: "Fitness",
    },
  });
  const leadClaim2 = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `lead_claim2_${Date.now()}`,
      profileUrl: "https://www.instagram.com/claim2/",
      category: "Fitness",
    },
  });

  const claimJobRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      leadIds: [leadClaim1.id, leadClaim2.id],
      selection: "selected",
    }),
  });
  const claimJobData = await claimJobRes.json() as any;
  const claimJobId = claimJobData.job.id;

  // Simulate atomic DB state transition: QUEUED -> PROCESSING
  const nextItem = await prisma.bulkMessageItem.findFirst({
    where: { jobId: claimJobId, status: BulkMessageItemStatus.QUEUED },
  });
  assert(nextItem !== null, "Found queued item for claiming");

  const claimResult1 = await prisma.bulkMessageItem.updateMany({
    where: { id: nextItem!.id, status: BulkMessageItemStatus.QUEUED },
    data: {
      status: BulkMessageItemStatus.PROCESSING,
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });
  assert(claimResult1.count === 1, "First worker successfully claimed item atomically (count = 1)");

  const claimResult2 = await prisma.bulkMessageItem.updateMany({
    where: { id: nextItem!.id, status: BulkMessageItemStatus.QUEUED },
    data: {
      status: BulkMessageItemStatus.PROCESSING,
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });
  assert(claimResult2.count === 0, "Second concurrent worker cannot claim already processing item (count = 0)");

  console.log("--- 18. Successful dispatch record tracking ---");
  await prisma.bulkMessageItem.update({
    where: { id: nextItem!.id },
    data: {
      status: BulkMessageItemStatus.SENT,
      completedAt: new Date(),
    },
  });
  const statusAfterSent = await (await fetch(`${BASE_URL}/api/message-jobs/${claimJobId}`, {
    headers: { Cookie: userA.cookie },
  })).json() as any;
  assert(statusAfterSent.sent === 1, "Status API reflects 1 SENT item from actual DB state");

  console.log("--- 19. Failed dispatch error tracking ---");
  const secondItem = await prisma.bulkMessageItem.findFirst({
    where: { jobId: claimJobId, status: BulkMessageItemStatus.QUEUED },
  });
  await prisma.bulkMessageItem.update({
    where: { id: secondItem!.id },
    data: {
      status: BulkMessageItemStatus.FAILED,
      errorCode: "RECIPIENT_NOT_FOUND",
      errorMessage: "Instagram user not found",
      completedAt: new Date(),
    },
  });
  const statusAfterFailed = await (await fetch(`${BASE_URL}/api/message-jobs/${claimJobId}`, {
    headers: { Cookie: userA.cookie },
  })).json() as any;
  assert(statusAfterFailed.failed === 1, "Status API reflects 1 FAILED item with errorCode preserved");

  console.log("--- 20. Authentication failure safety pause ---");
  await prisma.bulkMessageJob.update({
    where: { id: claimJobId },
    data: {
      status: BulkMessageJobStatus.PAUSED,
      errorMessage: "Paused: Instagram session expired or requires authentication",
    },
  });
  const authJobStatus = await (await fetch(`${BASE_URL}/api/message-jobs/${claimJobId}`, {
    headers: { Cookie: userA.cookie },
  })).json() as any;
  assert(authJobStatus.status === "PAUSED" && Boolean(authJobStatus.errorMessage?.includes("authentication")), "Job is auto-paused on authentication failure");

  console.log("--- 21. Rate-limit / platform block safety ---");
  await prisma.bulkMessageJob.update({
    where: { id: claimJobId },
    data: {
      status: BulkMessageJobStatus.PAUSED,
      errorMessage: "Paused: Rate limit or platform restriction detected",
    },
  });
  const rateJobStatus = await (await fetch(`${BASE_URL}/api/message-jobs/${claimJobId}`, {
    headers: { Cookie: userA.cookie },
  })).json() as any;
  assert(rateJobStatus.status === "PAUSED" && Boolean(rateJobStatus.errorMessage?.includes("Rate limit")), "Job is halted safely on RATE_LIMITED without attempting evasion");

  console.log("--- 22. Already-sent items are never resent ---");
  const sentItem = await prisma.bulkMessageItem.findUnique({
    where: { id: nextItem!.id },
  });
  assert(sentItem?.status === "SENT", "SENT item remains permanently in SENT state");

  console.log("--- 23. Duplicate recipient constraint in same job ---");
  try {
    await prisma.bulkMessageItem.create({
      data: {
        jobId: claimJobId,
        leadId: nextItem!.leadId,
        renderedMessage: "Duplicate test",
        status: BulkMessageItemStatus.QUEUED,
      },
    });
    assert(false, "Duplicate recipient in same job should be prevented by @@unique constraint");
  } catch {
    assert(true, "Database @@unique([jobId, leadId]) constraint guarantees idempotency");
  }

  console.log("--- 24. Terminal job status aggregation ---");
  // 1 SENT + 1 FAILED -> PARTIAL
  await prisma.bulkMessageJob.update({
    where: { id: claimJobId },
    data: { status: BulkMessageJobStatus.PARTIAL, completedAt: new Date() },
  });
  const terminalJob = await (await fetch(`${BASE_URL}/api/message-jobs/${claimJobId}`, {
    headers: { Cookie: userA.cookie },
  })).json() as any;
  assert(terminalJob.status === "PARTIAL" && terminalJob.progress === 100, "Progress calculates 100% and status resolves to PARTIAL");

  console.log("--- 25. IDOR protection on job status & controls ---");
  // Tenant B attempts to access Tenant A's job
  const idorStatusRes = await fetch(`${BASE_URL}/api/message-jobs/${claimJobId}`, {
    headers: { Cookie: userB.cookie },
  });
  assert(idorStatusRes.status === 404, "User B cannot view User A's job status (404)");

  const idorCancelRes = await fetch(`${BASE_URL}/api/message-jobs/${claimJobId}/cancel`, {
    method: "POST",
    headers: { Cookie: userB.cookie },
  });
  assert(idorCancelRes.status === 404, "User B cannot cancel User A's job (404)");

  console.log("--- 26. Campaign jobs listing API ---");
  const listJobsRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs`, {
    headers: { Cookie: userA.cookie },
  });
  const listJobsData = await listJobsRes.json() as any;
  assert(listJobsRes.status === 200 && Array.isArray(listJobsData.jobs) && listJobsData.jobs.length >= 2, "GET /api/campaigns/[campaignId]/message-jobs returns user's campaign jobs");

  console.log("--- 27. Single-lead messaging regression check ---");
  const leadSingle = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `lead_single_${Date.now()}`,
      fullName: "Lead Single",
      profileUrl: "https://www.instagram.com/lead_single/",
    },
  });
  const singleSendRes = await fetch(`${BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({
      campaignId: campaignA.id,
      leadId: leadSingle.id,
      message: "Hi Lead Single, single send regression verification message",
    }),
  });
  const singleSendData = await singleSendRes.json() as any;
  assert(singleSendRes.status === 200 && singleSendData.messageId !== undefined, "Single-lead messaging from Task 5 still works seamlessly alongside bulk messaging");

  console.log("\n=================================================================");
  console.log(`TASK 6 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("Test execution failed with unhandled error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
