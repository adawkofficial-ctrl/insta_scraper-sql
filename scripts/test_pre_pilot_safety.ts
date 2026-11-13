import "dotenv/config";
// Test doubles (Apify mock) are only honored when NODE_ENV=test.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
import assert from "node:assert";
import type { MessagingProvider } from "../src/lib/services/messaging/messaging-provider";

// Mock server-only before importing server code in standalone script
try {
  const serverOnlyPath = require.resolve("server-only");
  require.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    exports: {},
  } as unknown as NodeModule;
} catch {}

async function run() {
  const { getPrismaClient } = await import("../src/lib/db/prisma");
  const {
    UnipileClient,
    isUnipileMockMode,
    getUnipileReadTimeoutMs,
    getUnipileSendTimeoutMs,
  } = await import("../src/lib/services/unipile/unipile-client");
  const { GET: readyProbe } = await import("../src/app/api/health/ready/route");
  const { isDryRunMode } = await import("../src/lib/services/scraper/apify-cost-guard");
  const { setApifyClientForTesting, hasMockApifyClient } = await import("../src/lib/services/scraper/apify-client");
  const {
    setSendGateClock,
    getSendGateNow,
    reserveSendSlot,
    releaseSendSlot,
    reconcileUnknownSendSlot,
  } = await import("../src/lib/services/messaging/send-gate");
  const {
    sendSingleMessage,
    setMessagingProvider,
  } = await import("../src/lib/services/messaging");
  const {
    dispatchDueFollowUps,
    scheduleFollowUpsForLead,
  } = await import("../src/lib/services/messaging/follow-up-service");
  const { MessageStatus, FollowUpStatus, LeadStatus } = await import("../src/generated/prisma/enums");

  console.log("=== PRE-PILOT SAFETY SUITE ===");
  const prisma = getPrismaClient();

  // -------------------------------------------------------------------------
  // SECTION 1: Mock Guard Verification
  // -------------------------------------------------------------------------
  console.log("\n[Section 1] Mock Guard Verification");

  const originalNodeEnv = process.env.NODE_ENV;
  const originalMockUnipile = process.env.MOCK_UNIPILE;
  const originalApifyDryRun = process.env.APIFY_DRY_RUN;

  try {
    // 1A: isUnipileMockMode returns false in production/development even if MOCK_UNIPILE=1
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.MOCK_UNIPILE = "1";
    assert.strictEqual(isUnipileMockMode(), false, "isUnipileMockMode must return false in production");

    (process.env as Record<string, string>).NODE_ENV = "development";
    assert.strictEqual(isUnipileMockMode(), false, "isUnipileMockMode must return false in development");

    (process.env as Record<string, string>).NODE_ENV = "test";
    assert.strictEqual(isUnipileMockMode(), true, "isUnipileMockMode must return true in test when MOCK_UNIPILE=1");
    console.log("  PASS: isUnipileMockMode only works when NODE_ENV === 'test'");

    // 1B: /api/health/ready fails when MOCK_UNIPILE=1 in production
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.MOCK_UNIPILE = "1";
    const resReady = await readyProbe();
    assert.strictEqual(resReady.status, 503, "/api/health/ready must return 503 if MOCK_UNIPILE=1 in production");
    const jsonReady = (await resReady.json()) as { checks: Record<string, string>; status: string };
    assert.strictEqual(jsonReady.checks.mock_unipile, "mock_mode_prohibited_in_production");
    console.log("  PASS: /api/health/ready fails (503) if MOCK_UNIPILE is set in production");

    // 1C: isDryRunMode returns false in production even if APIFY_DRY_RUN="true"
    process.env.APIFY_DRY_RUN = "true";
    assert.strictEqual(isDryRunMode(), false, "isDryRunMode must be false in production");
    console.log("  PASS: isDryRunMode is strictly false in production");

    // 1D: setApifyClientForTesting is locked down outside test mode
    (process.env as Record<string, string>).NODE_ENV = "production";
    assert.throws(
      () => setApifyClientForTesting({} as any),
      /test-only/,
      "setApifyClientForTesting must throw outside test instead of silently installing a mock",
    );
    assert.strictEqual(hasMockApifyClient(), false, "setApifyClientForTesting must not install a mock outside test");
    console.log("  PASS: setApifyClientForTesting is rejected outside NODE_ENV=test");

    // 1E: setSendGateClock is locked down outside test mode
    (process.env as Record<string, string>).NODE_ENV = "production";
    const fakeTime = new Date("2020-01-01T12:00:00Z");
    setSendGateClock(() => fakeTime);
    assert.notStrictEqual(
      getSendGateNow().toISOString(),
      fakeTime.toISOString(),
      "getSendGateNow must not return injected clock in production",
    );
    console.log("  PASS: setSendGateClock is rejected outside NODE_ENV=test");
  } finally {
    (process.env as Record<string, string>).NODE_ENV = originalNodeEnv ?? "test";
    process.env.MOCK_UNIPILE = originalMockUnipile;
    process.env.APIFY_DRY_RUN = originalApifyDryRun;
  }

  // -------------------------------------------------------------------------
  // SECTION 2: Timeout Configuration & Values
  // -------------------------------------------------------------------------
  console.log("\n[Section 2] Timeout Configuration");

  try {
    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.UNIPILE_READ_TIMEOUT_MS;
    delete process.env.UNIPILE_SEND_TIMEOUT_MS;
    assert.strictEqual(getUnipileReadTimeoutMs(), 15000, "Default production read timeout is 15000ms");
    assert.strictEqual(getUnipileSendTimeoutMs(), 45000, "Default production send timeout is 45000ms");

    process.env.UNIPILE_READ_TIMEOUT_MS = "12000";
    process.env.UNIPILE_SEND_TIMEOUT_MS = "35000";
    assert.strictEqual(getUnipileReadTimeoutMs(), 12000, "Configurable read timeout via env");
    assert.strictEqual(getUnipileSendTimeoutMs(), 35000, "Configurable send timeout via env");
    console.log("  PASS: Configurable per-call timeouts for reads (15s) and sends (45s)");
  } finally {
    (process.env as Record<string, string>).NODE_ENV = originalNodeEnv ?? "test";
    delete process.env.UNIPILE_READ_TIMEOUT_MS;
    delete process.env.UNIPILE_SEND_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // SECTION 3: Timeout on Send -> UNKNOWN -> No Retry, No Duplicate
  // -------------------------------------------------------------------------
  console.log("\n[Section 3] Timeout on Send -> UNKNOWN -> Reconciliation Guard");

  // Create test user, campaign, lead, sender
  const timestamp = Date.now();
  const testUser = await prisma.user.create({
    data: {
      email: `safety_test_${timestamp}@example.com`,
      passwordHash: "hash_test_12345678901234567890",
      role: "USER",
    },
  });

  const testProfile = await prisma.companyProfile.create({
    data: {
      userId: testUser.id,
      name: `Profile_${timestamp}`,
      description: "Quality service",
      targetIndustries: ["Hospitality"],
    },
  });

  const testCampaign = await prisma.campaign.create({
    data: {
      userId: testUser.id,
      companyProfileId: testProfile.id,
      name: `Safety Campaign ${timestamp}`,
      status: "RUNNING",
      followUpEnabled: true,
      followUpCount: 1,
      followUpDelayDays: [1],
      followUpTemplates: ["Follow up after timeout"],
    },
  });

  const testSender = await prisma.instagramSenderAccount.create({
    data: {
      userId: testUser.id,
      username: `sender_${timestamp}`,
      status: "CONNECTED",
      sessionPath: `sessions/sender_${timestamp}`,
      dailyCap: 50,
      hourlyCap: 10,
      workingHoursStart: 0,
      workingHoursEnd: 24,
      warmupStartedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });

  const testLead = await prisma.lead.create({
    data: {
      userId: testUser.id,
      campaignId: testCampaign.id,
      username: `recipient_${timestamp}`,
      fullName: "Jane Doe",
      profileUrl: `https://instagram.com/recipient_${timestamp}`,
      status: LeadStatus.READY_FOR_OUTREACH,
    },
  });

  // Inject a mock messaging provider that simulates a timeout on send
  const timeoutMockProvider: MessagingProvider = {
    name: "mock_timeout_provider",
    async connect() {},
    async disconnect() {},
    async getStatus() {
      return { provider: "mock_timeout_provider", authenticated: true, status: "READY" };
    },
    async sendMessage() {
      return {
        success: false,
        provider: "mock_timeout_provider",
        messageText: "Test message",
        error: {
          code: "SEND_TIMEOUT",
          message: "Send request timed out after 45000ms. Delivery state is unknown.",
        },
      };
    },
  };

  setMessagingProvider(timeoutMockProvider);

  // Set fake clock inside working hours (Monday 10:00 UTC)
  setSendGateClock(() => new Date("2026-11-02T10:00:00Z"));

  // Send single message that times out
  const sendRes = await sendSingleMessage(
    {
      campaignId: testCampaign.id,
      leadId: testLead.id,
      message: "Initial outreach message",
      senderAccountId: testSender.id,
      step: "1",
    },
    testUser.id,
  );

  assert.strictEqual(sendRes.success, false, "Send must report not successful");
  assert.strictEqual(sendRes.status, "UNKNOWN", "Status must be UNKNOWN on send timeout");
  console.log("  PASS: Single send timeout resulted in status UNKNOWN");

  // Verify DB record has status UNKNOWN
  const dbMessage = await prisma.message.findFirst({
    where: { leadId: testLead.id, campaignId: testCampaign.id },
  });
  assert(dbMessage, "Message record must exist in DB");
  assert.strictEqual(dbMessage.status, MessageStatus.UNKNOWN, "Message DB status is UNKNOWN");
  console.log("  PASS: DB message is marked UNKNOWN (not FAILED)");

  // Attempt to reserve the same slot again without reconciliation -> MUST BE BLOCKED
  const duplicateReserve = await reserveSendSlot({
    senderAccountId: testSender.id,
    campaignId: testCampaign.id,
    leadId: testLead.id,
    step: "1",
    messageText: "Initial outreach message",
    now: new Date("2026-11-02T10:01:00Z"),
  });

  assert.strictEqual(duplicateReserve.success, false, "Reserve must fail for UNKNOWN slot");
  assert.strictEqual(
    duplicateReserve.reason,
    "UNKNOWN_DELIVERY_REQUIRES_RECONCILIATION",
    "Must block auto-retry and duplicate sends with UNKNOWN_DELIVERY_REQUIRES_RECONCILIATION",
  );
  console.log("  PASS: Unreconciled UNKNOWN slot blocks subsequent reserve (no duplicate / no blind retry)");

  // Reconcile the unknown slot (e.g. after checking thread, confirmed FAILED)
  await reconcileUnknownSendSlot(testCampaign.id, testLead.id, "1", "FAILED");
  console.log("  PASS: reconcileUnknownSendSlot updated slot state");

  // -------------------------------------------------------------------------
  // SECTION 4: Follow-up Dispatcher Timeout -> UNKNOWN -> No Auto-Retry
  // -------------------------------------------------------------------------
  console.log("\n[Section 4] Follow-up Dispatcher Timeout Guard");

  // Create a lead with a successfully sent first message
  const testLead2 = await prisma.lead.create({
    data: {
      userId: testUser.id,
      campaignId: testCampaign.id,
      username: `lead2_${timestamp}`,
      fullName: "Bob Smith",
      profileUrl: `https://instagram.com/lead2_${timestamp}`,
      status: LeadStatus.CONTACTED,
    },
  });

  const firstSentMessage = await prisma.message.create({
    data: {
      campaignId: testCampaign.id,
      leadId: testLead2.id,
      senderAccountId: testSender.id,
      status: MessageStatus.SENT,
      direction: "OUTBOUND",
      channel: "INSTAGRAM",
      messageText: "First message to Bob",
      sentAt: new Date("2026-11-01T10:00:00Z"),
    },
  });

  // Schedule follow-ups for lead2
  await scheduleFollowUpsForLead({
    campaignId: testCampaign.id,
    leadId: testLead2.id,
    sentAt: new Date("2026-11-01T10:00:00Z"),
    initialMessageText: "First message to Bob",
    senderAccountId: testSender.id,
  });

  // Advance clock to dueAt and dispatch with timeout mock provider
  const dispatchDueTime = new Date("2026-11-05T14:00:00Z");
  setSendGateClock(() => dispatchDueTime);

  const dispatchResult = await dispatchDueFollowUps({
    now: dispatchDueTime,
    messagingProvider: timeoutMockProvider,
  });

  // Follow-up was attempted, timed out, and marked SKIPPED (not FAILED, no retryAt)
  const followUpItem = await prisma.followUpMessage.findFirst({
    where: { campaignId: testCampaign.id, leadId: testLead2.id, step: 1 },
  });

  assert(followUpItem, "Follow-up item must exist");
  assert.strictEqual(followUpItem.status, FollowUpStatus.SKIPPED, "Status must be SKIPPED on timeout");
  assert.strictEqual(followUpItem.retryAt, null, "retryAt must be null (NO AUTO-RETRY)");
  assert.strictEqual(followUpItem.errorCode, "UNKNOWN", "errorCode must be UNKNOWN");
  console.log("  PASS: Follow-up dispatch timeout marks item SKIPPED with retryAt: null (no auto-retry)");

  // Re-run dispatch: must send 0 because retryAt is null
  const rerunResult = await dispatchDueFollowUps({
    now: new Date("2026-11-05T15:00:00Z"),
    messagingProvider: timeoutMockProvider,
  });
  assert.strictEqual(rerunResult.sent, 0, "Re-run dispatch must send 0");
  console.log("  PASS: Re-running dispatcher does not retry timed-out follow-up (no duplicate)");

  // Cleanup test data
  console.log("\nCleaning up test data...");
  await prisma.followUpMessage.deleteMany({ where: { campaignId: testCampaign.id } });
  await prisma.outboundSendIdempotency.deleteMany({ where: { campaignId: testCampaign.id } });
  await prisma.messageAttempt.deleteMany({ where: { campaignId: testCampaign.id } });
  await prisma.message.deleteMany({ where: { campaignId: testCampaign.id } });
  await prisma.lead.deleteMany({ where: { campaignId: testCampaign.id } });
  await prisma.campaign.deleteMany({ where: { id: testCampaign.id } });
  await prisma.companyProfile.deleteMany({ where: { id: testProfile.id } });
  await prisma.instagramSenderAccount.deleteMany({ where: { id: testSender.id } });
  await prisma.user.deleteMany({ where: { id: testUser.id } });

  // -------------------------------------------------------------------------
  // SECTION 4: Database Isolation Guard Verification
  // -------------------------------------------------------------------------
  console.log("\n[Section 4] Test Database Isolation Guard Verification");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { assertSafeTestDatabase, extractDatabaseName } = require("./test_db_guard.cjs");

  assert.strictEqual(
    extractDatabaseName("postgresql://user:pass@localhost:5432/insta_scraper_test?schema=public"),
    "insta_scraper_test",
    "extractDatabaseName must correctly extract db name"
  );

  // 4A: Blocks database matching /prod/i
  assert.throws(
    () => {
      assertSafeTestDatabase("postgresql://localhost:5432/insta_scraper_prod", { throwOnError: true });
    },
    /Refusing to run tests against production\/live database/,
    "Must refuse to run against database matching /prod/i"
  );

  // 4B: Blocks database matching /live/i
  assert.throws(
    () => {
      assertSafeTestDatabase("postgresql://localhost:5432/client_live_db", { throwOnError: true });
    },
    /Refusing to run tests against production\/live database/,
    "Must refuse to run against database matching /live/i"
  );

  // 4C: Blocks when DB equals primary DB and NODE_ENV=production
  assert.throws(
    () => {
      assertSafeTestDatabase("postgresql://localhost:5432/my_custom_db", {
        prodDbUrl: "postgresql://localhost:5432/my_custom_db",
        nodeEnv: "production",
        throwOnError: true,
      });
    },
    /Refusing to run tests against primary database/,
    "Must refuse when test DB equals primary DB while NODE_ENV=production"
  );

  // 4D: Allows safe test DB
  assert.doesNotThrow(() => {
    assertSafeTestDatabase("postgresql://localhost:5432/insta_scraper_test", { throwOnError: true });
  }, "Must allow dedicated test database");
  console.log("  PASS: Database isolation guard blocks prod/live DBs and production collisions");

  // Reset clock and provider
  setSendGateClock(null);
  setMessagingProvider(null);

  console.log("\n========================================");
  console.log("PRE-PILOT SAFETY SUITE: ALL CHECKS PASSED");
  console.log("PASSED: 16 | FAILED: 0");
  console.log("========================================");
  process.exit(0);
}

run().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
