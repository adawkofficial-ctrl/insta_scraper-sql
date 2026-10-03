import "dotenv/config";
import "./preload_server_only.cjs";
import { chromium, type Page } from "playwright";
import { getPrismaClient } from "../src/lib/db/prisma";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";
const prisma = getPrismaClient();

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
      email: `task22_${stamp}@example.com`,
      password: "Password123!",
      name: "Task22",
    }),
  });
  if (!reg.ok) throw new Error(`register failed ${reg.status} ${await reg.text()}`);
  const setCookie = reg.headers.get("set-cookie");
  if (!setCookie) throw new Error("no cookie");
  const cookie = setCookie.split(";")[0];
  const body = (await reg.json()) as { user?: { id: string }; id?: string };
  const userId = body.user?.id ?? body.id;
  if (!userId) throw new Error("no user id");

  const profile = await prisma.companyProfile.create({
    data: { userId, name: `Profile ${stamp}` },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId,
      companyProfileId: profile.id,
      name: `No Poll ${stamp}`,
      leadLimit: 50,
      status: "DRAFT",
    } as any,
  });
  for (let i = 0; i < 3; i += 1) {
    await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        username: `task22_lead_${stamp}_${i}`,
        fullName: `Lead ${i}`,
        profileUrl: `https://www.instagram.com/task22_lead_${stamp}_${i}/`,
      },
    });
  }

  console.log("=================================================================");
  console.log("   TASK 22: CAMPAIGN PAGE MUST NOT POLL (REAL BROWSER)           ");
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

  const counts = { campaign: 0, leads: 0, analytics: 0 };
  page.on("request", (req) => {
    if (req.method() !== "GET") return;
    let pathname = "";
    try {
      pathname = new URL(req.url()).pathname;
    } catch {
      return;
    }
    if (pathname === `/api/campaigns/${campaign.id}`) counts.campaign += 1;
    else if (pathname === `/api/campaigns/${campaign.id}/leads`) counts.leads += 1;
    else if (pathname === `/api/campaigns/${campaign.id}/analytics`) counts.analytics += 1;
  });

  await page.goto(`${BASE_URL}/campaigns/${campaign.id}`, { waitUntil: "networkidle" });
  await page.getByText(`task22_lead_${stamp}_0`).first().waitFor({ state: "visible", timeout: 20000 });
  await sleep(1000);

  const initial = { ...counts };
  console.log(`  [t0] campaign=${initial.campaign} leads=${initial.leads} analytics=${initial.analytics}`);
  check(initial.leads >= 1, "[load] leads endpoint requested at least once");
  check(initial.campaign >= 1, "[load] campaign endpoint requested at least once");

  // Idle for 8 seconds: there must be no repeated requests.
  await sleep(8000);
  const afterIdle = { ...counts };
  console.log(`  [t+8s] campaign=${afterIdle.campaign} leads=${afterIdle.leads} analytics=${afterIdle.analytics}`);
  check(
    afterIdle.campaign === initial.campaign,
    `[idle] campaign endpoint did not repeat (was ${initial.campaign}, now ${afterIdle.campaign})`,
  );
  check(
    afterIdle.leads === initial.leads,
    `[idle] leads endpoint did not repeat (was ${initial.leads}, now ${afterIdle.leads})`,
  );
  check(
    afterIdle.analytics === initial.analytics,
    `[idle] analytics endpoint did not repeat (was ${initial.analytics}, now ${afterIdle.analytics})`,
  );

  // Navigate away: no further requests for this campaign at all.
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  const beforeLeave = { ...counts };
  await sleep(3500);
  const afterLeave = { ...counts };
  console.log(`  [after nav] campaign=${afterLeave.campaign} leads=${afterLeave.leads} analytics=${afterLeave.analytics}`);
  check(
    afterLeave.campaign === beforeLeave.campaign &&
      afterLeave.leads === beforeLeave.leads &&
      afterLeave.analytics === beforeLeave.analytics,
    "[navigate-away] no further campaign requests after leaving the page",
  );

  await browser.close();
  await prisma.$disconnect();

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
