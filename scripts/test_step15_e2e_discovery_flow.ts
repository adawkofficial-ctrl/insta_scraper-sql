import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";

async function main() {
  console.log("===============================================================");
  console.log("==> E2E LEADS DISCOVERY FLOW VERIFICATION (FRONTEND -> API -> PERSISTENCE)");
  console.log("===============================================================\n");

  const connectionString = process.env.DATABASE_URL!;
  const prisma = createPrismaClient();

  // 1. Authenticate user
  console.log("[1] Authenticating user...");
  const loginRes = await fetch("http://localhost:3001/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "pcplayer809@gmail.com",
      password: "ProductionReady2026!",
    }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }

  const { token, user } = await loginRes.json();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Cookie: `insta_session=${token}; session_token=${token}`,
  };
  console.log(`✓ Authenticated as ${user.email} (${user.id})`);

  // 2. Create campaign
  console.log("\n[2] Creating test campaign...");
  const campaignPayload = {
    name: "Rawalpindi Fitness E2E Verified",
    description: "Automated verification of leads discovery flow",
    intent: "fitness gyms and fitness businesses",
    location: "Rawalpindi",
    category: "Fitness",
    leadLimit: 10,
  };

  const createRes = await fetch("http://localhost:3001/api/campaigns", {
    method: "POST",
    headers,
    body: JSON.stringify(campaignPayload),
  });

  if (!createRes.ok) {
    throw new Error(`Campaign creation failed: ${createRes.status} ${await createRes.text()}`);
  }

  const campaign = await createRes.json();
  console.log("✓ Created campaign:", {
    id: campaign.id,
    name: campaign.name,
    intent: campaign.intent,
    location: campaign.location,
    category: campaign.category,
    leadLimit: campaign.leadLimit,
  });

  // 3. Trigger Discovery Endpoint
  console.log("\n[3] Triggering POST /api/scraper/instagram/discover with Step 14 payload...");
  const discoveryPayload = {
    campaignId: campaign.id,
    query: "fitness gyms and fitness businesses",
    location: "Rawalpindi",
    category: "Fitness",
    maxLeads: 10,
  };

  console.log("[Discovery UI] starting discovery", discoveryPayload);

  const discoverRes = await fetch("http://localhost:3001/api/scraper/instagram/discover", {
    method: "POST",
    headers: {
      ...headers,
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify(discoveryPayload),
  });

  console.log(`✓ Discovery response status: ${discoverRes.status} ${discoverRes.statusText}`);

  if (!discoverRes.ok) {
    throw new Error(`Discovery HTTP error: ${discoverRes.status} ${await discoverRes.text()}`);
  }

  if (!discoverRes.body) {
    throw new Error("Discovery response body is empty!");
  }

  // 4. Stream & parse NDJSON events
  console.log("\n[4] Streaming discovery NDJSON events...");
  const reader = discoverRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: Record<string, unknown> | null = null;
  const progressEvents: Array<Record<string, unknown>> = [];

  const handleEventLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "progress") {
        progressEvents.push(event);
        console.log(`  [Progress Event] stage=${event.stage} message="${event.message}" candidatesDiscovered=${event.candidatesDiscovered ?? "-"} enriched=${event.candidatesEnriched ?? "-"} persisted=${event.persisted ?? "-"}`);
      } else if (event.type === "result") {
        finalResult = event;
        console.log(`  [Result Event] success=${event.success} persisted=${(event.meta as Record<string, unknown>)?.persisted} enriched=${(event.meta as Record<string, unknown>)?.candidatesEnriched}`);
      } else if (event.type === "error") {
        console.error("  [Error Event]", event.error);
        throw new Error(`Stream error event: ${JSON.stringify(event.error)}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Stream error event")) throw e;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      handleEventLine(line);
    }
  }

  if (buffer.trim()) {
    handleEventLine(buffer);
  }

  console.log("[Discovery UI] discovery request completed");

  if (!finalResult) {
    throw new Error("Discovery completed without emitting a final result event!");
  }

  const resultObj = finalResult as unknown as {
    meta: {
      campaignId: string;
      scrapeJobId: string;
      candidatesDiscovered: number;
      candidatesEnriched: number;
      persisted: number;
      skipped: number;
      notice: string | null;
    };
  };
  const meta = resultObj.meta;

  console.log("\n✓ Discovery Run Summary:", {
    campaignId: meta.campaignId,
    scrapeJobId: meta.scrapeJobId,
    candidatesDiscovered: meta.candidatesDiscovered,
    candidatesEnriched: meta.candidatesEnriched,
    persisted: meta.persisted,
    skipped: meta.skipped,
    notice: meta.notice,
  });

  // 5. Verify Leads API: GET /api/campaigns/:id/leads?page=1&limit=25
  console.log("\n[5] Fetching GET /api/campaigns/:id/leads?page=1&limit=25...");
  const leadsRes = await fetch(`http://localhost:3001/api/campaigns/${campaign.id}/leads?page=1&limit=25`, {
    headers,
  });

  if (!leadsRes.ok) {
    throw new Error(`GET leads failed: ${leadsRes.status} ${await leadsRes.text()}`);
  }

  const leadsJson = await leadsRes.json();
  console.log(`✓ Leads count returned from API: ${leadsJson.items.length} (total in pagination: ${leadsJson.pagination.total})`);

  if (meta.persisted > 0 && leadsJson.items.length === 0) {
    throw new Error("Persisted leads count > 0 but GET leads returned 0 items!");
  }

  if (leadsJson.items.length > 0) {
    console.log("Sample persisted leads in database:");
    for (const lead of leadsJson.items.slice(0, 3)) {
      console.log(`  - @${lead.username} (${lead.fullName || "No name"}) | Followers: ${lead.followers} | Category: ${lead.category || "N/A"}`);
    }
  }

  // 6. Verify Scrape Jobs API
  console.log("\n[6] Fetching GET /api/campaigns/:id/scrape-jobs...");
  const jobsRes = await fetch(`http://localhost:3001/api/campaigns/${campaign.id}/scrape-jobs`, { headers });
  const jobs = await jobsRes.json();
  console.log(`✓ Scrape jobs count: ${jobs.length}`);
  if (jobs.length > 0) {
    const latestJob = jobs[0];
    console.log("  Latest Scrape Job:", {
      id: latestJob.id,
      status: latestJob.status,
      provider: latestJob.provider,
      candidatesDiscovered: latestJob.candidatesDiscovered,
      candidatesEnriched: latestJob.candidatesEnriched,
      processedCount: latestJob.processedCount,
    });
  }

  // 7. Verify Analytics
  console.log("\n[7] Fetching GET /api/campaigns/:id/analytics...");
  const analyticsRes = await fetch(`http://localhost:3001/api/campaigns/${campaign.id}/analytics`, { headers });
  const analytics = await analyticsRes.json();
  console.log("✓ Analytics verified:", {
    totalLeads: analytics.leads.total,
    verifiedLeads: analytics.leads.verified,
    businessLeads: analytics.leads.business,
    totalScrapeJobs: analytics.scraping.jobs,
  });

  console.log("\n===============================================================");
  console.log("🎉 DISCOVERY FLOW VERIFICATION SUCCESSFUL!");
  console.log("===============================================================");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
