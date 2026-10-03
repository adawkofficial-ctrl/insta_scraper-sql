import "server-only";

import { LeadStatus, ReplyIntent, type Prisma } from "@/generated/prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import {
  resolveCompanyProfileForCampaign,
  toCompanyProfileDto,
} from "../company-profile";
import { transitionLeadStatus } from "../lead/lead-status-service";
import { generateStructured } from "./gemini";
import {
  REPLY_INTENT_PROMPT_VERSION,
  REPLY_INTENT_RESPONSE_SCHEMA,
  buildReplyIntentPrompt,
  validateReplyIntentOutput,
  type RecentMessageContext,
} from "./prompts";

export type ClassifyReplyInput = {
  leadId: string;
  messageId: string;
};

export type ClassifyReplyResult = {
  ok: boolean;
  intent: ReplyIntent | null;
  interestLevel: "high" | "medium" | "low" | null;
  confidence: "high" | "medium" | "low" | null;
  requiresHuman: boolean;
  reasoning: string;
};

/**
 * Classifies an inbound message by intent using Gemini.
 *
 * Guarantees:
 * - Updates the Message row with intent, interestLevel, aiAnalysis, classifiedAt, and classificationPromptVersion.
 * - Tracks usage in UsageLog under provider GEMINI, operation "reply_classification".
 * - On any AI/network failure, NEVER crashes or blocks the caller; falls back to intent=null, requiresHuman=true.
 */
