import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3001";
const prisma = createPrismaClient();

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function registerUser(label: string): Promise<{ cookie: string; userId: string }> {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const email = `${label}_${stamp}@example.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!", name: `QA ${label}` }),
  });
  if (!res.ok) throw new Error(`register ${label} failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie");
  const cookie = setCookie.split(";")[0];
  const body = (await res.json()) as { user?: { id: string }; id?: string };
  const userId = body.user?.id ?? body.id;
  if (!userId) throw new Error("no user id in register response");
  return { cookie, userId };
}

async function createCampaign(cookie: string, name: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name, leadLimit: 50 }),
  });
  if (!res.ok) throw new Error(`campaign create failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function createTemplate(
  cookie: string,
  campaignId: string,
  name: string,
  templateBody: string,
): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name, body: templateBody }),
  });
  if (!res.ok) throw new Error(`template create failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function main(): Promise<void> {
  console.log("=================================================================");
  console.log("   TASK 17: BULK MESSAGE TEMPLATE LOADING / MAPPING SUITE         ");
  console.log("=================================================================\n");

  const userA = await registerUser("task17_a");
  const userB = await registerUser("task17_b");

  const campaignA = await createCampaign(userA.cookie, `Bulk Template Campaign A ${Date.now()}`);
  const campaignB = await createCampaign(userB.cookie, `Bulk Template Campaign B ${Date.now()}`);
  const campaignEmpty = await createCampaign(userA.cookie, `Bulk Template Campaign Empty ${Date.now()}`);

  const templateA = await createTemplate(
    userA.cookie,
    campaignA,
    "hy fitness",
    "Hi {{firstName}}, I came across your {{businessCategory}} profile and wanted to reach out about {{campaignName}}!",
  );
  const templateB = await createTemplate(userB.cookie, campaignB, "Tenant B Template", "Hello from B");
  const campaignNameA = (await prisma.campaign.findUnique({ where: { id: campaignA } }))!.name;

  const leadA = await prisma.lead.create({
    data: {
      campaignId: campaignA,
      username: `ahmed_fit_${Date.now()}`,
      fullName: "Ahmed Khan",
      category: "Fitness",
      businessCategoryName: "Fitness",
      profileUrl: "https://www.instagram.com/ahmed_fit/",
    },
  });
  const leadB = await prisma.lead.create({
    data: {
      campaignId: campaignB,
      username: `lead_b_${Date.now()}`,
      fullName: "Tenant B Lead",
      profileUrl: "https://www.instagram.com/lead_b/",
    },
  });

  // ---- 1. Authoritative endpoint + response shape ----
  console.log("[1] GET campaign templates response shape");
  const listRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/templates`, {
    headers: { Cookie: userA.cookie },
  });
  const listJson: unknown = await listRes.json();
  check(listRes.status === 200, `GET templates returns 200 (got ${listRes.status})`);
  check(Array.isArray(listJson), "response is a bare JSON array (the shape the UI must read)");
  const list = Array.isArray(listJson)
    ? (listJson as Array<{ id: string; name: string; body: string; campaignId: string | null }>)
    : [];
  const hasTemplatesWrapper = Object.prototype.hasOwnProperty.call(
    listJson,
    "templates",
  );
  check(
    !hasTemplatesWrapper,
    "response has NO `templates` wrapper key (regression guard for data.templates bug)",
  );
  check(list.some((t) => t.id === templateA), "campaign template present in list");
  const listed = list.find((t) => t.id === templateA);
  check(listed?.name === "hy fitness", "template name mapped correctly");
  check(
    typeof listed?.body === "string" && listed.body.includes("{{firstName}}"),
    "template body field present (UI must read .body, not .content)",
  );
  check(
    !list.some((t) => t.id === templateB),
    "other campaign's template not returned",
  );

  // ---- 2. Auth / ownership ----
  console.log("\n[2] Auth and ownership");
  const anonRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/templates`);
  check(anonRes.status === 401, `unauthenticated template list rejected (got ${anonRes.status})`);
  const crossTenantList = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/templates`, {
    headers: { Cookie: userB.cookie },
  });
  check(crossTenantList.status === 404, `cross-tenant campaign templates rejected (got ${crossTenantList.status})`);

  // ---- 3. Zero-template campaign ----
  console.log("\n[3] Campaign with zero templates");
  const emptyRes = await fetch(`${BASE_URL}/api/campaigns/${campaignEmpty}/templates`, {
    headers: { Cookie: userA.cookie },
  });
  const emptyJson = await emptyRes.json();
  check(emptyRes.status === 200, "zero-template campaign returns 200");
  check(Array.isArray(emptyJson), "zero-template response is an array");
  check(
    Array.isArray(emptyJson) && emptyJson.length === 0,
    `zero-template campaign returns [] so the UI shows the empty state (got ${Array.isArray(emptyJson) ? emptyJson.length : "n/a"})`,
  );

  // ---- 4. Preview response shape + rendering ----
  console.log("\n[4] Bulk preview mapping + rendering");
  const prevRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/message-jobs/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({ templateId: templateA, leadIds: [leadA.id], selection: "selected" }),
  });
  const prevJson = (await prevRes.json()) as Record<string, unknown>;
  check(prevRes.status === 200, `preview returns 200 (got ${prevRes.status})`);
  check(typeof prevJson.totalSelected === "number", "preview uses totalSelected (not total)");
  check(typeof prevJson.eligibleCount === "number", "preview uses eligibleCount (not eligible)");
  check(typeof prevJson.skippedCount === "number", "preview uses skippedCount (not skipped)");
  check(prevJson.templateName === "hy fitness", "preview echoes template name");
  const samples = prevJson.samples as Array<{ renderedMessage: string }> | undefined;
  const rendered = samples?.[0]?.renderedMessage ?? "";
  console.log(`  rendered="${rendered}"`);
  check(rendered.includes("Ahmed"), "{{firstName}} renders lead-specific value");
  check(rendered.includes("Fitness"), "{{businessCategory}} renders lead category");
  check(rendered.includes(campaignNameA), "{{campaignName}} renders campaign name");

  // ---- 5. Job creation payload mapping ----
  console.log("\n[5] Job creation response mapping");
  const jobRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/message-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({ templateId: templateA, leadIds: [leadA.id], selection: "selected" }),
  });
  const jobJson = (await jobRes.json()) as {
    job?: { id: string; templateId: string; campaignId: string };
    summary?: { eligibleCount: number; totalSelected: number; skippedCount: number };
  };
  check(jobRes.status === 201, `job create returns 201 (got ${jobRes.status})`);
  check(typeof jobJson.job?.id === "string", "job.id present");
  check(jobJson.job?.templateId === templateA, "job bound to selected template");
  check(jobJson.job?.campaignId === campaignA, "job bound to current campaign");
  check(jobJson.summary?.eligibleCount === 1, `job summary reports 1 eligible (got ${jobJson.summary?.eligibleCount})`);

  // ---- 6. Cross-campaign template rejected ----
  console.log("\n[6] Cross-campaign template rejection");
  const crossTemplateRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/message-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({ templateId: templateB, leadIds: [leadA.id], selection: "selected" }),
  });
  check(crossTemplateRes.status === 404, `template from another campaign rejected (got ${crossTemplateRes.status})`);

  // ---- 7. Deleted template rejected ----
  console.log("\n[7] Deleted template rejection");
  const doomed = await createTemplate(userA.cookie, campaignA, "Doomed Template", "Hi {{username}}");
  const delRes = await fetch(`${BASE_URL}/api/templates/${doomed}`, {
    method: "DELETE",
    headers: { Cookie: userA.cookie },
  });
  check(delRes.status === 200, `template delete returns 200 (got ${delRes.status})`);
  const deletedUseRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/message-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({ templateId: doomed, leadIds: [leadA.id], selection: "selected" }),
  });
  check(deletedUseRes.status === 404, `deleted template rejected (got ${deletedUseRes.status})`);

  // ---- 8. Cross-campaign lead cannot be targeted ----
  console.log("\n[8] Cross-campaign lead isolation");
  const crossLeadRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/message-jobs/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userA.cookie },
    body: JSON.stringify({ templateId: templateA, leadIds: [leadB.id], selection: "selected" }),
  });
  const crossLeadJson = (await crossLeadRes.json()) as { totalSelected?: number };
  check(
    crossLeadRes.status === 200 && crossLeadJson.totalSelected === 0,
    `lead from another campaign not targetable (got status ${crossLeadRes.status}, totalSelected ${crossLeadJson.totalSelected})`,
  );

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error("Unexpected test failure:", error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
