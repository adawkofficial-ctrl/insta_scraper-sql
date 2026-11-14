/* eslint-disable */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";
import { renderTemplate } from "../src/lib/services/template/template-renderer";
import {
  parseLeadLimit,
  DEFAULT_LEAD_LIMIT,
  MAX_LEAD_LIMIT,
  MIN_LEAD_LIMIT,
} from "../src/lib/services/scraper/instagram-profile";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";
const COOKIE_NAME = "insta_session";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(condition: boolean, name: string) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}`);
    failed++;
  }
}

function skip(name: string) {
  console.log(`  SKIP: ${name}`);
  skipped++;
}

function extractCookie(response: Response, cookieName: string): string | null {
  const getSetCookie = (response.headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getSetCookie === "function") {
    for (const c of getSetCookie.call(response.headers)) {
      const match = c.match(new RegExp(`${cookieName}=([^;]+)`));
      if (match) return match[1];
    }
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

type ApiResult = { status: number; json: any; res: Response };

async function api(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.cookie) headers["Cookie"] = options.cookie;

  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, res };
}

// ---------------------------------------------------------------------------
// Pure unit tests
// ---------------------------------------------------------------------------

function testTemplateRenderer() {
  console.log("\n[Task 14] Message template rendering");

  const t1 = renderTemplate(
    "Hi {{firstName}}, welcome to {{campaignName}}.",
    { username: "john", fullName: "John" },
    "Fitness Campaign",
  );
  check(t1 === "Hi John, welcome to Fitness Campaign.", `exact render (got "${t1}")`);

  const t2 = renderTemplate(
    "Hello {{firstName}} from {{campaignName}} - {{senderName}}",
    { username: "acct", fullName: null, category: null },
    "Campaign X",
    "Alice",
  );
  check(
    !t2.includes("{{") && t2.includes("Alice") && t2.includes("acct"),
    `missing firstName -> safe fallback (got "${t2}")`,
  );

  const t3 = renderTemplate(
    "Unknown: {{unknownVar}}!",
    { username: "acct" },
    "C",
    "A",
  );
  check(t3 === "Unknown: !", `unknown variable renders empty (got "${t3}")`);

  const t4 = renderTemplate("", { username: "x" }, "C");
  check(t4 === "", "empty template renders empty without throwing");

  const t5 = renderTemplate(
    "Bio: {{bio}} / category: {{category}}",
    { username: "x", biography: null, category: null },
    "C",
  );
  check(!t5.includes("{{"), "null bio/category leave no placeholders");

  const t6 = renderTemplate("Ok {{ fullName }}", { username: "x", fullName: "Jane Doe" }, "C");
  check(t6 === "Ok Jane Doe", "whitespace inside braces supported");
}

function testLeadLimitParsing() {
  console.log("\n[Task 13] Lead limit validation (pure)");

  check(parseLeadLimit(undefined) === DEFAULT_LEAD_LIMIT, `default is ${DEFAULT_LEAD_LIMIT}`);
  check(parseLeadLimit(10) === 10, "limit 10 accepted");
  check(parseLeadLimit(MIN_LEAD_LIMIT) === MIN_LEAD_LIMIT, "limit 1 accepted");
  check(parseLeadLimit(MAX_LEAD_LIMIT) === MAX_LEAD_LIMIT, "max limit accepted");
  check(parseLeadLimit(1000) === 1000, "limit 1000 accepted (no campaign cap)");

  const invalid: Array<[string, unknown]> = [
    ["0", 0],
    ["2147483648", 2_147_483_648],
    ['"abc"', "abc"],
    ["-5", -5],
    ["1.5", 1.5],
    ['"10" (string)', "10"],
  ];

  for (const [label, value] of invalid) {
    let threw = false;
    try {
      parseLeadLimit(value);
    } catch {
      threw = true;
    }
    check(threw, `rejects invalid limit ${label}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP / database integration tests
// ---------------------------------------------------------------------------

