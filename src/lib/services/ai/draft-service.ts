import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { AiStatus, DraftStatus, LeadStatus } from "@/generated/prisma/enums";
import {
  BadRequestError,
  CompanyProfileIncompleteError,
  NotFoundError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  getCompanyProfileCompleteness,
  resolveCompanyProfileForCampaign,
  toCompanyProfileDto,
  type CompanyProfileDto,
} from "../company-profile";
import { generateStructured, GeminiApiError } from "./gemini";
import { isDryRunLead } from "@/lib/services/messaging";
import {
  DRAFT_PROMPT_VERSION,
  DRAFT_RESPONSE_SCHEMA,
  buildDraftPrompt,
  buildLeadContext,
  validateDraftOutput,
  type DraftOutput,
} from "./prompts";

const MAX_AUTO_REGENERATIONS = 2;

export type GenerateDraftResult = {
  draftId: string;
  body: string;
  wordCount: number;
  promptVersion: string;
  regenerationCount: number;
  validationWarnings: string[];
};

function wordCountOf(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Deterministic draft validation. Returns human-readable reasons (no PII). */
export function validateDraftAgainstProfile(
  body: string,
  company: CompanyProfileDto,
): string[] {
  const reasons: string[] = [];
  const trimmed = body.trim();
  if (trimmed.length === 0) reasons.push("empty_body");

  if (/\{\{[^}]+\}\}|\{[a-zA-Z_]+\}|\[[A-Za-z ]+\]|TODO|lorem ipsum/i.test(trimmed)) {
    reasons.push("unresolved_placeholder");
  }
  if (/https?:\/\/|www\./i.test(trimmed)) {
    reasons.push("contains_url");
  }
  for (const claim of company.forbiddenClaims) {
    const term = claim.trim();
    if (term.length === 0) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(trimmed)) {
      reasons.push(`forbidden_claim:${term}`);
    }
  }
  const preferred = company.preferredLength;
  if (preferred) {
    const words = wordCountOf(trimmed);
    const min = Math.floor(preferred.minWords * 0.8);
    const max = Math.ceil(preferred.maxWords * 1.2);
    if (words < min || words > max) reasons.push("length_out_of_range");
    if (wordCountOf(trimmed) > 1000) reasons.push("too_long");
  }
  return reasons;
}

/**
 * Generates (and validates) a message draft. The CompanyProfile completeness
 * gate runs BEFORE any Gemini call or UsageLog write.
 */
export async function generateDraft(input: {
  userId: string;
  leadId: string;
  regenerationReason?: string;
}): Promise<GenerateDraftResult> {
  const prisma = getPrismaClient();
  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, campaign: { userId: input.userId } },
    include: { campaign: true },
  });
  if (!lead) {
    throw new NotFoundError("LEAD_NOT_FOUND", `Lead "${input.leadId}" was not found.`);
  }

  // ---- Completeness gate FIRST (no Gemini / UsageLog before this) ----
  const profileRecord = await resolveCompanyProfileForCampaign(lead.campaignId, input.userId);
  const completeness = getCompanyProfileCompleteness(profileRecord);
  if (!completeness.complete) {
    throw new CompanyProfileIncompleteError(completeness.missingFields, completeness.warnings);
  }
  const company = toCompanyProfileDto(profileRecord!);

  if (lead.duplicateOfLeadId) {
    throw new BadRequestError("DUPLICATE_LEAD", "Cannot draft for a duplicate-linked lead.");
  }
  if (lead.isDryRun || isDryRunLead(lead)) {
    throw new BadRequestError("DRY_RUN_LEAD_DRAFT_BLOCKED", "Cannot generate message draft for a dry-run or mock lead.");
  }
  if (lead.aiStatus !== AiStatus.DONE) {
    throw new BadRequestError("LEAD_NOT_ANALYZED", "Analyze the lead before generating a draft.");
  }
  if (
    lead.campaign.aiQualificationEnabled &&
    lead.status !== LeadStatus.QUALIFIED &&
    lead.status !== LeadStatus.READY_FOR_OUTREACH
  ) {
    throw new BadRequestError(
      "LEAD_NOT_QUALIFIED",
      "Lead is not qualified for outreach yet.",
    );
  }

  const recent = await prisma.messageDraft.findMany({
    where: { campaignId: lead.campaignId, userId: input.userId, status: { not: DraftStatus.SUPERSEDED } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { body: true },
  });

  const context = buildLeadContext(lead, lead.campaign, {
    ...company,
    messageLanguage: lead.campaign.messageLanguage ?? company.messageLanguage,
  });

  let lastOutput: DraftOutput | null = null;
  let warnings: string[] = [];
  const reasons: string[] = [];
  if (input.regenerationReason) reasons.push(input.regenerationReason);

  for (let attempt = 0; attempt <= MAX_AUTO_REGENERATIONS; attempt += 1) {
    const prompt = buildDraftPrompt(context, [
      ...reasons,
      ...recent.map((draft) => draft.body),
    ]);
    const result = await generateStructured({
      systemInstruction: prompt.systemInstruction,
      userText: prompt.userText,
      responseSchema: DRAFT_RESPONSE_SCHEMA,
      validate: validateDraftOutput,
      operation: attempt === 0 ? "draft_generation" : "regenerate_draft",
      promptVersion: DRAFT_PROMPT_VERSION,
      userId: input.userId,
      campaignId: lead.campaignId,
    });
    lastOutput = result.data;
    warnings = validateDraftAgainstProfile(result.data.message, company);
    if (warnings.length === 0) break;
    reasons.push(...warnings);
  }

  if (!lastOutput) {
    throw new GeminiApiError("AI_BAD_OUTPUT", "No draft could be generated.");
  }

  const superseded = await prisma.messageDraft.updateMany({
    where: {
      leadId: lead.id,
      campaignId: lead.campaignId,
      status: DraftStatus.DRAFT,
    },
    data: { status: DraftStatus.SUPERSEDED },
  });

  const created = await prisma.messageDraft.create({
    data: {
      userId: input.userId,
      leadId: lead.id,
      campaignId: lead.campaignId,
      body: lastOutput.message,
      channel: "INSTAGRAM",
      status: DraftStatus.DRAFT,
      promptVersion: DRAFT_PROMPT_VERSION,
      model: "gemini",
      personalizationPointsUsed: lastOutput.personalizationPointsUsed,
      generationMeta: { warnings, regenerationReason: input.regenerationReason ?? null },
      wordCount: lastOutput.wordCount,
    },
  });

  logger.info("[AI] draft generated", {
    draftId: created.id,
    leadId: lead.id,
    warnings: warnings.length,
    superseded: superseded.count,
  });

  return {
    draftId: created.id,
    body: lastOutput.message,
    wordCount: lastOutput.wordCount,
    promptVersion: DRAFT_PROMPT_VERSION,
    regenerationCount: reasons.length,
    validationWarnings: warnings,
  };
}
