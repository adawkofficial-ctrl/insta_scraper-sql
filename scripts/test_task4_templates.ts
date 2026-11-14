/* eslint-disable */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";
import {
  renderTemplate,
  renderTemplateDetailed,
  resolveFirstName,
  validateTemplateVariables,
  TEMPLATE_VARIABLE_DEFINITIONS,
} from "../src/lib/services/template/template-renderer";

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
    body: JSON.stringify({
      email: `task4_${label}_${stamp}@example.com`,
      password: "ProductionReady2026!",
      name: `Task4 ${label}`,
    }),
  });
  const cookieValue = extractCookie(res);
  if (!cookieValue) throw new Error("no session cookie");
  return `${COOKIE_NAME}=${cookieValue}`;
}

async function createCampaign(cookie: string, name: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/campaigns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name }),
  });
  const json = await res.json();
  return json.id as string;
}

function testRendererUnit() {
  console.log("\n[Unit] Renderer / variables / first name");

  // Exact render
  const t1 = renderTemplate(
    "Hi {{firstName}}, welcome to {{campaignName}}.",
    { username: "john", fullName: "John" },
    "Fitness Campaign",
  );
  check(t1 === "Hi John, welcome to Fitness Campaign.", `exact render (got "${t1}")`);

  // Repeated variables
  const t2 = renderTemplate(
    "Hi {{firstName}}! Your username is {{username}}. We noticed {{username}} has {{followersCount}} followers.",
    { username: "acct", fullName: "Acct Name", followersCount: 245 },
    "C",
  );
  check(
    t2 ===
      "Hi Acct! Your username is acct. We noticed acct has 245 followers.",
    `repeated variables render (got "${t2}")`,
  );

  // First name resolution
  check(resolveFirstName("John Smith", "jsmith") === "John", "firstName from full name");
  check(resolveFirstName("John", "jsmith") === "John", "single-token full name");
  check(resolveFirstName("", "john_doe") === "john_doe", "empty full name -> username");
  check(resolveFirstName(null, null) === "there", "null full name+username -> fallback");
  check(
    renderTemplate("Hi {{firstName}}", { username: "", fullName: null }) === "Hi there",
    "firstName fallback used in render",
  );

  // Missing data
  const missing = renderTemplateDetailed(
    "Bio: {{biography}} / category: {{businessCategory}}",
    { username: "x", biography: null, category: null },
    "C",
  );
  check(!missing.text.includes("{{"), "missing data leaves no placeholders");
  check(!missing.text.includes("undefined"), "missing data never renders 'undefined'");
  check(
    missing.missingVariables.includes("biography") &&
      missing.missingVariables.includes("businesscategory"),
    `missing variables reported (${missing.missingVariables.join(",")})`,
  );

  // Valid / invalid variables
  check(validateTemplateVariables("Hello {{username}} {{postsCount}}").valid, "valid variables accepted");
  const bad = validateTemplateVariables("Hello {{unknownField}}");
  check(!bad.valid && bad.unsupported.includes("unknownfield"), "unknown variable rejected");

  // Code-execution safety
  const dangerous = renderTemplate(
    "x {{constructor}} y {{__proto__}} z ${process.env.SECRET}",
    { username: "u" },
    "C",
  );
  check(
    dangerous === "x y z ${process.env.SECRET}",
    `no prototype/code leakage, no expressions (got "${dangerous}")`,
  );
  check(
    !validateTemplateVariables("{{constructor}}").valid,
    "{{constructor}} rejected by validation",
  );

  // Special characters treated as plain text
  const special = renderTemplate(
    `<b>Hi {{firstName}}</b> & "quotes" 😀 <script>alert(1)</script>`,
    { username: "u", fullName: "John" },
    "C",
  );
  check(
    special.includes("<script>alert(1)</script>") && special.includes("😀") && special.includes('"quotes"'),
    "special characters preserved as plain text",
  );

  // Definition list sanity
  const names = TEMPLATE_VARIABLE_DEFINITIONS.map((d) => d.name);
  for (const required of [
    "username",
    "fullName",
    "firstName",
    "biography",
    "followersCount",
    "followingCount",
    "postsCount",
    "businessCategory",
    "externalUrl",
    "profileUrl",
  ]) {
    check(names.includes(required), `variable definition includes ${required}`);
  }
}

