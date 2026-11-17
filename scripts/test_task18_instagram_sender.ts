import "dotenv/config";
process.env.MESSAGING_PROVIDER = "playwright";
process.env.SENDER_COOLDOWN_SECONDS = "0";
process.env.SENDER_COOLDOWN_MINUTES = "0";
import "./preload_server_only.cjs";
import { getPrismaClient } from "../src/lib/db/prisma";
import type { BrowserContext } from "playwright";

import {
  cancelSenderLogin,
  createSenderAccount,
  disconnectSenderAccount,
  getSenderAccount,
  getSenderSessionManager,
  listSenderAccounts,
  senderSessionDirExists,
  setSenderSessionDriver,
  startSenderConnect,
  SenderBrowserMissingError,
  SenderProfileLaunchFailedError,
  verifySenderAccount,
  type BrowserAvailability,
  type SenderAuthProbe,
  type SenderBrowserSession,
  type SenderSessionDiagnostics,
  type SenderSessionDriver,
  type SenderSessionMode,
} from "../src/lib/services/senders";
import {
  sendSingleMessage,
  setMessagingProvider,
  setSendGateClock,
} from "../src/lib/services/messaging";
import { createBulkMessageJob } from "../src/lib/services/messaging/bulk-messaging-service";
import { dispatchBulkJobQueue } from "../src/lib/services/messaging/bulk-messaging-service";
import type {
  MessagingProvider,
  MessagingProviderStatus,
  SendMessageRequest,
  SendMessageResult,
} from "../src/lib/services/messaging/messaging-provider";

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

/** Controlled Playwright replacement ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â no real browser or Instagram traffic. */
class MockSession implements SenderBrowserSession {
  readonly id = `mock_${Math.random().toString(36).slice(2, 8)}`;
  readonly context = {} as BrowserContext;
  readonly headed: boolean;
  private closed = false;
  private closeCallbacks: Array<() => void> = [];
  probeCount = 0;
  openInstagramCount = 0;
  focusCount = 0;
  constructor(
    readonly mode: SenderSessionMode,
    private readonly probe: () => SenderAuthProbe,
    private readonly navOk: () => boolean,
  ) {
    this.headed = mode === "manual-login";
  }
  isClosed() {
    return this.closed;
  }
  async probeAuth() {
    this.probeCount += 1;
    return this.probe();
  }
  async openInstagram() {
    this.openInstagramCount += 1;
    if (!this.navOk()) {
      return { ok: false, url: null, error: "mock navigation failure" };
    }
    return { ok: true, url: "https://www.instagram.com/" };
  }
  async focusPage() {
    this.focusCount += 1;
  }
  async diagnostics(): Promise<SenderSessionDiagnostics> {
    return {
      live: !this.closed,
      mode: this.mode,
      headed: this.headed,
      browserName: "mock",
      browserVersion: "0",
      pagesCount: this.closed ? 0 : 1,
      currentUrl: this.closed ? null : "https://www.instagram.com/",
      isClosed: this.closed,
      pageClosed: this.closed,
      viewport: { width: 1280, height: 900 },
    };
  }
  onClose(callback: () => void) {
    this.closeCallbacks.push(callback);
  }
  /** Simulates the user closing the browser window directly. */
  simulateExternalClose() {
    this.closed = true;
    for (const callback of this.closeCallbacks) callback();
  }
  async close() {
    this.closed = true;
    for (const callback of this.closeCallbacks) callback();
  }
}

