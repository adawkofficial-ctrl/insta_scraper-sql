import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  LeadEventType,
  MessageChannel,
  LeadStatus,
  DncChannel,
  DncIdentifierType,
  DncSource,
  Prisma,
} from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { transitionLeadStatus } from "../lead/lead-status-service";
import { addDoNotContact } from "../compliance/dnc-service";

export type ReplyCategory =
  | "positive"
  | "question"
  | "not_now"
  | "negative"
  | "unsubscribe"
  | "spam"
  | "unknown";

export const OPT_OUT_REGEX =
  /\b(stop|unsubscribe|opt[\s-]?out|remove me|don't message|dont message|cancel|leave me alone|do not contact|quit|end)\b/i;

export const SPAM_REGEX =
  /\b(crypto|casino|investment return|telegram\.me|t\.me\/|whatsapp me at \+|click here to earn|guaranteed profit)\b/i;

/**
 * Fast deterministic heuristic for reply text before or in place of AI classification.
 */
export function classifyReplyText(text: string): ReplyCategory {
  const trimmed = text.trim();
  if (!trimmed) return "unknown";

  if (OPT_OUT_REGEX.test(trimmed)) {
    return "unsubscribe";
  }

  if (SPAM_REGEX.test(trimmed)) {
    return "spam";
  }

  const lower = trimmed.toLowerCase();

  // 1. Clear negative signals (MUST check before positive so "not interested" does not match "interested")
  if (
    /\b(no thanks|not interested|not for us|pass|no thank you|wrong person|we're good|were good|not looking|don't contact|dont contact|not for me)\b/i.test(
      lower,
    )
  ) {
    return "negative";
  }

  // 2. Not now / deferral
  if (
    /\b(busy right now|check back next month|not right now|following quarter|next year|reach out later|next month|check back later)\b/i.test(
      lower,
    )
  ) {
    return "not_now";
  }

  // 3. Question
  if (trimmed.includes("?") || /\b(what do you|who are you|how does it work|what is the cost|how much|what does this)\b/i.test(lower)) {
    return "question";
  }

  // 4. Clear positive signals
  if (
    /\b(yes|interested|sounds good|let's talk|lets talk|book a call|send info|tell me more|schedule|available tomorrow|available next week|let's do it|lets do it)\b/i.test(
      lower,
    )
  ) {
    return "positive";
  }

  return "unknown";
}

export function toMessageChannel(ch?: string | MessageChannel | null): MessageChannel {
  if (!ch) return MessageChannel.INSTAGRAM;
  const upper = String(ch).toUpperCase();
  if (upper.includes("EMAIL")) return MessageChannel.EMAIL;
  return MessageChannel.INSTAGRAM;
}

export type RecordLeadEventInput = {
  leadId: string;
  campaignId: string;
  eventType: LeadEventType;
  channel?: MessageChannel | string;
  messageId?: string | null;
  variant?: string | null;
  metadata?: Prisma.InputJsonValue;
  actor?: string;
  createdAt?: Date;
};

/**
 * Records an immutable event in the append-only LeadEvent table.
 */
export async function recordLeadEvent(
  input: RecordLeadEventInput,
): Promise<{ id: string; eventType: LeadEventType; createdAt: Date }> {
  const prisma = getPrismaClient();

  const event = await prisma.leadEvent.create({
    data: {
      leadId: input.leadId,
      campaignId: input.campaignId,
      eventType: input.eventType,
      channel: toMessageChannel(input.channel),
      messageId: input.messageId ?? null,
      variant: input.variant ?? null,
      metadata: input.metadata ?? Prisma.DbNull,
      actor: input.actor ?? "system",
      createdAt: input.createdAt ?? new Date(),
    },
    select: {
      id: true,
      eventType: true,
      createdAt: true,
    },
  });

  logger.info("[LEAD_EVENT] Recorded lead outcome event", {
    leadId: input.leadId,
    campaignId: input.campaignId,
    eventType: input.eventType,
    variant: input.variant,
  });

  return event;
}

export type ProcessInboundReplyInput = {
  leadId: string;
  messageId?: string;
  replyText?: string;
  channel?: MessageChannel;
  aiIntent?: string | null;
  actor?: string;
};

/**
 * Handles inbound reply processing:
 * 1. Emits REPLIED event.
 * 2. Classifies reply category (positive, question, not_now, negative, unsubscribe, spam, unknown).
 * 3. Emits POSITIVE_REPLY, NEGATIVE_REPLY, or UNSUBSCRIBE_OR_DNC event.
 * 4. If unsubscribe: adds lead to DNC and cancels pending outreach automatically.
 */
export async function processInboundReplyOutcome(
  input: ProcessInboundReplyInput,
): Promise<{
  replyCategory: ReplyCategory;
  eventsEmitted: LeadEventType[];
  leadStatus: LeadStatus;
}> {
  const prisma = getPrismaClient();

  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
    select: {
      id: true,
      campaignId: true,
      userId: true,
      status: true,
      username: true,
      instagramUserId: true,
      email: true,
      emailNormalized: true,
      phone: true,
      phoneNormalized: true,
      websiteDomain: true,
      messageVariant: true,
      campaign: {
        select: {
          userId: true,
        },
      },
    },
  });

  if (!lead) {
    throw new Error(`Lead "${input.leadId}" not found for inbound reply processing.`);
  }

  const eventsEmitted: LeadEventType[] = [];

  // 1. Record REPLIED event
  await recordLeadEvent({
    leadId: lead.id,
    campaignId: lead.campaignId,
    eventType: LeadEventType.REPLIED,
    channel: input.channel ?? MessageChannel.INSTAGRAM,
    messageId: input.messageId,
    variant: lead.messageVariant,
    actor: input.actor ?? "system:webhook",
  });
  eventsEmitted.push(LeadEventType.REPLIED);

  // 2. Classify reply
  let replyCategory: ReplyCategory = "unknown";
  const text = input.replyText ?? "";

  // Check text heuristics first
  if (text) {
    replyCategory = classifyReplyText(text);
  }

  // If text was ambiguous or a question with specific AI intent, map from AI intent
  if ((replyCategory === "unknown" || replyCategory === "question") && input.aiIntent) {
    const intentUpper = input.aiIntent.toUpperCase();
    if (
      intentUpper === "INTERESTED" ||
      intentUpper === "PRICE_REQUEST" ||
      intentUpper === "MEETING_REQUEST"
    ) {
      replyCategory = "positive";
    } else if (intentUpper === "NOT_INTERESTED") {
      replyCategory = "negative";
    } else if (intentUpper === "FOLLOW_UP_LATER" || intentUpper === "OUT_OF_OFFICE") {
      replyCategory = "not_now";
    } else if (intentUpper === "QUESTION") {
      replyCategory = "question";
    }
  }

  // Update Message record with replyCategory
  if (input.messageId) {
    await prisma.message.update({
      where: { id: input.messageId },
      data: { replyCategory },
    });
  }

  let finalStatus = lead.status;

  // Ensure lead advances from CONTACTED -> REPLIED first so subsequent status transitions succeed
  if (lead.status === LeadStatus.CONTACTED) {
    try {
      const res = await transitionLeadStatus({
        leadId: lead.id,
        to: LeadStatus.REPLIED,
        reason: "Inbound reply received",
        actor: input.actor ?? "system:reply_tracker",
      });
      finalStatus = res.status;
    } catch {
      // Ignore if transition disallowed
    }
  }

  // 3. Handle category specific actions & outcome events
  if (replyCategory === "unsubscribe") {
    // A. Record UNSUBSCRIBE_OR_DNC event
    await recordLeadEvent({
      leadId: lead.id,
      campaignId: lead.campaignId,
      eventType: LeadEventType.UNSUBSCRIBE_OR_DNC,
      channel: input.channel ?? MessageChannel.INSTAGRAM,
      messageId: input.messageId,
      variant: lead.messageVariant,
      actor: input.actor ?? "system:unsubscribe_guard",
      metadata: { reason: "Recipient requested unsubscribe or stop" },
    });
    eventsEmitted.push(LeadEventType.UNSUBSCRIBE_OR_DNC);

    // B. Add to DoNotContact table and cancel pending outreach
    const dncEntries: Array<{
      identifierType: DncIdentifierType;
      value: string;
      channel: DncChannel;
      reason: string;
    }> = [];

    if (lead.username) {
      dncEntries.push({
        identifierType: DncIdentifierType.USERNAME,
        value: lead.username,
        channel: DncChannel.ALL,
        reason: "Inbound opt-out reply",
      });
    }
    if (lead.instagramUserId) {
      dncEntries.push({
        identifierType: DncIdentifierType.INSTAGRAM_ID,
        value: lead.instagramUserId,
        channel: DncChannel.ALL,
        reason: "Inbound opt-out reply",
      });
    }
    if (lead.emailNormalized || lead.email) {
      dncEntries.push({
        identifierType: DncIdentifierType.EMAIL,
        value: lead.emailNormalized || lead.email!,
        channel: DncChannel.ALL,
        reason: "Inbound opt-out reply",
      });
    }
    if (lead.phoneNormalized || lead.phone) {
      dncEntries.push({
        identifierType: DncIdentifierType.PHONE,
        value: lead.phoneNormalized || lead.phone!,
        channel: DncChannel.ALL,
        reason: "Inbound opt-out reply",
      });
    }

    const effectiveUserId = lead.userId || lead.campaign?.userId;
    if (effectiveUserId && dncEntries.length > 0) {
      await addDoNotContact({
        userId: effectiveUserId,
        entries: dncEntries,
        source: DncSource.REPLY_OPT_OUT,
        reason: "Recipient requested stop/unsubscribe",
        actor: input.actor ?? "system:reply_classifier",
      });
    }

    // Transition lead to DO_NOT_CONTACT
    const res = await transitionLeadStatus({
      leadId: lead.id,
      to: LeadStatus.DO_NOT_CONTACT,
      reason: "Opt-out / stop requested by recipient",
      actor: input.actor ?? "system:unsubscribe_guard",
    });
    finalStatus = res.status;
  } else if (replyCategory === "positive") {
    // Record POSITIVE_REPLY event
    await recordLeadEvent({
      leadId: lead.id,
      campaignId: lead.campaignId,
      eventType: LeadEventType.POSITIVE_REPLY,
      channel: input.channel ?? MessageChannel.INSTAGRAM,
      messageId: input.messageId,
      variant: lead.messageVariant,
      actor: input.actor ?? "system:reply_classifier",
    });
    eventsEmitted.push(LeadEventType.POSITIVE_REPLY);

    const res = await transitionLeadStatus({
      leadId: lead.id,
      to: LeadStatus.INTERESTED,
      reason: "Positive reply received",
      actor: input.actor ?? "system:reply_classifier",
    });
    finalStatus = res.status;
  } else if (replyCategory === "negative") {
    // Record NEGATIVE_REPLY event
    await recordLeadEvent({
      leadId: lead.id,
      campaignId: lead.campaignId,
      eventType: LeadEventType.NEGATIVE_REPLY,
      channel: input.channel ?? MessageChannel.INSTAGRAM,
      messageId: input.messageId,
      variant: lead.messageVariant,
      actor: input.actor ?? "system:reply_classifier",
    });
    eventsEmitted.push(LeadEventType.NEGATIVE_REPLY);

    const res = await transitionLeadStatus({
      leadId: lead.id,
      to: LeadStatus.NOT_INTERESTED,
      reason: "Negative reply received",
      actor: input.actor ?? "system:reply_classifier",
    });
    finalStatus = res.status;
  }

  return {
    replyCategory,
    eventsEmitted,
    leadStatus: finalStatus,
  };
}

