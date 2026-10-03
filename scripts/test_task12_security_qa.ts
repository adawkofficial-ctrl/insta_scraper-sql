import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";
const COOKIE_NAME = "insta_session";

let passed = 0;
let failed = 0;
const secretLeakSamples: string[] = [];

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
  const sc = res.headers.get("set-cookie");
  if (!sc) return null;
  const m = sc.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return m ? m[1] : null;
}

async function register(label: string) {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `t12_${label}_${stamp}@example.com`, password: "ProductionReady2026!", name: `T12 ${label}` }),
  });
  const body = (await res.clone().json()) as { user?: { id?: string }; id?: string };
  return { cookie: `${COOKIE_NAME}=${extractCookie(res)}`, userId: (body.user?.id ?? body.id) as string };
}

async function createCampaign(cookie: string, name: string) {
  const res = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

async function status(url: string, cookie?: string, method = "GET", body?: unknown) {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let text = "";
  try { text = await res.text(); } catch {}
  const patterns = ["apify_api_", "postgresql://", "insta_session", "AUTH_SECRET", "sk-", "E:\\", "DATABASE_URL", "at Object.", "PrismaClient"];
  if (patterns.some((p) => text.includes(p))) secretLeakSamples.push(`${url} -> ${text.slice(0, 200)}`);
  return { status: res.status, text };
}

function scanSourceForClientSecretLeaks() {
  console.log("\n[Static] Server-only leakage scan");
  const root = path.join(process.cwd(), "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full.includes("generated")) continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);

  const serverOnlyImports = ["@/lib/env", "@/lib/db/prisma", "apify-client", "playwright", "@/lib/logger", "server-only"];
  const offenders: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    if (!/["']use client["']/.test(src.slice(0, 200))) continue;
    for (const imp of serverOnlyImports) {
      if (src.includes(`from "${imp}"`) || src.includes(`from '${imp}'`)) offenders.push(`${file} -> ${imp}`);
    }
  }
  check(offenders.length === 0, `no client component imports server-only modules (${offenders.join("; ") || "none"})`);

  const publicSecret = files.filter((f) => fs.readFileSync(f, "utf8").includes("NEXT_PUBLIC_"));
  check(publicSecret.length === 0, `no NEXT_PUBLIC_* usage (${publicSecret.join(", ") || "none"})`);

  const envInClient = files.filter((f) => {
    const src = fs.readFileSync(f, "utf8");
    return /["']use client["']/.test(src.slice(0, 200)) && /process\.env\.(APIFY_API_TOKEN|DATABASE_URL|AUTH_SECRET|OPENAI_API_KEY|GEMINI_API_KEY)/.test(src);
  });
  check(envInClient.length === 0, `no server secret env vars in client files (${envInClient.join(", ") || "none"})`);
}

async function main() {
  console.log("=================================================================");
  console.log("   TASK 12: DATABASE + API + SECURITY QA                         ");
  console.log(`   Base URL: ${BASE_URL}`);
  console.log("=================================================================");

  scanSourceForClientSecretLeaks();

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

  try {
    const A = await register("A");
    const B = await register("B");
    const campA = await createCampaign(A.cookie, `T12 A ${Date.now()}`);
    const campB = await createCampaign(B.cookie, `T12 B ${Date.now()}`);

    console.log("\n[Auth]");
    check((await status("/api/campaigns")).status === 401, "unauthenticated GET campaigns -> 401");
    check((await status("/api/auth/me")).status === 401, "unauthenticated GET me -> 401");
    check((await status("/api/campaigns", `${COOKIE_NAME}=not-a-valid-jwt`)).status === 401, "invalid session -> 401");

    console.log("\n[IDOR] Campaign-scoped routes (user B -> A)");
    const idor: Array<[string, string, string, unknown?]> = [
      ["GET campaign", `/api/campaigns/${campA.id}`, "GET"],
      ["PATCH campaign", `/api/campaigns/${campA.id}`, "PATCH", { name: "hijack" }],
      ["DELETE campaign", `/api/campaigns/${campA.id}`, "DELETE"],
      ["GET leads", `/api/campaigns/${campA.id}/leads`, "GET"],
      ["GET analytics", `/api/campaigns/${campA.id}/analytics`, "GET"],
      ["GET scrape-jobs", `/api/campaigns/${campA.id}/scrape-jobs`, "GET"],
      ["GET messages", `/api/campaigns/${campA.id}/messages`, "GET"],
      ["GET templates", `/api/campaigns/${campA.id}/templates`, "GET"],
      ["POST pause", `/api/campaigns/${campA.id}/pause`, "POST"],
      ["POST resume", `/api/campaigns/${campA.id}/resume`, "POST"],
      ["POST cancel", `/api/campaigns/${campA.id}/cancel`, "POST"],
      ["POST execute", `/api/campaigns/${campA.id}/execute`, "POST", {}],
      ["POST profile scrape", "/api/scraper/instagram/profile", "POST", { campaignId: campA.id, profiles: ["instagram"], maxLeads: 1 }],
      ["POST discover", "/api/scraper/instagram/discover", "POST", { campaignId: campA.id, query: "x", maxLeads: 1 }],
    ];
    for (const [label, url, method, body] of idor) {
      const res = await status(url, B.cookie, method, body);
      check([404, 403].includes(res.status), `${label} as B -> ${res.status} (expected 404/403)`);
    }

    console.log("\n[IDOR] Nested resources (user B -> A)");
    const leadA = await prisma.lead.create({
      data: { campaignId: campA.id, username: `t12lead${Date.now()}`, profileUrl: "https://www.instagram.com/x", fullName: "A Lead", source: "apify", scrapedAt: new Date() },
    });
    const tplA = await prisma.messageTemplate.create({ data: { campaignId: campA.id, name: "T12", body: "hi {{firstName}}" } });

    for (const [label, url, method, body] of [
      ["GET lead", `/api/leads/${leadA.id}`, "GET", undefined],
      ["PATCH lead", `/api/leads/${leadA.id}`, "PATCH", { fullName: "hijack" }],
      ["DELETE lead", `/api/leads/${leadA.id}`, "DELETE", undefined],
      ["GET lead messages", `/api/leads/${leadA.id}/messages`, "GET", undefined],
      ["GET template", `/api/templates/${tplA.id}`, "GET", undefined],
      ["PATCH template", `/api/templates/${tplA.id}`, "PATCH", { body: "hijack" }],
      ["DELETE template", `/api/templates/${tplA.id}`, "DELETE", undefined],
      ["POST template preview", `/api/templates/${tplA.id}/preview`, "POST", { campaignId: campB.id, leadIds: [leadA.id] }],
    ] as Array<[string, string, string, unknown]>) {
      const res = await status(url, B.cookie, method, body);
      check([404, 403].includes(res.status), `${label} as B -> ${res.status} (expected 404/403)`);
    }

    const execA = await prisma.campaignExecution.create({
      data: { campaignId: campA.id, userId: A.userId, status: "RUNNING", phase: "READY", executionMode: "MANUAL", totalItems: 0, leaseUntil: new Date(Date.now() + 60000), heartbeatAt: new Date() },
    });
    const jobA = await prisma.bulkMessageJob.create({
      data: { campaignId: campA.id, userId: A.userId, templateId: tplA.id, status: "PAUSED", total: 1, failed: 1 },
    });
    const itemA = await prisma.bulkMessageItem.create({
      data: { jobId: jobA.id, leadId: leadA.id, renderedMessage: "hi", status: "FAILED", attempts: 1, errorCode: "NETWORK_ERROR", errorMessage: "x", completedAt: new Date() },
    });

    for (const [label, url, method, body] of [
      ["GET execution", `/api/campaign-executions/${execA.id}`, "GET", undefined],
      ["dispatch execution", `/api/campaign-executions/${execA.id}/dispatch`, "POST", undefined],
      ["cancel execution", `/api/campaign-executions/${execA.id}/cancel`, "POST", undefined],
      ["GET message job", `/api/message-jobs/${jobA.id}`, "GET", undefined],
      ["start message job", `/api/message-jobs/${jobA.id}/start`, "POST", undefined],
      ["pause message job", `/api/message-jobs/${jobA.id}/pause`, "POST", undefined],
      ["resume message job", `/api/message-jobs/${jobA.id}/resume`, "POST", undefined],
      ["cancel message job", `/api/message-jobs/${jobA.id}/cancel`, "POST", undefined],
      ["retry message item", `/api/message-jobs/${jobA.id}/items/${itemA.id}/retry`, "POST", undefined],
      ["recover-stale message job", `/api/message-jobs/${jobA.id}/recover-stale`, "POST", undefined],
    ] as Array<[string, string, string, unknown]>) {
      const res = await status(url, B.cookie, method, body);
      check([404, 403, 409].includes(res.status), `${label} as B -> ${res.status} (expected 404/403/409)`);
    }

    console.log("\n[IDOR] recover-stale tenant scoping");
    const staleExec = await prisma.campaignExecution.create({
      data: { campaignId: campA.id, userId: A.userId, status: "RUNNING", phase: "READY", executionMode: "MANUAL", totalItems: 0, leaseUntil: new Date(Date.now() - 120000), heartbeatAt: new Date(Date.now() - 120000) },
    });
    await status("/api/campaign-executions/recover-stale", B.cookie, "POST");
    const afterB = await prisma.campaignExecution.findUnique({ where: { id: staleExec.id } });
    check(afterB?.status === "RUNNING", "user B recover-stale does NOT mutate user A execution");
    await status("/api/campaign-executions/recover-stale", A.cookie, "POST");
    const afterA = await prisma.campaignExecution.findUnique({ where: { id: staleExec.id } });
    check(afterA?.status !== "RUNNING", `owner recover-stale mutates own stale execution (got ${afterA?.status})`);

    console.log("\n[Validation] Pagination / filters / limits / mass-assignment");
    for (const [label, qs] of [
      ["page=0", "page=0"],
      ["page=-1", "page=-1"],
      ["page=abc", "page=abc"],
      ["limit=0", "limit=0"],
      ["limit=101", "limit=101"],
      ["limit=abc", "limit=abc"],
      ["verified=maybe", "verified=maybe"],
      ["status=BOGUS", "status=BOGUS"],
    ] as Array<[string, string]>) {
      const res = await status(`/api/campaigns/${campA.id}/leads?${qs}`, A.cookie);
      check(res.status === 400, `leads ${label} -> 400 (got ${res.status})`);
    }
    check((await status(`/api/campaigns/${campA.id}/leads?page=1&limit=100`, A.cookie)).status === 200, "leads limit=100 accepted (bounded max)");

    for (const [label, limit] of [["0", 0], ["-1", -1], ["101", 101], ["999999", 999999], ['"abc"', "abc"]] as Array<[string, unknown]>) {
      const res = await status(`/api/campaigns/${campA.id}`, A.cookie, "PATCH", { leadLimit: limit });
      check([400, 422].includes(res.status), `campaign leadLimit=${label} -> 400/422 (got ${res.status})`);
    }
    const massAssign = await status(`/api/campaigns/${campA.id}`, A.cookie, "PATCH", { userId: B.userId, name: "ok" });
    check(massAssign.status === 400, `mass-assignment userId rejected -> 400 (got ${massAssign.status})`);
    const oversized = await status("/api/campaigns", A.cookie, "POST", { name: "x".repeat(500) });
    check(oversized.status === 400, `oversized campaign name -> 400 (got ${oversized.status})`);

    console.log("\n[State machine]");
    const badTransition = await status(`/api/campaigns/${campA.id}`, A.cookie, "PATCH", { status: "COMPLETED" });
    check(badTransition.status === 400, `DRAFT -> COMPLETED invalid transition rejected (got ${badTransition.status})`);
    const invalidStatus = await status(`/api/campaigns/${campA.id}`, A.cookie, "PATCH", { status: "NOPE" });
    check(invalidStatus.status === 400, `unknown status value rejected (got ${invalidStatus.status})`);

    console.log("\n[Data integrity]");
    let duplicateRejected = false;
    try {
      await prisma.lead.create({ data: { campaignId: campA.id, username: leadA.username, profileUrl: "https://www.instagram.com/dup", source: "apify" } });
    } catch (e) {
      duplicateRejected = (e as { code?: string }).code === "P2002";
    }
    check(duplicateRejected, "duplicate campaign username rejected by unique constraint");

    console.log("\n[Analytics integrity]");
    const analytics = await fetch(`${BASE_URL}/api/campaigns/${campA.id}/analytics`, { headers: { Cookie: A.cookie } });
    const aJson = await analytics.json();
    const leadCount = await prisma.lead.count({ where: { campaignId: campA.id } });
    check(analytics.status === 200, `analytics 200 (got ${analytics.status})`);
    check(aJson?.summary?.totalLeads === leadCount && aJson?.leads?.total === leadCount, `analytics lead total matches DB (${aJson?.summary?.totalLeads} vs ${leadCount})`);

    console.log("\n[Cascade / orphan audit]");
    const campC = await createCampaign(A.cookie, `T12 C ${Date.now()}`);
    const cLead = await prisma.lead.create({ data: { campaignId: campC.id, username: `t12c${Date.now()}`, profileUrl: "https://www.instagram.com/c", source: "apify" } });
    const cTpl = await prisma.messageTemplate.create({ data: { campaignId: campC.id, name: "C", body: "hi" } });
    const cScrape = await prisma.scrapeJob.create({ data: { campaignId: campC.id, status: "COMPLETED", provider: "apify" } });
    const cJob = await prisma.bulkMessageJob.create({ data: { campaignId: campC.id, userId: A.userId, templateId: cTpl.id, status: "PAUSED", total: 1, failed: 1 } });
    const cItem = await prisma.bulkMessageItem.create({ data: { jobId: cJob.id, leadId: cLead.id, renderedMessage: "hi", status: "FAILED", attempts: 1 } });
    await prisma.messageAttempt.create({ data: { userId: A.userId, campaignId: campC.id, leadId: cLead.id, jobId: cJob.id, itemId: cItem.id, status: "FAILED", messageText: "hi", attemptNumber: 1 } });
    await prisma.campaignExecution.create({ data: { campaignId: campC.id, userId: A.userId, status: "READY", phase: "READY", executionMode: "MANUAL" } });

    const del = await status(`/api/campaigns/${campC.id}`, A.cookie, "DELETE");
    check(del.status === 200, `delete campaign -> 200 (got ${del.status})`);
    const [leadsLeft, tplLeft, jobsLeft, itemsLeft, attemptsLeft, execsLeft, scrapeLeft] = await Promise.all([
      prisma.lead.count({ where: { campaignId: campC.id } }),
      prisma.messageTemplate.count({ where: { campaignId: campC.id } }),
      prisma.bulkMessageJob.count({ where: { campaignId: campC.id } }),
      prisma.bulkMessageItem.count({ where: { jobId: cJob.id } }),
      prisma.messageAttempt.count({ where: { campaignId: campC.id } }),
      prisma.campaignExecution.count({ where: { campaignId: campC.id } }),
      prisma.scrapeJob.count({ where: { id: cScrape.id } }),
    ]);
    check(leadsLeft === 0 && tplLeft === 0 && jobsLeft === 0 && itemsLeft === 0 && attemptsLeft === 0 && execsLeft === 0, "cascade deleted leads/templates/jobs/items/attempts/executions");
    // Verified schema behavior: ScrapeJob.campaign onDelete: Cascade (campaign-scoped job history is removed with the campaign).
    check(scrapeLeft === 0, `scrape job cascade-deleted with campaign (remaining ${scrapeLeft})`);

    console.log("\n[Secret leak]");
    check(secretLeakSamples.length === 0, `no secrets in error/API responses (${secretLeakSamples.slice(0, 2).join(" | ") || "none"})`);

    console.log("\n[Regression]");
    check((await status("/api/health")).status === 200, "health 200");
    check((await status("/api/campaigns", A.cookie)).status === 200, "authenticated campaigns list 200");
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
