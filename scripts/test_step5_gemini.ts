import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import { LeadStatus, UsageProvider } from "../src/generated/prisma/enums";
import {
  getCompanyProfileCompleteness,
  createCompanyProfile,
  updateCompanyProfile,
} from "../src/lib/services/company-profile/company-profile-service";
import { analyzeLead } from "../src/lib/services/ai/lead-analysis-service";
import { generateDraft } from "../src/lib/services/ai/draft-service";
import { createAiAnalysisJob } from "../src/lib/services/ai/ai-analysis-job-service";
import { generateStructured } from "../src/lib/services/ai/gemini/gemini-client";
import { CompanyProfileIncompleteError } from "../src/lib/errors";

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

const prisma = getPrismaClient();
const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

const ANALYSIS_PAYLOAD = {
  leadQuality: "high",
  leadScore: 85,
  businessType: "Gym",
  niche: "fitness",
  isTargetMatch: true,
  potentialNeed: "Wants more members",
  painPoints: ["low online presence"],
  personalizationPoints: ["Certified fitness trainer"],
  recommendedApproach: "Reference their training expertise",
  confidence: "high",
  reasoning: "Clear fitness business",
  disqualifyReason: null,
  riskFlags: [],
};
const DRAFT_PAYLOAD = {
  message:
    "Hi there, noticed you are a certified fitness trainer. We help fitness studios fill their schedule with a simple booking flow. Would a two minute look be useful?",
  personalizationPointsUsed: ["Certified fitness trainer"],
  openingType: "observation",
  cta: "question",
  wordCount: 27,
};

let geminiCalls = 0;
let nextPayload: unknown = ANALYSIS_PAYLOAD;
let nextRawBody: string | null = null;
const originalFetch = globalThis.fetch;

function installFetchMock() {
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const target = String(url);
    if (target.includes("generativelanguage.googleapis.com")) {
      geminiCalls += 1;
      const text = nextRawBody ?? JSON.stringify(nextPayload);
      nextRawBody = null;
      return new Response(
        JSON.stringify({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 },
        }),
        { status: 200 },
      );
    }
    return originalFetch(url as RequestInfo);
  }) as typeof fetch;
}

function requiredProfile(overrides: Record<string, unknown> = {}) {
  return {
    name: "Fixture Co",
    description: "We provide a fixture service.",
    services: [{ name: "Fixture service", value: "handles fixtures" }],
    targetIndustries: ["fitness"],
    targetCountries: ["US"],
    idealCustomerProfile: "Independent fitness studios",
    brandTone: "friendly, direct",
    messageLanguage: "en",
    preferredLength: { minWords: 10, maxWords: 60 },
    ctaStyle: "soft question",
    forbiddenClaims: ["guaranteed"],
    pricingPolicy: "do not share price in first DM",
    exampleMessages: [],
    objectionNotes: null,
    ...overrides,
  };
}