async function main() {
  console.log("=================================================================");
  console.log("   TASK 4: TEMPLATES + VARIABLES + PREVIEW TEST SUITE            ");
  console.log(`   Base URL: ${BASE_URL}`);
  console.log("=================================================================");

  testRendererUnit();

  const prisma = createPrismaClient();

  try {
    const cookieA = await register("A");
    const cookieB = await register("B");
    const campaignA = await createCampaign(cookieA, `Task4 A ${Date.now()}`);
    const campaignB = await createCampaign(cookieB, `Task4 B ${Date.now()}`);

    console.log("\n[HTTP] Template CRUD");
    const createRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: "Fitness Outreach",
        body: "Hi {{firstName}}, I saw your {{postsCount}} posts in {{businessCategory}}. — {{senderName}}",
      }),
    });
    const created = await createRes.json();
    check(createRes.status === 201, `create template -> 201 (got ${createRes.status})`);
    const templateId = created.id as string;

    const getRes = await fetch(`${BASE_URL}/api/templates/${templateId}`, {
      headers: { Cookie: cookieA },
    });
    check(getRes.status === 200, `get template -> 200 (got ${getRes.status})`);

    const patchRes = await fetch(`${BASE_URL}/api/templates/${templateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ body: "Updated: hi {{firstName}} ({{username}})" }),
    });
    const patched = await patchRes.json();
    check(patchRes.status === 200 && patched.id === templateId, "update keeps id");
    check(
      patched.updatedAt !== created.updatedAt || patched.body.startsWith("Updated"),
      "update applied",
    );

    console.log("\n[HTTP] Validation");
    const emptyRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ name: "Empty", body: "   " }),
    });
    check([400, 422].includes(emptyRes.status), `empty message -> 400/422 (got ${emptyRes.status})`);

    const longRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ name: "Long", body: "x".repeat(1001) }),
    });
    check([400, 422].includes(longRes.status), `message > 1000 chars -> 400/422 (got ${longRes.status})`);

    const invalidVarRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ name: "Bad", body: "Hi {{unknownField}}" }),
    });
    const invalidVarBody = await invalidVarRes.json();
    check(
      [400, 422].includes(invalidVarRes.status) && invalidVarBody?.error?.code === "UNSUPPORTED_VARIABLES",
      `unsupported variable rejected (got ${invalidVarRes.status} ${invalidVarBody?.error?.code})`,
    );

    console.log("\n[HTTP] Tenant isolation");
    const crossGet = await fetch(`${BASE_URL}/api/templates/${templateId}`, { headers: { Cookie: cookieB } });
    check(crossGet.status === 404, `user B get user A template -> 404 (got ${crossGet.status})`);

    const crossPatch = await fetch(`${BASE_URL}/api/templates/${templateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({ body: "hijack {{username}}" }),
    });
    check(crossPatch.status === 404, `user B patch user A template -> 404 (got ${crossPatch.status})`);

    const crossDelete = await fetch(`${BASE_URL}/api/templates/${templateId}`, {
      method: "DELETE",
      headers: { Cookie: cookieB },
    });
    check(crossDelete.status === 404, `user B delete user A template -> 404 (got ${crossDelete.status})`);

    const anonGet = await fetch(`${BASE_URL}/api/templates/${templateId}`);
    check(anonGet.status === 401, `anonymous get -> 401 (got ${anonGet.status})`);

    console.log("\n[HTTP] Preview with real leads");

    // Dedicated preview template (the CRUD template above was intentionally updated).
    const previewTemplateRes = await fetch(`${BASE_URL}/api/campaigns/${campaignA}/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: "Preview Template",
        body: "Hi {{firstName}}, I saw your {{postsCount}} posts in {{businessCategory}}. — {{senderName}}",
      }),
    });
    const previewTemplateCreated = await previewTemplateRes.json();
    const previewTemplateId = previewTemplateCreated.id as string;
    check(previewTemplateRes.status === 201, "created dedicated preview template");

    const leadJohn = await prisma.lead.create({
      data: { campaignId: campaignA, username: "johnsmith", profileUrl: "https://www.instagram.com/johnsmith", fullName: "John Smith", category: "Fitness", followers: 245, following: 12, postsCount: 34, biography: "Gym owner", source: "apify", scrapedAt: new Date() },
    });
    const leadSarah = await prisma.lead.create({
      data: { campaignId: campaignA, username: "sarahkhan", profileUrl: "https://www.instagram.com/sarahkhan", fullName: "Sarah Khan", followers: 100, following: 50, postsCount: 5, source: "apify", scrapedAt: new Date() },
    });
    const leadHub = await prisma.lead.create({
      data: { campaignId: campaignA, username: "fitnesshub", profileUrl: "https://www.instagram.com/fitnesshub", fullName: "Fitness Hub", category: "Gym", followers: 5000, following: 80, postsCount: 210, source: "apify", scrapedAt: new Date() },
    });

    const previewRes = await fetch(`${BASE_URL}/api/templates/${previewTemplateId}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ campaignId: campaignA, leadIds: [leadJohn.id, leadSarah.id, leadHub.id] }),
    });
    const preview = await previewRes.json();
    check(previewRes.status === 200, `multi-lead preview -> 200 (got ${previewRes.status})`);
    check(preview?.sent === false, "preview flagged sent:false");
    check(preview?.previews?.length === 3, `preview returns one entry per lead (got ${preview?.previews?.length})`);
    const johnPreview = preview?.previews?.find((p: any) => p.lead.username === "johnsmith");
    check(
      typeof johnPreview?.text === "string" && johnPreview.text.includes("John") && johnPreview.text.includes("34") && johnPreview.text.includes("Fitness"),
      `rendered with real lead data (got "${johnPreview?.text}")`,
    );
    const sarahPreview = preview?.previews?.find((p: any) => p.lead.username === "sarahkhan");
    check(
      sarahPreview?.missingVariables?.includes("businesscategory") === true,
      "missing lead data reported in preview",
    );

    const tooMany = await fetch(`${BASE_URL}/api/templates/${previewTemplateId}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ campaignId: campaignA, leadIds: Array.from({ length: 11 }, (_, i) => `fake_${i}`) }),
    });
    check([400, 422].includes(tooMany.status), `preview > 10 leads rejected (got ${tooMany.status})`);

    // Lead from another campaign cannot be previewed against this template/campaign.
    const otherLead = await prisma.lead.create({
      data: { campaignId: campaignB, username: "otherlead", profileUrl: "https://www.instagram.com/otherlead", fullName: "Other Lead", source: "apify", scrapedAt: new Date() },
    });
    const foreignLead = await fetch(`${BASE_URL}/api/templates/${previewTemplateId}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ campaignId: campaignA, leadIds: [otherLead.id] }),
    });
    check([400, 422].includes(foreignLead.status), `lead from another campaign rejected (got ${foreignLead.status})`);

    const crossTenantPreview = await fetch(`${BASE_URL}/api/templates/${previewTemplateId}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({ campaignId: campaignB, leadIds: [otherLead.id] }),
    });
    check(crossTenantPreview.status === 404, `user B preview user A template -> 404 (got ${crossTenantPreview.status})`);

    console.log("\n[Regression] Existing messaging flow");
    const legacyPreview = await fetch(`${BASE_URL}/api/messages/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ leadId: leadJohn.id, templateId: previewTemplateId }),
    });
    const legacyBody = await legacyPreview.json();
    check(legacyPreview.status === 200 && typeof legacyBody.text === "string", `legacy single preview intact (got ${legacyPreview.status})`);
    check(!String(legacyBody.text).includes("{{"), "legacy preview resolves variables");

    const statusRes = await fetch(`${BASE_URL}/api/messaging/status`, { headers: { Cookie: cookieA } });
    check(statusRes.status === 200, `messaging status endpoint intact (got ${statusRes.status})`);

    console.log("\n[HTTP] Delete");
    const deleteRes = await fetch(`${BASE_URL}/api/templates/${templateId}`, {
      method: "DELETE",
      headers: { Cookie: cookieA },
    });
    check(deleteRes.status === 200, `delete -> 200 (got ${deleteRes.status})`);
    const goneRes = await fetch(`${BASE_URL}/api/templates/${templateId}`, { headers: { Cookie: cookieA } });
    check(goneRes.status === 404, `deleted template -> 404 (got ${goneRes.status})`);
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