export async function classifyReply(input: ClassifyReplyInput): Promise<ClassifyReplyResult> {
  const prisma = getPrismaClient();

  const message = await prisma.message.findUnique({
    where: { id: input.messageId },
    include: {
      lead: {
        include: {
          campaign: true,
        },
      },
      conversation: true,
    },
  });

  if (!message || !message.lead) {
    logger.warn("[REPLY_CLASSIFICATION] message or lead not found", {
      messageId: input.messageId,
      leadId: input.leadId,
    });
    return {
      ok: false,
      intent: null,
      interestLevel: null,
      confidence: null,
      requiresHuman: true,
      reasoning: "Message or lead not found",
    };
  }

  const lead = message.lead;
  const campaign = lead.campaign;

  // Resolve company profile for campaign if present
  let companyDto = null;
  if (campaign) {
    try {
      const profileRecord = await resolveCompanyProfileForCampaign(campaign.id, campaign.userId);
      if (profileRecord) {
        companyDto = toCompanyProfileDto(profileRecord);
      }
    } catch (err) {
      logger.warn("[REPLY_CLASSIFICATION] could not resolve company profile", {
        campaignId: campaign.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Load recent message history (last 5 messages, chronological)
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

  const prompt = buildReplyIntentPrompt({
    inboundMessageText: message.messageText,
    recentHistory,
    company: companyDto,
    leadUsername: lead.username,
  });

  try {
    const result = await generateStructured({
      systemInstruction: prompt.systemInstruction,
      userText: prompt.userText,
      responseSchema: REPLY_INTENT_RESPONSE_SCHEMA,
      validate: validateReplyIntentOutput,
      operation: "reply_classification",
      promptVersion: REPLY_INTENT_PROMPT_VERSION,
      userId: campaign?.userId,
      campaignId: campaign?.id,
    });

    const classified = result.data;

    // Update Message row with classification fields
    await prisma.message.update({
      where: { id: message.id },
      data: {
        intent: classified.intent,
        interestLevel: classified.interestLevel,
        requiresHuman: classified.requiresHuman,
        aiAnalysis: classified as unknown as Prisma.InputJsonValue,
        classifiedAt: new Date(),
        classificationPromptVersion: REPLY_INTENT_PROMPT_VERSION,
      },
    });

    // If requires human attention, update conversation
    if (classified.requiresHuman && message.conversationId) {
      await prisma.conversation.update({
        where: { id: message.conversationId },
        data: { requiresHuman: true },
      }).catch(() => undefined);
    }

    logger.info("[REPLY_CLASSIFICATION] classified inbound message", {
      leadId: lead.id,
      messageId: message.id,
      intent: classified.intent,
      interestLevel: classified.interestLevel,
      requiresHuman: classified.requiresHuman,
    });

    return {
      ok: true,
      intent: classified.intent,
      interestLevel: classified.interestLevel,
      confidence: classified.confidence,
      requiresHuman: classified.requiresHuman,
      reasoning: classified.reasoning,
    };
  } catch (error) {
    logger.warn("[REPLY_CLASSIFICATION] failed to classify message, falling back to safe defaults", {
      leadId: lead.id,
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });

    // Safe fallback: mark requiresHuman: true, leave intent null
    await prisma.message.update({
      where: { id: message.id },
      data: {
        requiresHuman: true,
      },
    }).catch(() => undefined);

    if (message.conversationId) {
      await prisma.conversation.update({
        where: { id: message.conversationId },
        data: { requiresHuman: true },
      }).catch(() => undefined);
    }

    return {
      ok: false,
      intent: null,
      interestLevel: null,
      confidence: null,
      requiresHuman: true,
      reasoning: "AI classification failed",
    };
  }
}

export type ApplyIntentToLeadStatusInput = {
  leadId: string;
  intent?: ReplyIntent | string | null;
  interestLevel?: "high" | "medium" | "low" | string | null;
  actor?: string;
};

export type ApplyIntentToLeadStatusResult = {
  leadId: string;
  previousStatus: LeadStatus;
  newStatus: LeadStatus;
  transitioned: boolean;
  reason?: string;
};

/**
 * Transitions lead status based on classified intent and interestLevel.
 *
 * Rules:
 * - DO_NOT_CONTACT leads are never transitioned.
 * - Does not regress advanced leads (MEETING, CONVERTED).
 * - INTERESTED, PRICE_REQUEST, MEETING_REQUEST with high/medium interest -> INTERESTED.
 * - NOT_INTERESTED -> NOT_INTERESTED.
 * - FOLLOW_UP_LATER -> FOLLOW_UP.
 * - Ambiguous intents (QUESTION, OUT_OF_OFFICE, UNCLEAR) -> remain at REPLIED.
 */
export async function applyIntentToLeadStatus(
  input: ApplyIntentToLeadStatusInput,
): Promise<ApplyIntentToLeadStatusResult> {
  const prisma = getPrismaClient();

  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
    select: { id: true, status: true },
  });

  if (!lead) {
    return {
      leadId: input.leadId,
      previousStatus: LeadStatus.NEW,
      newStatus: LeadStatus.NEW,
      transitioned: false,
      reason: "Lead not found",
    };
  }

  const currentStatus = lead.status;

  // 1. DO_NOT_CONTACT leads are never transitioned
  if (currentStatus === LeadStatus.DO_NOT_CONTACT) {
    logger.info("[REPLY_INTENT] DO_NOT_CONTACT lead reply classified but status unchanged", {
      leadId: lead.id,
      intent: input.intent,
    });
    return {
      leadId: lead.id,
      previousStatus: LeadStatus.DO_NOT_CONTACT,
      newStatus: LeadStatus.DO_NOT_CONTACT,
      transitioned: false,
      reason: "Lead is marked DO_NOT_CONTACT",
    };
  }

  // 2. Do not regress advanced leads
  if (currentStatus === LeadStatus.MEETING || currentStatus === LeadStatus.CONVERTED) {
    logger.info("[REPLY_INTENT] advanced lead reply classified without status regression", {
      leadId: lead.id,
      currentStatus,
      intent: input.intent,
    });
    return {
      leadId: lead.id,
      previousStatus: currentStatus,
      newStatus: currentStatus,
      transitioned: false,
      reason: `Lead is already at ${currentStatus}`,
    };
  }

  // 3. Determine target status based on intent
  let targetStatus: LeadStatus = currentStatus;
  const intentStr = input.intent ? String(input.intent).toUpperCase() : "";
  const interestLevelStr = input.interestLevel ? String(input.interestLevel).toLowerCase() : "medium";

  if (
    intentStr === "INTERESTED" ||
    intentStr === "PRICE_REQUEST" ||
    intentStr === "MEETING_REQUEST"
  ) {
    if (interestLevelStr === "high" || interestLevelStr === "medium") {
      targetStatus = LeadStatus.INTERESTED;
    }
  } else if (intentStr === "NOT_INTERESTED") {
    targetStatus = LeadStatus.NOT_INTERESTED;
  } else if (intentStr === "FOLLOW_UP_LATER") {
    targetStatus = LeadStatus.FOLLOW_UP;
  }
  // QUESTION, OUT_OF_OFFICE, UNCLEAR remain at currentStatus (REPLIED)

  if (targetStatus === currentStatus) {
    return {
      leadId: lead.id,
      previousStatus: currentStatus,
      newStatus: currentStatus,
      transitioned: false,
      reason: "No status change warranted for intent",
    };
  }

  try {
    const transitionResult = await transitionLeadStatus({
      leadId: lead.id,
      to: targetStatus,
      reason: `Inbound reply intent "${intentStr}" with interest "${interestLevelStr}"`,
      actor: input.actor ?? "system:reply_classifier",
    });

    return {
      leadId: lead.id,
      previousStatus: currentStatus,
      newStatus: transitionResult.status,
      transitioned: transitionResult.transitioned,
    };
  } catch (error) {
    logger.warn("[REPLY_INTENT] status transition failed", {
      leadId: lead.id,
      from: currentStatus,
      to: targetStatus,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      leadId: lead.id,
      previousStatus: currentStatus,
      newStatus: currentStatus,
      transitioned: false,
      reason: error instanceof Error ? error.message : "Transition failed",
    };
  }
}