async function main() {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "test-key";
  installFetchMock();

  const user = await prisma.user.create({
    data: { email: `s5_${stamp}@example.com`, passwordHash: "x", name: "S5" },
  });
  const profile = await createCompanyProfile(user.id, { name: "Incomplete Co" });
  const campaign = await prisma.campaign.create({
    data: { userId: user.id, name: `S5 ${stamp}`, leadLimit: 50, companyProfileId: profile.id },
  });
  const lead = await prisma.lead.create({
    data: {
      campaignId: campaign.id,
      userId: user.id,
      username: `s5_lead_${stamp}`,
      fullName: "Fitness Fixture",
      biography: "Certified fitness trainer in New York City",
      category: "Gym/Physical Fitness Center",
      businessCategoryName: "Gym/Physical Fitness Center",
      profileUrl: `https://www.instagram.com/s5_lead_${stamp}/`,
      status: LeadStatus.NEW,
      source: "test",
    },
  });

  console.log("=================================================================");
  console.log("   STEP 5: COMPANY PROFILE COMPLETENESS + AI GATING (MOCKED)      ");
  console.log("=================================================================\n");

  // ---- 1. Completeness contract (pure) ----
  console.log("[1] Completeness contract");
  const empty = getCompanyProfileCompleteness(null);
  check(empty.complete === false, "null profile is incomplete");
  check(
    ["name", "description", "services", "targetIndustries", "brandTone", "messageLanguage", "ctaStyle", "pricingPolicy", "preferredLength"].every((f) =>
      empty.missingFields.includes(f),
    ),
    "null profile reports every required field",
  );

  const fullRecord = {
    id: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...requiredProfile(),
    services: requiredProfile().services,
    exampleMessages: [],
    targetCountries: ["US"],
  } as unknown as Parameters<typeof getCompanyProfileCompleteness>[0];
  check(getCompanyProfileCompleteness(fullRecord).complete === true, "complete profile passes");

  // Each required field individually missing.
  const requiredCases: Array<[string, Record<string, unknown>]> = [
    ["name", { name: "" }],
    ["description", { description: "" }],
    ["services", { services: [] }],
    ["targetIndustries", { targetIndustries: [] }],
    ["brandTone", { brandTone: null }],
    ["messageLanguage", { messageLanguage: "" }],
    ["ctaStyle", { ctaStyle: null }],
    ["pricingPolicy", { pricingPolicy: null }],
    ["preferredLength", { preferredLength: { minWords: 60, maxWords: 10 } }],
  ];
  for (const [field, override] of requiredCases) {
    const record = { ...fullRecord, ...override } as Parameters<typeof getCompanyProfileCompleteness>[0];
    const result = getCompanyProfileCompleteness(record);
    check(
      result.complete === false && result.missingFields.includes(field),
      `missing "${field}" is reported`,
      JSON.stringify(result.missingFields),
    );
  }

  // Warnings.
  const warningRecord = { ...fullRecord, forbiddenClaims: [], idealCustomerProfile: null } as Parameters<typeof getCompanyProfileCompleteness>[0];
  const warningResult = getCompanyProfileCompleteness(warningRecord);
  check(
    warningResult.complete && warningResult.warnings.includes("forbiddenClaims_empty"),
    "empty forbiddenClaims is a warning, not a blocker",
  );
  check(
    warningResult.warnings.includes("idealCustomerProfile_empty"),
    "empty idealCustomerProfile is a warning",
  );

  // ---- 2. Incomplete profile blocks AI (no Gemini call, no UsageLog) ----
  console.log("\n[2] Incomplete profile gating");
  geminiCalls = 0;
  const usageBefore = await prisma.usageLog.count({ where: { userId: user.id } });

  let analyzeBlocked = false;
  try {
    await analyzeLead({ userId: user.id, leadId: lead.id });
  } catch (error) {
    analyzeBlocked = error instanceof CompanyProfileIncompleteError;
    if (error instanceof CompanyProfileIncompleteError) {
      check(error.status === 422, "analyze blocked with 422");
      check(error.missingFields.length > 0, "analyze error lists missingFields");
    }
  }
  check(analyzeBlocked, "analyzeLead refuses an incomplete profile");

  let draftBlocked = false;
  try {
    await generateDraft({ userId: user.id, leadId: lead.id });
  } catch (error) {
    draftBlocked = error instanceof CompanyProfileIncompleteError;
  }
  check(draftBlocked, "generateDraft refuses an incomplete profile");

  let jobBlocked = false;
  try {
    await createAiAnalysisJob({ userId: user.id, campaignId: campaign.id });
  } catch (error) {
    jobBlocked = error instanceof CompanyProfileIncompleteError;
  }
  check(jobBlocked, "job creation refuses an incomplete profile");

  await new Promise((r) => setTimeout(r, 150));
  check(geminiCalls === 0, "no Gemini call happened while incomplete");
  const usageAfter = await prisma.usageLog.count({ where: { userId: user.id } });
  check(usageAfter === usageBefore, "no UsageLog row written while incomplete");

  // ---- 3. Complete profile -> analysis + draft + usage ----
  console.log("\n[3] Complete profile passes");
  await updateCompanyProfile(user.id, profile.id, requiredProfile());
  const completeness = getCompanyProfileCompleteness(
    (await prisma.companyProfile.findUnique({ where: { id: profile.id } })) as unknown as Parameters<typeof getCompanyProfileCompleteness>[0],
  );
  check(completeness.complete, "saved profile is complete");

  nextPayload = ANALYSIS_PAYLOAD;
  const analysis = await analyzeLead({ userId: user.id, leadId: lead.id });
  check(analysis.status === "DONE", "analyzeLead succeeds with a complete profile", JSON.stringify(analysis));
  const savedLead = await prisma.lead.findUnique({ where: { id: lead.id } });
  check(savedLead?.aiStatus === "DONE" && savedLead?.leadScore === 85, "analysis persisted to lead");

  const analysisUsage = await prisma.usageLog.findFirst({
    where: { userId: user.id, operation: "lead_analysis" },
  });
  check(
    analysisUsage?.provider === UsageProvider.GEMINI &&
      analysisUsage.inputTokens === 12 &&
      analysisUsage.outputTokens === 34,
    "UsageLog row written for analysis with tokens",
  );

  nextPayload = DRAFT_PAYLOAD;
  const draft = await generateDraft({ userId: user.id, leadId: lead.id });
  check(draft.body.includes("fitness trainer"), "draft generated and stored");
  const storedDraft = await prisma.messageDraft.findUnique({ where: { id: draft.draftId } });
  check(storedDraft?.status === "DRAFT" && storedDraft.promptVersion === "draft-v1", "draft row stored as DRAFT with prompt version");
  check(
    (await prisma.messageDraft.count({ where: { leadId: lead.id } })) === 1,
    "only one draft exists for the lead",
  );
  check(
    (await prisma.usageLog.count({ where: { userId: user.id, operation: "draft_generation" } })) >= 1,
    "UsageLog row written for draft generation",
  );

  // ---- 4. Gemini client defensive parsing ----
  console.log("\n[4] Gemini client parsing");
  nextRawBody = "```json\n" + JSON.stringify(DRAFT_PAYLOAD).replace(
    DRAFT_PAYLOAD.message,
    "Hi there, noticed you are a certified fitness trainer. We help studios fill their schedule. Would a look be useful?",
  ) + "\n```";
  const fenced = await generateStructured({
    systemInstruction: "sys",
    userText: "user",
    responseSchema: { type: "object" },
    validate: (data) => data as { message: string },
    operation: "draft_generation",
    promptVersion: "draft-v1",
    userId: user.id,
  });
  check(typeof fenced.data.message === "string", "code-fenced JSON is parsed");

  nextRawBody = "not json at all";
  let badOutput = false;
  try {
    await generateStructured({
      systemInstruction: "sys",
      userText: "user",
      responseSchema: { type: "object" },
      validate: (data) => data,
      operation: "draft_generation",
      promptVersion: "draft-v1",
      userId: user.id,
    });
  } catch (error) {
    badOutput = (error as { code?: string }).code === "AI_BAD_OUTPUT";
  }
  check(badOutput, "malformed JSON raises AI_BAD_OUTPUT");

  // ---- Cleanup ----
  globalThis.fetch = originalFetch;
  await prisma.campaign.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
  await prisma.companyProfile.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  await prisma.$disconnect();

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  globalThis.fetch = originalFetch;
  console.error(error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
