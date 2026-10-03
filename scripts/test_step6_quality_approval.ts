import "./preload_server_only.cjs";
/**
 * STEP 6 — quality gate, approval workflow, and draft-based sending.
 *
 * Gemini and the Instagram sender are mocked; no live calls. Pure rule tests run
 * without any DB writes, then a DB-backed section exercises the pipeline,
 * approval, stats, auto mode and the draft send path.
 */
import "dotenv/config";
import { Prisma } from "../src/generated/prisma/client";
import { getPrismaClient } from "../src/lib/db/prisma";
import { LeadStatus } from "../src/generated/prisma/enums";
import { upsertCompanyProfile } from "../src/lib/services/company-profile/company-profile-service";
import { runQualityChecks } from "../src/lib/services/quality/runner";
import { QUALITY_VERSION, FIXABLE_BLOCKER_IDS, MAX_MESSAGE_LENGTH } from "../src/lib/services/quality/rules";
import { draftBodyHash } from "../src/lib/services/quality/hash";
import { editDistance, maxShingleSimilarity, normalizeForExactDuplicate } from "../src/lib/services/quality/similarity";
import type { QualityContext } from "../src/lib/services/quality/types";
import { generateAndCheckDraft } from "../src/lib/services/drafts/draft-pipeline-service";
import {
  approveDraft,
  bulkApproveDrafts,
  editDraft,
  evaluateAutoApproval,
  getAutoApprovalEligibility,
  getReviewStats,
  recheckDraft,
  rejectDraft,
  revokeApproval,
} from "../src/lib/services/drafts/approval-service";
import { createDraftSendJob } from "../src/lib/services/drafts/draft-send-service";
import { evaluateDraftDispatch } from "../src/lib/services/messaging/draft-dispatch-guard";
import { dispatchBulkJobQueue } from "../src/lib/services/messaging/bulk-messaging-service";
import { sendSingleMessage, setMessagingProvider } from "../src/lib/services/messaging/messaging-service";
import type { MessagingProvider } from "../src/lib/services/messaging/messaging-provider";
import { QualityBlockedError } from "../src/lib/errors";

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
const CLEAN_DRAFT = {
  message:
    "Hi there, noticed you are a certified fitness trainer in Rawalpindi. We help fitness studios fill their schedule with a simple booking flow. Would a two minute look be useful?",
  personalizationPointsUsed: ["Certified fitness trainer"],
  openingType: "observation",
  cta: "question",
  wordCount: 31,
};

let geminiCalls = 0;
let nextPayload: unknown = CLEAN_DRAFT;
const originalFetch = globalThis.fetch;
function installFetchMock() {
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const target = String(url);
    if (target.includes("generativelanguage.googleapis.com")) {
      geminiCalls += 1;
      return new Response(
        JSON.stringify({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(nextPayload) }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
        }),
        { status: 200 },
      );
    }
    return originalFetch(url as RequestInfo);
  }) as typeof fetch;
}

let sendCalls = 0;
class MockMessagingProvider implements MessagingProvider {
  readonly name = "mock";
  async connect() {}
  async disconnect() {}
  async getStatus() {
    return { provider: "mock", authenticated: true, status: "READY" as const };
  }
  async sendMessage(request: { profileUrl: string; message: string }) {
    sendCalls += 1;
    return {
      success: true,
      provider: "mock",
      messageText: request.message,
      messageId: `mock_${sendCalls}`,
    } as unknown as Awaited<ReturnType<MessagingProvider["sendMessage"]>>;
  }
}

