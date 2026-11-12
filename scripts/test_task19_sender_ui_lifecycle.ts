import "dotenv/config";
import { chromium, type Page } from "playwright";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3005";
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const reg = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `task19_${stamp}@example.com`,
      password: "Password123!",
      name: "Task19 UI",
    }),
  });
  if (!reg.ok) throw new Error(`register failed ${reg.status} ${await reg.text()}`);
  const setCookie = reg.headers.get("set-cookie");
  if (!setCookie) throw new Error("no cookie");
  const cookie = setCookie.split(";")[0];
  const body = (await reg.json()) as { user?: { id: string }; id?: string };
  const userId = body.user?.id ?? body.id;
  if (!userId) throw new Error("no user id");

  const sender = await prisma.instagramSenderAccount.create({
    data: {
      userId,
      username: `pending_${stamp.slice(-6)}`,
      sessionType: "PERSISTENT_PROFILE",
      sessionPath: `${userId}/ui_${stamp}`,
      status: "CONNECTING",
    },
  });

  console.log("=================================================================");
  console.log("   TASK 19: SENDER SETTINGS UI LIFECYCLE (NO BROWSER LAUNCH)      ");
  console.log("=================================================================\n");

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([
    {
      name: "insta_session",
      value: cookie.split("=").slice(1).join("="),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const page: Page = await context.newPage();

  let listRequests = 0;
  page.on("request", (req) => {
    if (req.method() === "GET" && req.url().endsWith("/api/instagram/senders")) {
      listRequests++;
    }
  });

  await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="sender-CONNECTING"]').waitFor({ state: "visible", timeout: 20000 });

  // N: UI disables Connect while CONNECTING and shows the login panel.
  console.log("[N] UI state while CONNECTING");
  const connectBtn = page.locator("#connect-instagram-account-btn");
  check(await connectBtn.isDisabled(), "[N] top Connect button disabled while CONNECTING");
  check(
    (await connectBtn.innerText()).includes("Connecting"),
    "[N] top Connect button shows Connecting...",
  );
  const rowConnectBtn = page.locator("#connect-sender-btn").first();
  check(await rowConnectBtn.isDisabled(), "[N] per-row Connect disabled while CONNECTING");
  check(
    (await rowConnectBtn.innerText()).includes("Connecting"),
    "[N] per-row Connect shows Connecting...",
  );
  check(
    (await page.locator("#verify-sender-btn").count()) === 1,
    "[N] Verify Session button available",
  );
  check(
    (await page.locator("#cancel-sender-login-btn").count()) === 1,
    "[N] Cancel Login button available",
  );
  const panelText = await page.locator('[data-testid="interactive-login-panel"]').innerText();
  check(panelText.includes("Instagram browser opened"), "[N] login panel title shown");
  check(panelText.includes("Log into Instagram in the browser window."), "[N] login panel instructions shown");
  check(panelText.includes("Keep the browser open."), "[N] login panel keep-open warning shown");
  check(panelText.includes("Elapsed:"), "[N] login panel shows elapsed time");
  check(
    (await page.locator('[data-testid="sender-diagnostics"]').count()) >= 1,
    "[N] sender diagnostics panel rendered",
  );

  // O: polling runs while CONNECTING and stops after a terminal status.
  console.log("\n[O] Polling lifecycle");
  const countAtStart = listRequests;
  await sleep(4500);
  const pollsWhileConnecting = listRequests - countAtStart;
  check(pollsWhileConnecting >= 2, `[O] UI polls while CONNECTING (got ${pollsWhileConnecting})`);

  await prisma.instagramSenderAccount.update({
    where: { id: sender.id },
    data: { status: "CONNECTED", lastVerifiedAt: new Date() },
  });
  await sleep(3600); // Allow the in-flight poll to observe CONNECTED and stop.
  const afterTerminal = listRequests;
  await sleep(3200);
  const pollsAfterTerminal = listRequests - afterTerminal;
  check(
    pollsAfterTerminal === 0,
    `[O] polling stops after terminal status (got ${pollsAfterTerminal} extra polls)`,
  );
  const bodyText = await page.locator("body").innerText();
  check(bodyText.includes("Connected"), "[O] UI reflects CONNECTED status");
  check(
    (await page.locator('[data-testid="interactive-login-panel"]').count()) === 0,
    "[O] login panel hidden after CONNECTED",
  );

  await browser.close();
  await prisma.$disconnect();

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