async function main() {
  console.log("=================================================================");
  console.log("   STEP 14: LEAD LIMIT / TEMPLATE / EXECUTION TEST SUITE        ");
  console.log(`   Base URL: ${BASE_URL}`);
  console.log("=================================================================");

  testTemplateRenderer();
  testLeadLimitParsing();

  const connectionString = process.env.DATABASE_URL!;
  const prisma = createPrismaClient();

  const stamp = Date.now();
  const email = `qa14_${stamp}@example.com`;
  const password = "ProductionReady2026!";

  try {
    console.log("\n[Setup] Health + auth");
    const health = await api("/api/health");
    check(health.status === 200, "server health check returns 200");

    const register = await api("/api/auth/register", {
      method: "POST",
      body: { email, password, name: "QA Sender" },
    });
    check(
      register.status === 200 || register.status === 201,
      `register returns ${register.status}`,
    );

    const rawCookie = extractCookie(register.res, COOKIE_NAME);
    check(Boolean(rawCookie), "received session cookie");
    const cookie = `${COOKIE_NAME}=${rawCookie}`;

    const me = await api("/api/auth/me", { cookie });
    check(me.status === 200, "authenticated /me returns 200");
    check(
      me.json?.name === "QA Sender" || me.json?.user?.name === "QA Sender",
      "registered user has sender name",
    );

    // -----------------------------------------------------------------
    // Task 13: limit validation over HTTP
    // -----------------------------------------------------------------
    console.log("\n[Task 13] Maximum Leads validation (HTTP)");

    const limitCampaign = await api("/api/campaigns", {
      method: "POST",
      cookie,
      body: { name: `QA14 Limit ${stamp}` },
    });
    check(limitCampaign.status === 201, "created limit-test campaign");
    const limitCampaignId: string = limitCampaign.json.id;

    for (const [label, value] of [
      ["0", 0],
      ["101", 101],
      ['"abc"', "abc"],
    ] as const) {
      const res = await api("/api/scraper/instagram/profile", {
        method: "POST",
        cookie,
        body: {
          campaignId: limitCampaignId,
          usernames: ["instagram"],
          maxLeads: value,
        },
      });
      check(
        res.status === 400 || res.status === 422,
        `limit ${label} rejected with ${res.status} (${res.json?.error?.code})`,
      );
    }

    const jobsAfterInvalid = await prisma.scrapeJob.count({
      where: { campaignId: limitCampaignId },
    });
    check(jobsAfterInvalid === 0, "invalid limits never start a scrape job");

    // -----------------------------------------------------------------
    // Task 13: real scrape respects limit and prevents duplicates
    // -----------------------------------------------------------------
    console.log("\n[Task 13] Real scrape: limit cap + duplicate prevention");

    const scrapeCampaign = await api("/api/campaigns", {
      method: "POST",
      cookie,
      body: { name: `QA14 Scrape ${stamp}` },
    });
    check(scrapeCampaign.status === 201, "created scrape-test campaign");
    const scrapeCampaignId: string = scrapeCampaign.json.id;

    const usernames = ["instagram", "natgeo", "nasa"];

    const limited = await api("/api/scraper/instagram/profile", {
      method: "POST",
      cookie,
      body: { campaignId: scrapeCampaignId, usernames, maxLeads: 1 },
    });

    if (limited.status === 500 && limited.json?.error?.code === "APIFY_NOT_CONFIGURED") {
      skip("real Apify scrape tests (APIFY_API_TOKEN not configured)");
    } else {
      check(limited.status === 200, `limit=1 scrape returns 200 (got ${limited.status})`);
      const firstLeads = await api(
        `/api/campaigns/${scrapeCampaignId}/leads?limit=100`,
        { cookie },
      );
      const firstCount: number = firstLeads.json?.items?.length ?? -1;
      check(
        firstCount >= 0 && firstCount <= 1,
        `limit=1 persisted no more than 1 lead (got ${firstCount})`,
      );
      check(
        (limited.json?.meta?.processedCount ?? 99) <= 1,
        "scrape meta processedCount respects the limit",
      );

      const full = await api("/api/scraper/instagram/profile", {
        method: "POST",
        cookie,
        body: { campaignId: scrapeCampaignId, usernames, maxLeads: 10 },
      });
      check(full.status === 200, `limit=10 scrape returns 200 (got ${full.status})`);

      const secondLeads = await api(
        `/api/campaigns/${scrapeCampaignId}/leads?limit=100`,
        { cookie },
      );
      const secondItems: Array<{ username: string }> = secondLeads.json?.items ?? [];
      const uniqueUsernames = new Set(secondItems.map((l) => l.username));
      check(
        secondItems.length === uniqueUsernames.size,
        `no duplicate campaign leads (${secondItems.length} leads, ${uniqueUsernames.size} unique)`,
      );
      check(secondItems.length <= 10, `limit=10 caps persisted leads (got ${secondItems.length})`);

      // Duplicate re-run: same usernames must not increase the lead count.
      const rerun = await api("/api/scraper/instagram/profile", {
        method: "POST",
        cookie,
        body: { campaignId: scrapeCampaignId, usernames, maxLeads: 10 },
      });
      check(rerun.status === 200, "duplicate re-run returns 200");

      const thirdLeads = await api(
        `/api/campaigns/${scrapeCampaignId}/leads?limit=100`,
        { cookie },
      );
      const thirdItems: Array<{ username: string }> = thirdLeads.json?.items ?? [];
      check(
        thirdItems.length === secondItems.length,
        `re-running the same profiles creates no duplicates (${secondItems.length} -> ${thirdItems.length})`,
      );
    }

    // -----------------------------------------------------------------
    // Tasks 5/6: template + preview
    // -----------------------------------------------------------------
    console.log("\n[Tasks 5-6] Message template + preview");

    const emptyTemplate = await api(`/api/campaigns/${scrapeCampaignId}/templates`, {
      method: "POST",
      cookie,
      body: { name: "Empty", body: "   " },
    });
    check(
      emptyTemplate.status === 400 || emptyTemplate.status === 422,
      `empty template rejected with ${emptyTemplate.status} (${emptyTemplate.json?.error?.code})`,
    );

    const templateRes = await api(`/api/campaigns/${scrapeCampaignId}/templates`, {
      method: "POST",
      cookie,
      body: {
        name: "QA14 Template",
        body: "Hi {{firstName}}, welcome to {{campaignName}}. - {{senderName}}",
      },
    });
    check(templateRes.status === 201 || templateRes.status === 200, "created message template");
    const templateId: string = templateRes.json.id;

    const leadsRes = await api(`/api/campaigns/${scrapeCampaignId}/leads?limit=100`, {
      cookie,
    });
    const leads: Array<{ id: string; username: string }> = leadsRes.json?.items ?? [];
    check(leads.length > 0, `campaign has leads for execution (got ${leads.length})`);

    if (leads.length > 0) {
      const preview = await api("/api/messages/preview", {
        method: "POST",
        cookie,
        body: { leadId: leads[0].id, templateId },
      });
      check(preview.status === 200, `message preview returns 200 (got ${preview.status})`);
      check(
        typeof preview.json?.text === "string" && preview.json.text.length > 0,
        "message preview returns text",
      );
      check(!String(preview.json?.text ?? "").includes("{{"), "preview has no unresolved variables");
      check(
        String(preview.json?.text ?? "").includes("QA Sender"),
        "preview renders {{senderName}} from the authenticated user",
      );
      check(
        String(preview.json?.text ?? "").includes("QA14 Scrape"),
        "preview renders {{campaignName}}",
      );
    } else {
      skip("message preview (no leads available)");
    }

    // -----------------------------------------------------------------
    // Tasks 7-11: execution workflow
    // -----------------------------------------------------------------
    console.log("\n[Tasks 7-11] Controlled execution workflow");

    if (leads.length === 0) {
      skip("execution workflow (no leads available)");
    } else {
      const selectedLeadIds = leads.slice(0, 3).map((l) => l.id);

      const executeRes = await api(`/api/campaigns/${scrapeCampaignId}/execute`, {
        method: "POST",
        cookie,
        body: { templateId, leadIds: selectedLeadIds },
      });
      check(
        executeRes.status === 201 || executeRes.status === 200,
        `execution preview created (got ${executeRes.status})`,
      );
      const executionId: string = executeRes.json.executionId;
      check(
        executeRes.json?.planned === selectedLeadIds.length,
        `preview planned only selected leads (planned ${executeRes.json?.planned}, selected ${selectedLeadIds.length})`,
      );

      let detail = await api(`/api/campaign-executions/${executionId}?limit=100`, {
        cookie,
      });
      check(detail.status === 200, "execution detail fetched");
      const items: Array<{ id: string; leadId: string; status: string }> =
        detail.json?.items ?? [];
      check(items.length === selectedLeadIds.length, "execution has one item per selected lead");

      await api(
        `/api/campaign-executions/${executionId}/items/${items[0].id}/approve`,
        { method: "POST", cookie, body: { messageText: items[0] ? "Approved QA message" : undefined } },
      );

      if (items.length > 1) {
        await api(
          `/api/campaign-executions/${executionId}/items/${items[1].id}/skip`,
          { method: "POST", cookie },
        );
      }

      detail = await api(`/api/campaign-executions/${executionId}?limit=100`, { cookie });
      check(detail.json?.approvedItems === 1, "one item is APPROVED");
      check(
        items.length > 1 ? detail.json?.skippedItems === 1 : true,
        "one item is SKIPPED",
      );

      const dispatch = await api(`/api/campaign-executions/${executionId}/dispatch`, {
        method: "POST",
        cookie,
      });
      check(
        dispatch.status === 200,
        `dispatch returns 200 (got ${dispatch.status}: ${dispatch.json?.error?.code})`,
      );
      check(
        dispatch.json?.attempted === 1,
        `only APPROVED messages were attempted (attempted ${dispatch.json?.attempted})`,
      );
      check(
        dispatch.json?.sent === 1 || dispatch.json?.failed === 1,
        `approved message ended SENT or FAILED (sent ${dispatch.json?.sent}, failed ${dispatch.json?.failed})`,
      );

      const dispatchedItems: Array<{ leadId: string; status: string }> =
        dispatch.json?.items ?? [];
      const approvedLeadId = items[0].leadId;
      const approvedResult = dispatchedItems.find((i) => i.leadId === approvedLeadId);
      check(
        approvedResult?.status === "SENT" || approvedResult?.status === "FAILED",
        `approved lead moved to SENT/FAILED (got ${approvedResult?.status})`,
      );

      // DB audit verification
      const dbItems = await prisma.campaignExecutionItem.findMany({
        where: { executionId },
        orderBy: { createdAt: "asc" },
      });
      check(dbItems.length === selectedLeadIds.length, "audit: execution items persisted");
      check(
        dbItems.some((i) => i.status === "SKIPPED"),
        "audit: skipped item persisted as SKIPPED",
      );
      check(
        dbItems.some((i) => i.status === "SENT" || i.status === "FAILED"),
        "audit: dispatched item persisted with terminal status",
      );

      const auditMessages = await prisma.message.findMany({
        where: { leadId: approvedLeadId, campaignId: scrapeCampaignId },
      });
      check(auditMessages.length >= 1, "audit: a Message history record was written");

      // Second dispatch must be rejected (no approved items remain)
      const secondDispatch = await api(
        `/api/campaign-executions/${executionId}/dispatch`,
        { method: "POST", cookie },
      );
      check(
        secondDispatch.status === 400,
        `dispatch without approved items rejected (got ${secondDispatch.status})`,
      );
    }
  } catch (error) {
    console.error("\nUnexpected test failure:", error);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log("=================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main();
