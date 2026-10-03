import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  BulkMessageItemStatus,
  BulkMessageJobStatus,
  MessageStatus,
} from "../src/generated/prisma/enums";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  ALL_ERROR_CODES,
  ERROR_CATALOG,
  classifyErrorCode,
  computeBackoffMs,
  decideStaleRecovery,
  getRetryDecision,
  isManualRetryAllowed,
  providerCodeToErrorCode,
  shouldAutoRetryMessageDelivery,
  type ErrorCode,
} from "../src/lib/services/errors";
import { sanitizeMessage } from "../src/lib/services/errors/sanitize";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";
const COOKIE_NAME = "insta_session";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}`);
    failed++;
  }
}

function extractCookie(res: Response): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const m = setCookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return m ? m[1] : null;
}

async function register(label: string) {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `t11_${label}_${stamp}@example.com`, password: "ProductionReady2026!", name: `T11 ${label}` }),
  });
  const c = extractCookie(res);
  const body = (await res.clone().json()) as { user?: { id?: string }; id?: string };
  return { cookie: `${COOKIE_NAME}=${c}`, userId: (body.user?.id ?? body.id) as string };
}

// ---------------------------------------------------------------------------
// Pure unit tests
// ---------------------------------------------------------------------------

function testTaxonomy() {
  console.log("\n[Taxonomy]");
  const required = [
    "VALIDATION_ERROR", "AUTH_REQUIRED", "SESSION_UNAVAILABLE", "RECIPIENT_NOT_FOUND",
    "COMPOSER_NOT_FOUND", "SEND_TIMEOUT", "RATE_LIMITED", "PLATFORM_BLOCKED",
    "CAPTCHA_REQUIRED", "ACCOUNT_RESTRICTED", "BROWSER_ERROR", "NETWORK_ERROR",
    "DISCOVERY_ERROR", "ENRICHMENT_ERROR", "WORKER_ERROR", "DUPLICATE_REQUEST",
    "CONFIGURATION_ERROR", "DNC_SUPPRESSED", "PROVIDER_AUTH_FAILED",
    "PROVIDER_RATE_LIMITED", "PROVIDER_QUOTA_EXHAUSTED", "UNKNOWN",
  ];
  for (const code of required) {
    const def = (ERROR_CATALOG as Record<string, { userMessage: string }>)[code];
    check(Boolean(def) && typeof def.userMessage === "string" && def.userMessage.length > 0, `code ${code} defined with safe message`);
  }
  check(ALL_ERROR_CODES.length === required.length, `taxonomy matches the expected set (no duplicate/undocumented codes) (${ALL_ERROR_CODES.length})`);
  check(new Set(ALL_ERROR_CODES).size === ALL_ERROR_CODES.length, "ERROR_CATALOG has no duplicate keys");
}

function testClassification() {
  console.log("\n[Classification] determinism");
  const cases: Array<[string, ErrorCode]> = [
    ["AUTH_REQUIRED", "AUTH_REQUIRED"],
    ["SESSION_UNAVAILABLE: no profile", "SESSION_UNAVAILABLE"],
    ["RECIPIENT_NOT_FOUND", "RECIPIENT_NOT_FOUND"],
    ["COMPOSER_NOT_FOUND", "COMPOSER_NOT_FOUND"],
    ["SEND_TIMEOUT waiting", "SEND_TIMEOUT"],
    ["RATE_LIMITED by platform", "RATE_LIMITED"],
    ["PLATFORM_BLOCKED action blocked", "PLATFORM_BLOCKED"],
    ["CAPTCHA_REQUIRED", "CAPTCHA_REQUIRED"],
    ["ACCOUNT_RESTRICTED checkpoint", "ACCOUNT_RESTRICTED"],
    ["BROWSER_ERROR target crashed", "BROWSER_ERROR"],
    ["NETWORK_ERROR ECONNRESET", "NETWORK_ERROR"],
    ["VALIDATION_ERROR", "VALIDATION_ERROR"],
    ["DUPLICATE_REQUEST", "DUPLICATE_REQUEST"],
    ["CONFIGURATION_ERROR missing", "CONFIGURATION_ERROR"],
    ["DISCOVERY actor failed", "DISCOVERY_ERROR"],
    ["ENRICHMENT scrape failed", "ENRICHMENT_ERROR"],
    ["WORKER lease expired", "WORKER_ERROR"],
    ["some totally unexplained failure xyz", "UNKNOWN"],
  ];
  for (const [input, expected] of cases) {
    check(classifyErrorCode(input) === expected, `"${input}" -> ${expected}`);
  }
  // deterministic across repeats
  check(classifyErrorCode("RATE_LIMITED") === classifyErrorCode("RATE_LIMITED"), "classification deterministic");
  // provider mapping
  check(providerCodeToErrorCode("discover", "actor_failed") === "DISCOVERY_ERROR", "provider discover actor_failed -> DISCOVERY_ERROR");
  check(providerCodeToErrorCode("startJob", "actor_failed") === "ENRICHMENT_ERROR", "provider startJob actor_failed -> ENRICHMENT_ERROR");
  check(providerCodeToErrorCode("discover", "missing_credentials") === "CONFIGURATION_ERROR", "provider missing_credentials -> CONFIGURATION_ERROR");
  check(providerCodeToErrorCode("startJob", "invalid_input") === "VALIDATION_ERROR", "provider invalid_input -> VALIDATION_ERROR");
  // Regression: an Apify 403 "Monthly usage hard limit exceeded" is a quota
  // problem, not an invalid-credentials problem.
  check(classifyErrorCode("Monthly usage hard limit exceeded") === "PROVIDER_QUOTA_EXHAUSTED", "monthly usage hard limit -> PROVIDER_QUOTA_EXHAUSTED");
  check(classifyErrorCode("insufficient funds") === "PROVIDER_QUOTA_EXHAUSTED", "insufficient funds -> PROVIDER_QUOTA_EXHAUSTED");
  check(providerCodeToErrorCode("startJob", "quota_exhausted") === "PROVIDER_QUOTA_EXHAUSTED", "provider quota_exhausted -> PROVIDER_QUOTA_EXHAUSTED");
  check(providerCodeToErrorCode("discover", "rate_limited") === "PROVIDER_RATE_LIMITED", "provider rate_limited -> PROVIDER_RATE_LIMITED");
  check(!getRetryDecision({ code: "PROVIDER_QUOTA_EXHAUSTED", attempt: 1, domain: "discovery" }).retry, "quota exhaustion is not auto-retried");
}

function testRetryPolicy() {
  console.log("\n[Retry policy]");
  const net1 = getRetryDecision({ code: "NETWORK_ERROR", attempt: 1, domain: "discovery" });
  check(net1.retry && net1.delayMs > 0, "1. retryable network failure retries with backoff");

  const limited = getRetryDecision({ code: "NETWORK_ERROR", attempt: 3, domain: "discovery", maxAttempts: 3 });
  check(!limited.retry && !limited.withinAttemptLimit, "2. retry limit enforced");

  const b1 = computeBackoffMs(1), b2 = computeBackoffMs(2), b3 = computeBackoffMs(3), b99 = computeBackoffMs(99);
  check(b1 < b2 && b2 < b3, `3. backoff increases (${b1}<${b2}<${b3})`);
  check(b99 <= 9000 && b99 === b3, "3b. backoff bounded");

  check(!getRetryDecision({ code: "VALIDATION_ERROR", attempt: 1, domain: "discovery" }).retry, "4. permanent failure not retried");
  check(!getRetryDecision({ code: "RATE_LIMITED", attempt: 1, domain: "messaging" }).retry, "5. rate limit not auto-retried");
  check(!getRetryDecision({ code: "AUTH_REQUIRED", attempt: 1, domain: "messaging" }).retry, "6. auth failure not auto-retried");
  check(!getRetryDecision({ code: "CAPTCHA_REQUIRED", attempt: 1, domain: "messaging" }).retry, "7. CAPTCHA not auto-retried");
  check(!getRetryDecision({ code: "ACCOUNT_RESTRICTED", attempt: 1, domain: "messaging" }).retry, "8. restriction not auto-retried");
  check(!getRetryDecision({ code: "UNKNOWN", attempt: 1, domain: "messaging" }).retry, "9. unknown not auto-retried");
  check(!getRetryDecision({ code: "NETWORK_ERROR", attempt: 1, domain: "messaging", outcomeKnown: false }).retry, "9b. unconfirmed messaging outcome not auto-retried");
  check(!getRetryDecision({ code: "DUPLICATE_REQUEST", attempt: 1, domain: "messaging" }).retry, "11. duplicate request not retried");

  // message-specific guard
  check(!shouldAutoRetryMessageDelivery({ itemStatus: "SENT" }), "10. confirmed SENT never retried");
  check(!shouldAutoRetryMessageDelivery({ itemStatus: "UNKNOWN", errorCode: "NETWORK_ERROR", outcomeKnown: true }), "10b. UNKNOWN never retried");
  check(!shouldAutoRetryMessageDelivery({ itemStatus: "FAILED", errorCode: "RATE_LIMITED", outcomeKnown: true }), "10c. FAILED+RATE_LIMITED not retried");
  check(!shouldAutoRetryMessageDelivery({ itemStatus: "FAILED", errorCode: "AUTH_REQUIRED", outcomeKnown: true }), "10d. FAILED+AUTH not retried");
  check(shouldAutoRetryMessageDelivery({ itemStatus: "FAILED", errorCode: "NETWORK_ERROR", outcomeKnown: true }), "10e. confirmed-before-send network failure may retry");
  check(!shouldAutoRetryMessageDelivery({ itemStatus: "FAILED", errorCode: "NETWORK_ERROR", outcomeKnown: false }), "10f. failed with unknown outcome not retried");

  check(isManualRetryAllowed("FAILED") && isManualRetryAllowed("UNKNOWN"), "12. manual retry allowed for FAILED/UNKNOWN");
  check(!isManualRetryAllowed("SENT") && !isManualRetryAllowed("PROCESSING"), "12b. manual retry blocked for SENT/PROCESSING");
}

function testStaleRecovery() {
  console.log("\n[Worker recovery decisions]");
  check(decideStaleRecovery("SENT") === "RESOLVED_SENT", "sent attempt resolves SENT");
  check(decideStaleRecovery("FAILED") === "RESOLVED_FAILED", "failed attempt resolves FAILED");
  check(decideStaleRecovery("SENDING") === "MARKED_UNKNOWN", "in-flight SENDING -> UNKNOWN");
  check(decideStaleRecovery("UNKNOWN") === "MARKED_UNKNOWN", "UNKNOWN stays UNKNOWN");
  check(decideStaleRecovery("PROCESSING") === "MARKED_UNKNOWN", "PROCESSING -> UNKNOWN");
  check(decideStaleRecovery(null) === "RETURNED_TO_QUEUED", "no attempt -> safe re-queue");
  check(decideStaleRecovery("UNKNOWN") !== "RETURNED_TO_QUEUED", "UNKNOWN is never re-queued");
}

function testSanitization() {
  console.log("\n[Sanitization]");
  check(!sanitizeMessage("postgresql://user:pass@host:5432/db").includes("pass"), "connection string credentials masked");
  check(!sanitizeMessage("token apify_api_abcdef123456").includes("abcdef123456"), "apify token masked");
  check(!sanitizeMessage("Authorization: Bearer abc.def.ghi").includes("abc.def.ghi"), "bearer token masked");
  check(!sanitizeMessage("Cookie: insta_session=eyJhbGciOi.payload.sig").includes("payload"), "session cookie masked");
  check(sanitizeMessage("at C:\\Users\\me\\project\\file.ts:10:5").includes("<path>") || !sanitizeMessage("at E:\\insta_scraper\\src\\x.ts").includes("E:\\"), "filesystem path masked");
  check(!sanitizeMessage("Error\n    at foo (E:\\insta_scraper\\src\\a.ts:1:1)\n    at bar").includes("at foo"), "stack frames removed");
  check(!sanitizeMessage("sk-abcdefghijklmnopqrstuvwx").includes("abcdefghijklmnop"), "openai key masked");
}

// ---------------------------------------------------------------------------
// HTTP tests
// ---------------------------------------------------------------------------

async function main() {
  console.log("=================================================================");
  console.log("   TASK 11: CENTRALIZED ERRORS + RETRY/RECOVERY TEST SUITE       ");
  console.log(`   Base URL: ${BASE_URL}`);
  console.log("=================================================================");

  testTaxonomy();
  testClassification();
  testRetryPolicy();
  testStaleRecovery();
  testSanitization();

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  try {
    console.log("\n[HTTP] Correlation id + no-secret responses");
    const health = await fetch(`${BASE_URL}/api/health`);
    check(health.status === 200, `health 200 (got ${health.status})`);
    check(Boolean(health.headers.get("x-request-id")), "response carries x-request-id");

    const a = await register("A");
    const b = await register("B");

    const campRes = await fetch(`${BASE_URL}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: JSON.stringify({ name: `T11 A ${Date.now()}` }),
    });
    const campaign = await campRes.json();

    const badTemplate = await fetch(`${BASE_URL}/api/campaigns/${campaign.id}/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: JSON.stringify({ name: "Bad", body: "Hi {{unknownField}}" }),
    });
    const badText = await badTemplate.text();
    check(badTemplate.status === 400, `invalid template 400 (got ${badTemplate.status})`);
    const secretPatterns = ["apify_api_", "postgresql://", "insta_session", "E:\\", "sk-", "AUTH_SECRET"];
    check(secretPatterns.every((p) => !badText.includes(p)), "error response contains no secrets/paths");

    console.log("\n[HTTP] Manual retry: new attempt + immutable history + IDOR");
    const template = await prisma.messageTemplate.create({
      data: { campaignId: campaign.id, name: "T11", body: "Hi {{firstName}}" },
    });
    const lead = await prisma.lead.create({
      data: { campaignId: campaign.id, username: `t11lead${Date.now()}`, profileUrl: "https://www.instagram.com/x", fullName: "T11 Lead", source: "apify", scrapedAt: new Date() },
    });

    const job = await prisma.bulkMessageJob.create({
      data: {
        campaignId: campaign.id,
        userId: a.userId,
        templateId: template.id,
        status: BulkMessageJobStatus.PAUSED,
        total: 1,
        failed: 1,
      },
    });
    const item = await prisma.bulkMessageItem.create({
      data: {
        jobId: job.id,
        leadId: lead.id,
        renderedMessage: "Hi T11",
        status: BulkMessageItemStatus.FAILED,
        attempts: 1,
        errorCode: "NETWORK_ERROR",
        errorMessage: "temporary network failure",
        completedAt: new Date(),
      },
    });
    const attempt1 = await prisma.messageAttempt.create({
      data: {
        userId: a.userId,
        campaignId: campaign.id,
        leadId: lead.id,
        jobId: job.id,
        itemId: item.id,
        status: MessageStatus.FAILED,
        messageText: "Hi T11",
        attemptNumber: 1,
        errorCode: "NETWORK_ERROR",
        errorMessage: "temporary network failure",
        completedAt: new Date(),
      },
    });

    // IDOR / anon
    const anonRetry = await fetch(`${BASE_URL}/api/message-jobs/${job.id}/items/${item.id}/retry`, { method: "POST" });
    check(anonRetry.status === 401, `anonymous retry 401 (got ${anonRetry.status})`);

    const crossRetry = await fetch(`${BASE_URL}/api/message-jobs/${job.id}/items/${item.id}/retry`, { method: "POST", headers: { Cookie: b.cookie } });
    check(crossRetry.status === 404, `cross-tenant retry 404 (got ${crossRetry.status})`);

    const crossGet = await fetch(`${BASE_URL}/api/message-jobs/${job.id}`, { headers: { Cookie: b.cookie } });
    check(crossGet.status === 404, `cross-tenant job read 404 (got ${crossGet.status})`);

    // Prohibited state must not be retryable
    await prisma.bulkMessageItem.update({ where: { id: item.id }, data: { status: BulkMessageItemStatus.SENT } });
    const sentRetry = await fetch(`${BASE_URL}/api/message-jobs/${job.id}/items/${item.id}/retry`, { method: "POST", headers: { Cookie: a.cookie } });
    check([400, 409].includes(sentRetry.status), `retry of SENT rejected (got ${sentRetry.status})`);
    await prisma.bulkMessageItem.update({ where: { id: item.id }, data: { status: BulkMessageItemStatus.FAILED } });

    // Reject state conflict
    const okRetry = await fetch(`${BASE_URL}/api/message-jobs/${job.id}/items/${item.id}/retry`, { method: "POST", headers: { Cookie: a.cookie } });
    check(okRetry.status === 200, `owner retry 200 (got ${okRetry.status})`);
    const itemAfter = await prisma.bulkMessageItem.findUnique({ where: { id: item.id } });
    check(itemAfter?.status === "QUEUED", `retry re-queues item (got ${itemAfter?.status})`);
    const attempt1After = await prisma.messageAttempt.findUnique({ where: { id: attempt1.id } });
    check(
      attempt1After?.status === "FAILED" && attempt1After?.attemptNumber === 1 && attempt1After?.errorCode === "NETWORK_ERROR",
      "historical attempt #1 unchanged",
    );
    check(Boolean(itemAfter?.idempotencyKey), "retry assigns a new idempotency key");

    // Resume so the worker dispatches the queued item, creating attempt #2.
    await fetch(`${BASE_URL}/api/message-jobs/${job.id}/resume`, { method: "POST", headers: { Cookie: a.cookie } });
    let attempt2: { id: string } | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      attempt2 = await prisma.messageAttempt.findFirst({
        where: { itemId: item.id, attemptNumber: 2 },
      });
      if (attempt2) break;
    }
    check(Boolean(attempt2), "manual retry creates a new attempt record (#2)");
    const attempt1Still = await prisma.messageAttempt.findUnique({ where: { id: attempt1.id } });
    check(attempt1Still?.status === "FAILED" && attempt1Still?.attemptNumber === 1, "attempt #1 history immutable after retry");

    console.log("\n[Regression]");
    const status = await fetch(`${BASE_URL}/api/messaging/status`, { headers: { Cookie: a.cookie } });
    check(status.status === 200, `messaging status intact (got ${status.status})`);
  } catch (error) {
    console.error("\nUnexpected test failure:", error);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main();
