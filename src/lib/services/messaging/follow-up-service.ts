import { getPrismaClient } from "@/lib/db/prisma";
import {
  FollowUpStatus,
  FollowUpMessage,
  MessageDirection,
  MessageStatus,
  MessageChannel,
  LeadStatus,
  DncChannel,
} from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { checkLeadSuppression } from "../compliance";
import { addDoNotContact, DncIdentifierType } from "../compliance/dnc-service";
import {
  canSendNow,
  getSendGateNow,
  chooseHealthySender,
} from "./send-gate";
import { recordSenderAccountSent } from "./bulk-messaging-service";
import { findConnectedSendersForDispatch } from "../senders/instagram-sender-service";
import { updateSenderAccountRecord } from "../senders/instagram-sender-repository";
import { getMessagingProvider } from "./messaging-service";
import type { MessagingProvider } from "./messaging-provider";
import { classifyMessagingError } from "./error-classifier";
import { transitionLeadStatus } from "../lead/lead-status-service";

// False-positive phrases where words like 'stop' appear in harmless or colloquial contexts
export const STOP_FALSE_POSITIVE_PATTERNS: readonly RegExp[] = [
  /\b(?:bus|train|pit|door|truck|tram)\s+stop\b/i,
  /\bnon[- ]?stop\b/i,
  /\b(?:can'?t|couldn'?t|won'?t|don'?t|dont)\s+stop\b/i,
  /\bnever\s+stop\b/i,
  /\bstop\s+(?:by|in|around)\b/i, // e.g. "feel free to stop by"
  /\bhard\s+to\s+stop\b/i,
];

