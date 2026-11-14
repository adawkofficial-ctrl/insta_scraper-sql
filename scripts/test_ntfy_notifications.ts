/**
 * Test Suite: ntfy.sh Push Notifications Integration
 *
 * Verifies:
 * 1. ntfy URL & HTTP header formatting (topic, title, priority, tags, Bearer auth)
 * 2. Resilience: 4xx non-retry, 5xx single retry, timeout abort, zero-throw guarantee
 * 3. Burst guard rate limiting: collapsed notice, skipping beyond limit, resetBurstGuard()
 * 4. Privacy: token masking, no raw token in getNotificationConfig, NotificationLog schema check
 * 5. Event triggers: notifyLeadReplied, notifyHighValueLead, notifySenderStatusChange, notifySystemError
 * 6. Daily summary aggregation and push dispatch
 */

import "dotenv/config";
import "./preload_server_only.cjs";
import { PrismaClient, NotificationEventType, NotificationLogStatus } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";
import {
  NtfyNotifier,
  setNotificationFetchFn,
  resetBurstGuard,
  EVENT_DEFAULT_PRIORITIES,
  EVENT_DEFAULT_TAGS,
} from "../src/lib/services/notifications/ntfy-notifier";
import {
  maskAccessToken,
  getNotificationConfig,
  upsertNotificationConfig,
  sendDailySummaryNotification,
} from "../src/lib/services/notifications/notification-config-service";
import {
  notifyLeadReplied,
  notifyHighValueLead,
  notifySenderStatusChange,
  notifySystemError,
} from "../src/lib/services/notifications/notification-triggers";

const db = createPrismaClient();

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

