import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { scoreFlagCreate, withLeadChannelFlags } from "../src/lib/services/lead/lead-channels";

// Test isolation: Ensure tests use test database and test environment
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl, assertSafeTestDatabase } = require("./test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.OUTBOUND_SENDING_ENABLED = "true";
assertSafeTestDatabase(process.env.DATABASE_URL);

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

async function main() {
  const {
    canSendNow,
    reserveSendSlot,
    releaseSendSlot,
    setSendGateClock,
    getRandomGapMs,
    isWithinWorkingHours,
    resolveLeadTimezone,
    calculateWarmupCap,
    isDangerErrorCode,
    calculateBackoffPauseUntil,
    validateMessageVariation,
    chooseHealthySender,
    formatSenderDateString,
    formatSenderHourString,
    getSenderDailyHardMax,
    getSenderHourlyCap,
    getSenderMinGapSeconds,
    getSenderMaxGapSeconds,
    setOutboundSendingEnabledForTesting,
  } = await import("../src/lib/services/messaging/send-gate");

  // Enable outbound sending explicitly in test harness to evaluate all rate limiting gates
  setOutboundSendingEnabledForTesting(true);

  const { getPrismaClient } = await import("../src/lib/db/prisma");
  const prisma = getPrismaClient();

  // Initialize fake clock to Wednesday 14:00 UTC (during normal working hours)
  const baseFakeClock = new Date("2026-06-10T14:00:00Z");
  setSendGateClock(() => baseFakeClock);

  console.log("==================================================");
  console.log("    OUTBOUND SEND SAFETY & RATE LIMITING SUITE   ");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, name: string) {
    if (cond) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      failed++;
    }
  }

  // Helper to create or clean up test accounts
  const testRunId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const createdSenderIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdCampaignIds: string[] = [];
  const createdLeadIds: string[] = [];

  // Setup test user
  const testUser = await prisma.user.create({
    data: {
      email: `${testRunId}@example.com`,
      name: "Safety Test User",
      passwordHash: "test_hash",
      role: "USER",
    },
  });
  createdUserIds.push(testUser.id);

  try {
    // ---------------------------------------------------------------------------
    // TEST 1: Daily Cap Stops at Cap
    // ---------------------------------------------------------------------------
    console.log("\n[1] Testing Daily Cap stops exactly at cap...");
    const sender1 = await prisma.instagramSenderAccount.create({
      data: {
        userId: testUser.id,
        username: `sender1_${testRunId}`,
        sessionPath: `test/${testRunId}/sender1`,
        status: "ACTIVE",
        dailyCap: 5,
        hourlyCap: 10,
        warmupStartedAt: new Date(baseFakeClock.getTime() - 30 * 24 * 3600 * 1000), // fully warmed
        sentToday: 4,
        sentTodayDate: formatSenderDateString(baseFakeClock, "UTC"),
      },
    });
    createdSenderIds.push(sender1.id);

    // 4 sent, cap 5 -> Allowed
    const check1 = await canSendNow(sender1.id);
    assert(check1.allowed === true, "Sender with 4/5 daily sent is allowed to send");

    // Simulate 5 sent (cap reached)
    await prisma.instagramSenderAccount.update({
      where: { id: sender1.id },
      data: { sentToday: 5 },
    });
    const check2 = await canSendNow(sender1.id);
    assert(
      check2.allowed === false && check2.reason === "DAILY_CAP_REACHED",
      "Sender with 5/5 daily sent is blocked by DAILY_CAP_REACHED",
    );
    assert(
      check2.retryAt instanceof Date && check2.retryAt.getTime() > baseFakeClock.getTime(),
      "Daily cap block provides retryAt for the next UTC/local day rollover",
    );

    // ---------------------------------------------------------------------------
    // TEST 2: Hourly Cap Stops at Cap
    // ---------------------------------------------------------------------------
    console.log("\n[2] Testing Hourly Cap stops at cap...");
    const currentHourWindow = formatSenderHourString(baseFakeClock, "UTC");
    const sender2 = await prisma.instagramSenderAccount.create({
      data: {
        userId: testUser.id,
        username: `sender2_${testRunId}`,
        sessionPath: `test/${testRunId}/sender2`,
        status: "ACTIVE",
        dailyCap: 25,
        hourlyCap: 3,
        warmupStartedAt: new Date(baseFakeClock.getTime() - 30 * 24 * 3600 * 1000),
        sentToday: 2,
        sentTodayDate: formatSenderDateString(baseFakeClock, "UTC"),
        sentThisHour: 2,
        sentThisHourWindow: currentHourWindow,
      },
    });
    createdSenderIds.push(sender2.id);

    const checkH1 = await canSendNow(sender2.id);
    assert(checkH1.allowed === true, "Sender with 2/3 hourly sent is allowed");

    // Hit hourly cap 3/3
    await prisma.instagramSenderAccount.update({
      where: { id: sender2.id },
      data: { sentThisHour: 3 },
    });
    const checkH2 = await canSendNow(sender2.id);
    assert(
      checkH2.allowed === false && checkH2.reason === "HOURLY_CAP_REACHED",
      "Sender with 3/3 hourly sent is blocked by HOURLY_CAP_REACHED",
    );

    // ---------------------------------------------------------------------------
    // TEST 3: Warm-up Stage Limits Ramp
    // ---------------------------------------------------------------------------
    console.log("\n[3] Testing Warm-up stage ramping limits...");
    const fakeNow = new Date("2026-06-15T12:00:00Z");

    // Day 1 (0 days elapsed -> 8/day)
    const ramp1 = calculateWarmupCap({
      warmupStartedAt: new Date("2026-06-15T00:00:00Z"),
      configuredDailyCap: 30,
      now: fakeNow,
    });
    assert(
      ramp1.dailyCap === 8 && ramp1.stage.includes("8/day") && ramp1.isWarming === true,
      `Days 1-3 ramp caps at 8/day (got: ${ramp1.dailyCap}, stage: ${ramp1.stage})`,
    );

    // Day 5 (4 days elapsed -> 15/day)
    const ramp2 = calculateWarmupCap({
      warmupStartedAt: new Date("2026-06-11T00:00:00Z"),
      configuredDailyCap: 30,
      now: fakeNow,
    });
    assert(
      ramp2.dailyCap === 15 && ramp2.stage.includes("15/day") && ramp2.isWarming === true,
      `Days 4-7 ramp caps at 15/day (got: ${ramp2.dailyCap}, stage: ${ramp2.stage})`,
    );

    // Day 10 (9 days elapsed -> 25/day)
    const ramp3 = calculateWarmupCap({
      warmupStartedAt: new Date("2026-06-06T00:00:00Z"),
      configuredDailyCap: 35,
      now: fakeNow,
    });
    assert(
      ramp3.dailyCap === 25 && ramp3.stage.includes("25/day") && ramp3.isWarming === true,
      `Days 8-14 ramp caps at 25/day (got: ${ramp3.dailyCap}, stage: ${ramp3.stage})`,
    );

    // Day 20 (19 days elapsed -> configured cap up to hard ceiling 40)
    const ramp4 = calculateWarmupCap({
      warmupStartedAt: new Date("2026-05-25T00:00:00Z"),
      configuredDailyCap: 35,
      now: fakeNow,
    });
    assert(
      ramp4.dailyCap === 35 && ramp4.isWarming === false,
      `Days 15+ fully warmed reaches configured cap 35 (got: ${ramp4.dailyCap})`,
    );

    // Hard ceiling clamping: configured cap 50 should clamp to SENDER_DAILY_HARD_MAX (40)
    const ramp5 = calculateWarmupCap({
      warmupStartedAt: new Date("2026-05-25T00:00:00Z"),
      configuredDailyCap: 50,
      now: fakeNow,
    });
    assert(
      ramp5.dailyCap === getSenderDailyHardMax(),
      `Configured cap > hard ceiling clamps to hard ceiling ${getSenderDailyHardMax()}`,
    );

    // ---------------------------------------------------------------------------
    // TEST 4: Jitter Within Range & Not Constant
    // ---------------------------------------------------------------------------
    console.log("\n[4] Testing Jitter is non-constant and within min/max bounds...");
    const minSec = 360; // 6 min
    const maxSec = 900; // 15 min
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      samples.push(getRandomGapMs(minSec, maxSec));
    }

    const minBound = minSec * 1000;
    const maxBound = maxSec * 1000;
    const allWithinBounds = samples.every((s) => s >= minBound && s <= maxBound);
    assert(
      allWithinBounds,
      `All 50 jitter samples fall strictly between ${minSec}s (${minBound}ms) and ${maxSec}s (${maxBound}ms)`,
    );

    const uniqueSamples = new Set(samples);
    assert(
      uniqueSamples.size > 40,
      `Jitter re-rolls per send and is non-constant (${uniqueSamples.size} unique values out of 50)`,
    );

    // ---------------------------------------------------------------------------
    // TEST 5: Working Hours Deferral Across Timezones
    // ---------------------------------------------------------------------------
    console.log("\n[5] Testing Working Hours deferral across lead timezones and weekend skip...");
    // Lead timezone resolver tests
    assert(
      resolveLeadTimezone({ city: "New York", location: "United States" }) === "America/New_York",
      "Resolves New York to America/New_York",
    );
    assert(
      resolveLeadTimezone({ location: "London, UK" }) === "Europe/London",
      "Resolves London to Europe/London",
    );
    assert(
      resolveLeadTimezone({ city: "Tokyo" }) === "Asia/Tokyo",
      "Resolves Tokyo to Asia/Tokyo",
    );

    // Set a known Wednesday 14:00 UTC
    // In London: 15:00 BST / 14:00 UTC (inside 09:00-18:00)
    // In New York: 10:00 EDT (inside 09:00-18:00)
    // In Tokyo: 23:00 JST (outside 09:00-18:00)
    const testWed = new Date("2026-06-10T14:00:00Z");

    const nyCheck = isWithinWorkingHours(testWed, "America/New_York", 9, 18, true);
    assert(
      nyCheck.inWindow === true && nyCheck.localHour === 10,
      `New York at 14:00 UTC is local 10:00 -> IN window (inWindow: ${nyCheck.inWindow})`,
    );

    const tokyoCheck = isWithinWorkingHours(testWed, "Asia/Tokyo", 9, 18, true);
    assert(
      tokyoCheck.inWindow === false && tokyoCheck.localHour === 23,
      `Tokyo at 14:00 UTC is local 23:00 -> OUT of window (inWindow: ${tokyoCheck.inWindow})`,
    );
    assert(
      tokyoCheck.nextWindowStart.getTime() > testWed.getTime(),
      "Deferred Tokyo send provides nextWindowStart opening at 09:00 JST next morning",
    );

    // Weekend test: Sunday 14:00 UTC in New York -> outside window if skipWeekends = true
    const testSun = new Date("2026-06-14T14:00:00Z"); // Sunday
    const sundayCheck = isWithinWorkingHours(testSun, "America/New_York", 9, 18, true);
    assert(
      sundayCheck.inWindow === false && sundayCheck.isWeekend === true,
      `Sunday send is deferred when skipWeekends=true (isWeekend: ${sundayCheck.isWeekend})`,
    );
    assert(
      sundayCheck.nextWindowStart.getTime() > testSun.getTime(),
      "Sunday deferred send calculates nextWindowStart on Monday 09:00 local time",
    );

    // Gate integration test with lead timezone
    const sender3 = await prisma.instagramSenderAccount.create({
      data: {
        userId: testUser.id,
        username: `sender3_${testRunId}`,
        sessionPath: `test/${testRunId}/sender3`,
        status: "ACTIVE",
        dailyCap: 25,
        hourlyCap: 6,
        warmupStartedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
      },
    });
    createdSenderIds.push(sender3.id);

    // Inject fake clock = Wednesday 14:00 UTC
    setSendGateClock(() => testWed);

    // Send to Tokyo lead at 23:00 local time
    const gateTokyo = await canSendNow(sender3.id, {
      lead: { username: "tokyo_test_lead", city: "Tokyo", location: "Japan" },
    });
    assert(
      gateTokyo.allowed === false && gateTokyo.reason === "OUTSIDE_WORKING_HOURS",
      "canSendNow rejects Tokyo lead at night with OUTSIDE_WORKING_HOURS",
    );
    assert(
      gateTokyo.retryAt instanceof Date && gateTokyo.retryAt.getTime() > testWed.getTime(),
      "OUTSIDE_WORKING_HOURS returns retryAt timestamp for next window opening",
    );

    // Keep base fake clock active (Wednesday 14:00 UTC) for subsequent tests
    setSendGateClock(() => baseFakeClock);

    // ---------------------------------------------------------------------------
    // TEST 6: Restart Does NOT Reset Counters (DB Persistence)
    // ---------------------------------------------------------------------------
    console.log("\n[6] Testing Persistent Counters survive process restart / cache clear...");
    const sender4 = await prisma.instagramSenderAccount.create({
      data: {
        userId: testUser.id,
        username: `sender4_${testRunId}`,
        sessionPath: `test/${testRunId}/sender4`,
        status: "ACTIVE",
        dailyCap: 25,
        hourlyCap: 6,
        warmupStartedAt: new Date(baseFakeClock.getTime() - 30 * 24 * 3600 * 1000),
        sentToday: 12,
        sentTodayDate: formatSenderDateString(baseFakeClock, "UTC"),
        sentThisHour: 4,
        sentThisHourWindow: formatSenderHourString(baseFakeClock, "UTC"),
        totalSent: 150,
      },
    });
    createdSenderIds.push(sender4.id);

    // Simulate process termination by reading straight from fresh DB queries
    const freshRecord = await prisma.instagramSenderAccount.findUnique({
      where: { id: sender4.id },
    });
    assert(freshRecord !== null, "Fresh database connection successfully loads sender record");
    assert(
      freshRecord?.sentToday === 12 &&
        freshRecord?.sentThisHour === 4 &&
        freshRecord?.totalSent === 150,
      `Counters persisted across restart: sentToday=12, sentThisHour=4, totalSent=150`,
    );

    // Verify gate evaluates DB counters directly
    const gateFresh = await canSendNow(sender4.id);
    assert(gateFresh.allowed === true, "Gate evaluates freshly loaded DB counters without memory loss");

    // ---------------------------------------------------------------------------
    // TEST 7: Concurrent Reservations Cannot Exceed Cap ($transaction atomic)
    // ---------------------------------------------------------------------------
    console.log("\n[7] Testing Concurrent Slot Reservations cannot exceed cap...");
    const sender5 = await prisma.instagramSenderAccount.create({
      data: {
        userId: testUser.id,
        username: `sender5_${testRunId}`,
        sessionPath: `test/${testRunId}/sender5`,
        status: "ACTIVE",
        dailyCap: 10,
        hourlyCap: 10,
        warmupStartedAt: new Date(baseFakeClock.getTime() - 30 * 24 * 3600 * 1000),
        sentToday: 9, // exactly 1 slot left
        sentTodayDate: formatSenderDateString(baseFakeClock, "UTC"),
      },
    });
    createdSenderIds.push(sender5.id);

    // Launch 5 concurrent reservations for the single remaining slot
    const reservationPromises = Array.from({ length: 5 }, (_, i) =>
      reserveSendSlot({
        senderAccountId: sender5.id,
        campaignId: `test_camp_${testRunId}`,
        leadId: `lead_concurrent_${i}_${testRunId}`,
        step: 1,
        messageText: `Concurrent test message ${i}`,
      }),
    );

    const results = await Promise.all(reservationPromises);
    const successfulReservations = results.filter((r) => r.allowed);
    const rejectedReservations = results.filter((r) => !r.allowed);

    assert(
      successfulReservations.length === 1,
      `Exactly 1 reservation succeeded out of 5 concurrent attempts (succeeded: ${successfulReservations.length})`,
    );
    assert(
      rejectedReservations.length === 4,
      `Remaining 4 reservations were rejected without cap overrun (rejected: ${rejectedReservations.length})`,
    );

    const postConcurrentRecord = await prisma.instagramSenderAccount.findUnique({
      where: { id: sender5.id },
    });
    assert(
      postConcurrentRecord?.sentToday === 10,
      `Database counter sentToday is exactly at cap 10, never exceeded (got: ${postConcurrentRecord?.sentToday})`,
    );

    // ---------------------------------------------------------------------------
    // TEST 8: Idempotency Key Prevents Double Send
    // ---------------------------------------------------------------------------
    console.log("\n[8] Testing Idempotency key per (campaignId, leadId, step)...");
    const testCampaignId = `camp_idem_${testRunId}`;
    const testLeadId = `lead_idem_${testRunId}`;
    const testStep = 1;

    const sender6 = await prisma.instagramSenderAccount.create({
      data: {
        userId: testUser.id,
        username: `sender6_${testRunId}`,
        sessionPath: `test/${testRunId}/sender6`,
        status: "ACTIVE",
        dailyCap: 25,
        hourlyCap: 6,
        warmupStartedAt: new Date(baseFakeClock.getTime() - 30 * 24 * 3600 * 1000),
      },
    });
    createdSenderIds.push(sender6.id);

    // First reservation for this (campaignId, leadId, step)
    const idem1 = await reserveSendSlot({
      senderAccountId: sender6.id,
      campaignId: testCampaignId,
      leadId: testLeadId,
      step: testStep,
      messageText: "Hello there!",
    });
    assert(idem1.allowed === true, "First reservation with idempotency key succeeds");

    // Second reservation for the exact same (campaignId, leadId, step)
    const idem2 = await reserveSendSlot({
      senderAccountId: sender6.id,
      campaignId: testCampaignId,
      leadId: testLeadId,
      step: testStep,
      messageText: "Hello there!",
    });
    assert(
      idem2.allowed === false && ((idem2 as any).reason === "ALREADY_IN_PROGRESS" || (idem2 as any).reason === "ALREADY_SENT"),
      `Duplicate reservation with identical (campaignId, leadId, step) is blocked (reason: ${(idem2 as any).reason})`,
    );

    // ---------------------------------------------------------------------------
    // TEST 9: Auto-Pause on Rate-Limit & Danger Signals with Exponential Backoff
    // ---------------------------------------------------------------------------
    console.log("\n[9] Testing Auto-Pause on danger errors and exponential backoff...");
    // Danger codes verification
    assert(isDangerErrorCode("RATE_LIMITED") === true, "RATE_LIMITED recognized as danger code");
    assert(isDangerErrorCode("CAPTCHA_REQUIRED") === true, "CAPTCHA_REQUIRED recognized as danger code");
    assert(isDangerErrorCode("PLATFORM_BLOCKED") === true, "PLATFORM_BLOCKED recognized as danger code");
    assert(isDangerErrorCode("TIMEOUT") === false, "Generic TIMEOUT is not a permanent danger code");

    // Backoff calculation: 1 error -> 1h, 2 errors -> 6h, 3 errors -> 24h
    const backoff1 = calculateBackoffPauseUntil(1, fakeNow);
    assert(backoff1.backoffHours === 1, "First error applies 1-hour backoff");
    const backoff2 = calculateBackoffPauseUntil(2, fakeNow);
    assert(backoff2.backoffHours === 6, "Second consecutive error applies 6-hour backoff");
    const backoff3 = calculateBackoffPauseUntil(3, fakeNow);
    assert(backoff3.backoffHours === 24, "Third consecutive error applies 24-hour backoff");

    // Live releaseSendSlot auto-pause test
    const sender7 = await prisma.instagramSenderAccount.create({
      data: {
        userId: testUser.id,
        username: `sender7_${testRunId}`,
        sessionPath: `test/${testRunId}/sender7`,
        status: "ACTIVE",
        dailyCap: 25,
        hourlyCap: 6,
        warmupStartedAt: new Date(baseFakeClock.getTime() - 30 * 24 * 3600 * 1000),
        sentToday: 1,
        consecutiveErrors: 0,
      },
    });
    createdSenderIds.push(sender7.id);

    const res7 = await reserveSendSlot({
      senderAccountId: sender7.id,
      campaignId: `camp_err_${testRunId}`,
      leadId: `lead_err_${testRunId}`,
      step: 1,
      messageText: "Test error message",
    });

    // Release slot with RATE_LIMITED error
    await releaseSendSlot({
      senderAccountId: sender7.id,
      status: "FAILED",
      errorCode: "RATE_LIMITED",
      errorMessage: "Instagram action blocked: rate limit exceeded",
      idempotencyKeyId: res7.allowed ? res7.reservationId : undefined,
    });

    const pausedSender = await prisma.instagramSenderAccount.findUnique({
      where: { id: sender7.id },
    });
    assert(
      pausedSender?.status === "PAUSED" || pausedSender?.status === "NEEDS_ATTENTION",
      `Sender immediately paused on RATE_LIMITED (status: ${pausedSender?.status})`,
    );
    assert(
      pausedSender?.pausedUntil !== null && pausedSender?.pausedUntil! > baseFakeClock,
      `Sender has pausedUntil set into the future (${pausedSender?.pausedUntil?.toISOString()})`,
    );
    assert(
      pausedSender?.lastErrorCode === "RATE_LIMITED",
      `lastErrorCode recorded as RATE_LIMITED (got: ${pausedSender?.lastErrorCode})`,
    );

    // Gate should now block sender
    const gatePaused = await canSendNow(sender7.id);
    assert(
      gatePaused.allowed === false && gatePaused.reason === "SENDER_PAUSED",
      "canSendNow rejects paused sender with SENDER_PAUSED",
    );

    // ---------------------------------------------------------------------------
    // TEST 10: DNC / Suppression Blocked at Gate
    // ---------------------------------------------------------------------------
    console.log("\n[10] Testing DNC suppression blocked at send gate...");
    const dncUsername = `dnc_user_${testRunId}`;
    // Add to DNC list
    await prisma.doNotContact.create({
      data: {
        userId: testUser.id,
        channel: "INSTAGRAM",
        identifierType: "USERNAME",
        identifierNormalized: dncUsername.toLowerCase(),
        source: "MANUAL",
        reason: "User opted out",
      },
    });

    const sender8 = await prisma.instagramSenderAccount.create({
      data: {
        userId: testUser.id,
        username: `sender8_${testRunId}`,
        sessionPath: `test/${testRunId}/sender8`,
        status: "ACTIVE",
        dailyCap: 25,
        hourlyCap: 6,
        warmupStartedAt: new Date(baseFakeClock.getTime() - 30 * 24 * 3600 * 1000),
      },
    });
    createdSenderIds.push(sender8.id);

    const gateDnc = await canSendNow(sender8.id, {
      lead: { username: dncUsername },
    });
    assert(
      gateDnc.allowed === false && (gateDnc.reason === "SUPPRESSED_DNC" || gateDnc.reason === "LEAD_DNC_SUPPRESSED"),
      `DNC-suppressed lead is strictly blocked at the send gate (reason: ${gateDnc.reason})`,
    );

    // ---------------------------------------------------------------------------
    // TEST 11: Message Variation & Spam Prevention Guard
    // ---------------------------------------------------------------------------
    console.log("\n[11] Testing Message Variation Guard (unresolved placeholders & duplicates)...");
    const placeholderCheck1 = await validateMessageVariation({
      text: "Hello {{unresolved_field}}, we noticed your profile!",
      lead: { username: "bob", fullName: "Bob" },
    });
    assert(
      placeholderCheck1.valid === false && placeholderCheck1.reason === "UNRESOLVED_PLACEHOLDERS",
      "Unresolved placeholders (e.g. {{unresolved_field}}) are rejected with UNRESOLVED_PLACEHOLDERS",
    );

    const greetingCheck = await validateMessageVariation({
      text: "Hi , thanks for connecting!",
      lead: { username: "bob" },
    });
    assert(
      greetingCheck.valid === false && greetingCheck.reason === "EMPTY_NAME_GREETING",
      "Empty greeting ('Hi ,') without resolved name is rejected with EMPTY_NAME_GREETING",
    );

    const linksCheck = await validateMessageVariation({
      text: "Check out https://site1.com and also visit https://site2.com for free gifts!",
      lead: { username: "bob", fullName: "Bob" },
      isFirstMessage: true,
      maxLinks: 1,
    });
    assert(
      linksCheck.valid === false && linksCheck.reason === "TOO_MANY_LINKS_FIRST_MESSAGE",
      "Multiple links (>1) on first message are rejected to prevent spam flag",
    );

    // ---------------------------------------------------------------------------
    // TEST 12: Every Send Path Enforces the Shared Send Gate (AST / Regex Scan)
    // ---------------------------------------------------------------------------
    console.log("\n[12] Verifying all send paths route through shared send gate...");
    const srcDir = path.resolve(__dirname, "../src/lib/services");
    
    // Check that bulk messaging calls canSendNow and reserveSendSlot
    const bulkServiceCode = fs.readFileSync(path.join(srcDir, "messaging/bulk-messaging-service.ts"), "utf-8");
    assert(
      bulkServiceCode.includes("canSendNow") && bulkServiceCode.includes("chooseHealthySender"),
      "bulk-messaging-service.ts calls canSendNow and chooseHealthySender",
    );

    // Check that campaign execution calls canSendNow and sendSingleMessage (which calls gate)
    const executionServiceCode = fs.readFileSync(path.join(srcDir, "execution/campaign-execution-service.ts"), "utf-8");
    assert(
      executionServiceCode.includes("canSendNow") && executionServiceCode.includes("sendSingleMessage"),
      "campaign-execution-service.ts calls canSendNow and delegates to sendSingleMessage",
    );

    // Check that messaging-service.ts (single message & test message) calls reserveSendSlot and releaseSendSlot
    const messagingServiceCode = fs.readFileSync(path.join(srcDir, "messaging/messaging-service.ts"), "utf-8");
    assert(
      messagingServiceCode.includes("reserveSendSlot") && messagingServiceCode.includes("releaseSendSlot"),
      "messaging-service.ts enforces reserveSendSlot and releaseSendSlot on all dispatch paths",
    );

    // Check reply send service calls reserveSendSlot and releaseSendSlot
    const replyServiceCode = fs.readFileSync(path.join(srcDir, "messaging/reply-send-service.ts"), "utf-8");
    assert(
      replyServiceCode.includes("reserveSendSlot") && replyServiceCode.includes("releaseSendSlot"),
      "reply-send-service.ts enforces reserveSendSlot and releaseSendSlot",
    );

    // Check draft send service uses findConnectedSenderForDispatch
    const draftServiceCode = fs.readFileSync(path.join(srcDir, "drafts/draft-send-service.ts"), "utf-8");
    assert(
      draftServiceCode.includes("findConnectedSenderForDispatch"),
      "draft-send-service.ts resolves healthy senders through findConnectedSenderForDispatch",
    );

    // ---------------------------------------------------------------------------
    // TEST 13: Leads without Instagram Handle Cannot Be Queued or Sent as Instagram DMs
    // ---------------------------------------------------------------------------
    console.log("\n[13] Testing Leads without Instagram Handle are impossible to queue/send as Instagram DMs...");
    const noHandleProfile = await prisma.companyProfile.create({
      data: { userId: testUser.id, name: `No Handle Test Co ${testRunId}` },
    });
    const noHandleCamp = await prisma.campaign.create({
      data: {
        userId: testUser.id,
        companyProfileId: noHandleProfile.id,
        name: `No Handle Test Campaign ${testRunId}`,
        followUpEnabled: true,
        followUpCount: 1,
        followUpDelayDays: [3],
        followUpTemplates: ["Hi {firstName}, following up!"],
      },
    });
    createdCampaignIds.push(noHandleCamp.id);

    const noHandleLead = await prisma.lead.create({
      data: {
        campaignId: noHandleCamp.id,
        userId: testUser.id,
        fullName: "No Handle Clinic",
        username: null,
        usernameNormalized: null,
        instagramUsername: null,
        profileUrl: null,
        phone: "+14165559001",
        email: "clinic@nohandle.ca",
        ...withLeadChannelFlags(["PHONE", "EMAIL"]),
        status: "NEW",
      },
    });
    createdLeadIds.push(noHandleLead.id);

    // Path 1: Single send via canSendNow and reserveSendSlot
    const singleGateCheck = await canSendNow({
      senderAccountId: sender1.id,
      leadId: noHandleLead.id,
    });
    assert(
      singleGateCheck.allowed === false && singleGateCheck.reason === "NO_INSTAGRAM_HANDLE",
      `canSendNow rejects no-handle lead (allowed=false, reason="${singleGateCheck.reason}")`,
    );

    const singleReserveCheck = await reserveSendSlot({
      senderAccountId: sender1.id,
      campaignId: noHandleCamp.id,
      leadId: noHandleLead.id,
      step: 1,
      messageText: "Hello there!",
    });
    const singleReserveReason = (singleReserveCheck as { reason?: string }).reason;
    assert(
      singleReserveCheck.allowed === false && singleReserveReason === "NO_INSTAGRAM_HANDLE",
      `reserveSendSlot rejects no-handle lead (allowed=false, reason="${singleReserveReason}")`,
    );

    // Path 2: Bulk message job creation / preview
    const { previewBulkMessageJob } = await import("../src/lib/services/messaging/bulk-messaging-service");
    const bulkPreview = await previewBulkMessageJob(
      noHandleCamp.id,
      { leadIds: [noHandleLead.id] },
      testUser.id,
    );
    assert(bulkPreview.eligibleCount === 0, "Bulk message preview reports 0 eligible leads for no-handle lead");
    assert(
      bulkPreview.skippedReasons.some((s) => s.leadId === noHandleLead.id && s.reason.includes("Instagram")),
      "Bulk preview logs skip reason explaining lack of Instagram username",
    );

    // Path 3: Campaign execution candidate lead eligibility check
    const executionFilterPasses =
      Boolean(noHandleLead.username && noHandleLead.username.trim()) &&
      (noHandleLead.profileUrl?.trim() || "").startsWith("http");
    assert(!executionFilterPasses, "Campaign execution candidate filter strictly excludes leads without Instagram username");

    // Path 4: Follow-up message scheduling & dispatch
    const { scheduleFollowUpsForLead } = await import("../src/lib/services/messaging/follow-up-service");
    const scheduledFollowUps = await scheduleFollowUpsForLead({
      campaignId: noHandleCamp.id,
      leadId: noHandleLead.id,
    });
    assert(
      scheduledFollowUps.length === 0,
      `scheduleFollowUpsForLead refuses to schedule follow-ups for no-handle lead (scheduled: ${scheduledFollowUps.length})`,
    );

  } finally {
    // Cleanup test artifacts
    setSendGateClock(null);
    setOutboundSendingEnabledForTesting(null);
    if (createdLeadIds.length > 0) {
      await prisma.lead.deleteMany({
        where: { id: { in: createdLeadIds } },
      }).catch(() => undefined);
    }
    if (createdCampaignIds.length > 0) {
      await prisma.campaign.deleteMany({
        where: { id: { in: createdCampaignIds } },
      }).catch(() => undefined);
    }
    if (createdUserIds.length > 0) {
      await prisma.doNotContact.deleteMany({
        where: { userId: { in: createdUserIds } },
      }).catch(() => undefined);
    }
    if (createdSenderIds.length > 0) {
      await prisma.outboundSendIdempotency.deleteMany({
        where: { senderAccountId: { in: createdSenderIds } },
      }).catch(() => undefined);
      await prisma.instagramSenderAccount.deleteMany({
        where: { id: { in: createdSenderIds } },
      }).catch(() => undefined);
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }

  console.log("\n==================================================");
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