class MockSessionDriver implements SenderSessionDriver {
  readonly name = "mock-playwright";
  interactiveLaunches = 0;
  headlessLaunches = 0;
  navOk = true;
  failInteractiveLaunch = false;
  browserMissing = false;
  profileLaunchFailed = false;
  lastInteractiveHeaded: boolean | null = null;
  nextProbe: SenderAuthProbe = {
    authenticated: false,
    username: null,
    code: "AUTH_REQUIRED",
    reason: "mock: not authenticated",
  };
  interactiveSessions: MockSession[] = [];
  async ensureAvailable(): Promise<BrowserAvailability> {
    if (this.browserMissing) {
      throw new SenderBrowserMissingError();
    }
    return {
      bundledChromiumAvailable: true,
      preferredEngine: "bundled",
      channelBrowserDetected: true,
    };
  }
  async launchInteractive(): Promise<SenderBrowserSession> {
    if (this.browserMissing) {
      throw new SenderBrowserMissingError();
    }
    if (this.profileLaunchFailed) {
      throw new SenderProfileLaunchFailedError();
    }
    if (this.failInteractiveLaunch) {
      throw new Error("mock: launchPersistentContext failed");
    }
    this.interactiveLaunches++;
    const session = new MockSession(
      "manual-login",
      () => this.nextProbe,
      () => this.navOk,
    );
    this.lastInteractiveHeaded = session.headed;
    this.interactiveSessions.push(session);
    return session;
  }
  async launchHeadless(): Promise<SenderBrowserSession> {
    if (this.browserMissing) {
      throw new SenderBrowserMissingError();
    }
    if (this.profileLaunchFailed) {
      throw new SenderProfileLaunchFailedError();
    }
    this.headlessLaunches++;
    return new MockSession(
      "headless",
      () => this.nextProbe,
      () => this.navOk,
    );
  }
}

class MockMessagingProvider implements MessagingProvider {
  readonly name = "mock";
  calls: SendMessageRequest[] = [];
  result: SendMessageResult = {
    success: true,
    provider: "mock",
    messageText: "",
    sentAt: new Date().toISOString(),
  };
  async connect() {}
  async disconnect() {}
  async getStatus(): Promise<MessagingProviderStatus> {
    return { provider: "mock", authenticated: true, status: "READY" };
  }
  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    this.calls.push(request);
    return { ...this.result, messageText: request.message };
  }
}

