import "server-only";

import { DraftKind, DraftStatus, ReplyIntent } from "@/generated/prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import {
  resolveCompanyProfileForCampaign,
  toCompanyProfileDto,
} from "../company-profile";
import {
  FIXABLE_BLOCKER_IDS,
  runQualityGate,
  type QualityGateResult,
} from "../quality";
import { generateStructured } from "./gemini";
import {
  REPLY_DRAFT_PROMPT_VERSION,
  REPLY_DRAFT_RESPONSE_SCHEMA,
  buildReplyDraftPrompt,
  validateReplyDraftOutput,
  type RecentMessageContext,
} from "./prompts";

export const REPLY_WORTHY_INTENTS = new Set<string>([
  "INTERESTED",
  "PRICE_REQUEST",
  "MEETING_REQUEST",
  "QUESTION",
]);

export type GenerateReplyDraftInput = {
  leadId: string;
  messageId: string;
};

export type GenerateReplyDraftResult = {
  draftId?: string;
  status: DraftStatus | "SKIPPED";
  passed: boolean;
  blocked: boolean;
  score: number;
  regenerationCount: number;
  blockers: Array<{ id: string; detail: string }>;
  warnings: Array<{ id: string; detail: string }>;
  skippedReason?: string;
};

function clampRegenerations(value: number | null | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 2;
  return Math.max(0, Math.min(5, Math.trunc(value)));
}

/**
 * Generates an AI-suggested reply draft for an inbound Instagram reply,
 * runs it through the EXISTING Step 6 quality gate, and persists it for human approval.
 *
 * Rules:
 * - Only runs for reply-worthy intents: INTERESTED, PRICE_REQUEST, MEETING_REQUEST, QUESTION.
 * - Skips NOT_INTERESTED, OUT_OF_OFFICE, etc.
 * - Saves as MessageDraft with kind=REPLY and replyToMessageId=messageId.
 * - Quality-gates via the existing runQualityGate engine (exempting ALREADY_CONTACTED / duplicate checks).
 * - Fixable blockers trigger bounded auto-regeneration (up to qualityMaxRegenerations).
 * - Resulting draft is saved with status PENDING_REVIEW or BLOCKED.
 */