// Explicit opt-out phrases and keywords
export const OPT_OUT_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\bunsub(?:scribe)?\b/i, // stop, unsubscribe, unsub
  /\bnot\s+interested\b/i, // not interested
  /\bno\s+thank(?:s|\s+you)\b/i, // no thanks, no thank you
  /\bremove\s+me\b/i, // remove me
  /\b(?:don'?t|dont|do\s+not)\s+message\b/i, // don't message, dont message
  /\bdo\s+not\s+contact\b/i, // do not contact
  /\b(?:don'?t|dont)\s+contact\b/i, // don't contact, dont contact
  /\bleave\s+me\s+alone\b/i, // leave me alone
  /\bstop\s+messaging\b/i, // stop messaging
  /\bopt[- ]?out\b/i, // opt out, opt-out
];

/**
 * Checks if incoming text indicates an explicit opt-out / DNC request.
 * Pure regex-based, handles punctuation, smart quotes, and common emojis.
 * Excludes false positives (e.g. "bus stop near us", "stop by").
 */
export function isStopKeyword(text: string | null | undefined): boolean {
  if (!text) return false;
  // Normalize smart quotes and common apostrophes
  const normalized = text.replace(/[’‘`]/g, "'").trim();

  // 1. Check for false-positive phrases containing "stop" in non-opt-out contexts
  const hasFalsePositive = STOP_FALSE_POSITIVE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );

  if (hasFalsePositive) {
    // If a false-positive pattern matched, only return true if an explicit non-"stop"
    // opt-out phrase is also present in the message (e.g. "bus stop near us, please unsubscribe")
    return OPT_OUT_KEYWORD_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  // 2. Check explicit multi-word opt-out patterns
  if (OPT_OUT_KEYWORD_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // 3. Standalone or word-bounded "stop" (e.g. "STOP", "stop!", "Please stop", "stop 🛑")
  return /\bstop\b/i.test(normalized);
}

export type FollowUpTemplateRenderResult =
  | { valid: true; text: string; error?: never }
  | { valid: false; text?: never; error: string };

/**
 * Validates and renders plain text follow-up template with placeholders:
 * {firstName}, {businessName}, {city} (or {{firstName}}, etc.)
 *
 * Rules:
 * 1. Unresolved placeholders -> mark item NEEDS_EDIT, never send blank names.
 * 2. Follow-up text must differ from the first message and from each other.
 */
export function renderFollowUpTemplate(
  template: string,
  lead: {
    fullName?: string | null;
    username?: string | null;
    category?: string | null;
    city?: string | null;
    location?: string | null;
    isBusinessAccount?: boolean | null;
  },
  initialMessageText?: string | null,
  previousStepTemplateText?: string | null,
): FollowUpTemplateRenderResult {
  if (!template || !template.trim()) {
    return { valid: false, error: "Template is empty." };
  }

  let text = template;
  const firstNameRegex = /\{{1,2}firstName\}{1,2}/gi;
  const businessNameRegex = /\{{1,2}businessName\}{1,2}/gi;
  const cityRegex = /\{{1,2}city\}{1,2}/gi;

  // 1. firstName: derived from lead.fullName
  if (firstNameRegex.test(text)) {
    const rawFullName = lead.fullName?.trim() || "";
    if (!rawFullName) {
      return { valid: false, error: "Unresolved placeholder {firstName}: recipient has no full name." };
    }
    const firstName = rawFullName.split(/\s+/)[0]?.trim();
    if (!firstName) {
      return { valid: false, error: "Unresolved placeholder {firstName}: recipient first name is blank." };
    }
    text = text.replace(firstNameRegex, firstName);
  }

  // 2. businessName: lead.category or lead.fullName (if business) or lead.username
  if (businessNameRegex.test(text)) {
    const businessName =
      lead.category?.trim() ||
      (lead.isBusinessAccount ? lead.fullName?.trim() : "") ||
      lead.username?.trim() ||
      "";
    if (!businessName) {
      return { valid: false, error: "Unresolved placeholder {businessName}: recipient has no business name." };
    }
    text = text.replace(businessNameRegex, businessName);
  }

  // 3. city: lead.city or first token of lead.location
  if (cityRegex.test(text)) {
    const city = lead.city?.trim() || lead.location?.split(",")?.[0]?.trim() || "";
    if (!city) {
      return { valid: false, error: "Unresolved placeholder {city}: recipient has no city or location." };
    }
    text = text.replace(cityRegex, city);
  }

  // 4. Any remaining curly bracket placeholder is invalid
  const remainingMatches = text.match(/\{{1,2}[a-zA-Z0-9_]+\}{1,2}/g);
  if (remainingMatches && remainingMatches.length > 0) {
    return {
      valid: false,
      error: `Unresolved placeholder(s): ${remainingMatches.join(", ")}`,
    };
  }

  const trimmedText = text.trim();

  // 5. Follow-up text must differ from the first message
  if (initialMessageText && trimmedText.toLowerCase() === initialMessageText.trim().toLowerCase()) {
    return {
      valid: false,
      error: "Follow-up text must differ from the initial outreach message.",
    };
  }

  // 6. Follow-up text must differ from previous step follow-up
  if (
    previousStepTemplateText &&
    trimmedText.toLowerCase() === previousStepTemplateText.trim().toLowerCase()
  ) {
    return {
      valid: false,
      error: "Follow-up text must differ from the previous follow-up message.",
    };
  }

  return { valid: true, text: trimmedText };
}

/**
 * Creates follow-up items when a first DM is SENT.
 * Idempotent: safe against duplicate invocations.
 */
export async function scheduleFollowUpsForLead(input: {
  campaignId: string;
  leadId: string;
  sentAt?: Date;
  firstMessageId?: string | null;
  initialMessageText?: string | null;
  threadId?: string | null;
  senderAccountId?: string | null;
}): Promise<FollowUpMessage[]> {
  const prisma = getPrismaClient();
  const { campaignId, leadId } = input;
  const sentAt = input.sentAt || new Date();

  if (input.firstMessageId) {
    const firstMsg = await prisma.message.findUnique({
      where: { id: input.firstMessageId },
      select: { status: true },
    });
    if (
      firstMsg &&
      (firstMsg.status === MessageStatus.FAILED || firstMsg.status === MessageStatus.UNKNOWN)
    ) {
      return [];
    }
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      status: true,
      followUpEnabled: true,
      followUpCount: true,
      followUpDelayDays: true,
      followUpTemplates: true,
    },
  });

  if (!campaign || !campaign.followUpEnabled || campaign.followUpCount < 1) {
    return [];
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      fullName: true,
      username: true,
      category: true,
      city: true,
      location: true,
      isBusinessAccount: true,
      status: true,
    },
  });

  if (!lead) return [];

  // Leads without Instagram handle cannot receive Instagram DM follow-ups
  if (!lead.username || !lead.username.trim()) {
    return [];
  }

  // If lead already replied or DNC, do not schedule
  if (
    lead.status === LeadStatus.REPLIED ||
    lead.status === LeadStatus.DO_NOT_CONTACT ||
    lead.status === LeadStatus.INTERESTED ||
    lead.status === LeadStatus.NOT_INTERESTED
  ) {
    return [];
  }

  const maxCount = Math.min(2, Math.max(1, campaign.followUpCount));
  const delayDaysList = campaign.followUpDelayDays || [3, 5];
  const templates = campaign.followUpTemplates || [];

  const results: FollowUpMessage[] = [];
  let previousRenderedText: string | null = null;

  for (let step = 1; step <= maxCount; step++) {
    const delayDays = delayDaysList[step - 1] ?? (step === 1 ? 3 : 5);
    const dueAt = new Date(sentAt.getTime() + delayDays * 86400000);
    const templateText =
      templates[step - 1] ||
      (step === 1
        ? "Hi {firstName}, following up on my previous note!"
        : "Hi {firstName}, just wanted to check in one last time!");

    const rendered = renderFollowUpTemplate(
      templateText,
      lead,
      input.initialMessageText,
      previousRenderedText,
    );

    if (rendered.valid) {
      previousRenderedText = rendered.text;
    }

    const idempotencyKey = `followup:${campaignId}:${leadId}:${step}`;

    const upserted = await prisma.followUpMessage.upsert({
      where: { campaignId_leadId_step: { campaignId, leadId, step } },
      create: {
        campaignId,
        leadId,
        step,
        status: rendered.valid ? FollowUpStatus.SCHEDULED : FollowUpStatus.NEEDS_EDIT,
        templateText,
        renderedBody: rendered.valid ? rendered.text : null,
        errorMessage: rendered.valid ? null : rendered.error,
        dueAt,
        threadId: input.threadId || null,
        senderAccountId: input.senderAccountId || null,
        idempotencyKey,
      },
      update: {
        // If already in SCHEDULED/NEEDS_EDIT, re-render to reflect new template
        ...(rendered.valid
          ? {
              templateText,
              renderedBody: rendered.text,
              errorMessage: null,
            }
          : {
              templateText,
              renderedBody: null,
              errorMessage: rendered.error,
              status: FollowUpStatus.NEEDS_EDIT,
            }),
      },
    });
    results.push(upserted);
  }
  return results;
}

/**
 * Cancels all pending follow-ups for a lead when they reply or hit DNC.
 */
export async function cancelFollowUpsForLead(
  leadId: string,
  reason: "REPLIED" | "DNC" | "MANUAL",
): Promise<{ count: number }> {
  const prisma = getPrismaClient();
  const targetStatus =
    reason === "DNC"
      ? FollowUpStatus.CANCELLED_DNC
      : reason === "MANUAL"
      ? FollowUpStatus.CANCELLED_MANUAL
      : FollowUpStatus.CANCELLED_REPLIED;

  const result = await prisma.followUpMessage.updateMany({
    where: {
      leadId,
      status: { in: [FollowUpStatus.SCHEDULED, FollowUpStatus.NEEDS_EDIT] },
    },
    data: {
      status: targetStatus,
      cancelReason: reason,
    },
  });

  return { count: result.count };
}

/**
 * Inbound reply hook for follow-up message cancellation and keyword opt-outs.
 */
export async function handleInboundReplyForFollowUps(
  leadIdOrInput:
    | string
    | {
        leadId: string;
        inboundText?: string;
        replyText?: string;
        userId?: string;
        repliedAt?: Date;
      },
  replyTextArg?: string,
  userIdArg?: string,
): Promise<{ stopOptOut: boolean; isDnc: boolean; cancelledCount: number }> {
  const prisma = getPrismaClient();

  const leadId = typeof leadIdOrInput === "string" ? leadIdOrInput : leadIdOrInput.leadId;
  const replyText =
    typeof leadIdOrInput === "string"
      ? replyTextArg || ""
      : leadIdOrInput.inboundText || leadIdOrInput.replyText || "";
  let userId =
    typeof leadIdOrInput === "string" ? userIdArg : leadIdOrInput.userId;

  const stopOptOut = isStopKeyword(replyText);

  if (stopOptOut) {
    if (!userId) {
      const leadWithCampaign = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { campaign: { select: { userId: true } } },
      });
      userId = leadWithCampaign?.campaign?.userId;
    }

    if (userId) {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { username: true },
      });
      if (lead?.username) {
        await addDoNotContact({
          userId,
          entries: [
            {
              identifierType: DncIdentifierType.USERNAME,
              value: lead.username,
              channel: DncChannel.INSTAGRAM,
              reason: "keyword_optout",
            },
          ],
          actor: "system:keyword_guard",
        }).catch((err: unknown) => {
          logger.warn("[FOLLOW_UP_DNC] Failed to create DNC entry for stop keyword", {
            leadId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    try {
      await transitionLeadStatus({
        leadId,
        to: LeadStatus.DO_NOT_CONTACT,
        reason: "Recipient replied with stop/opt-out keyword",
        actor: "system:keyword_guard",
      });
    } catch {
      // Ignore if transition restricted
    }

    const { count } = await cancelFollowUpsForLead(leadId, "DNC");
    return { stopOptOut: true, isDnc: true, cancelledCount: count };
  }

  const { count } = await cancelFollowUpsForLead(leadId, "REPLIED");
  return { stopOptOut: false, isDnc: false, cancelledCount: count };
}

/**
 * Dispatches due follow-up messages adhering to Fix 5 send gate safety:
 * - Daily & hourly caps
 * - Working hours in lead's timezone
 * - Warmup & jitter
 * - DNC suppression
 * - Spacing: max 1 follow-up per lead per 48 hours
 * - Thread preservation
 */
export async function dispatchDueFollowUps(options?: {
  now?: Date;
  campaignId?: string;
  leadId?: string;
  userId?: string;
  limit?: number;
  messagingProvider?: MessagingProvider;
}): Promise<{
  processed: number;
  sent: number;
  deferred: number;
  cancelled: number;
}> {
  const prisma = getPrismaClient();
  const now = options?.now || getSendGateNow();
  const limit = options?.limit ?? 50;

  let processed = 0;
  let sent = 0;
  let deferred = 0;
  let cancelled = 0;

  // 1. Fetch eligible due follow-ups
  const dueItems = await prisma.followUpMessage.findMany({
    where: {
      status: FollowUpStatus.SCHEDULED,
      dueAt: { lte: now },
      OR: [{ retryAt: null }, { retryAt: { lte: now } }],
      ...(options?.campaignId ? { campaignId: options.campaignId } : {}),
      ...(options?.leadId ? { leadId: options.leadId } : {}),
    },
    orderBy: [{ dueAt: "asc" }, { step: "asc" }],
    take: limit,
    include: {
      campaign: {
        select: {
          id: true,
          userId: true,
          status: true,
          followUpEnabled: true,
          followUpCount: true,
        },
      },
      lead: {
        select: {
          id: true,
          username: true,
          fullName: true,
          profileUrl: true,
          category: true,
          city: true,
          location: true,
          status: true,
        },
      },
    },
  });

  for (const item of dueItems) {
    processed++;
    const { campaign, lead } = item;

    // Check Campaign state
    if (!campaign.followUpEnabled || campaign.status === "CANCELLED") {
      await prisma.followUpMessage.update({
        where: { id: item.id },
        data: {
          status: FollowUpStatus.CANCELLED_MANUAL,
          cancelReason: "CAMPAIGN_INACTIVE",
        },
      });
      cancelled++;
      continue;
    }

    if (campaign.status === "PAUSED") {
      // Defer without cancellation
      deferred++;
      continue;
    }

    if (!lead.username || !lead.username.trim()) {
      await prisma.followUpMessage.update({
        where: { id: item.id },
        data: {
          status: FollowUpStatus.CANCELLED_MANUAL,
          cancelReason: "NO_INSTAGRAM_HANDLE",
        },
      });
      cancelled++;
      continue;
    }

    if (item.step > campaign.followUpCount) {
      await prisma.followUpMessage.update({
        where: { id: item.id },
        data: {
          status: FollowUpStatus.SKIPPED,
          errorMessage: `Step ${item.step} exceeds campaign follow-up count of ${campaign.followUpCount}`,
        },
      });
      continue;
    }

    // Eligibility Check 1: Re-check DB for ANY inbound message from lead or in thread
    // This protects against missed, late, or unhandled webhooks where lead.status is still CONTACTED
    const threadConditions = [];
    if (item.threadId) {
      threadConditions.push(
        { unipileChatId: item.threadId, direction: MessageDirection.INBOUND },
        { conversationId: item.threadId, direction: MessageDirection.INBOUND },
      );
    }

    const inboundReply = await prisma.message.findFirst({
      where: {
        OR: [
          { leadId: lead.id, direction: MessageDirection.INBOUND },
          ...threadConditions,
        ],
      },
      orderBy: { createdAt: "desc" },
    });

    if (
      inboundReply ||
      lead.status === LeadStatus.REPLIED ||
      lead.status === LeadStatus.INTERESTED ||
      lead.status === LeadStatus.NOT_INTERESTED
    ) {
      if (inboundReply && isStopKeyword(inboundReply.messageText)) {
        await handleInboundReplyForFollowUps({
          leadId: lead.id,
          inboundText: inboundReply.messageText,
          userId: campaign.userId,
        });
      } else {
        await cancelFollowUpsForLead(lead.id, "REPLIED");
      }
      cancelled++;
      continue;
    }

    // Eligibility Check 2: Lead is not DNC / suppressed
    const suppression = await checkLeadSuppression({
      userId: campaign.userId,
      lead,
      channel: DncChannel.INSTAGRAM,
    });
    if (suppression.suppressed || lead.status === LeadStatus.DO_NOT_CONTACT) {
      await cancelFollowUpsForLead(lead.id, "DNC");
      cancelled++;
      continue;
    }

    // Eligibility Check 3: First message was actually delivered/sent (not UNKNOWN/failed)
    const initialSentMessage = await prisma.message.findFirst({
      where: {
        campaignId: campaign.id,
        leadId: lead.id,
        direction: MessageDirection.OUTBOUND,
        status: MessageStatus.SENT,
      },
      orderBy: { sentAt: "asc" },
    });
    if (!initialSentMessage) {
      // First outreach has not reached confirmed SENT status; cannot follow up yet
      deferred++;
      continue;
    }

    // Spacing Check: Max 1 follow-up per lead per 48 hours
    const recentSentFollowUp = await prisma.followUpMessage.findFirst({
      where: {
        leadId: lead.id,
        status: FollowUpStatus.SENT,
      },
      orderBy: { sentAt: "desc" },
    });
    if (
      recentSentFollowUp &&
      recentSentFollowUp.sentAt &&
      now.getTime() - recentSentFollowUp.sentAt.getTime() < 48 * 3600000
    ) {
      const earliestNextSend = new Date(recentSentFollowUp.sentAt.getTime() + 48 * 3600000);
      await prisma.followUpMessage.update({
        where: { id: item.id },
        data: { retryAt: earliestNextSend },
      });
      deferred++;
      continue;
    }

    // Resolve Body text (if needs edit, skip dispatch)
    if (!item.renderedBody) {
      await prisma.followUpMessage.update({
        where: { id: item.id },
        data: { status: FollowUpStatus.NEEDS_EDIT },
      });
      continue;
    }

    // Resolve Sender Account
    let sender: {
      id: string;
      status: string;
      pausedUntil: Date | null;
      connectionMethod?: string | null;
    } | null = null;
    if (item.senderAccountId) {
      sender = await prisma.instagramSenderAccount.findFirst({
        where: { id: item.senderAccountId },
        select: { id: true, status: true, pausedUntil: true, connectionMethod: true },
      });
    }

    if (!sender || sender.status !== "CONNECTED") {
      const connectedSenders = await findConnectedSendersForDispatch(campaign.userId);
      const chosen = chooseHealthySender(connectedSenders);
      if (chosen) {
        sender = {
          id: chosen.id,
          status: chosen.status,
          pausedUntil: chosen.pausedUntil,
          connectionMethod: chosen.connectionMethod,
        };
      }
    }

    if (!sender || (sender.pausedUntil && now.getTime() < sender.pausedUntil.getTime())) {
      // No sender available or paused; defer
      deferred++;
      continue;
    }

    // Send Gate Check (daily/hourly cap, warmup, working hours in lead timezone)
    const gateCheck = await canSendNow({
      senderAccountId: sender.id,
      leadId: lead.id,
      lead,
      campaignId: campaign.id,
      now,
    });

    if (!gateCheck.allowed) {
      if (
        gateCheck.reason === "OUTSIDE_WORKING_HOURS" ||
        gateCheck.reason === "DAILY_CAP_REACHED" ||
        gateCheck.reason === "SENDING_DISABLED"
      ) {
        await prisma.followUpMessage.update({
          where: { id: item.id },
          data: {
            retryAt: gateCheck.retryAt ?? new Date(now.getTime() + 3600000),
            errorMessage: `Deferred: ${gateCheck.reason}`,
          },
        });
      }
      deferred++;
      continue;
    }

    // Resolve Thread preservation
    const threadId =
      item.threadId ||
      initialSentMessage.providerMessageId ||
      initialSentMessage.unipileChatId ||
      undefined;

    // Send Outbound Follow-up Message
    try {
      const provider = options?.messagingProvider || getMessagingProvider(sender);

      const sendResult = await provider.sendMessage({
        senderAccountId: sender.id,
        profileUrl: lead.profileUrl || `https://instagram.com/${lead.username}`,
        message: item.renderedBody,
        chatId: threadId,
      });

      if (sendResult.success) {
        // Record send in gate & sender
        recordSenderAccountSent(sender.id, now.getTime());

        // Create Message row
        const createdMessage = await prisma.message.create({
          data: {
            campaignId: campaign.id,
            leadId: lead.id,
            senderAccountId: sender.id,
            status: MessageStatus.SENT,
            direction: MessageDirection.OUTBOUND,
            channel: MessageChannel.INSTAGRAM,
            messageText: item.renderedBody,
            providerMessageId: sendResult.providerMessageId || null,
            sentAt: now,
            idempotencyKey: item.idempotencyKey,
          },
        });

        // Update Follow-up record
        await prisma.followUpMessage.update({
          where: { id: item.id },
          data: {
            status: FollowUpStatus.SENT,
            sentAt: now,
            messageId: createdMessage.id,
            senderAccountId: sender.id,
            errorMessage: null,
            errorCode: null,
          },
        });

        // Update Lead last contacted
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            lastContactedAt: now,
          },
        });

        sent++;
      } else {
        const errorMsg = sendResult.error?.message || "Follow-up delivery failed";
        const errorCode = sendResult.error?.code || "";
        const isTimeout =
          errorCode === "SEND_TIMEOUT" ||
          errorCode === "TIMEOUT" ||
          errorCode === "UNKNOWN" ||
          /timed?\s*out/i.test(errorMsg);

        if (isTimeout) {
          // Timeout / unconfirmed delivery: status UNKNOWN, DO NOT auto-retry, DO NOT duplicate
          const createdMessage = await prisma.message.create({
            data: {
              campaignId: campaign.id,
              leadId: lead.id,
              senderAccountId: sender.id,
              status: MessageStatus.UNKNOWN,
              direction: MessageDirection.OUTBOUND,
              channel: MessageChannel.INSTAGRAM,
              messageText: item.renderedBody,
              sentAt: null,
              errorCode: "UNKNOWN",
              errorMessage: `Follow-up dispatch timed out: ${errorMsg}`,
              idempotencyKey: item.idempotencyKey,
            },
          });

          await prisma.followUpMessage.update({
            where: { id: item.id },
            data: {
              status: FollowUpStatus.SKIPPED,
              retryAt: null,
              messageId: createdMessage.id,
              errorCode: "UNKNOWN",
              errorMessage: "Delivery unconfirmed (timed out). No auto-retry to prevent duplicate sends.",
            },
          });
          continue;
        }

        const classified = classifyMessagingError(sendResult.error?.code || errorMsg);
        const isRateLimitOrCheckpoint =
          classified.isFatalPlatformRestriction ||
          classified.code === "RATE_LIMITED" ||
          classified.code === "PLATFORM_BLOCKED" ||
          classified.code === "CAPTCHA_REQUIRED" ||
          classified.code === "ACCOUNT_RESTRICTED" ||
          classified.code === "AUTH_REQUIRED";

        if (isRateLimitOrCheckpoint) {
          await updateSenderAccountRecord(sender.id, {
            status: "PAUSED",
            pausedUntil: new Date(now.getTime() + 45 * 60000),
            lastErrorCode: classified.code,
          });
        }

        await prisma.followUpMessage.update({
          where: { id: item.id },
          data: {
            retryAt: new Date(now.getTime() + 30 * 60000),
            errorCode: classified.code,
            errorMessage: classified.userFacingMessage,
          },
        });
        deferred++;
      }
    } catch (sendErr) {
      const errorMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      const isTimeout = /timed?\s*out/i.test(errorMsg);

      if (isTimeout) {
        const createdMessage = await prisma.message.create({
          data: {
            campaignId: campaign.id,
            leadId: lead.id,
            senderAccountId: sender?.id ?? null,
            status: MessageStatus.UNKNOWN,
            direction: MessageDirection.OUTBOUND,
            channel: MessageChannel.INSTAGRAM,
            messageText: item.renderedBody,
            sentAt: null,
            errorCode: "UNKNOWN",
            errorMessage: `Follow-up dispatch exception timed out: ${errorMsg}`,
            idempotencyKey: item.idempotencyKey,
          },
        });

        await prisma.followUpMessage.update({
          where: { id: item.id },
          data: {
            status: FollowUpStatus.SKIPPED,
            retryAt: null,
            messageId: createdMessage.id,
            errorCode: "UNKNOWN",
            errorMessage: "Delivery unconfirmed (exception timeout). No auto-retry to prevent duplicate sends.",
          },
        });
        continue;
      }

      const classified = classifyMessagingError(errorMsg, sendErr);
      const isRateLimitOrCheckpoint =
        classified.isFatalPlatformRestriction ||
        classified.code === "RATE_LIMITED" ||
        classified.code === "PLATFORM_BLOCKED" ||
        classified.code === "CAPTCHA_REQUIRED" ||
        classified.code === "ACCOUNT_RESTRICTED" ||
        classified.code === "AUTH_REQUIRED";

      if (isRateLimitOrCheckpoint) {
        await updateSenderAccountRecord(sender.id, {
          status: "PAUSED",
          pausedUntil: new Date(now.getTime() + 45 * 60000),
          lastErrorCode: classified.code,
        });
      }

      await prisma.followUpMessage.update({
        where: { id: item.id },
        data: {
          retryAt: new Date(now.getTime() + 30 * 60000),
          errorCode: classified.code,
          errorMessage: classified.userFacingMessage,
        },
      });
      deferred++;
    }
  }

  return { processed, sent, deferred, cancelled };
}

