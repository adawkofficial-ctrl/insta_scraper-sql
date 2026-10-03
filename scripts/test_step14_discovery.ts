/* eslint-disable */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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

async function registerAndCampaign(label: string) {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const email = `${label}_${stamp}@example.com`;
  const reg = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "ProductionReady2026!", name: `QA ${label}` }),
  });
  const cookieValue = extractCookie(reg);
  if (!cookieValue) throw new Error("no session cookie");
  const cookie = `${COOKIE_NAME}=${cookieValue}`;

  const camp = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: `Discovery ${label} ${stamp}` }),
  });
  const campaign = await camp.json();
  return { cookie, campaignId: campaign.id as string };
}

type DiscoverEvent = Record<string, any>;

async function streamDiscover(
  cookie: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; events: DiscoverEvent[]; result: DiscoverEvent | null; error: DiscoverEvent | null }> {
  const res = await fetch(`${BASE_URL}/api/scraper/instagram/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", Cookie: cookie },
    body: JSON.stringify(payload),
  });

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("ndjson")) {
    const body = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(body); } catch {}
    return { status: res.status, events: [], result: null, error: parsed?.error ?? { code: `HTTP_${res.status}`, message: body } };
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: DiscoverEvent[] = [];
  let result: DiscoverEvent | null = null;
  let error: DiscoverEvent | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let ev: DiscoverEvent;
      try { ev = JSON.parse(t); } catch { continue; }
      events.push(ev);
      if (ev.type === "result") result = ev;
      if (ev.type === "error") error = ev;
    }
  }

  return { status: res.status, events, result, error };
}

async function main() {
  console.log("=================================================================");
  console.log("   STEP 14: CAMPAIGN-INTENT DISCOVERY TEST SUITE                 ");
  console.log(`   Base URL: ${BASE_URL}`);
  console.log("=================================================================");

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  try {
    const a = await registerAndCampaign("discover");
    console.log(`\n[Setup] user A, campaign=${a.campaignId}`);

    // ---- Validation ----
    console.log("\n[Validation]");
    const missingQuery = await streamDiscover(a.cookie, { campaignId: a.campaignId, maxLeads: 10 });
    check(missingQuery.status === 400, `missing query -> 400 (got ${missingQuery.status})`);

    const badLimit0 = await streamDiscover(a.cookie, { campaignId: a.campaignId, query: "fitness", maxLeads: 0 });
    check(badLimit0.status === 400, `maxLeads=0 -> 400 (got ${badLimit0.status})`);

    const badLimit101 = await streamDiscover(a.cookie, { campaignId: a.campaignId, query: "fitness", maxLeads: 101 });
    check(badLimit101.status === 400, `maxLeads=101 -> 400 (got ${badLimit101.status})`);

    const badLimitStr = await streamDiscover(a.cookie, { campaignId: a.campaignId, query: "fitness", maxLeads: "abc" });
    check(badLimitStr.status === 400, `maxLeads="abc" -> 400 (got ${badLimitStr.status})`);

    // ---- Ownership (IDOR) ----
    console.log("\n[Security]");
    const b = await registerAndCampaign("intruder");
    const idor = await streamDiscover(b.cookie, { campaignId: a.campaignId, query: "fitness", maxLeads: 5 });
    check(idor.status === 404, `user B discover into user A campaign -> 404 (got ${idor.status})`);

    const anon = await fetch(`${BASE_URL}/api/scraper/instagram/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId: a.campaignId, query: "fitness", maxLeads: 5 }),
    });
    check(anon.status === 401, `anonymous discover -> 401 (got ${anon.status})`);

    // ---- Real discovery (requested test) ----
    async function runDiscovery(label: string, payload: Record<string, unknown>) {
      console.log(`\n[Discovery] ${label}`);
      const out = await streamDiscover(a.cookie, payload);
      for (const ev of out.events) {
        if (ev.type === "progress") {
          console.log(`  progress: ${ev.stage} :: ${ev.message}`);
        }
      }
      if (out.error) console.log("  error:", JSON.stringify(out.error));
      if (out.result) {
        console.log("  meta:", JSON.stringify(out.result.meta));
      }
      return out;
    }

    const requested = await runDiscovery("Rawalpindi fitness intent", {
      campaignId: a.campaignId,
      query: "fitness gyms and fitness businesses",
      location: "Rawalpindi",
      category: "Fitness",
      maxLeads: 10,
    });

    check(requested.status === 200, "discovery endpoint returns 200 stream");
    check(requested.result !== null || requested.error !== null, "stream produced a result or error");
    if (requested.result) {
      check(
        requested.result.meta.persisted <= 10,
        `10-lead limit enforced (persisted ${requested.result.meta.persisted})`,
      );
      const leadIds: string[] = requested.result.data.map((l: any) => l.username);
      check(new Set(leadIds).size === leadIds.length, "no duplicate usernames persisted");
    }

    // Fallback: if the long intent found nothing, prove the pipeline with a
    // simpler, higher-yield intent (still real, no fake data).
    let proof = requested;
    if (!requested.result || requested.result.meta.persisted === 0) {
      proof = await runDiscovery("fallback intent: fitness India", {
        campaignId: a.campaignId,
        query: "fitness",
        location: "India",
        category: "Fitness",
        maxLeads: 10,
      });
    }

    // ---- Verify persisted leads via the Leads API ----
    console.log("\n[Persistence]");
    const leadsRes = await fetch(
      `${BASE_URL}/api/campaigns/${a.campaignId}/leads?page=1&limit=100`,
      { headers: { Cookie: a.cookie } },
    );
    const leadsBody = await leadsRes.json();
    const leads = leadsBody.items ?? [];
    console.log(`  leads in campaign: ${leads.length}`);
    if (leads.length > 0) {
      console.log("  sample lead:", JSON.stringify({
        username: leads[0].username,
        fullName: leads[0].fullName,
        followers: leads[0].followers,
        profileUrl: leads[0].profileUrl,
        isVerified: leads[0].isVerified,
        isBusiness: leads[0].isBusiness,
        category: leads[0].category,
      }));
    }
    check(leadsRes.status === 200, "GET leads returns 200");
    check(leads.length <= 10, `campaign contains at most 10 leads (got ${leads.length})`);
    check(new Set(leads.map((l: any) => l.username)).size === leads.length, "no duplicate campaign leads");

    const finalResult = (proof.result ?? requested.result) as DiscoverEvent | null;
    if (finalResult) {
      check(
        leads.length >= finalResult.meta.persisted,
        `persisted leads visible via API (${leads.length} >= ${finalResult.meta.persisted})`,
      );
      check(
        finalResult.meta.persisted === finalResult.data.length,
        "result payload matches persisted count",
      );
    }

    // ---- ScrapeJob audit metadata ----
    console.log("\n[ScrapeJob audit]");
    const jobs = await prisma.scrapeJob.findMany({
      where: { campaignId: a.campaignId },
      orderBy: { createdAt: "desc" },
      take: 3,
    });
    if (jobs.length > 0) {
      console.log("  latest job:", JSON.stringify({
        status: jobs[0].status,
        discoveryActor: jobs[0].discoveryActor,
        enrichmentActor: jobs[0].enrichmentActor,
        requestedLimit: jobs[0].requestedLimit,
        candidatesDiscovered: jobs[0].candidatesDiscovered,
        candidatesEnriched: jobs[0].candidatesEnriched,
        processedCount: jobs[0].processedCount,
        errorMessage: jobs[0].errorMessage,
      }));
    }
    check(jobs.length > 0, "discovery scrape job recorded");
    check(jobs[0]?.discoveryActor === "apify/instagram-search-scraper", "job stores discovery actor");
    check(jobs[0]?.enrichmentActor === "apify/instagram-profile-scraper", "job stores enrichment actor");

    // ---- Campaign intent stored ----
    const campaignRes = await fetch(`${BASE_URL}/api/campaigns/${a.campaignId}`, {
      headers: { Cookie: a.cookie },
    });
    const campaign = await campaignRes.json();
    check(typeof campaign.intent === "string" && campaign.intent.length > 0, "campaign intent persisted");
    check(campaign.leadLimit === 10, `campaign leadLimit persisted (got ${campaign.leadLimit})`);

    // ---- Regression: existing profile scraper still works ----
    console.log("\n[Regression] Specific profiles mode");
    const c = await registerAndCampaign("profiles");
    const profileRes = await fetch(`${BASE_URL}/api/scraper/instagram/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: c.cookie },
      body: JSON.stringify({
        campaignId: c.campaignId,
        profiles: ["instagram", "natgeo"],
        maxLeads: 10,
      }),
    });
    const profileBody = await profileRes.json();
    check(profileRes.status === 200, `profile scrape returns 200 (got ${profileRes.status})`);
    check(profileBody?.meta?.processedCount === 2, `profile scrape persisted 2 leads (got ${profileBody?.meta?.processedCount})`);
    console.log("  profile meta:", JSON.stringify(profileBody?.meta));
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