export async function generateReplyDraft(
  input: GenerateReplyDraftInput,
): Promise<GenerateReplyDraftResult> {
  const prisma = getPrismaClient();

  const message = await prisma.message.findUnique({
    where: { id: input.messageId },
    include: {
      lead: {
        include: {
          campaign: true,
        },
      },
    },
  });

  if (!message || !message.lead || !message.lead.campaign) {
    logger.warn("[REPLY_DRAFT] message, lead, or campaign not found", {
      messageId: input.messageId,
      leadId: input.leadId,
    });
    return {
      status: "SKIPPED",
      passed: false,
      blocked: false,
      score: 0,
      regenerationCount: 0,
      blockers: [],
      warnings: [],
      skippedReason: "Message or lead not found",
    };
  }

  const lead = message.lead;
  const campaign = lead.campaign;
  const intentStr = message.intent ? message.intent.toUpperCase() : "UNCLEAR";

  // 1. Only generate reply drafts for reply-worthy intents
  if (!REPLY_WORTHY_INTENTS.has(intentStr)) {
    logger.info("[REPLY_DRAFT] skipping draft generation for non-reply intent", {
      leadId: lead.id,
      messageId: message.id,
      intent: intentStr,
    });
    return {
      status: "SKIPPED",
      passed: false,
      blocked: false,
      score: 0,
      regenerationCount: 0,
      blockers: [],
      warnings: [],
      skippedReason: `Intent "${intentStr}" is not in reply-worthy intents`,
    };
  }

  // 2. Resolve company profile
  const profileRecord = await resolveCompanyProfileForCampaign(campaign.id, campaign.userId);
  if (!profileRecord) {
    logger.warn("[REPLY_DRAFT] no company profile found for campaign", { campaignId: campaign.id });
    return {
      status: "SKIPPED",
      passed: false,
      blocked: false,
      score: 0,
      regenerationCount: 0,
      blockers: [],
      warnings: [],
      skippedReason: "Company profile missing",
    };
  }

  const company = toCompanyProfileDto(profileRecord);
  const maxRegenerations = clampRegenerations(campaign.qualityMaxRegenerations);

  // 3. Load recent conversation history (last 5 messages, chronological)
  const recentMessages = await prisma.message.findMany({
    where: {
      leadId: lead.id,
      id: { not: message.id },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      direction: true,
      messageText: true,
      createdAt: true,
    },
  });

  const recentHistory: RecentMessageContext[] = recentMessages
    .reverse()
    .map((m) => ({
      direction: m.direction,
      messageText: m.messageText,
      createdAt: m.createdAt,
    }));

  const regenerationReasons: string[] = [];
  let lastDraftId = "";
  let lastResult: QualityGateResult | null = null;

  for (let attempt = 0; attempt <= maxRegenerations; attempt += 1) {
    const prompt = buildReplyDraftPrompt({
      inboundMessageText: message.messageText,
      classifiedIntent: intentStr as ReplyIntent,
      recentHistory,
      company,
      campaign: {
        name: campaign.name,
        intent: campaign.intent,
        aiInstructions: campaign.aiInstructions,
        messageLanguage: campaign.messageLanguage,
      },
      leadUsername: lead.username,
      regenerationReasons,
    });

    let draftOutput;
    try {
      const generated = await generateStructured({
        systemInstruction: prompt.systemInstruction,
        userText: prompt.userText,
        responseSchema: REPLY_DRAFT_RESPONSE_SCHEMA,
        validate: validateReplyDraftOutput,
        operation: "reply_draft_generation",
        promptVersion: REPLY_DRAFT_PROMPT_VERSION,
        userId: campaign.userId,
        campaignId: campaign.id,
      });
      draftOutput = generated.data;
    } catch (err) {
      logger.warn("[REPLY_DRAFT] generation failed", {
        leadId: lead.id,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (lastDraftId) break;
      return {
        status: "SKIPPED",
        passed: false,
        blocked: false,
        score: 0,
        regenerationCount: attempt,
        blockers: [],
        warnings: [],
        skippedReason: "AI generation failed",
      };
    }

    // Mark previous DRAFT-status reply drafts for this lead as SUPERSEDED
    await prisma.messageDraft.updateMany({
      where: {
        leadId: lead.id,
        kind: DraftKind.REPLY,
        status: DraftStatus.DRAFT,
      },
      data: { status: DraftStatus.SUPERSEDED },
    });

    // Create the reply MessageDraft
    const createdDraft = await prisma.messageDraft.create({
      data: {
        userId: campaign.userId,
        leadId: lead.id,
        campaignId: campaign.id,
        kind: DraftKind.REPLY,
        replyToMessageId: message.id,
        body: draftOutput.message,
        channel: "INSTAGRAM",
        status: DraftStatus.DRAFT,
        promptVersion: REPLY_DRAFT_PROMPT_VERSION,
        model: "gemini",
        wordCount: draftOutput.wordCount,
        generationMeta: {
          intent: intentStr,
          intentAddressed: draftOutput.intentAddressed,
          reasoning: draftOutput.reasoning,
          attempt,
        },
        regenerationCount: attempt,
      },
    });

    lastDraftId = createdDraft.id;

    // Run existing quality gate (applyStatus: false so we control final status here)
    lastResult = await runQualityGate({ draftId: lastDraftId, applyStatus: false });

    if (lastResult.passed) {
      await prisma.messageDraft.update({
        where: { id: lastDraftId },
        data: { status: DraftStatus.PENDING_REVIEW },
      });

      logger.info("[REPLY_DRAFT] reply draft generated and passed quality gate", {
        draftId: lastDraftId,
        leadId: lead.id,
        score: lastResult.score,
        status: DraftStatus.PENDING_REVIEW,
      });

      return {
        draftId: lastDraftId,
        status: DraftStatus.PENDING_REVIEW,
        passed: true,
        blocked: false,
        score: lastResult.score,
        regenerationCount: attempt,
        blockers: [],
        warnings: lastResult.warnings.map((w) => ({ id: w.id, detail: w.detail })),
      };
    }

    // Evaluate blockers
    const blockerIds = lastResult.blockers.map((b) => b.id);
    const nonFixable = blockerIds.filter((id) => !FIXABLE_BLOCKER_IDS.has(id));

    if (nonFixable.length > 0 || attempt >= maxRegenerations) {
      await prisma.messageDraft.update({
        where: { id: lastDraftId },
        data: { status: DraftStatus.BLOCKED, regenerationCount: attempt },
      });

      logger.info("[REPLY_DRAFT] reply draft blocked by quality gate", {
        draftId: lastDraftId,
        leadId: lead.id,
        blockers: blockerIds,
        status: DraftStatus.BLOCKED,
      });

      return {
        draftId: lastDraftId,
        status: DraftStatus.BLOCKED,
        passed: false,
        blocked: true,
        score: lastResult.score,
        regenerationCount: attempt,
        blockers: lastResult.blockers.map((b) => ({ id: b.id, detail: b.detail })),
        warnings: lastResult.warnings.map((w) => ({ id: w.id, detail: w.detail })),
      };
    }

    // Fixable blockers: feed back into next iteration
    regenerationReasons.push(...lastResult.blockers.map((b) => `${b.id}: ${b.detail}`));
  }

  // Fallback return if loop completed without early exit
  return {
    draftId: lastDraftId || undefined,
    status: DraftStatus.BLOCKED,
    passed: false,
    blocked: true,
    score: lastResult?.score ?? 0,
    regenerationCount: maxRegenerations,
    blockers: lastResult?.blockers.map((b) => ({ id: b.id, detail: b.detail })) ?? [],
    warnings: lastResult?.warnings.map((w) => ({ id: w.id, detail: w.detail })) ?? [],
  };
}