/**
 * Returns summary counts of follow-ups for a campaign.
 */
export async function getCampaignFollowUpSummary(campaignId: string): Promise<{
  scheduled: number;
  sent: number;
  cancelled: number;
  repliesAfterFollowUp: number;
  total: number;
}> {
  const prisma = getPrismaClient();

  const items = await prisma.followUpMessage.findMany({
    where: { campaignId },
    select: {
      id: true,
      leadId: true,
      status: true,
      sentAt: true,
    },
  });

  const scheduled = items.filter(
    (i) => i.status === FollowUpStatus.SCHEDULED || i.status === FollowUpStatus.NEEDS_EDIT,
  ).length;
  const sent = items.filter((i) => i.status === FollowUpStatus.SENT).length;
  const cancelled = items.filter(
    (i) =>
      i.status === FollowUpStatus.CANCELLED_REPLIED ||
      i.status === FollowUpStatus.CANCELLED_DNC ||
      i.status === FollowUpStatus.CANCELLED_MANUAL,
  ).length;

  const sentItems = items.filter((i) => i.status === FollowUpStatus.SENT && i.sentAt !== null);
  let repliesAfterFollowUp = 0;

  if (sentItems.length > 0) {
    const leadSentDates = new Map<string, Date>();
    for (const item of sentItems) {
      const existing = leadSentDates.get(item.leadId);
      if (!existing || (item.sentAt && item.sentAt < existing)) {
        leadSentDates.set(item.leadId, item.sentAt!);
      }
    }

    const replies = await prisma.message.findMany({
      where: {
        campaignId,
        leadId: { in: Array.from(leadSentDates.keys()) },
        direction: MessageDirection.INBOUND,
      },
      select: {
        leadId: true,
        receivedAt: true,
        createdAt: true,
      },
    });

    const repliedLeadIds = new Set<string>();
    for (const reply of replies) {
      const replyTime = reply.receivedAt || reply.createdAt;
      const sentTime = leadSentDates.get(reply.leadId);
      if (sentTime && replyTime >= sentTime) {
        repliedLeadIds.add(reply.leadId);
      }
    }
    repliesAfterFollowUp = repliedLeadIds.size;
  }

  return {
    scheduled,
    sent,
    cancelled,
    repliesAfterFollowUp,
    total: items.length,
  };
}

/**
 * Returns follow-up items for lead timeline view.
 */
export async function getLeadFollowUps(leadId: string) {
  const prisma = getPrismaClient();
  return prisma.followUpMessage.findMany({
    where: { leadId },
    orderBy: { step: "asc" },
    select: {
      id: true,
      step: true,
      status: true,
      templateText: true,
      renderedBody: true,
      dueAt: true,
      sentAt: true,
      retryAt: true,
      cancelReason: true,
      errorCode: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}
