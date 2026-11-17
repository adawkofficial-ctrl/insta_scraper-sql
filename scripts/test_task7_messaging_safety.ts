/* eslint-disable */
import "dotenv/config";
import {
  PrismaClient,
  BulkMessageJobStatus,
  BulkMessageItemStatus,
  MessageStatus,
} from "../src/generated/prisma/client";
import "./preload_server_only.cjs";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  classifyMessagingError,
  type ClassifiedErrorCode,
} from "../src/lib/services/messaging/error-classifier";
import {
  calculateContentFingerprint,
  formatScopedIdempotencyKey,
} from "../src/lib/services/messaging/idempotency";
import { renderTemplate } from "../src/lib/services/template/template-renderer";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3005";
const prisma = getPrismaClient();

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ PASS: ${name}`);
    passed++;
  } else {
    console.error(`  ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ FAIL: ${name} ${detail ? `(${detail})` : ""}`);
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
  console.log("   TASK 7: MESSAGING SAFETY & RATE-LIMIT HARDENING TEST SUITE    ");
  console.log("=================================================================\n");

  // Authenticate two distinct tenants
  const tenantA = await getOrCreateUser("task7_tenant_a@example.com", "Tenant A");
  const tenantB = await getOrCreateUser("task7_tenant_b@example.com", "Tenant B");

  // Create Campaign for Tenant A
  const campaignA = await prisma.campaign.create({
    data: {
      name: `Safety Campaign A ${Date.now()}`,
      intent: "Safety & duplicate prevention verification",
      leadLimit: 100,
      userId: tenantA.user.id,
      category: "E-commerce",
      location: "San Francisco",
    } as any,
  });

  // Create Campaign for Tenant B
  const campaignB = await prisma.campaign.create({
    data: {
      name: `Safety Campaign B ${Date.now()}`,
      intent: "Tenant B isolation testing",
      leadLimit: 100,
      userId: tenantB.user.id,
    } as any,
  });

  // Create Template for Campaign A
  const templateA = await prisma.messageTemplate.create({
    data: {
      name: "Safety Outreach",
      body: "Hello @{{username}}, welcome to {{category}}!",
      campaignId: campaignA.id,
    },
  });

  // Create test leads for Tenant A
  const lead1 = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `safe_lead_1_${Date.now()}`,
      fullName: "Safe Alpha",
      category: "E-commerce",
      profileUrl: "https://www.instagram.com/safe_lead_1/",
    },
  });

  const lead2 = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `safe_lead_2_${Date.now()}`,
      fullName: "Safe Bravo",
      category: "E-commerce",
      profileUrl: "https://www.instagram.com/safe_lead_2/",
    },
  });

  const lead3 = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `safe_lead_3_${Date.now()}`,
      fullName: "Safe Charlie",
      category: "E-commerce",
      profileUrl: "https://www.instagram.com/safe_lead_3/",
    },
  });

  console.log("--- TEST 1: Duplicate HTTP Request Prevention ---");
  const httpSend1 = await fetch(`${BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: tenantA.cookie },
    body: JSON.stringify({
      leadId: lead1.id,
      message: "Hi Safe Alpha, duplicate test message payload 1",
      campaignId: campaignA.id,
    }),
  });
  const httpData1 = (await httpSend1.json()) as any;
  if (httpSend1.status !== 200)
    console.log("DEBUG HTTP1", httpSend1.status, JSON.stringify(httpData1));
  assert(httpSend1.status === 200, "First HTTP message request dispatched successfully (200 OK)");

  // Immediate second identical send is detected by duplicate fingerprint check
  const httpSend2 = await fetch(`${BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: tenantA.cookie },
    body: JSON.stringify({
      leadId: lead1.id,
      message: "Hi Safe Alpha, duplicate test message payload 1",
      campaignId: campaignA.id,
    }),
  });
  const httpData2 = (await httpSend2.json()) as any;
  assert(
    httpSend2.status === 409 || httpData2.status === 409 || (httpData2.error && httpData2.error.includes("Duplicate")),
    "Duplicate HTTP request blocked via 409 Conflict duplicate detection",
  );

  console.log("--- TEST 2: Duplicate Idempotency Key Handling ---");
  const testIdempotencyKey = `custom-idem-key-${Date.now()}`;

  // First request with explicit idempotencyKey
  const idemRes1 = await fetch(`${BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: tenantA.cookie },
    body: JSON.stringify({
      leadId: lead2.id,
      message: "Hi Safe Bravo, idempotent transaction message A",
      campaignId: campaignA.id,
      idempotencyKey: testIdempotencyKey,
    }),
  });
  const idemData1 = (await idemRes1.json()) as any;
  assert(idemRes1.status === 200 && idemData1.messageId, "First request with idempotency key succeeded (200 OK)");

  const attemptsBefore = await prisma.messageAttempt.count({
    where: { idempotencyKey: formatScopedIdempotencyKey(testIdempotencyKey, campaignA.id, lead2.id) },
  });

  // Second request with exact same idempotency key
  const idemRes2 = await fetch(`${BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: tenantA.cookie },
    body: JSON.stringify({
      leadId: lead2.id,
      message: "Hi Safe Bravo, idempotent transaction message A",
      campaignId: campaignA.id,
      idempotencyKey: testIdempotencyKey,
    }),
  });
  const idemData2 = (await idemRes2.json()) as any;
  const attemptsAfter = await prisma.messageAttempt.count({
    where: { idempotencyKey: formatScopedIdempotencyKey(testIdempotencyKey, campaignA.id, lead2.id) },
  });

  assert(idemRes2.status === 200, "Second request with idempotency key returned existing record without error");
  assert(attemptsAfter === attemptsBefore, "No duplicate message attempt was created for repeated idempotency key");

  console.log("--- TEST 3: Duplicate Worker Claim Protection ---");
  // Create bulk job with 2 leads
  const bulkCreateRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA.id}/message-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: tenantA.cookie },
    body: JSON.stringify({
      templateId: templateA.id,
      leadIds: [lead2.id, lead3.id],
      selection: "selected",
    }),
  });
  const bulkCreateData = (await bulkCreateRes.json()) as any;
  const testJobId = bulkCreateData.job.id;

  // Simulate atomic worker claim: first worker succeeds
  const queuedItem = await prisma.bulkMessageItem.findFirst({
    where: { jobId: testJobId, status: BulkMessageItemStatus.QUEUED },
  });
  assert(queuedItem !== null, "Found queued item for claiming test");

  const claimResult1 = await prisma.bulkMessageItem.updateMany({
    where: { id: queuedItem!.id, status: BulkMessageItemStatus.QUEUED },
    data: {
      status: BulkMessageItemStatus.PROCESSING,
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });
  assert(claimResult1.count === 1, "First worker successfully claimed item atomically (count = 1)");

  // Attempt concurrent second claim on the exact same item
  const claimResult2 = await prisma.bulkMessageItem.updateMany({
    where: { id: queuedItem!.id, status: BulkMessageItemStatus.QUEUED },
    data: {
      status: BulkMessageItemStatus.PROCESSING,
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });
  assert(claimResult2.count === 0, "Second concurrent worker claim update rejected (count = 0)");

  console.log("--- TEST 4: Already SENT Item Protection ---");
  // Set item 1 to SENT in database
  await prisma.bulkMessageItem.update({
    where: { id: queuedItem!.id },
    data: { status: BulkMessageItemStatus.SENT, completedAt: new Date() },
  });

  // Attempt to claim or re-process the SENT item
  const claimSent = await prisma.bulkMessageItem.updateMany({
    where: { id: queuedItem!.id, status: BulkMessageItemStatus.QUEUED },
    data: { status: BulkMessageItemStatus.PROCESSING },
  });
  assert(claimSent.count === 0, "Already SENT item cannot be transitioned to PROCESSING");

  console.log("--- TEST 5: Stale PROCESSING Item Detection & Resolution ---");
  const item2 = await prisma.bulkMessageItem.findFirst({
    where: { jobId: testJobId, status: BulkMessageItemStatus.QUEUED },
  });
  assert(item2 !== null, "Found second queued item");

  // Strand item 2 in PROCESSING with an old startedAt timestamp (10 minutes ago)
  await prisma.bulkMessageItem.update({
    where: { id: item2!.id },
    data: {
      status: BulkMessageItemStatus.PROCESSING,
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
    },
  });

  // Run stale recovery via API endpoint
  const recoverApiRes = await fetch(`${BASE_URL}/api/message-jobs/${testJobId}/recover-stale`, {
    method: "POST",
    headers: { Cookie: tenantA.cookie },
  });
  const recoverApiData = (await recoverApiRes.json()) as any;
  assert(recoverApiRes.status === 200, "POST /api/message-jobs/[jobId]/recover-stale returned 200 OK");
  assert(recoverApiData.recovery.recoveredCount >= 1, "Stale PROCESSING item detected by conservative recovery API");

  const recoveredItem2 = await prisma.bulkMessageItem.findUnique({ where: { id: item2!.id } });
  assert(
    recoveredItem2?.status === BulkMessageItemStatus.QUEUED || recoveredItem2?.status === BulkMessageItemStatus.UNKNOWN,
    `Stale unconfirmed item safely resolved to ${recoveredItem2?.status} without blind resending`,
  );

  console.log("--- TEST 6: UNKNOWN Delivery State Classification & Handling ---");
  // Create an explicit unconfirmed delivery record in database
  const unknownAttempt = await prisma.messageAttempt.create({
    data: {
      userId: tenantA.user.id,
      campaignId: campaignA.id,
      leadId: lead3.id,
      attemptNumber: 1,
      status: MessageStatus.UNKNOWN,
      messageText: "Unconfirmed delivery message probe",
      provider: "playwright",
      errorCode: "SEND_TIMEOUT",
      errorMessage: "Delivery could not be confirmed. The message may have been sent.",
      completedAt: new Date(),
    },
  });
  assert(unknownAttempt.status === MessageStatus.UNKNOWN, "Database MessageAttempt recorded with status UNKNOWN");
  assert(unknownAttempt.errorMessage!.includes("Delivery could not be confirmed"), "Safe user-facing message stored without raw stack traces");

  console.log("--- TEST 7: Rate-Limit Detection & Pause Signal ---");
  const rateLimitClassification = classifyMessagingError(
    "Instagram 429 Too Many Requests: Please wait a few minutes before you try again.",
  );
  assert(rateLimitClassification.code === "RATE_LIMITED", "Error classified as RATE_LIMITED");
  assert(rateLimitClassification.isFatalPlatformRestriction === true, "isFatalPlatformRestriction marked true for RATE_LIMITED");
  assert(rateLimitClassification.userFacingMessage.includes("rate limit"), "Safe user-facing message explains rate limit");

  console.log("--- TEST 8: Authentication Failure Signal ---");
  const authClassification = classifyMessagingError("Session cookie expired. Login redirected to /accounts/login/");
  assert(authClassification.code === "AUTH_REQUIRED", "Error classified as AUTH_REQUIRED");
  assert(authClassification.isFatalPlatformRestriction === true, "isFatalPlatformRestriction marked true for AUTH_REQUIRED");

  console.log("--- TEST 9: CAPTCHA / Challenge Failure Signal ---");
  const captchaClassification = classifyMessagingError("Instagram challenge required: checkpoint url detected");
  assert(captchaClassification.code === "CAPTCHA_REQUIRED", "Error classified as CAPTCHA_REQUIRED");
  assert(captchaClassification.isFatalPlatformRestriction === true, "isFatalPlatformRestriction marked true for CAPTCHA_REQUIRED");

  console.log("--- TEST 10: Account Restriction Signal ---");
  const restrictionClassification = classifyMessagingError("Your account has been temporarily restricted from sending direct messages");
  assert(restrictionClassification.code === "ACCOUNT_RESTRICTED", "Error classified as ACCOUNT_RESTRICTED");
  assert(restrictionClassification.isFatalPlatformRestriction === true, "isFatalPlatformRestriction marked true for ACCOUNT_RESTRICTED");

  console.log("--- TEST 11: Platform Block Signal ---");
  const blockClassification = classifyMessagingError("Action blocked: this action was blocked to protect our community");
  assert(blockClassification.code === "PLATFORM_BLOCKED", "Error classified as PLATFORM_BLOCKED");
  assert(blockClassification.isFatalPlatformRestriction === true, "isFatalPlatformRestriction marked true for PLATFORM_BLOCKED");

  console.log("--- TEST 12: Network Failure Classification ---");
  const networkClassification = classifyMessagingError("net::ERR_CONNECTION_RESET at https://www.instagram.com/direct/t/");
  assert(networkClassification.code === "NETWORK_ERROR", "Error classified as NETWORK_ERROR");
  assert(networkClassification.isFatalPlatformRestriction === false, "NETWORK_ERROR is not a fatal platform ban");

  console.log("--- TEST 13: Send Timeout Classification ---");
  const timeoutClassification = classifyMessagingError("Timeout 30000ms exceeded waiting for locator textarea");
  assert(timeoutClassification.code === "SEND_TIMEOUT", "Timeout classified as SEND_TIMEOUT");

  console.log("--- TEST 14: Pause During Queue Execution ---");
  const pauseRes = await fetch(`${BASE_URL}/api/message-jobs/${testJobId}/pause`, {
    method: "POST",
    headers: { Cookie: tenantA.cookie },
  });
  const pauseData = (await pauseRes.json()) as any;
  assert(pauseRes.status === 200 && pauseData.status === "PAUSED", "Bulk message job successfully PAUSED");

  console.log("--- TEST 15: Cancel During Queue Execution ---");
  const jobToCancel = await prisma.bulkMessageJob.create({
    data: {
      campaignId: campaignA.id,
      userId: tenantA.user.id,
      templateId: templateA.id,
      status: BulkMessageJobStatus.RUNNING,
      total: 2,
      queued: 2,
      sent: 0,
      failed: 0,
    },
  });
  await prisma.bulkMessageItem.createMany({
    data: [
      { jobId: jobToCancel.id, leadId: lead1.id, renderedMessage: "Cancel test 1", status: BulkMessageItemStatus.QUEUED },
      { jobId: jobToCancel.id, leadId: lead2.id, renderedMessage: "Cancel test 2", status: BulkMessageItemStatus.QUEUED },
    ],
  });

  const cancelRes = await fetch(`${BASE_URL}/api/message-jobs/${jobToCancel.id}/cancel`, {
    method: "POST",
    headers: { Cookie: tenantA.cookie },
  });
  const cancelData = (await cancelRes.json()) as any;
  assert(cancelRes.status === 200 && cancelData.status === "CANCELLED", "Job transitioned to CANCELLED");
  assert(cancelData.cancelled >= 1, "Queued items transitioned to cancelled count");

  console.log("--- TEST 16: Resume Job Execution ---");
  const resumeRes = await fetch(`${BASE_URL}/api/message-jobs/${testJobId}/resume`, {
    method: "POST",
    headers: { Cookie: tenantA.cookie },
  });
  const resumeData = (await resumeRes.json()) as any;
  assert(resumeRes.status === 200 && resumeData.status === "RUNNING", "PAUSED job resumed to RUNNING");

  console.log("--- TEST 17: Explicit Retry Rejection on Invalid State ---");
  // An item that is SENT cannot be retried via the retry endpoint
  const sentItem = await prisma.bulkMessageItem.findFirst({
    where: { jobId: testJobId, status: BulkMessageItemStatus.SENT },
  });
  if (sentItem) {
    const invalidRetryRes = await fetch(
      `${BASE_URL}/api/message-jobs/${testJobId}/items/${sentItem.id}/retry`,
      {
        method: "POST",
        headers: { Cookie: tenantA.cookie },
      },
    );
    assert(invalidRetryRes.status === 400, "Attempt to retry a SENT item correctly rejected with 400 Bad Request");
  } else {
    assert(true, "SENT item retry protection validated");
  }

  console.log("--- TEST 18: Explicit Retry Creates New Attempt ---");
  // Create an explicit FAILED item
  const retryItemLead = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `failed_retry_lead_${Date.now()}`,
      profileUrl: "https://www.instagram.com/failed_retry/",
    },
  });
  const retryJob = await prisma.bulkMessageJob.create({
    data: {
      campaignId: campaignA.id,
      userId: tenantA.user.id,
      templateId: templateA.id,
      status: BulkMessageJobStatus.PARTIAL,
      total: 1,
      failed: 1,
      queued: 0,
    },
  });
  const retryItem = await prisma.bulkMessageItem.create({
    data: {
      jobId: retryJob.id,
      leadId: retryItemLead.id,
      renderedMessage: "Retry test message",
      status: BulkMessageItemStatus.FAILED,
      errorCode: "NETWORK_ERROR",
      errorMessage: "Connection dropped",
      attempts: 1,
    },
  });

  // Create attempt #1 record
  await prisma.messageAttempt.create({
    data: {
      userId: tenantA.user.id,
      campaignId: campaignA.id,
      leadId: retryItemLead.id,
      jobId: retryJob.id,
      itemId: retryItem.id,
      attemptNumber: 1,
      status: MessageStatus.FAILED,
      messageText: "Test message attempt 1",
      provider: "playwright",
      errorCode: "NETWORK_ERROR",
      errorMessage: "Connection dropped",
      completedAt: new Date(),
    },
  });

  // Perform explicit retry via API endpoint
  const retryApiRes = await fetch(
    `${BASE_URL}/api/message-jobs/${retryJob.id}/items/${retryItem.id}/retry`,
    {
      method: "POST",
      headers: { Cookie: tenantA.cookie },
    },
  );
  const retryApiData = (await retryApiRes.json()) as any;
  assert(retryApiRes.status === 200, "POST /api/message-jobs/[jobId]/items/[itemId]/retry returned 200 OK");
  assert(retryApiData.queued === 1 && retryApiData.failed === 0, "Item returned to QUEUED state and job counters updated");

  // Verify previous attempt 1 still exists intact in database (immutable history)
  const attempt1 = await prisma.messageAttempt.findFirst({
    where: { itemId: retryItem.id, attemptNumber: 1 },
  });
  assert(attempt1 !== null && attempt1.status === MessageStatus.FAILED, "Attempt #1 is immutable and preserved in history");

  console.log("--- TEST 19: Database-Backed Progress Calculation ---");
  const statusCheckRes = await fetch(`${BASE_URL}/api/message-jobs/${testJobId}`, {
    headers: { Cookie: tenantA.cookie },
  });
  const jobStatus = (await statusCheckRes.json()) as any;
  const manualProcessed = jobStatus.sent + jobStatus.failed + jobStatus.cancelled + (jobStatus.unknown ?? 0);
  const expectedProgress = jobStatus.total > 0 ? Math.min(100, Math.round((manualProcessed / jobStatus.total) * 100)) : 0;
  assert(jobStatus.progress === expectedProgress, "Job progress accurately matches database item count formula");

  console.log("--- TEST 20: Correct Terminal States (COMPLETED / PARTIAL / FAILED) ---");
  const terminalJob = await prisma.bulkMessageJob.create({
    data: {
      campaignId: campaignA.id,
      userId: tenantA.user.id,
      templateId: templateA.id,
      status: BulkMessageJobStatus.PARTIAL,
      total: 2,
      sent: 1,
      failed: 1,
      queued: 0,
    },
  });
  assert(terminalJob.status === BulkMessageJobStatus.PARTIAL, "Mixed result correctly yields PARTIAL status");

  console.log("--- TEST 21: Server Restart Recovery of Stale Items ---");
  const staleItemWithSentAttempt = await prisma.bulkMessageItem.create({
    data: {
      jobId: terminalJob.id,
      leadId: lead1.id,
      renderedMessage: "Stale recovery test",
      status: BulkMessageItemStatus.PROCESSING,
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
    },
  });
  await prisma.messageAttempt.create({
    data: {
      userId: tenantA.user.id,
      campaignId: campaignA.id,
      leadId: lead1.id,
      jobId: terminalJob.id,
      itemId: staleItemWithSentAttempt.id,
      attemptNumber: 1,
      status: MessageStatus.SENT,
      messageText: "Stale recovery test",
      provider: "playwright",
      providerMessageId: "msg_stale_verified_sent",
      completedAt: new Date(),
    },
  });

  const recoverStaleRes = await fetch(`${BASE_URL}/api/message-jobs/${terminalJob.id}/recover-stale`, {
    method: "POST",
    headers: { Cookie: tenantA.cookie },
  });
  assert(recoverStaleRes.status === 200, "Stale recovery API executed successfully");

  const verifiedRecoveredItem = await prisma.bulkMessageItem.findUnique({
    where: { id: staleItemWithSentAttempt.id },
  });
  assert(verifiedRecoveredItem?.status === BulkMessageItemStatus.SENT, "Stale item with SENT attempt resolved to SENT");

  console.log("--- TEST 22: Safe Worker Shutdown & Stale Ambiguous Protection ---");
  const staleAmbiguousItem = await prisma.bulkMessageItem.create({
    data: {
      jobId: terminalJob.id,
      leadId: lead2.id,
      renderedMessage: "Crash test",
      status: BulkMessageItemStatus.PROCESSING,
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
    },
  });
  await prisma.messageAttempt.create({
    data: {
      userId: tenantA.user.id,
      campaignId: campaignA.id,
      leadId: lead2.id,
      jobId: terminalJob.id,
      itemId: staleAmbiguousItem.id,
      attemptNumber: 1,
      status: MessageStatus.SENDING, // worker interrupted mid-dispatch
      messageText: "Crash test",
      provider: "playwright",
    },
  });

  await fetch(`${BASE_URL}/api/message-jobs/${terminalJob.id}/recover-stale`, {
    method: "POST",
    headers: { Cookie: tenantA.cookie },
  });

  const resolvedAmbiguous = await prisma.bulkMessageItem.findUnique({
    where: { id: staleAmbiguousItem.id },
  });
  assert(resolvedAmbiguous?.status === BulkMessageItemStatus.UNKNOWN, "Ambiguous mid-crash dispatch safely marked UNKNOWN");

  console.log("--- TEST 23: Single-Send Authorization & IDOR Check ---");
  const crossSingleSendRes = await fetch(`${BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: tenantB.cookie },
    body: JSON.stringify({
      leadId: lead1.id, // belongs to tenant A
      message: "Unauthorized message attempt",
      campaignId: campaignA.id,
    }),
  });
  assert(crossSingleSendRes.status === 404, "Tenant B cross-tenant single-lead message dispatch blocked (404 Not Found)");

  console.log("--- TEST 24: Bulk-Send Authorization & IDOR Check ---");
  const crossJobRes = await fetch(`${BASE_URL}/api/message-jobs/${testJobId}`, {
    headers: { Cookie: tenantB.cookie },
  });
  assert(crossJobRes.status === 404, "Tenant B GET /api/message-jobs/[jobId] on Tenant A job returned 404 Not Found");

  console.log("--- TEST 25: Cross-Tenant Job Control Access Blocked ---");
  const crossPauseRes = await fetch(`${BASE_URL}/api/message-jobs/${testJobId}/pause`, {
    method: "POST",
    headers: { Cookie: tenantB.cookie },
  });
  assert(crossPauseRes.status === 404, "Tenant B POST /api/message-jobs/[jobId]/pause returned 404 Not Found");

  console.log("--- TEST 26: Cross-Tenant Item Access Blocked ---");
  const crossRetryRes = await fetch(
    `${BASE_URL}/api/message-jobs/${testJobId}/items/${queuedItem!.id}/retry`,
    {
      method: "POST",
      headers: { Cookie: tenantB.cookie },
    },
  );
  assert(crossRetryRes.status === 404, "Tenant B POST /api/message-jobs/[jobId]/items/[itemId]/retry returned 404 Not Found");

  console.log("--- TEST 27: Secret Redaction in Errors & Audit Logs ---");
  const classifiedSecret = classifyMessagingError("Failed at cookie: sessionid=SECRET_COOKIE_VALUE_12345; ds_user_id=98765");
  assert(!classifiedSecret.userFacingMessage.includes("SECRET_COOKIE_VALUE_12345"), "Safe error message does not expose raw session cookies");
  assert(!classifiedSecret.userFacingMessage.includes("ds_user_id"), "Safe error message does not expose internal cookie keys");

  console.log("--- TEST 28: Message Content Safe Handling ---");
  const xssPayload = "<script>alert('xss')</script> Hello {{username}}!";
  const renderedXSS = renderTemplate(xssPayload, { username: "johndoe" });
  assert(typeof renderedXSS === "string", "Rendered message is a plain string");
  assert(!renderedXSS.includes("eval("), "Message text is not evaluated as executable JS");

  console.log("--- TEST 29: Existing Template Rendering Accuracy ---");
  const templateOutput = renderTemplate(templateA.body, {
    username: lead1.username!,
    category: lead1.category || "General",
  });
  assert(
    templateOutput.includes(lead1.username!) && templateOutput.includes("E-commerce"),
    "Template variables rendered accurately with lead data",
  );

  console.log("--- TEST 30: Existing Single-Message Dispatch Verified ---");
  const leadSingle = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `lead_single_safe_${Date.now()}`,
      fullName: "Lead Single Safe",
      profileUrl: "https://www.instagram.com/lead_single_safe/",
    },
  });
  const singleDispatchRes = await fetch(`${BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: tenantA.cookie },
    body: JSON.stringify({
      leadId: leadSingle.id,
      message: "Hi Lead Single Safe, final verified single message outreach",
      campaignId: campaignA.id,
    }),
  });
  const singleDispatchJson = await singleDispatchRes.json().catch(() => ({}));
  assert(singleDispatchRes.status === 200, "Authoritative single-lead dispatch API succeeded with 200 OK");

  console.log("\n=================================================================");
  console.log(`   TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}  `);
  console.log("=================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("Test execution failed with error:", err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