async function main() {
  console.log("=================================================================");
  console.log("   NTFY.SH PUSH NOTIFICATION INTEGRATION TEST SUITE             ");
  console.log("=================================================================\n");

  const testRunId = `ntfy_${Date.now()}`;
  const testEmail = `${testRunId}@example.com`;

  // Create isolated test user
  const testUser = await db.user.create({
    data: {
      email: testEmail,
      name: "Notification Test User",
      passwordHash: "dummy-hash",
    },
  });

  try {
    // -------------------------------------------------------------------------
    // 1. PRIVACY & TOKEN MASKING
    // -------------------------------------------------------------------------
    console.log("--- 1. Privacy & Token Masking ---");

    check(maskAccessToken(null) === null, "maskAccessToken handles null");
    check(maskAccessToken("") === null, "maskAccessToken handles empty string");
    check(maskAccessToken("abc") === "****", "maskAccessToken masks short tokens <= 4 chars");
    check(maskAccessToken("secret_token_1234") === "****1234", "maskAccessToken masks long tokens preserving last 4 chars");

    // Upsert config with an access token
    const savedConfig = await upsertNotificationConfig(testUser.id, {
      ntfyTopic: "Instagram_notification",
      ntfyServerUrl: "https://ntfy.sh",
      ntfyAccessToken: "tk_test_auth_secret_9988",
      enabled: true,
      eventTypes: [
        NotificationEventType.LEAD_REPLIED,
        NotificationEventType.HIGH_VALUE_LEAD,
        NotificationEventType.SESSION_EXPIRED,
        NotificationEventType.SENDER_ERROR,
        NotificationEventType.SYSTEM_ERROR,
        NotificationEventType.DAILY_SUMMARY,
      ],
    });

    check(savedConfig.hasAccessToken === true, "hasAccessToken is true when token exists");
    check(savedConfig.maskedAccessToken === "****9988", "maskedAccessToken has only last 4 digits visible");
    check(!("ntfyAccessToken" in savedConfig), "Raw ntfyAccessToken is stripped from public config object");

    // Fetch config via getNotificationConfig
    const fetchedConfig = await getNotificationConfig(testUser.id);
    check(fetchedConfig !== null, "getNotificationConfig returns config");
    check(fetchedConfig?.maskedAccessToken === "****9988", "Fetched config has maskedAccessToken");
    check(!("ntfyAccessToken" in (fetchedConfig ?? {})), "Fetched config does not contain raw token");

    // Schema audit: NotificationLog must not store message bodies or topic names
    const tableColumns = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT COLUMN_NAME AS column_name FROM information_schema.columns WHERE table_name = 'NotificationLog'`
    );
    const colNames = tableColumns.map((c) => c.column_name.toLowerCase());
    check(!colNames.includes("body"), "NotificationLog table has no 'body' column");
    check(!colNames.includes("message"), "NotificationLog table has no 'message' column");
    check(!colNames.includes("topic"), "NotificationLog table has no 'topic' column");

    // -------------------------------------------------------------------------
    // 2. HTTP FORMATTING & DELIVERY SUCCESS
    // -------------------------------------------------------------------------
    console.log("\n--- 2. HTTP Formatting & Delivery Success ---");

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const mockFetchSuccess: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      capturedBody = String(init?.body || "");
      return new Response("OK", { status: 200, statusText: "OK" });
    };

    setNotificationFetchFn(mockFetchSuccess);
    resetBurstGuard();

    const notifier = new NtfyNotifier();

    const result = await notifier.send({
      userId: testUser.id,
      eventType: NotificationEventType.LEAD_REPLIED,
      title: "New Reply from @client",
      body: "Sounds interesting! Let's talk.",
      priority: "high",
      tags: ["speech_balloon", "envelope"],
    });

    check(result.success === true, "notifier.send returns success: true on 200 OK");
    check(result.status === NotificationLogStatus.SENT, "Result status is SENT");
    check(capturedUrl === "https://ntfy.sh/Instagram_notification", "URL targets server + encoded topic");
    check(capturedHeaders["Title"] === "New Reply from @client", "Title header sent correctly");
    check(capturedHeaders["Priority"] === "high", "Priority header matches");
    check(capturedHeaders["Tags"] === "speech_balloon,envelope", "Tags header matches CSV string");
    check(capturedHeaders["Authorization"] === "Bearer tk_test_auth_secret_9988", "Authorization Bearer header passed");
    check(capturedHeaders["Content-Type"] === "text/plain; charset=utf-8", "Content-Type is text/plain; charset=utf-8");
    check(capturedBody === "Sounds interesting! Let's talk.", "Body matches raw payload");

    // Verify NotificationLog audit entry was recorded
    const logSent = await db.notificationLog.findFirst({
      where: { userId: testUser.id, status: NotificationLogStatus.SENT },
      orderBy: { createdAt: "desc" },
    });
    check(logSent !== null, "NotificationLog audit row created for SENT event");
    check(logSent?.eventType === NotificationEventType.LEAD_REPLIED, "Log eventType matches");
    check(typeof logSent?.latencyMs === "number", "Log includes latencyMs");

    // -------------------------------------------------------------------------
    // 3. RESILIENCE: 4XX NON-RETRY & 5XX RETRY & TIMEOUT
    // -------------------------------------------------------------------------
    console.log("\n--- 3. Resilience: 4xx, 5xx, Timeout & Zero-Throw ---");

    // 3a. 4xx error (e.g. 403 Forbidden) -> do NOT retry
    let callCount4xx = 0;
    const mockFetch4xx: typeof fetch = async () => {
      callCount4xx++;
      return new Response("Forbidden: invalid token", { status: 403, statusText: "Forbidden" });
    };

    setNotificationFetchFn(mockFetch4xx);
    resetBurstGuard();

    const result4xx = await notifier.send({
      userId: testUser.id,
      eventType: NotificationEventType.SENDER_ERROR,
      title: "Sender Error",
      body: "Rate limited",
    });

    check(result4xx.success === false, "4xx returns success: false");
    check(result4xx.status === NotificationLogStatus.FAILED, "4xx status is FAILED");
    check(callCount4xx === 1, "4xx is NOT retried (callCount === 1)");

    // 3b. 5xx error -> retry once
    let callCount5xx = 0;
    const mockFetch5xx: typeof fetch = async () => {
      callCount5xx++;
      return new Response("Internal Server Error", { status: 500, statusText: "Error" });
    };

    setNotificationFetchFn(mockFetch5xx);
    resetBurstGuard();

    const result5xx = await notifier.send({
      userId: testUser.id,
      eventType: NotificationEventType.SYSTEM_ERROR,
      title: "System Error",
      body: "Gemini quota",
    });

    check(result5xx.success === false, "5xx returns success: false when all retries fail");
    check(callCount5xx === 2, "5xx is retried once (callCount === 2)");

    // 3c. 5xx on attempt 1, 200 on attempt 2 -> success
    let callCountRecover = 0;
    const mockFetchRecover: typeof fetch = async () => {
      callCountRecover++;
      if (callCountRecover === 1) {
        return new Response("Service Unavailable", { status: 503, statusText: "Unavailable" });
      }
      return new Response("OK", { status: 200, statusText: "OK" });
    };

    setNotificationFetchFn(mockFetchRecover);
    resetBurstGuard();

    const resultRecover = await notifier.send({
      userId: testUser.id,
      eventType: NotificationEventType.DAILY_SUMMARY,
      title: "Daily Summary",
      body: "Stats",
    });

    check(resultRecover.success === true, "5xx on attempt 1 with 200 on attempt 2 succeeds");
    check(resultRecover.status === NotificationLogStatus.SENT, "Recovered status is SENT");
    check(callCountRecover === 2, "Took 2 attempts to recover");

    // 3d. Timeout abort handling
    const shortTimeoutNotifier = new NtfyNotifier({ timeoutMs: 50 });
    const mockFetchTimeout: typeof fetch = async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };

    setNotificationFetchFn(mockFetchTimeout);
    resetBurstGuard();

    const resultTimeout = await shortTimeoutNotifier.send({
      userId: testUser.id,
      eventType: NotificationEventType.HIGH_VALUE_LEAD,
      title: "High Value Lead",
      body: "Lead score 90",
    });

    check(resultTimeout.success === false, "Timeout returns success: false without throwing");
    check(resultTimeout.status === NotificationLogStatus.FAILED, "Timeout status is FAILED");
    check(Boolean(resultTimeout.error?.includes("timed out")), "Timeout error message indicates timeout");

    // 3e. Zero-throw guarantee on network throw
    const mockFetchThrow: typeof fetch = async () => {
      throw new TypeError("Failed to fetch: DNS resolution failed");
    };

    setNotificationFetchFn(mockFetchThrow);
    resetBurstGuard();

    let didThrow = false;
    let throwResult = null;
    try {
      throwResult = await notifier.send({
        userId: testUser.id,
        eventType: NotificationEventType.LEAD_REPLIED,
        title: "Test",
        body: "Test body",
      });
    } catch {
      didThrow = true;
    }

    check(didThrow === false, "Zero-throw guarantee: notifier.send never throws an uncaught exception");
    check(throwResult?.success === false, "Returns success: false on network throw");

    // -------------------------------------------------------------------------
    // 4. BURST GUARD RATE LIMITING
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Burst Guard Rate Limiting ---");

    resetBurstGuard(testUser.id);
    setNotificationFetchFn(mockFetchSuccess);

    // Default rate limit is 20 per minute. Send 20 notifications.
    let burstSuccesses = 0;
    for (let i = 0; i < 20; i++) {
      const res = await notifier.send({
        userId: testUser.id,
        eventType: NotificationEventType.LEAD_REPLIED,
        title: `Reply ${i + 1}`,
        body: "Message",
      });
      if (res.success) burstSuccesses++;
    }
    check(burstSuccesses === 20, "20 notifications within 1 minute are allowed");

    // The 21st notification should exceed the burst limit and be collapsed
    const res21 = await notifier.send({
      userId: testUser.id,
      eventType: NotificationEventType.LEAD_REPLIED,
      title: "Reply 21",
      body: "Message",
    });
    check(res21.success === false, "21st notification is collapsed/blocked by burst guard");
    check(res21.status === NotificationLogStatus.SKIPPED_DISABLED, "Burst limit status is SKIPPED_DISABLED");
    check(res21.error === "BURST_LIMIT_EXCEEDED", "Error reason is BURST_LIMIT_EXCEEDED");

    // Reset burst guard and verify sending works again
    resetBurstGuard(testUser.id);
    const resAfterReset = await notifier.send({
      userId: testUser.id,
      eventType: NotificationEventType.LEAD_REPLIED,
      title: "Reply After Reset",
      body: "Message",
    });
    check(resAfterReset.success === true, "resetBurstGuard clears the window and allows sends again");

    // -------------------------------------------------------------------------
    // 5. EVENT TRIGGERS
    // -------------------------------------------------------------------------
    console.log("\n--- 5. Event Trigger Helpers ---");

    setNotificationFetchFn(mockFetchSuccess);
    resetBurstGuard();

    // 5a. Create test company profile, campaign and lead for triggers
    const testProfile = await db.companyProfile.create({
      data: {
        userId: testUser.id,
        name: "Test Co",
      },
    });

    const testCampaign = await db.campaign.create({
      data: {
        user: { connect: { id: testUser.id } },
        companyProfile: { connect: { id: testProfile.id } },
        name: "Notification VIP Outreach",
        minLeadScore: 60,
      },
    });

    const testLead = await db.lead.create({
      data: {
        campaign: { connect: { id: testCampaign.id } },
        username: "celebrity_influencer",
        fullName: "Celebrity Influencer",
        profileUrl: "https://instagram.com/celebrity_influencer",
        leadScore: 92,
        leadQuality: "HIGH",
      },
    });

    const testInboundMsg = await db.message.create({
      data: {
        campaign: { connect: { id: testCampaign.id } },
        lead: { connect: { id: testLead.id } },
        direction: "INBOUND",
        channel: "INSTAGRAM",
        messageText: "Hey! We are interested in your partnership proposal. Please send details.",
      },
    });

    // 5b. Test notifyLeadReplied
    capturedTitle = "";
    capturedBody = "";
    await notifyLeadReplied({ leadId: testLead.id, messageId: testInboundMsg.id });
    check(capturedHeaders["Title"] === "💬 Reply from @celebrity_influencer", "notifyLeadReplied generates @username title");
    check(capturedBody.includes("Hey! We are interested"), "notifyLeadReplied includes message preview in body");
    check(capturedBody.includes("Notification VIP Outreach"), "notifyLeadReplied includes campaign name");

    // 5c. Test notifyHighValueLead
    capturedTitle = "";
    capturedBody = "";
    await notifyHighValueLead({
      leadId: testLead.id,
      userId: testUser.id,
      username: testLead.username,
      score: 95,
      quality: "HIGH",
      campaignName: testCampaign.name,
    });
    check(capturedHeaders["Title"] === "⭐ High-Value Lead: @celebrity_influencer", "notifyHighValueLead generates high-value title");
    check(capturedBody.includes("Score: 95/100"), "notifyHighValueLead body includes score");

    // High value lead below threshold (e.g. 50 < 85) should NOT send
    let sentOnLowScore = false;
    const mockFetchCatch: typeof fetch = async () => {
      sentOnLowScore = true;
      return new Response("OK", { status: 200 });
    };
    setNotificationFetchFn(mockFetchCatch);
    await notifyHighValueLead({
      leadId: testLead.id,
      userId: testUser.id,
      username: "low_lead",
      score: 50,
    });
    check(sentOnLowScore === false, "notifyHighValueLead does not trigger when score < threshold");
    setNotificationFetchFn(mockFetchSuccess);

    // 5d. Test notifySenderStatusChange
    capturedTitle = "";
    capturedBody = "";
    await notifySenderStatusChange({
      userId: testUser.id,
      senderUsername: "my_brand_bot",
      previousStatus: "CONNECTED",
      newStatus: "AUTH_REQUIRED",
      errorMessage: "Checkpoint challenge required",
    });
    check(capturedHeaders["Title"] === "🔑 Session Expired: @my_brand_bot", "AUTH_REQUIRED triggers SESSION_EXPIRED title");
    check(capturedBody.includes("Checkpoint challenge required"), "Includes error details in body");

    // Status unchanged (already AUTH_REQUIRED) should not trigger duplicate alert
    let sentDuplicate = false;
    const mockCatchDup: typeof fetch = async () => {
      sentDuplicate = true;
      return new Response("OK", { status: 200 });
    };
    setNotificationFetchFn(mockCatchDup);
    await notifySenderStatusChange({
      userId: testUser.id,
      senderUsername: "my_brand_bot",
      previousStatus: "AUTH_REQUIRED",
      newStatus: "AUTH_REQUIRED",
    });
    check(sentDuplicate === false, "notifySenderStatusChange does not re-alert on unchanged status");
    setNotificationFetchFn(mockFetchSuccess);

    // 5e. Test notifySystemError
    capturedTitle = "";
    capturedBody = "";
    await notifySystemError({
      userId: testUser.id,
      provider: "Sparior",
      errorType: "QUOTA_EXHAUSTED",
      details: "RapidAPI monthly credits reached 0",
    });
    check(capturedHeaders["Title"] === "🚨 System Alert: Sparior QUOTA EXHAUSTED", "notifySystemError generates alert title");
    check(capturedBody.includes("RapidAPI monthly credits reached 0"), "Includes quota exhaustion details");

    // -------------------------------------------------------------------------
    // 6. DAILY SUMMARY DISPATCH
    // -------------------------------------------------------------------------
    console.log("\n--- 6. Daily Summary Aggregation & Dispatch ---");

    capturedTitle = "";
    capturedBody = "";
    const summarySuccess = await sendDailySummaryNotification(testUser.id);

    check(summarySuccess === true, "sendDailySummaryNotification succeeds");
    check(capturedHeaders["Title"] === "Daily Lead Activity Summary", "Summary title is Daily Lead Activity Summary");
    check(capturedBody.includes("24h Activity Summary"), "Summary body contains 24h Activity Summary header");
    check(capturedBody.includes("New Leads:"), "Summary body includes New Leads metric");
    check(capturedBody.includes("Replies Received:"), "Summary body includes Replies metric");

  } finally {
    // Clean up test data
    setNotificationFetchFn(null);
    resetBurstGuard();

    await db.notificationLog.deleteMany({ where: { userId: testUser.id } }).catch(() => undefined);
    await db.notificationConfig.deleteMany({ where: { userId: testUser.id } }).catch(() => undefined);
    await db.message.deleteMany({ where: { campaign: { userId: testUser.id } } }).catch(() => undefined);
    await db.lead.deleteMany({ where: { campaign: { userId: testUser.id } } }).catch(() => undefined);
    await db.campaign.deleteMany({ where: { userId: testUser.id } }).catch(() => undefined);
    await db.companyProfile.deleteMany({ where: { userId: testUser.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: testUser.id } }).catch(() => undefined);
    await db.$disconnect();
  }

  console.log("\n=================================================================");
  console.log(`PASSED: ${passed} | FAILED: ${failed}`);
  console.log("=================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

let capturedTitle = "";
let capturedBody = "";

main().catch((err) => {
  console.error("Fatal error running ntfy notification test suite:", err);
  process.exit(1);
});
