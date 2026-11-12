/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { BulkMessageItemStatus } from "../src/generated/prisma/enums";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3005";
const COOKIE = "insta_session";

let passed = 0;
let failed = 0;
const leaks: string[] = [];

function check(cond: boolean, name: string) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}`);
    failed++;
  }
}

function cookieOf(res: Response): string {
  const sc = res.headers.get("set-cookie") || "";
  const m = sc.match(new RegExp(`${COOKIE}=([^;]+)`));
  return `${COOKIE}=${m?.[1] ?? ""}`;
}

async function call(path: string, cookie: string, method = "GET", body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let text = "";
  try { text = await res.text(); } catch {}
  if (["apify_api_", "postgresql://", "insta_session", "AUTH_SECRET", "E:\\", " at "].some((p) => text.includes(p))) {
    leaks.push(`${method} ${path}`);
  }
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function register(label: string) {
  const s = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `t13_${label}_${s}@example.com`, password: "ProductionReady2026!", name: `T13 ${label}` }),
  });
  const b = (await res.clone().json()) as { user?: { id?: string } };
  return { cookie: cookieOf(res), userId: b.user?.id as string };
}

async function campaign(cookie: string, name: string) {
  const r = await call("/api/campaigns", cookie, "POST", { name });
  return r.json;
}

async function main() {
  console.log("=================================================================");
  console.log("   TASK 13: E2E + REGRESSION GAP SUITE (deterministic)           ");
  console.log("=================================================================");

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

  try {
    const A = await register("A");
    const B = await register("B");
    const cA = await campaign(A.cookie, `T13 A ${Date.now()}`);
    await campaign(B.cookie, `T13 B ${Date.now()}`);

    console.log("\n[Fuzzing / input edge cases]");
    for (const [label, payload] of [
      ["empty name", { name: "" }],
      ["whitespace name", { name: "   " }],
      ["numeric name", { name: 123 }],
      ["array name", { name: ["a"] }],
      ["null body", null],
      ["array body", [1, 2]],
    ] as Array<[string, unknown]>) {
      const r = await call("/api/campaigns", A.cookie, "POST", payload);
      check([400, 422].includes(r.status), `campaign create ${label} -> ${r.status}`);
    }
    const unicode = await campaign(A.cookie, "🔥 Gym — Rāwalpindi <b>test</b>");
    check(unicode?.name === "🔥 Gym — Rāwalpindi <b>test</b>", "unicode/emoji/HTML-looking name preserved as text");
    const longDesc = await call(`/api/campaigns/${cA.id}`, A.cookie, "PATCH", { description: "x".repeat(5000) });
    check([400, 422].includes(longDesc.status), `oversized description rejected (${longDesc.status})`);

    console.log("\n[API contract]");
    const badReq = await call("/api/campaigns", A.cookie, "POST", { name: "" });
    check(typeof badReq.json?.error?.code === "string" && typeof badReq.json?.error?.message === "string", "error shape { error: { code, message } }");
    check(!/ at |stack|prisma/i.test(badReq.text), "error body has no stack/Prisma internals");
    const unauth = await call("/api/campaigns", "");
    check(unauth.status === 401 && typeof unauth.json?.error?.code === "string", "401 contract with safe code");
    const listOk = await call("/api/campaigns", A.cookie);
    check(listOk.status === 200 && Array.isArray(listOk.json), "campaign list success shape");

    console.log("\n[Persistence across refresh (server-authoritative state)]");
    await call(`/api/campaigns/${cA.id}`, A.cookie, "PATCH", { intent: "fitness gyms", location: "Rawalpindi", category: "Fitness", leadLimit: 10 });
    const reread = await call(`/api/campaigns/${cA.id}`, A.cookie);
    check(
      reread.json?.intent === "fitness gyms" && reread.json?.location === "Rawalpindi" && reread.json?.category === "Fitness" && reread.json?.leadLimit === 10,
      "intent/location/category/leadLimit persisted server-side",
    );

    console.log("\n[Discovery validation matrix — provider not invoked]");
    for (const [label, payload] of [
      ["missing query", { campaignId: cA.id, maxLeads: 5 }],
      ["maxLeads 0", { campaignId: cA.id, query: "fitness", maxLeads: 0 }],
      ["maxLeads 101", { campaignId: cA.id, query: "fitness", maxLeads: 101 }],
      ["maxLeads abc", { campaignId: cA.id, query: "fitness", maxLeads: "abc" }],
      ["malformed campaignId", { campaignId: "bad id!", query: "fitness", maxLeads: 5 }],
    ] as Array<[string, unknown]>) {
      const r = await call("/api/scraper/instagram/discover", A.cookie, "POST", payload);
      check(r.status === 400, `discover ${label} -> ${r.status}`);
    }
    const crossDiscover = await call("/api/scraper/instagram/discover", B.cookie, "POST", { campaignId: cA.id, query: "fitness", maxLeads: 5 });
    check(crossDiscover.status === 404, `discover into another tenant campaign -> 404 (${crossDiscover.status})`);
    const jobsAfterInvalid = await prisma.scrapeJob.count({ where: { campaignId: cA.id } });
    check(jobsAfterInvalid === 0, "invalid discovery never created a ScrapeJob");

    console.log("\n[DB integrity]");
    const lead = await prisma.lead.create({ data: { campaignId: cA.id, username: `t13lead${Date.now()}`, profileUrl: "https://www.instagram.com/x", source: "apify", scrapedAt: new Date() } });
    let dup = false;
    try { await prisma.lead.create({ data: { campaignId: cA.id, username: lead.username, profileUrl: "https://www.instagram.com/dup", source: "apify" } }); } catch (e) { dup = (e as { code?: string }).code === "P2002"; }
    check(dup, "unique (campaignId, username) enforced");
    let fk = false;
    try { await prisma.lead.create({ data: { campaignId: "nonexistent_campaign_id", username: `t13fk${Date.now()}`, profileUrl: "https://www.instagram.com/fk", source: "apify" } }); } catch (e) { fk = ["P2003", "P2025"].includes((e as { code?: string }).code ?? ""); }
    check(fk, "foreign key integrity enforced (invalid campaignId rejected)");

    const tpl = await prisma.messageTemplate.create({ data: { campaignId: cA.id, name: "T13", body: "Hi {{firstName}} from {{campaignName}} ({{postsCount}})" } });
    const exec = await prisma.campaignExecution.create({ data: { campaignId: cA.id, userId: A.userId, status: "READY", phase: "READY", executionMode: "MANUAL" } });
    await prisma.campaignExecutionItem.create({ data: { executionId: exec.id, leadId: lead.id, messageText: "hi", status: "PENDING" } });
    let execDup = false;
    try { await prisma.campaignExecutionItem.create({ data: { executionId: exec.id, leadId: lead.id, messageText: "dup", status: "PENDING" } }); } catch (e) { execDup = (e as { code?: string }).code === "P2002"; }
    check(execDup, "unique (executionId, leadId) enforced");

    console.log("\n[Template preview does not send]");
    const beforeMsgs = await prisma.message.count({ where: { campaignId: cA.id } });
    const beforeAttempts = await prisma.messageAttempt.count({ where: { campaignId: cA.id } });
    const preview = await call(`/api/templates/${tpl.id}/preview`, A.cookie, "POST", { campaignId: cA.id, leadIds: [lead.id] });
    check(preview.status === 200 && preview.json?.sent === false, "preview returns sent:false");
    const afterMsgs = await prisma.message.count({ where: { campaignId: cA.id } });
    const afterAttempts = await prisma.messageAttempt.count({ where: { campaignId: cA.id } });
    check(afterMsgs === beforeMsgs && afterAttempts === beforeAttempts, "preview created no Message/MessageAttempt rows");

    console.log("\n[Analytics per-state accuracy]");
    const cD = await campaign(A.cookie, `T13 D ${Date.now()}`);
    const tplD = await prisma.messageTemplate.create({ data: { campaignId: cD.id, name: "D", body: "hi" } });
    const jobD = await prisma.bulkMessageJob.create({ data: { campaignId: cD.id, userId: A.userId, templateId: tplD.id, status: "PAUSED", total: 17, sent: 10, failed: 2, unknown: 1, skipped: 1, queued: 2, cancelled: 1 } });
    const statuses: Array<[BulkMessageItemStatus, number]> = [
      [BulkMessageItemStatus.SENT, 10],
      [BulkMessageItemStatus.FAILED, 2],
      [BulkMessageItemStatus.UNKNOWN, 1],
      [BulkMessageItemStatus.SKIPPED, 1],
      [BulkMessageItemStatus.QUEUED, 2],
      [BulkMessageItemStatus.PROCESSING, 1],
      [BulkMessageItemStatus.CANCELLED, 1],
    ];
    for (const [st, n] of statuses) {
      for (let i = 0; i < n; i++) {
        const l = await prisma.lead.create({ data: { campaignId: cD.id, username: `t13d_${st}_${i}_${Date.now()}`, profileUrl: "https://www.instagram.com/x", source: "apify" } });
        await prisma.bulkMessageItem.create({ data: { jobId: jobD.id, leadId: l.id, renderedMessage: "hi", status: st, attempts: 1 } });
      }
    }
    const an = await call(`/api/campaigns/${cD.id}/analytics`, A.cookie);
    check(an.status === 200, `analytics 200 (${an.status})`);
    check(an.json?.messaging?.sent === 10, `sent = 10 not inflated (got ${an.json?.messaging?.sent})`);
    check(an.json?.messaging?.failed === 2 && an.json?.messaging?.unknown === 1 && an.json?.messaging?.skipped === 1, "failed/unknown/skipped accurate");
    check(an.json?.messaging?.queued === 2 && an.json?.messaging?.processing === 1 && an.json?.messaging?.cancelled === 1, "queued/processing/cancelled accurate");
    check(an.json?.summary?.messagesSent === 10, "summary.messagesSent = 10 (no join inflation)");

    console.log("\n[Concurrency]");
    const [l1, l2] = await Promise.all([call(`/api/campaigns/${cA.id}/leads?page=1&limit=25`, A.cookie), call(`/api/campaigns/${cA.id}/leads?page=1&limit=25`, A.cookie)]);
    check(l1.status === 200 && l2.status === 200 && l1.json?.pagination?.total === l2.json?.pagination?.total, "concurrent lead reads consistent");
    const [t1, t2] = await Promise.all([
      call(`/api/campaigns/${cA.id}/templates`, A.cookie, "POST", { name: `Conc ${Date.now()}`, body: "hi {{username}}" }),
      call(`/api/campaigns/${cA.id}/templates`, A.cookie, "POST", { name: `Conc2 ${Date.now()}`, body: "hi {{username}}" }),
    ]);
    check(t1.status === 201 && t2.status === 201, "concurrent template creates both succeed");
    const [d1, d2] = await Promise.all([
      call("/api/scraper/instagram/discover", A.cookie, "POST", { campaignId: cA.id, query: "x", maxLeads: 101 }),
      call("/api/scraper/instagram/discover", A.cookie, "POST", { campaignId: cA.id, query: "x", maxLeads: 101 }),
    ]);
    check(d1.status === 400 && d2.status === 400, "concurrent discovery cannot bypass lead limit");
    const jobR = await prisma.bulkMessageJob.create({ data: { campaignId: cA.id, userId: A.userId, templateId: tpl.id, status: "PAUSED", total: 1, failed: 1 } });
    const itemR = await prisma.bulkMessageItem.create({ data: { jobId: jobR.id, leadId: lead.id, renderedMessage: "hi", status: "FAILED", attempts: 1, errorCode: "NETWORK_ERROR" } });
    const [r1, r2] = await Promise.all([
      call(`/api/message-jobs/${jobR.id}/items/${itemR.id}/retry`, A.cookie, "POST"),
      call(`/api/message-jobs/${jobR.id}/items/${itemR.id}/retry`, A.cookie, "POST"),
    ]);
    const successes = [r1.status, r2.status].filter((s) => s === 200).length;
    const itemAfter = await prisma.bulkMessageItem.findUnique({ where: { id: itemR.id } });
    check(successes >= 1 && itemAfter?.status === "QUEUED", `concurrent retry converges to a single QUEUED item (${r1.status}/${r2.status})`);

    console.log("\n[Secret-leak scan]");
    check(leaks.length === 0, `no secrets in any tested response (${leaks.slice(0, 3).join("; ") || "none"})`);
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