// ---------- pure context builder ----------
function makeCtx(overrides: {
  draft?: Partial<QualityContext["draft"]>;
  lead?: Partial<QualityContext["lead"]>;
  campaign?: Partial<QualityContext["campaign"]>;
  company?: Partial<QualityContext["company"]>;
  suppression?: Partial<QualityContext["suppression"]>;
  history?: Partial<QualityContext["history"]>;
  previouslyContacted?: boolean;
} = {}): QualityContext {
  const base: QualityContext = {
    draft: {
      id: "d1",
      body:
        "Hi Ahmed, I noticed your fitness studio in Rawalpindi. We help fitness businesses with scheduling. Would a short chat be useful?",
      generatedBody:
        "Hi Ahmed, I noticed your fitness studio in Rawalpindi. We help fitness businesses with scheduling. Would a short chat be useful?",
      promptVersion: "draft-v1",
      personalizationPointsUsed: [],
    },
    lead: {
      id: "l1",
      campaignId: "c1",
      username: "ahmed_fit",
      fullName: "Ahmed",
      biography: "Fitness trainer in Rawalpindi",
      businessCategoryName: "Gym/Physical Fitness Center",
      category: "Gym",
      location: "Rawalpindi",
      aiStatus: "DONE",
      status: "READY_FOR_OUTREACH",
      duplicateOfLeadId: null,
      leadScore: 80,
      targetNiche: "fitness",
      personalizationPoints: ["Fitness trainer in Rawalpindi"],
      hasPostContext: false,
    },
    campaign: { id: "c1", aiQualificationEnabled: false, messageLanguage: "en" },
    company: {
      name: "Fixture Co",
      description: "We provide booking software for fitness studios.",
      services: ["booking software"],
      forbiddenClaims: ["guaranteed"],
      preferredLength: { minWords: 5, maxWords: 80 },
      pricingPolicy: null,
      brandTone: "friendly",
      messageLanguage: "en",
      rawText: "Fixture Co booking software for fitness studios",
    },
    suppression: { suppressed: false, matchedIdentifierTypes: [] },
    previouslyContacted: false,
    history: { exactDuplicateBodies: [], recentOutboundTexts: [], recentCampaignOpeners: [] },
  };
  return {
    ...base,
    draft: { ...base.draft, ...overrides.draft },
    lead: { ...base.lead, ...overrides.lead },
    campaign: { ...base.campaign, ...overrides.campaign },
    company: { ...base.company, ...overrides.company },
    suppression: { ...base.suppression, ...overrides.suppression },
    history: { ...base.history, ...overrides.history },
    previouslyContacted: overrides.previouslyContacted ?? base.previouslyContacted,
  };
}
function checkFor(ctx: QualityContext, id: string) {
  return runQualityChecks(ctx).checks.find((c) => c.id === id)!;
}