export type RecordManualOutcomeInput = {
  leadId: string;
  eventType: "MEETING_BOOKED" | "WON" | "POSITIVE_REPLY" | "NEGATIVE_REPLY" | "UNSUBSCRIBE_OR_DNC";
  channel?: MessageChannel;
  notes?: string;
  actor: string;
};

/**
 * Records a manual outcome event triggered by a user in the UI (e.g. meeting booked, won).
 */
export async function recordManualOutcomeEvent(
  input: RecordManualOutcomeInput,
): Promise<{
  event: { id: string; eventType: LeadEventType; createdAt: Date };
  leadStatus: LeadStatus;
}> {
  const prisma = getPrismaClient();

  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
    select: {
      id: true,
      campaignId: true,
      userId: true,
      status: true,
      username: true,
      email: true,
      phone: true,
      messageVariant: true,
      campaign: {
        select: {
          userId: true,
        },
      },
    },
  });

  if (!lead) {
    throw new Error(`Lead "${input.leadId}" was not found.`);
  }

  const mappedEventType = LeadEventType[input.eventType];

  const event = await recordLeadEvent({
    leadId: lead.id,
    campaignId: lead.campaignId,
    eventType: mappedEventType,
    channel: input.channel ?? MessageChannel.INSTAGRAM,
    variant: lead.messageVariant,
    metadata: input.notes ? { notes: input.notes } : undefined,
    actor: input.actor,
  });

  let targetStatus: LeadStatus | null = null;
  if (mappedEventType === LeadEventType.MEETING_BOOKED) {
    targetStatus = LeadStatus.MEETING;
  } else if (mappedEventType === LeadEventType.WON) {
    targetStatus = LeadStatus.CONVERTED;
  } else if (mappedEventType === LeadEventType.POSITIVE_REPLY) {
    targetStatus = LeadStatus.INTERESTED;
  } else if (mappedEventType === LeadEventType.NEGATIVE_REPLY) {
    targetStatus = LeadStatus.NOT_INTERESTED;
  } else if (mappedEventType === LeadEventType.UNSUBSCRIBE_OR_DNC) {
    targetStatus = LeadStatus.DO_NOT_CONTACT;

    const effectiveUserId = lead.userId || lead.campaign?.userId;
    if (effectiveUserId && lead.username) {
      await addDoNotContact({
        userId: effectiveUserId,
        entries: [
          {
            identifierType: DncIdentifierType.USERNAME,
            value: lead.username,
            channel: DncChannel.ALL,
            reason: input.notes ?? "Manually marked as unsubscribe",
          },
        ],
        source: DncSource.MANUAL,
        reason: input.notes ?? "Manually marked as unsubscribe",
        actor: input.actor,
      });
    }
  }

  let finalStatus = lead.status;
  if (targetStatus && targetStatus !== lead.status) {
    const res = await transitionLeadStatus({
      leadId: lead.id,
      to: targetStatus,
      reason: `Manual event recorded: ${input.eventType}`,
      actor: input.actor,
    });
    finalStatus = res.status;
  }

  return {
    event,
    leadStatus: finalStatus,
  };
}