async function main() {
  const prisma = getPrismaClient();
  const driver = new MockSessionDriver();
  const provider = new MockMessagingProvider();
  setSenderSessionDriver(driver);
  setMessagingProvider(provider);

  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const userA = await prisma.user.create({
    data: { email: `task18_a_${stamp}@example.com`, passwordHash: "x", name: "Task18 A" },
  });
  const userB = await prisma.user.create({
    data: { email: `task18_b_${stamp}@example.com`, passwordHash: "x", name: "Task18 B" },
  });
  const campaignA = await prisma.campaign.create({
    data: { userId: userA.id, name: `Sender Campaign A ${stamp}`, leadLimit: 100 } as any,
  });
  const campaignB = await prisma.campaign.create({
    data: { userId: userB.id, name: `Sender Campaign B ${stamp}`, leadLimit: 100 } as any,
  });
  const templateA = await prisma.messageTemplate.create({
    data: { campaignId: campaignA.id, name: "Sender Template", body: "Hi {{firstName}}" },
  });
  const leadA = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `leadA_${stamp}`,
      fullName: "Lead A",
      profileUrl: "https://www.instagram.com/leadA/",
    },
  });
  const leadA2 = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `leadA2_${stamp}`,
      fullName: "Lead A2",
      profileUrl: "https://www.instagram.com/leadA2/",
    },
  });
  const leadB = await prisma.lead.create({
    data: {
      campaignId: campaignB.id,
      username: `leadB_${stamp}`,
      fullName: "Lead B",
      profileUrl: "https://www.instagram.com/leadB/",
    },
  });

  let fakeClockTime = new Date("2026-06-10T14:00:00Z");
  setSendGateClock(() => fakeClockTime);

  console.log("=================================================================");
  console.log("   TASK 18: INSTAGRAM SENDER ACCOUNT / SESSION SUITE (MOCKED)     ");
  console.log("=================================================================\n");

  // ---- 1. Create + DTO secrecy ----
  console.log("[1] Create sender account + sanitized DTO");
  const senderA = await createSenderAccount({ displayName: "Primary Sender" }, userA.id);
  check(senderA.status === "CONNECTING", "new sender starts in CONNECTING");
  check(senderA.isConnected === false, "new sender is not connected");
  const serialized = JSON.stringify(senderA);
  check(!serialized.includes("sessionPath"), "DTO never exposes sessionPath");
  check(
    !/sessionid|cookie|password|storageState/i.test(serialized),
    "DTO never exposes cookies/passwords/session state",
  );
  check(
    (await listSenderAccounts(userA.id)).length === 1,
    "list returns only the current user's sender",
  );
  check(
    (await listSenderAccounts(userB.id)).length === 0,
    "another user sees no sender accounts",
  );

  // ---- 2. Ownership / IDOR ----
  console.log("\n[2] Ownership enforcement");
  let idor = false;
  try {
    await getSenderAccount(senderA.id, userB.id);
  } catch (e) {
    idor = (e as { code?: string }).code === "SENDER_NOT_FOUND";
  }
  check(idor, "other user cannot read the sender account (404 SENDER_NOT_FOUND)");
  idor = false;
  try {
    await startSenderConnect(senderA.id, userB.id);
  } catch (e) {
    idor = (e as { code?: string }).code === "SENDER_NOT_FOUND";
  }
  check(idor, "other user cannot connect the sender account");

  // ---- 3. Connect (manual login browser) ----
  console.log("\n[3] Connect flow");
  const connectResult = await startSenderConnect(senderA.id, userA.id);
  check(driver.interactiveLaunches === 1, "headed browser launched once for manual login");
  check(connectResult.sender.status === "CONNECTING", "sender is CONNECTING while user logs in");
  check(
    connectResult.instructions.toLowerCase().includes("manually"),
    "instructions tell the user to log in manually",
  );

  // ---- 4. Verify CONNECTED ----
  console.log("\n[4] Verify -> CONNECTED");
  driver.nextProbe = {
    authenticated: true,
    username: "authorized_sender",
    code: "OK",
    reason: "mock authenticated",
  };
  let verified = await verifySenderAccount(senderA.id, userA.id);
  check(verified.status === "CONNECTED", "verify marks sender CONNECTED");
  check(verified.username === "authorized_sender", "verify stores detected Instagram username");
  check(verified.lastVerifiedAt !== null, "verify records lastVerifiedAt");
  check(verified.isConnected, "isConnected true");

  // ---- 5. Verify AUTH_REQUIRED ----
  console.log("\n[5] Verify -> AUTH_REQUIRED");
  driver.nextProbe = {
    authenticated: false,
    username: null,
    code: "AUTH_REQUIRED",
    reason: "mock: login required",
  };
  verified = await verifySenderAccount(senderA.id, userA.id);
  check(verified.status === "AUTH_REQUIRED", "verify marks AUTH_REQUIRED when logged out");
  check(verified.isConnected === false, "AUTH_REQUIRED is not connected");

  // ---- 6. Verify EXPIRED (previously verified, now missing session) ----
  console.log("\n[6] Verify -> EXPIRED");
  driver.nextProbe = {
    authenticated: false,
    username: null,
    code: "SESSION_UNAVAILABLE",
    reason: "mock: session gone",
  };
  verified = await verifySenderAccount(senderA.id, userA.id);
  check(verified.status === "EXPIRED", "missing session after prior auth marks EXPIRED");

  // ---- 7. Dispatch guards (not connected) ----
  console.log("\n[7] Dispatch blocked without a connected sender");
  provider.calls.length = 0;
  const blocked = await sendSingleMessage(
    { leadId: leadA.id, message: "Blocked message A", senderAccountId: senderA.id },
    userA.id,
  );
  check(!blocked.success, "message to a non-connected sender fails");
  check(
    !blocked.success && (blocked.errorCode === "AUTH_REQUIRED" || blocked.errorCode === "SESSION_UNAVAILABLE"),
    `structured SESSION/AUTH error (got ${!blocked.success ? blocked.errorCode : "?"})`,
  );
  check(provider.calls.length === 0, "no browser dispatch attempted for a non-connected sender");
  const blockedRow = await prisma.message.findFirst({
    where: { leadId: leadA.id },
    orderBy: { createdAt: "desc" },
  });
  check(blockedRow?.status === "FAILED", "audit Message is FAILED, never SENT");

  // No sender id supplied, but the user has senders and none are connected.
  const blocked2 = await sendSingleMessage(
    { leadId: leadA.id, message: "Blocked message B" },
    userA.id,
  );
  check(!blocked2.success && blocked2.status === "FAILED", "no connected sender -> FAILED (not SENT)");

  // ---- 8. IDOR: cross-user sender on an owned lead ----
  console.log("\n[8] Cross-user sender IDOR");
  const senderB = await createSenderAccount({}, userB.id);
  let senderIdor = false;
  try {
    await sendSingleMessage(
      { leadId: leadB.id, message: "Cross tenant sender", senderAccountId: senderA.id },
      userB.id,
    );
  } catch (e) {
    senderIdor = (e as { code?: string }).code === "SENDER_NOT_FOUND";
  }
  check(senderIdor, "cannot dispatch using another user's senderAccountId");

  // ---- 9. Successful dispatch uses the connected sender ----
  console.log("\n[9] Connected sender dispatch");
  await startSenderConnect(senderA.id, userA.id);
  driver.nextProbe = {
    authenticated: true,
    username: "authorized_sender",
    code: "OK",
    reason: "mock authenticated",
  };
  verified = await verifySenderAccount(senderA.id, userA.id);
  check(verified.status === "CONNECTED", "re-connected sender verified");

  provider.result = { success: true, provider: "mock", messageText: "", sentAt: new Date().toISOString() };
  provider.calls.length = 0;
  const sent = await sendSingleMessage(
    {
      leadId: leadA.id,
      message: "Hello from the connected sender",
      senderAccountId: senderA.id,
    },
    userA.id,
  );
  check(sent.success === true, "connected sender dispatch succeeds");
  check(
    provider.calls.length === 1 && provider.calls[0].senderAccountId === senderA.id,
    "dispatcher passes the authoritative senderAccountId to the provider",
  );
  const sentRow = await prisma.message.findFirst({
    where: { leadId: leadA.id, status: "SENT" },
  });
  check(sentRow?.senderAccountId === senderA.id, "SENT audit message records senderAccountId");

  // ---- 9b. Explicit OUTSIDE_WORKING_HOURS check with fake clock ----
  console.log("\n[9b] Clock-dependent working hours gate enforcement");
  const FAKE_OUTSIDE_HOURS = new Date("2026-06-10T03:00:00Z"); // 3 AM UTC (outside 9am-6pm)
  setSendGateClock(() => FAKE_OUTSIDE_HOURS);
  let blockedByHours = false;
  let retryAtSet = false;
  try {
    await sendSingleMessage(
      {
        leadId: leadA.id,
        message: "Should be blocked outside working hours",
        senderAccountId: senderA.id,
        step: "test_outside_hours",
      },
      userA.id,
    );
  } catch (err: unknown) {
    const errorObj = err as { code?: string; userMessage?: string };
    if (errorObj.code === "OUTSIDE_WORKING_HOURS") {
      blockedByHours = true;
      if (errorObj.userMessage && errorObj.userMessage.includes("retry after")) {
        retryAtSet = true;
      }
    }
  }
  check(blockedByHours, "send gate blocks dispatch when clock is OUTSIDE_WORKING_HOURS (3 AM)");
  check(retryAtSet, "OUTSIDE_WORKING_HOURS error message includes retryAt time");
  fakeClockTime = new Date("2026-06-10T14:20:00Z");
  setSendGateClock(() => fakeClockTime); // restore working hours and clear cooldown

  // ---- 10. Bulk job stores sender and worker uses it ----
  console.log("\n[10] Bulk job sender binding + worker");
  const jobResult = await createBulkMessageJob(
    campaignA.id,
    {
      templateId: templateA.id,
      leadIds: [leadA2.id],
      selection: "selected",
      senderAccountId: senderA.id,
    },
    userA.id,
  );
  check(jobResult.job.senderAccountId === senderA.id, "bulk job persists senderAccountId");

  provider.calls.length = 0;
  await dispatchBulkJobQueue(jobResult.job.id);
  check(
    provider.calls.length >= 1 &&
      provider.calls.every((call) => call.senderAccountId === senderA.id),
    "bulk worker dispatches every item through the job's sender account",
  );
  const bulkItem = await prisma.bulkMessageItem.findFirst({
    where: { jobId: jobResult.job.id },
  });
  check(bulkItem?.status === "SENT", "bulk item is SENT with a working sender");

  // Cross-campaign/other-user sender on a job.
  let jobIdor = false;
  try {
    await createBulkMessageJob(
      campaignA.id,
      { templateId: templateA.id, leadIds: [leadA2.id], selection: "selected", senderAccountId: senderB.id },
      userA.id,
    );
  } catch (e) {
    jobIdor = (e as { code?: string }).code === "SENDER_NOT_FOUND";
  }
  check(jobIdor, "bulk job rejects another user's senderAccountId");

  // ---- 11. CAPTCHA / rate limit causes safe pause, never SENT ----
  console.log("\n[11] CAPTCHA causes safe pause");
  fakeClockTime = new Date(fakeClockTime.getTime() + 20 * 60_000);
  const leadCaptcha = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      username: `leadCaptcha_${stamp}`,
      fullName: "Lead Captcha",
      profileUrl: "https://www.instagram.com/leadCaptcha/",
    },
  });
  const captchaJob = await createBulkMessageJob(
    campaignA.id,
    {
      templateId: templateA.id,
      leadIds: [leadCaptcha.id],
      selection: "selected",
      senderAccountId: senderA.id,
    },
    userA.id,
  );
  provider.result = {
    success: false,
    provider: "mock",
    messageText: "",
    error: { code: "CAPTCHA_REQUIRED", message: "security challenge" },
  };
  await dispatchBulkJobQueue(captchaJob.job.id);
  const captchaJobRow = await prisma.bulkMessageJob.findUnique({ where: { id: captchaJob.job.id } });
  const captchaItem = await prisma.bulkMessageItem.findFirst({ where: { jobId: captchaJob.job.id } });
  check(captchaJobRow?.status === "PAUSED", "job is PAUSED on CAPTCHA (no bypass attempt)");
  check(captchaItem?.status === "FAILED", "CAPTCHA item is FAILED, never SENT");
  const captchaMessage = await prisma.message.findFirst({
    where: { leadId: leadCaptcha.id },
    orderBy: { createdAt: "desc" },
  });
  check(captchaMessage?.status !== "SENT", "no SENT message recorded for CAPTCHA failure");
  provider.result = { success: true, provider: "mock", messageText: "", sentAt: new Date().toISOString() };

  // ---- 12. Disconnect ----
  console.log("\n[12] Disconnect");
  const disconnected = await disconnectSenderAccount(senderA.id, userA.id);
  check(disconnected.status === "DISCONNECTED", "sender marked DISCONNECTED");
  check(disconnected.lastVerifiedAt === null, "disconnect clears lastVerifiedAt");
  idor = false;
  try {
    await disconnectSenderAccount(senderA.id, userB.id);
  } catch (e) {
    idor = (e as { code?: string }).code === "SENDER_NOT_FOUND";
  }
  check(idor, "other user cannot disconnect the sender");

  // ---- 13. Manual-login session lifecycle ----
  console.log("\n[13] Manual-login session lifecycle");
  const manager = getSenderSessionManager();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // A/B/H/I: connect keeps the headed browser open and navigates to Instagram.
  manager.setTimeouts({ idleCloseMs: 60, manualLoginTimeoutMs: 60_000 });
  const senderLife = await createSenderAccount({}, userA.id);
  const connectLife = await startSenderConnect(senderLife.id, userA.id);
  check(connectLife.sender.status === "CONNECTING", "[A] connect returns status CONNECTING");
  const infoLife = manager.getManagedSessionInfo(senderLife.id);
  check(
    infoLife?.mode === "manual-login",
    "[B] manual-login session is tracked after POST /connect returns",
  );
  check(
    manager.getInteractiveSession(senderLife.id) !== null,
    "[H] no finally block closed the manual-login browser after connect",
  );
  const sessionLife = manager.getInteractiveSession(senderLife.id) as unknown as MockSession;
  await sleep(180); // Well beyond the 60ms messaging idle interval.
  check(
    manager.getManagedSessionInfo(senderLife.id) !== null &&
      manager.getInteractiveSession(senderLife.id) !== null,
    "[A] manual-login session is NOT closed by the normal idle timeout",
  );
  check(
    sessionLife.mode === "manual-login" && sessionLife.headed === true,
    "[A] interactive login uses a headed manual-login context",
  );
  check(
    driver.lastInteractiveHeaded === true,
    "[A] driver launched the interactive context headed (headless: false)",
  );

  // C/M: a second Connect while CONNECTING must NOT launch another browser.
  const launchesBeforeRepeat = driver.interactiveLaunches;
  const repeatConnect = await startSenderConnect(senderLife.id, userA.id);
  check(
    repeatConnect.reusedExistingSession === true,
    "[C] second Connect reports the existing session was reused",
  );
  check(
    driver.interactiveLaunches === launchesBeforeRepeat,
    "[C] second Connect does NOT launch another browser",
  );
  check(
    manager.getInteractiveSession(senderLife.id) === sessionLife,
    "[M] same sender account still has exactly one interactive session",
  );

  // L: different sender accounts get independent sessions.
  const senderLeft = await createSenderAccount({}, userA.id);
  const senderRight = await createSenderAccount({}, userA.id);
  await startSenderConnect(senderLeft.id, userA.id);
  await startSenderConnect(senderRight.id, userA.id);
  const leftSession = manager.getInteractiveSession(senderLeft.id);
  const rightSession = manager.getInteractiveSession(senderRight.id);
  check(
    leftSession !== null && rightSession !== null && leftSession.id !== rightSession.id,
    "[L] different sender accounts have separate interactive sessions",
  );

  // C: verify reuses the same manual-login session.
  driver.nextProbe = {
    authenticated: true,
    username: "lifecycle_sender",
    code: "OK",
    reason: "mock authenticated",
  };
  const headlessBeforeVerify = driver.headlessLaunches;
  const probeCountBefore = sessionLife.probeCount;
  const verifiedLife = await verifySenderAccount(senderLife.id, userA.id);
  check(verifiedLife.status === "CONNECTED", "[C] verify reaches CONNECTED");
  check(
    driver.headlessLaunches === headlessBeforeVerify,
    "[C] verify reused the live manual-login session (no separate browser)",
  );
  check(sessionLife.probeCount > probeCountBefore, "[C] auth probe ran on the reused session");
  check(
    manager.getManagedSessionInfo(senderLife.id) === null,
    "[C] interactive browser closes only after successful verify",
  );

  // G: CONNECTED sender uses normal headless idle cleanup.
  const lifecycleHeadless = await manager.getSession(senderLife.id);
  check(lifecycleHeadless.mode === "headless", "[G] post-verify messaging session is headless");
  manager.release(senderLife.id);
  await sleep(180);
  check(
    manager.getManagedSessionInfo(senderLife.id) === null,
    "[G] headless messaging session idle-closes normally",
  );

  // D/E: long manual-login safety timeout closes the browser and un-sticks status.
  manager.setTimeouts({ idleCloseMs: 60, manualLoginTimeoutMs: 80 });
  const senderTimeout = await createSenderAccount({}, userA.id);
  await startSenderConnect(senderTimeout.id, userA.id);
  check(
    manager.getManagedSessionInfo(senderTimeout.id) !== null,
    "[D] manual-login session tracked before timeout",
  );
  await sleep(900);
  check(
    manager.getManagedSessionInfo(senderTimeout.id) === null,
    "[D] manual-login safety timeout eventually closes the browser",
  );
  const timeoutRow = await prisma.instagramSenderAccount.findUnique({
    where: { id: senderTimeout.id },
  });
  check(
    timeoutRow?.status === "AUTH_REQUIRED",
    "[E] timeout moves CONNECTING -> AUTH_REQUIRED (not stuck)",
  );

  // F: user closes the browser manually -> CONNECTING -> AUTH_REQUIRED.
  manager.setTimeouts({ idleCloseMs: 60, manualLoginTimeoutMs: 60_000 });
  const senderManualClose = await createSenderAccount({}, userA.id);
  await startSenderConnect(senderManualClose.id, userA.id);
  const sessionManualClose = manager.getInteractiveSession(senderManualClose.id) as unknown as MockSession | null;
  check(sessionManualClose !== null, "[F] manual-login session tracked before manual close");
  sessionManualClose!.simulateExternalClose();
  let manualCloseRow = await prisma.instagramSenderAccount.findUnique({
    where: { id: senderManualClose.id },
  });
  for (let i = 0; i < 40 && manualCloseRow?.status !== "AUTH_REQUIRED"; i++) {
    await sleep(50);
    manualCloseRow = await prisma.instagramSenderAccount.findUnique({
      where: { id: senderManualClose.id },
    });
  }
  check(
    manualCloseRow?.status === "AUTH_REQUIRED",
    "[F] user-closed browser moves CONNECTING -> AUTH_REQUIRED",
  );
  check(
    manager.getManagedSessionInfo(senderManualClose.id) === null,
    "[F] manually closed session is removed from the manager",
  );

  // J: navigation failure -> ERROR, never stuck CONNECTING.
  driver.navOk = false;
  const senderNavFail = await createSenderAccount({}, userA.id);
  let navFailedWithBrowserError = false;
  try {
    await startSenderConnect(senderNavFail.id, userA.id);
  } catch (e) {
    navFailedWithBrowserError = (e as { code?: string }).code === "BROWSER_ERROR";
  }
  check(navFailedWithBrowserError, "[J] Instagram navigation failure returns BROWSER_ERROR");
  const navFailRow = await prisma.instagramSenderAccount.findUnique({
    where: { id: senderNavFail.id },
  });
  check(
    navFailRow?.status === "ERROR",
    "[J] navigation failure persists ERROR instead of CONNECTING",
  );
  driver.navOk = true;

  // K: browser launch failure -> ERROR, never CONNECTING.
  driver.failInteractiveLaunch = true;
  const senderLaunchFail = await createSenderAccount({}, userA.id);
  let launchFailed = false;
  try {
    await startSenderConnect(senderLaunchFail.id, userA.id);
  } catch (e) {
    launchFailed = (e as { code?: string }).code === "BROWSER_ERROR";
  }
  check(launchFailed, "[K] browser launch failure returns BROWSER_ERROR");
  const launchFailRow = await prisma.instagramSenderAccount.findUnique({
    where: { id: senderLaunchFail.id },
  });
  check(
    launchFailRow?.status === "ERROR",
    "[K] launch failure persists ERROR instead of CONNECTING",
  );
  driver.failInteractiveLaunch = false;

  // Cancel: closes the interactive browser and moves CONNECTING -> AUTH_REQUIRED.
  manager.setTimeouts({ idleCloseMs: 60, manualLoginTimeoutMs: 60_000 });
  const senderCancel = await createSenderAccount({}, userA.id);
  await startSenderConnect(senderCancel.id, userA.id);
  check(manager.getInteractiveSession(senderCancel.id) !== null, "cancel: session live before cancel");
  const cancelled = await cancelSenderLogin(senderCancel.id, userA.id);
  check(cancelled.status === "AUTH_REQUIRED", "cancel: status moves to AUTH_REQUIRED");
  check(manager.getInteractiveSession(senderCancel.id) === null, "cancel: interactive browser closed");

  // Diagnostics are safe (no userDataDir/sessionPath leaked) and live while connecting.
  const senderDiag = await createSenderAccount({}, userA.id);
  await startSenderConnect(senderDiag.id, userA.id);
  const diagDto = await getSenderAccount(senderDiag.id, userA.id);
  check(diagDto.sessionDiagnostics?.live === true, "diagnostics: live session reported");
  check(diagDto.sessionDiagnostics?.headed === true, "diagnostics: headed=true for manual login");
  const diagText = JSON.stringify(diagDto);
  check(!diagText.includes("sessionPath"), "diagnostics: sessionPath never exposed");
  check(!/userDataDir|cookie|password|sessionid/i.test(diagText), "diagnostics: no secrets exposed");
  await cancelSenderLogin(senderDiag.id, userA.id);

  // ---- 14. Browser availability + persistent profile preservation ----
  console.log("\n[14] Browser availability + persistent profile");

  // Playwright Chromium missing -> PLAYWRIGHT_BROWSER_MISSING, never AUTH_REQUIRED.
  driver.browserMissing = true;
  const senderMissing = await createSenderAccount({}, userA.id);
  let verifyMissingCode: string | null = null;
  try {
    await verifySenderAccount(senderMissing.id, userA.id);
  } catch (e) {
    verifyMissingCode = (e as { code?: string }).code ?? null;
  }
  check(
    verifyMissingCode === "PLAYWRIGHT_BROWSER_MISSING",
    "[16] verify returns PLAYWRIGHT_BROWSER_MISSING when Chromium is missing",
  );
  const missingRow = await prisma.instagramSenderAccount.findUnique({
    where: { id: senderMissing.id },
  });
  check(
    missingRow?.status === "ERROR",
    "[16] browser-missing verify sets ERROR (not AUTH_REQUIRED)",
  );
  check(
    (missingRow?.lastError ?? "").includes("npx playwright install chromium"),
    "[16] browser-missing error is actionable",
  );

  const senderMissingConnect = await createSenderAccount({}, userA.id);
  let connectMissingCode: string | null = null;
  try {
    await startSenderConnect(senderMissingConnect.id, userA.id);
  } catch (e) {
    connectMissingCode = (e as { code?: string }).code ?? null;
  }
  check(
    connectMissingCode === "PLAYWRIGHT_BROWSER_MISSING",
    "[16] connect returns PLAYWRIGHT_BROWSER_MISSING when Chromium is missing",
  );
  const missingConnectRow = await prisma.instagramSenderAccount.findUnique({
    where: { id: senderMissingConnect.id },
  });
  check(
    missingConnectRow?.status === "ERROR",
    "[16] browser-missing connect sets ERROR (not AUTH_REQUIRED)",
  );
  driver.browserMissing = false;

  // Persistent profile directory must survive connect + verify.
  const senderPreserve = await createSenderAccount({}, userA.id);
  await startSenderConnect(senderPreserve.id, userA.id);
  const preserveRow = await prisma.instagramSenderAccount.findUnique({
    where: { id: senderPreserve.id },
  });
  check(preserveRow !== null, "profile: sender row loaded");
  check(
    senderSessionDirExists(preserveRow!.sessionPath),
    "profile: directory exists after connect",
  );
  driver.nextProbe = {
    authenticated: true,
    username: "preserved_sender",
    code: "OK",
    reason: "mock authenticated",
  };
  const preserved = await verifySenderAccount(senderPreserve.id, userA.id);
  check(preserved.status === "CONNECTED", "[16] verify reaches CONNECTED using the profile");
  check(
    senderSessionDirExists(preserveRow!.sessionPath),
    "[16] verify did NOT delete the persistent sender profile",
  );

  // ---- 15. Profile launch failure + per-sender profile isolation ----
  console.log("\n[15] Profile launch failure + per-sender profile isolation");
  driver.profileLaunchFailed = true;
  const senderProfileFail = await createSenderAccount({}, userA.id);
  let connectProfileFailCode: string | null = null;
  try {
    await startSenderConnect(senderProfileFail.id, userA.id);
  } catch (e) {
    connectProfileFailCode = (e as { code?: string }).code ?? null;
  }
  check(
    connectProfileFailCode === "SENDER_PROFILE_LAUNCH_FAILED",
    "[17] connect returns SENDER_PROFILE_LAUNCH_FAILED",
  );
  const pfRow = await prisma.instagramSenderAccount.findUnique({
    where: { id: senderProfileFail.id },
  });
  check(pfRow?.status === "ERROR", "[17] profile failure sets ERROR (not AUTH_REQUIRED)");
  check(
    (pfRow?.lastError ?? "").includes("Disconnect this sender"),
    "[17] profile failure message is actionable",
  );

  const senderVerifyProfileFail = await createSenderAccount({}, userA.id);
  let verifyProfileFailCode: string | null = null;
  try {
    await verifySenderAccount(senderVerifyProfileFail.id, userA.id);
  } catch (e) {
    verifyProfileFailCode = (e as { code?: string }).code ?? null;
  }
  check(
    verifyProfileFailCode === "SENDER_PROFILE_LAUNCH_FAILED",
    "[17] verify returns SENDER_PROFILE_LAUNCH_FAILED",
  );
  const vpfRow = await prisma.instagramSenderAccount.findUnique({
    where: { id: senderVerifyProfileFail.id },
  });
  check(vpfRow?.status === "ERROR", "[17] verify profile failure sets ERROR");
  driver.profileLaunchFailed = false;

  // Disconnect removes ONLY the target sender's profile directory.
  const sLeft = await createSenderAccount({}, userA.id);
  const sRight = await createSenderAccount({}, userA.id);
  await startSenderConnect(sLeft.id, userA.id);
  await startSenderConnect(sRight.id, userA.id);
  const leftRow = await prisma.instagramSenderAccount.findUnique({ where: { id: sLeft.id } });
  const rightRow = await prisma.instagramSenderAccount.findUnique({ where: { id: sRight.id } });
  check(
    senderSessionDirExists(leftRow!.sessionPath) && senderSessionDirExists(rightRow!.sessionPath),
    "[17] both sender profiles exist before disconnect",
  );
  await disconnectSenderAccount(sLeft.id, userA.id);
  check(
    !senderSessionDirExists(leftRow!.sessionPath),
    "[17] disconnect removed the target sender's profile",
  );
  check(
    senderSessionDirExists(rightRow!.sessionPath),
    "[17] disconnect did NOT remove another sender's profile",
  );
  await cancelSenderLogin(sRight.id, userA.id).catch(() => undefined);

  setSendGateClock(null);
  await prisma.$disconnect();

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Unexpected failure:", error);
  process.exit(1);
});