async function main() {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "test-key";
  installFetchMock();
  setMessagingProvider(new MockMessagingProvider());

  console.log("=================================================================");
  console.log("   STEP 6: QUALITY GATE + APPROVAL + DRAFT SEND (MOCKED)         ");
  console.log("=================================================================\n");

  // ---------------- 1. Pure quality rules ----------------
  console.log("[1] Quality rules");
  check(runQualityChecks(makeCtx()).passed, "clean base draft passes all rules");
  check(QUALITY_VERSION === "quality-v1", "quality version is quality-v1");
  check(MAX_MESSAGE_LENGTH === 1000, "MAX_MESSAGE_LENGTH is 1000");

  check(!checkFor(makeCtx({ draft: { body: "" } }), "LENGTH").passed, "empty body blocks");
  check(
    !checkFor(makeCtx({ draft: { body: "x".repeat(1001) } }), "LENGTH").passed,
    "over-long body blocks",
  );
  check(
    !checkFor(makeCtx({ draft: { body: "Hi {{firstName}} there" } }), "UNRESOLVED_PLACEHOLDERS").passed,
    "placeholder blocks",
  );
  check(
    !checkFor(makeCtx({ draft: { body: "Quick question about your team" } }), "GENERIC_WORDING").passed,
    "one generic phrase is a warning",
  );
  const r1 = checkFor(makeCtx({ draft: { body: "Quick question — I hope this message finds you well." } }), "GENERIC_WORDING");
  check(!r1.passed && r1.severity === "WARNING", "two generic phrases stay a warning");
  const r2 = checkFor(
    makeCtx({ draft: { body: "Quick question. I hope this message finds you well. Loved your reel." } }),
    "GENERIC_WORDING",
  );
  check(!r2.passed, "generic wording fails when present");
  const soloQuick = checkFor(
    makeCtx({ draft: { body: "Hi Ahmed, a quick note about your fitness studio in Rawalpindi scheduling today." } }),
    "GENERIC_WORDING",
  );
  check(soloQuick.passed, "the word 'quick' alone is not 'quick question'");

  check(!checkFor(makeCtx({ suppression: { suppressed: true } }), "DNC_SUPPRESSED").passed, "suppression blocks");
  check(!checkFor(makeCtx({ lead: { status: "DO_NOT_CONTACT" } }), "DNC_SUPPRESSED").passed, "DNC status blocks");
  check(!checkFor(makeCtx({ lead: { duplicateOfLeadId: "other" } }), "DUPLICATE_LEAD").passed, "duplicate lead blocks");
  check(!checkFor(makeCtx({ previouslyContacted: true }), "ALREADY_CONTACTED").passed, "previously contacted blocks");
  check(
    !checkFor(makeCtx({ campaign: { aiQualificationEnabled: true }, lead: { status: "NEW" } }), "LEAD_ELIGIBILITY").passed,
    "AI campaign requires QUALIFIED+",
  );

  check(
    !checkFor(makeCtx({ history: { exactDuplicateBodies: [normalizeForExactDuplicate("Hello, world!")] }, draft: { body: "hello world" } }), "EXACT_DUPLICATE_MESSAGE").passed,
    "exact duplicate message blocks",
  );
  const near = "We help fitness studios in Rawalpindi fill their schedule with a simple booking flow today";
  const nearResult = checkFor(
    makeCtx({ draft: { body: `${near}.` }, history: { recentOutboundTexts: [near] } }),
    "NEAR_DUPLICATE_MESSAGE",
  );
  check(!nearResult.passed && nearResult.severity === "BLOCKER", "identical text is a near-duplicate blocker");
  const unrelated = checkFor(
    makeCtx({ draft: { body: "Completely different content about cars and engines in Tokyo" }, history: { recentOutboundTexts: [near] } }),
    "NEAR_DUPLICATE_MESSAGE",
  );
  check(unrelated.passed, "unrelated text is not a near duplicate");

  check(
    !checkFor(makeCtx({ draft: { body: "Hi Ahmed, I watched your video about fitness in Rawalpindi." } }), "UNVERIFIABLE_CLAIMS").passed,
    "unverifiable claim blocks",
  );
  check(
    checkFor(
      makeCtx({ draft: { body: "Hi Ahmed, I watched your video about fitness in Rawalpindi." }, lead: { hasPostContext: true } }),
      "UNVERIFIABLE_CLAIMS",
    ).passed,
    "unverifiable claim passes when post context exists",
  );

  check(
    !checkFor(makeCtx({ draft: { body: "This is a guaranteed method for fitness studios in Rawalpindi." } }), "FORBIDDEN_CLAIMS").passed,
    "forbidden claim blocks",
  );
  check(
    !checkFor(makeCtx({ draft: { body: "We served 500 clients in Rawalpindi fitness studios." } }), "COMPANY_FACTS").passed,
    "unverified number blocks",
  );
  check(
    checkFor(makeCtx({ company: { rawText: "Fixture Co served 500 clients booking software" }, draft: { body: "We served 500 clients in Rawalpindi fitness studios." } }), "COMPANY_FACTS").passed,
    "number present in the company profile is allowed",
  );
  check(
    checkFor(makeCtx({ draft: { body: "Hi @ahmed_fit, about your fitness studio in Rawalpindi." } }), "COMPANY_FACTS").passed,
    "the lead's own @handle is allowed",
  );
  check(
    !checkFor(makeCtx({ draft: { body: "Learn more at https://example.com for fitness studios." } }), "COMPANY_FACTS").passed,
    "unlisted URL blocks",
  );
  check(
    !checkFor(makeCtx({ draft: { body: "Hi Ahmed, your diabetes and fitness routine in Rawalpindi." } }), "SENSITIVE_INFERENCE").passed,
    "sensitive inference blocks",
  );
  check(
    !checkFor(makeCtx({ draft: { body: "Hi Ahmed, this is shit for your fitness studio." } }), "PROFANITY_OR_HARASSMENT").passed,
    "profanity blocks",
  );
  check(
    checkFor(makeCtx({ draft: { body: "Hi Ahmed, about your fitness studio in Rawalpindi — nice work." } }), "MISSING_PERSONALIZATION").passed,
    "body grounded in lead data passes personalization",
  );
  check(
    !checkFor(makeCtx({ draft: { body: "Hello there, we sell scheduling software to businesses." } }), "MISSING_PERSONALIZATION").passed,
    "ungrounded body blocks personalization",
  );

  const scoredClean = runQualityChecks(makeCtx());
  check(scoredClean.passed && scoredClean.score === 100, "clean draft scores 100 and passes");
  const scoredBlocked = runQualityChecks(makeCtx({ draft: { body: "" } }));
  check(!scoredBlocked.passed && scoredBlocked.score === 0, "a blocker forces score 0 and passed=false");
  const warningCtx = makeCtx({ draft: { body: "Hi Ahmed, quick question about your fitness studio in Rawalpindi scheduling." } });
  const warningRun = runQualityChecks(warningCtx);
  check(warningRun.passed && warningRun.score < 100, "warnings reduce score without failing the gate");
  check(FIXABLE_BLOCKER_IDS.has("GENERIC_WORDING") && !FIXABLE_BLOCKER_IDS.has("DNC_SUPPRESSED"), "fixable vs non-fixable blocker sets");

  // ---------------- 2. Similarity ----------------
  console.log("\n[2] Similarity");
  check(editDistance("hello world", "hello world") === 0, "editDistance identical = 0");
  check(editDistance("hello world", "hello there") > 0, "editDistance edits > 0");
  check(maxShingleSimilarity(near, [near]) >= 0.85, "identical text high similarity");
  const many = Array.from({ length: 300 }, (_, i) => `Message number ${i} about fitness studios in city ${i}`);
  const t0 = Date.now();
  maxShingleSimilarity("A totally unrelated sentence about boats", many);
  check(Date.now() - t0 < 2000, "300-message similarity comparison stays fast");

  // ---------------- 3. DB pipeline + approval ----------------
  console.log("\n[3] Pipeline + approval");
  const user = await prisma.user.create({
    data: { email: `s6_${stamp}@example.com`, passwordHash: "x", name: "S6" },
  });
  const campaign = await prisma.campaign.create({
    data: { userId: user.id, name: `S6 ${stamp}`, leadLimit: 50, qualityMaxRegenerations: 2 } as any,
  });
  const lead = await prisma.lead.create({
    data: {
      campaignId: campaign.id,
      userId: user.id,
      username: `s6_lead_${stamp}`,
      fullName: "Fitness Fixture",
      biography: "Certified fitness trainer in Rawalpindi",
      category: "Gym",
      businessCategoryName: "Gym/Physical Fitness Center",
      location: "Rawalpindi",
      profileUrl: `https://www.instagram.com/s6_lead_${stamp}/`,
      status: LeadStatus.QUALIFIED,
      aiStatus: "DONE",
      aiAnalysis: ANALYSIS_PAYLOAD,
      leadScore: 85,
      source: "test",
    },
  });
  const sender = await prisma.instagramSenderAccount.create({
    data: {
      userId: user.id,
      username: `s6_sender_${stamp}`,
      sessionPath: `./tmp/s6_${stamp}`,
      status: "CONNECTED",
    },
  });
  await upsertCompanyProfile(user.id, {
    name: "Fixture Co",
    description: "We provide booking software for fitness studios.",
    services: [{ name: "booking software" }],
    targetIndustries: ["fitness"],
    targetCountries: ["PK"],
    idealCustomerProfile: "Independent fitness studios",
    brandTone: "friendly, direct",
    messageLanguage: "en",
    preferredLength: { minWords: 5, maxWords: 80 },
    ctaStyle: "soft question",
    forbiddenClaims: ["guaranteed"],
    pricingPolicy: "do not share price in first DM",
    exampleMessages: [],
    objectionNotes: null,
  });

  nextPayload = CLEAN_DRAFT;
  const generated = await generateAndCheckDraft({ userId: user.id, leadId: lead.id });
  check(generated.status === "PENDING_REVIEW" && generated.passed, "pipeline produces a PENDING_REVIEW draft", JSON.stringify(generated.blockers));
  const stored = await prisma.messageDraft.findUnique({ where: { id: generated.draftId } });
  check(stored?.qualityPassed === true && stored?.qualityScore === 100, "gate result persisted");
  check(stored?.bodyHash === draftBodyHash(stored?.editedBody ?? stored?.body ?? ""), "bodyHash stored for final body");

  const approved = await approveDraft({ userId: user.id, draftId: generated.draftId });
  check(approved.status === "APPROVED" && approved.leadTransitioned, "approval stores hash and moves lead to READY_FOR_OUTREACH");
  const leadAfterApprove = await prisma.lead.findUnique({ where: { id: lead.id } });
  check(leadAfterApprove?.status === LeadStatus.READY_FOR_OUTREACH, "lead transitioned by approval");

  const idempotentApprove = await approveDraft({ userId: user.id, draftId: generated.draftId });
  check(idempotentApprove.status === "APPROVED" && idempotentApprove.overriddenWarnings.length === 0, "double approve is idempotent");

  const edited = await editDraft({ userId: user.id, draftId: generated.draftId, newBody: "Hi there, noticed your fitness studio in Rawalpindi — quick scheduling idea?" });
  check(edited.passed && edited.editDistance > 0, "edit re-checks and records editDistance");
  const afterEdit = await prisma.messageDraft.findUnique({ where: { id: generated.draftId } });
  check(afterEdit?.approvedBodyHash === null && afterEdit?.approvedAt === null, "edit clears approval");
  const leadAfterEdit = await prisma.lead.findUnique({ where: { id: lead.id } });
  check(leadAfterEdit?.status === LeadStatus.QUALIFIED, "edit moves lead back to QUALIFIED");

  const dispatched = await evaluateDraftDispatch(generated.draftId);
  check(dispatched.action === "SKIP" && dispatched.code === "DRAFT_CHANGED", "edited draft is not dispatchable");

  await approveDraft({ userId: user.id, draftId: generated.draftId });
  const dispatched2 = await evaluateDraftDispatch(generated.draftId);
  check(dispatched2.action === "SEND", "re-approved draft is dispatchable");

  const revoked = await revokeApproval({ userId: user.id, draftId: generated.draftId });
  check(revoked.status === "PENDING_REVIEW", "revoke returns draft to PENDING_REVIEW");
  const rechecked = await recheckDraft({ userId: user.id, draftId: generated.draftId });
  check(rechecked.passed, "recheck passes for a clean draft");
  await approveDraft({ userId: user.id, draftId: generated.draftId });

  // DNC/contact added after approval blocks a re-approval.
  await prisma.lead.update({ where: { id: lead.id }, data: { lastContactedAt: new Date() } });
  await revokeApproval({ userId: user.id, draftId: generated.draftId });
  let blockedApproval = false;
  try {
    await approveDraft({ userId: user.id, draftId: generated.draftId });
  } catch (error) {
    blockedApproval = error instanceof QualityBlockedError;
    if (error instanceof QualityBlockedError) {
      check(error.ruleIds.includes("ALREADY_CONTACTED"), "blocked approval lists ALREADY_CONTACTED");
    }
  }
  check(blockedApproval, "approval is refused when the person was contacted after generation");
  await prisma.lead.update({ where: { id: lead.id }, data: { lastContactedAt: null } });
  const restored = await prisma.messageDraft.findUnique({ where: { id: generated.draftId } });
  check(restored?.status === "BLOCKED", "blocked approval returns the draft to BLOCKED");
  await recheckDraft({ userId: user.id, draftId: generated.draftId });
  await approveDraft({ userId: user.id, draftId: generated.draftId });

  // Reject + regenerate.
  const beforeReject = await prisma.messageDraft.count({ where: { leadId: lead.id } });
  nextPayload = CLEAN_DRAFT;
  const rejected = await rejectDraft({ userId: user.id, draftId: generated.draftId, reasonCode: "TOO_GENERIC", regenerate: true });
  check(rejected.status === "REJECTED" && rejected.regeneratedDraftId !== null, "reject can regenerate a new draft");
  check((await prisma.messageDraft.count({ where: { leadId: lead.id } })) > beforeReject, "regeneration created new draft rows");

  // Non-fixable blocker ends BLOCKED with no regeneration.
  const blockedLead = await prisma.lead.create({
    data: {
      campaignId: campaign.id,
      userId: user.id,
      username: `s6_blocked_${stamp}`,
      biography: "Fitness trainer in Rawalpindi",
      category: "Gym",
      location: "Rawalpindi",
      profileUrl: `https://www.instagram.com/s6_blocked_${stamp}/`,
      status: LeadStatus.QUALIFIED,
      aiStatus: "DONE",
      aiAnalysis: ANALYSIS_PAYLOAD,
      lastContactedAt: new Date(),
      source: "test",
    },
  });
  const callsBefore = geminiCalls;
  const blockedResult = await generateAndCheckDraft({ userId: user.id, leadId: blockedLead.id });
  check(blockedResult.blocked && blockedResult.regenerationCount === 0, "non-fixable blocker ends BLOCKED without regeneration");
  check(geminiCalls >= callsBefore + 1, "non-fixable blocker costs at least one generation");

  // Fixable blocker loops to the configured limit (isolated user/profile).
  const loopUser = await prisma.user.create({
    data: { email: `s6_loop_${stamp}@example.com`, passwordHash: "x", name: "S6L" },
  });
  await upsertCompanyProfile(loopUser.id, {
    name: "Block Co",
    description: "We provide booking software for fitness studios.",
    services: [{ name: "booking software" }],
    targetIndustries: ["fitness"],
    targetCountries: ["PK"],
    idealCustomerProfile: "Independent fitness studios",
    brandTone: "friendly, direct",
    messageLanguage: "en",
    preferredLength: { minWords: 5, maxWords: 80 },
    ctaStyle: "soft question",
    forbiddenClaims: ["booking"],
    pricingPolicy: "do not share price in first DM",
    exampleMessages: [],
    objectionNotes: null,
  });
  const loopCampaign = await prisma.campaign.create({
    data: { userId: loopUser.id, name: `S6 loop ${stamp}`, qualityMaxRegenerations: 2 } as any,
  });
  const loopLead = await prisma.lead.create({
    data: {
      campaignId: loopCampaign.id,
      userId: loopUser.id,
      username: `s6_loop_${stamp}`,
      biography: "Certified fitness trainer in Rawalpindi",
      category: "Gym",
      location: "Rawalpindi",
      profileUrl: `https://www.instagram.com/s6_loop_${stamp}/`,
      status: LeadStatus.QUALIFIED,
      aiStatus: "DONE",
      aiAnalysis: ANALYSIS_PAYLOAD,
      source: "test",
    },
  });
  const callsBeforeLoop = geminiCalls;
  const loopResult = await generateAndCheckDraft({ userId: loopUser.id, leadId: loopLead.id });
  check(loopResult.blocked && loopResult.regenerationCount === 2, "fixable blocker respects qualityMaxRegenerations");
  check(geminiCalls > callsBeforeLoop, "regeneration loop made additional generations");
  check(loopResult.blockers.some((b) => b.id === "FORBIDDEN_CLAIMS"), "blocker rule ids are reported");

  // Stats.
  const stats = await getReviewStats({ campaignId: campaign.id, userId: user.id });
  check(stats.total > 0 && typeof stats.approvalRate === "number", "review stats computed");
  check(Array.isArray(stats.topFailedRules), "stats include top failed rules");

  // Bulk approve.
  const EMPTY_QUALITY = { passed: true, score: 100, warnings: [], blockers: [], checks: [] } as unknown as Prisma.InputJsonValue;
  await prisma.lead.update({ where: { id: blockedLead.id }, data: { lastContactedAt: null } });
  const cleanDraft = await prisma.messageDraft.create({
    data: {
      userId: user.id,
      leadId: blockedLead.id,
      campaignId: campaign.id,
      body: "Hi there, about your fitness studio in Rawalpindi scheduling — worth a look?",
      status: "PENDING_REVIEW",
      promptVersion: "draft-v1",
      model: "mock",
      wordCount: 14,
      qualityPassed: true,
      qualityScore: 100,
      qualityResult: EMPTY_QUALITY,
    },
  });
  const bulk = await bulkApproveDrafts({ userId: user.id, campaignId: campaign.id, draftIds: [cleanDraft.id] });
  check(bulk.approvedCount === 1 && bulk.results[0].ok, "bulk approve approves a clean draft");

  // Auto mode stays disabled by default.
  const eligibility = await getAutoApprovalEligibility(campaign.id);
  check(!eligibility.eligible && eligibility.unmet.some((u) => u.startsWith("auto_approval_disabled")), "auto approval disabled by default");
  await prisma.campaign.update({ where: { id: campaign.id }, data: { approvalMode: "AUTO_ELIGIBLE" } });
  const autoRun = await evaluateAutoApproval(campaign.id);
  check(!autoRun.evaluated && autoRun.reason === "auto_approval_disabled", "evaluateAutoApproval refuses while disabled");
  await prisma.campaign.update({ where: { id: campaign.id }, data: { approvalMode: "MANUAL" } });

  // ---------------- 4. Draft-based sending (mocked sender) ----------------
  console.log("\n[4] Draft-based sending");
  const sendDraft = await prisma.messageDraft.create({
    data: {
      userId: user.id,
      leadId: blockedLead.id,
      campaignId: campaign.id,
      body: "Hi there, noticed your fitness studio in Rawalpindi — quick scheduling idea?",
      status: "APPROVED",
      promptVersion: "draft-v1",
      model: "mock",
      wordCount: 12,
      qualityPassed: true,
      qualityScore: 100,
      qualityResult: EMPTY_QUALITY,
    },
  });
  await prisma.messageDraft.update({
    where: { id: sendDraft.id },
    data: { approvedBodyHash: draftBodyHash(sendDraft.body), approvedAt: new Date(), approvedByType: "user", approvedById: user.id },
  });
  await prisma.lead.update({ where: { id: blockedLead.id }, data: { lastContactedAt: null, status: LeadStatus.READY_FOR_OUTREACH } });

  const job = await createDraftSendJob({ userId: user.id, campaignId: campaign.id, senderAccountId: sender.id, limit: 10, draftIds: [sendDraft.id] });
  check(job.summary.eligibleCount === 1, "draft send job selects the approved draft");
  const jobItem = await prisma.bulkMessageItem.findFirst({ where: { jobId: job.job.id } });
  check(jobItem?.draftId === sendDraft.id && jobItem?.renderedBody === sendDraft.body, "item carries draftId + renderedBody");

  const secondJob = await createDraftSendJob({ userId: user.id, campaignId: campaign.id, senderAccountId: sender.id, limit: 10, draftIds: [sendDraft.id] }).catch(() => null);
  check(secondJob === null, "a draft already attached to an item cannot be queued twice");

  sendCalls = 0;
  await dispatchBulkJobQueue(job.job.id);
  const sentItem = await prisma.bulkMessageItem.findFirst({ where: { jobId: job.job.id } });
  check(sendCalls === 1, "mocked sender called exactly once");
  check(sentItem?.status === "SENT", "item marked SENT");
  const sentDraft = await prisma.messageDraft.findUnique({ where: { id: sendDraft.id } });
  check(sentDraft?.status === "SENT", "draft marked SENT after a successful send");
  const message = await prisma.message.findFirst({ where: { draftId: sendDraft.id } });
  check(message?.status === "SENT" && message?.aiGenerated === true, "Message links to the draft and is aiGenerated");
  const sentLead = await prisma.lead.findUnique({ where: { id: blockedLead.id } });
  check(sentLead?.status === LeadStatus.CONTACTED, "lead moved to CONTACTED");

  // A draft can never be sent twice.
  let doubleSendBlocked = false;
  try {
    await sendSingleMessage(
      { leadId: blockedLead.id, message: sendDraft.body, draftId: sendDraft.id, campaignId: campaign.id },
      user.id,
    );
  } catch (error) {
    doubleSendBlocked = (error as { code?: string }).code === "DRAFT_ALREADY_SENT";
  }
  check(doubleSendBlocked, "sending the same draft again is refused");

  // Dispatch-time DRAFT_CHANGED: edit after job creation -> skip, no send.
  const editLead = await prisma.lead.create({
    data: {
      campaignId: campaign.id,
      userId: user.id,
      username: `s6_edit_${stamp}`,
      biography: "Fitness trainer in Rawalpindi",
      profileUrl: `https://www.instagram.com/s6_edit_${stamp}/`,
      status: LeadStatus.READY_FOR_OUTREACH,
      aiStatus: "DONE",
      aiAnalysis: ANALYSIS_PAYLOAD,
      source: "test",
    },
  });
  const editDraftRow = await prisma.messageDraft.create({
    data: {
      userId: user.id,
      leadId: editLead.id,
      campaignId: campaign.id,
      body: "Hi there, about your fitness studio in Rawalpindi — quick scheduling idea?",
      status: "APPROVED",
      promptVersion: "draft-v1",
      model: "mock",
      wordCount: 12,
      qualityPassed: true,
      qualityScore: 100,
      qualityResult: EMPTY_QUALITY,
    },
  });
  await prisma.messageDraft.update({
    where: { id: editDraftRow.id },
    data: { approvedBodyHash: draftBodyHash(editDraftRow.body), approvedAt: new Date(), approvedByType: "user", approvedById: user.id },
  });
  const editJob = await createDraftSendJob({ userId: user.id, campaignId: campaign.id, senderAccountId: sender.id, limit: 10, draftIds: [editDraftRow.id] });
  await editDraft({ userId: user.id, draftId: editDraftRow.id, newBody: "Hi there, a different note about your fitness studio in Rawalpindi." });
  sendCalls = 0;
  await dispatchBulkJobQueue(editJob.job.id);
  const skippedItem = await prisma.bulkMessageItem.findFirst({ where: { jobId: editJob.job.id } });
  check(sendCalls === 0, "DRAFT_CHANGED never reaches the sender");
  check(skippedItem?.status === "SKIPPED" && skippedItem?.errorCode === "DRAFT_CHANGED", "item skipped as DRAFT_CHANGED");

  // Cleanup.
  globalThis.fetch = originalFetch;
  setMessagingProvider(null);
  await prisma.messageDraft.deleteMany({ where: { userId: { in: [loopUser.id, user.id] } } }).catch(() => undefined);
  await prisma.campaign.deleteMany({ where: { userId: { in: [loopUser.id, user.id] } } }).catch(() => undefined);
  await prisma.companyProfile.deleteMany({ where: { userId: { in: [loopUser.id, user.id] } } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: loopUser.id } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  await prisma.$disconnect();

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  globalThis.fetch = originalFetch;
  setMessagingProvider(null);
  console.error(error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
