import "server-only";

import { createHash } from "node:crypto";
import { getPrismaClient } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { getServerEnv } from "@/lib/env";
import {
  MessageDirection,
  MessageChannel,
  MessageStatus,
  LeadStatus,
  InstagramSenderStatus,
  UnipileWebhookStatus,
} from "@/generated/prisma/enums";
import { transitionLeadStatus } from "../lead/lead-status-service";
import {
  classifyReply,
  applyIntentToLeadStatus,
  generateReplyDraft,
  REPLY_WORTHY_INTENTS,
} from "../ai";
import {
  notifyLeadReplied,
  notifySenderStatusChange,
} from "../notifications/notification-triggers";

/**
 * Global hook emitted whenever an inbound message is successfully processed
 * for a lead and the lead is at or transitions to REPLIED status.
 *
 * Runs intent classification -> lead status progression -> suggested reply draft.
 * Each stage is isolated so errors in one stage never block the others or the webhook.
 */
export async function onLeadReplied(leadId: string, messageId: string): Promise<void> {
  logger.info("[LEAD_REPLIED] hook emitted", {
    leadId,
    messageId,
  });

  // 1. Classify reply intent
  let classification = null;
  try {
    classification = await classifyReply({ leadId, messageId });
  } catch (err) {
    logger.warn("[LEAD_REPLIED] classification failed in hook", {
      leadId,
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Advance lead status if classification succeeded
  if (classification && classification.intent) {
    try {
      await applyIntentToLeadStatus({
        leadId,
        intent: classification.intent,
        interestLevel: classification.interestLevel,
        actor: "system:reply_classifier",
      });
    } catch (err) {
      logger.warn("[LEAD_REPLIED] lead status update failed in hook", {
        leadId,
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Conditionally generate suggested reply draft for reply-worthy intents
  if (classification && classification.intent && REPLY_WORTHY_INTENTS.has(classification.intent)) {
    try {
      await generateReplyDraft({ leadId, messageId });
    } catch (err) {
      logger.warn("[LEAD_REPLIED] reply draft generation failed in hook", {
        leadId,
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Send push notification to user
  try {
    await notifyLeadReplied({ leadId, messageId });
  } catch (err) {
    logger.warn("[LEAD_REPLIED] notification trigger failed in hook", {
      leadId,
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Validates the webhook path secret against UNIPILE_WEBHOOK_PATH_SECRET.
 * If unset or mismatched, returns false (caller will return generic 404).
 */
export function verifyWebhookSecret(providedSecret: string): boolean {
  const expectedSecret = getServerEnv("UNIPILE_WEBHOOK_PATH_SECRET");
  if (!expectedSecret || !expectedSecret.trim()) {
    return false;
  }
  return providedSecret.trim() === expectedSecret.trim();
}

function computePayloadHash(payload: unknown): string {
  try {
    return createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex");
  } catch {
    return createHash("sha256").update(String(payload ?? "")).digest("hex");
  }
}

/**
 * Maps raw Unipile status strings to InstagramSenderStatus enum values.
 */
function mapUnipileStatus(rawStatus?: string | null): InstagramSenderStatus {
  if (!rawStatus) return InstagramSenderStatus.CONNECTED;
  const s = rawStatus.toUpperCase().trim();
  switch (s) {
    case "OK":
    case "CONNECTED":
    case "ACTIVE":
    case "VALID":
      return InstagramSenderStatus.CONNECTED;
    case "CREDENTIALS":
    case "CHECKPOINT":
    case "AUTH_REQUIRED":
    case "RECONNECT_NEEDED":
      return InstagramSenderStatus.AUTH_REQUIRED;
    case "EXPIRED":
      return InstagramSenderStatus.EXPIRED;
    case "STOPPED":
    case "DISABLED":
    case "DISCONNECTED":
      return InstagramSenderStatus.DISCONNECTED;
    case "ERROR":
    case "FAILED":
      return InstagramSenderStatus.ERROR;
    default:
      return InstagramSenderStatus.CONNECTED;
  }
}

export type WebhookResponse = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * Ingests an account-status webhook event from Unipile.
 */
export async function handleAccountStatusWebhook(
  payload: unknown,
  eventIdHeader?: string | null,
): Promise<WebhookResponse> {
  const prisma = getPrismaClient();
  const rawHash = computePayloadHash(payload);

  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const accountStatusObj = (
    body.AccountStatus && typeof body.AccountStatus === "object" ? body.AccountStatus : null
  ) as Record<string, unknown> | null;

  const accountId = (
    (typeof body.account_id === "string" ? body.account_id : null) ||
    (typeof body.accountId === "string" ? body.accountId : null) ||
    (accountStatusObj && typeof accountStatusObj.account_id === "string"
      ? accountStatusObj.account_id
      : null) ||
    (typeof body.id === "string" ? body.id : null)
  )?.trim();

  const statusRaw = (
    (typeof body.status === "string" ? body.status : null) ||
    (accountStatusObj && typeof accountStatusObj.message === "string"
      ? accountStatusObj.message
      : null) ||
    (typeof body.message === "string" ? body.message : null)
  )?.trim();

  const unipileEventId = (
    eventIdHeader?.trim() ||
    (typeof body.event_id === "string" ? body.event_id.trim() : null) ||
    (typeof body.id === "string" && body.id.startsWith("evt_") ? body.id.trim() : null)
  );

  // 1. De-dup via UnipileWebhookEvent
  const existingEvent = unipileEventId
    ? await prisma.unipileWebhookEvent.findUnique({ where: { unipileEventId } })
    : await prisma.unipileWebhookEvent.findFirst({
        where: { rawPayloadHash: rawHash, eventType: "account_status" },
      });

  if (existingEvent && existingEvent.status === UnipileWebhookStatus.PROCESSED) {
    logger.info("[WEBHOOK] duplicate account_status event skipped", {
      unipileEventId: existingEvent.unipileEventId,
      status: existingEvent.status,
    });
    return { status: 200, body: { ok: true, received: true, deduplicated: true, status: "IGNORED" } };
  }

  const webhookEvent =
    existingEvent ??
    (await prisma.unipileWebhookEvent.create({
      data: {
        eventType: "account_status",
        unipileEventId: unipileEventId || null,
        rawPayloadHash: rawHash,
        status: UnipileWebhookStatus.RECEIVED,
      },
    }));

  if (!accountId) {
    await prisma.unipileWebhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: UnipileWebhookStatus.IGNORED,
        failReason: "Missing account_id in payload",
        processedAt: new Date(),
      },
    });
    return { status: 200, body: { received: true, ignored: true, reason: "missing_account_id" } };
  }

  // 2. Find matching InstagramSenderAccount
  let sender = await prisma.instagramSenderAccount.findUnique({
    where: { unipileAccountId: accountId },
  });
  if (!sender) {
    sender = await prisma.instagramSenderAccount.findFirst({
      where: {
        sessionPath: `unipile:${accountId}`,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  if (!sender) {
    logger.warn("[WEBHOOK] no sender account found for unipileAccountId", {
      unipileAccountId: accountId,
    });
    await prisma.unipileWebhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: UnipileWebhookStatus.IGNORED,
        failReason: `No sender account matching accountId "${accountId}"`,
        processedAt: new Date(),
      },
    });
    return { status: 200, body: { received: true, ignored: true, reason: "sender_not_found" } };
  }

  // 3. Update sender account status
  const targetStatus = mapUnipileStatus(statusRaw);
  await prisma.instagramSenderAccount.update({
    where: { id: sender.id },
    data: {
      status: targetStatus,
      connectionMethod: "UNIPILE",
      ...(sender.unipileAccountId ? {} : { unipileAccountId: accountId }),
      sessionPath: `unipile:${accountId}`,
      lastVerifiedAt: targetStatus === InstagramSenderStatus.CONNECTED ? new Date() : undefined,
      lastError: targetStatus === InstagramSenderStatus.CONNECTED ? null : (statusRaw || null),
    },
  });

  if (sender.userId && sender.status !== targetStatus) {
    await notifySenderStatusChange({
      userId: sender.userId,
      senderUsername: sender.username,
      previousStatus: sender.status,
      newStatus: targetStatus,
      errorMessage: statusRaw || null,
    }).catch(() => undefined);
  }

  await prisma.unipileWebhookEvent.update({
    where: { id: webhookEvent.id },
    data: {
      status: UnipileWebhookStatus.PROCESSED,
      processedAt: new Date(),
    },
  });

  logger.info("[WEBHOOK] account_status applied", {
    senderAccountId: sender.id,
    newStatus: targetStatus,
  });

  return {
    status: 200,
    body: {
      ok: true,
      received: true,
      success: true,
      status: "PROCESSED",
      senderStatus: targetStatus,
    },
  };
}

/**
 * Ingests an inbound new-message webhook event from Unipile.
 */
export async function handleInboundMessageWebhook(
  payload: unknown,
  eventIdHeader?: string | null,
): Promise<WebhookResponse> {
  const prisma = getPrismaClient();
  const rawHash = computePayloadHash(payload);

  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const senderObj = (
    body.sender && typeof body.sender === "object" ? body.sender : null
  ) as Record<string, unknown> | null;

  const accountId = (
    (typeof body.account_id === "string" ? body.account_id : null) ||
    (typeof body.accountId === "string" ? body.accountId : null)
  )?.trim();

  const chatId = (
    (typeof body.chat_id === "string" ? body.chat_id : null) ||
    (typeof body.chatId === "string" ? body.chatId : null)
  )?.trim();

  const messageId = (
    (typeof body.message_id === "string" ? body.message_id : null) ||
    (typeof body.messageId === "string" ? body.messageId : null) ||
    (typeof body.id === "string" ? body.id : null)
  )?.trim();

  const rawMessageText = (
    (typeof body.message === "string" ? body.message : null) ||
    (typeof body.text === "string" ? body.text : null) ||
    (typeof body.content === "string" ? body.content : "")
  );

  const providerSenderId = (
    (typeof body.sender_id === "string" ? body.sender_id : null) ||
    (typeof body.senderId === "string" ? body.senderId : null) ||
    (senderObj && typeof senderObj.attendee_provider_id === "string"
      ? senderObj.attendee_provider_id
      : null) ||
    (senderObj && typeof senderObj.provider_id === "string" ? senderObj.provider_id : null) ||
    (senderObj && typeof senderObj.id === "string" ? senderObj.id : null)
  )?.trim();

  const senderUsername = (
    (typeof body.sender_name === "string" ? body.sender_name : null) ||
    (typeof body.sender_username === "string" ? body.sender_username : null) ||
    (typeof body.username === "string" ? body.username : null) ||
    (senderObj && typeof senderObj.attendee_name === "string" ? senderObj.attendee_name : null) ||
    (senderObj && typeof senderObj.username === "string" ? senderObj.username : null) ||
    (senderObj && typeof senderObj.name === "string" ? senderObj.name : null)
  )?.trim();

  const timestampIso = (
    (typeof body.timestamp === "string" ? body.timestamp : null) ||
    (typeof body.created_at === "string" ? body.created_at : null) ||
    new Date().toISOString()
  );
  const receivedAtDate = new Date(timestampIso);
  const validReceivedAt = isNaN(receivedAtDate.getTime()) ? new Date() : receivedAtDate;

  const unipileEventId = (
    eventIdHeader?.trim() ||
    (typeof body.event_id === "string" ? body.event_id.trim() : null)
  );

  // 1. De-dup check on existing Message row
  if (messageId) {
    const existingMessage = await prisma.message.findUnique({
      where: { unipileMessageId: messageId },
      select: { id: true, leadId: true },
    });
    if (existingMessage) {
      logger.info("[WEBHOOK] duplicate inbound message skipped", {
        messageId: existingMessage.id,
        leadId: existingMessage.leadId,
      });
      return {
        status: 200,
        body: { ok: true, received: true, deduplicated: true, duplicate: true, status: "IGNORED" },
      };
    }
  }

  // 2. De-dup check on UnipileWebhookEvent
  const existingEvent = unipileEventId
    ? await prisma.unipileWebhookEvent.findUnique({ where: { unipileEventId } })
    : await prisma.unipileWebhookEvent.findFirst({
        where: { rawPayloadHash: rawHash, eventType: "new_message" },
      });

  if (existingEvent && existingEvent.status === UnipileWebhookStatus.PROCESSED) {
    return { status: 200, body: { received: true, deduplicated: true } };
  }

  const webhookEvent =
    existingEvent ??
    (await prisma.unipileWebhookEvent.create({
      data: {
        eventType: "new_message",
        unipileEventId: unipileEventId || null,
        rawPayloadHash: rawHash,
        status: UnipileWebhookStatus.RECEIVED,
      },
    }));

  // 3. Find connected InstagramSenderAccount
  const senderAccount = accountId
    ? (await prisma.instagramSenderAccount.findUnique({
        where: { unipileAccountId: accountId },
      })) ||
      (await prisma.instagramSenderAccount.findFirst({
        where: { sessionPath: `unipile:${accountId}` },
        orderBy: { createdAt: "desc" },
      }))
    : null;

  // 4. Outbound Echo Detection: ignore our own messages
  if (senderAccount) {
    const cleanSenderUser = senderUsername?.replace(/^@/, "").toLowerCase();
    const cleanAccountUser = senderAccount.username.replace(/^@/, "").toLowerCase();
    const isOwnUsername = cleanSenderUser && cleanSenderUser === cleanAccountUser;
    const isOwnProviderId =
      providerSenderId &&
      (providerSenderId === senderAccount.unipileAccountId ||
        providerSenderId === senderAccount.id ||
        providerSenderId === accountId);

    if (isOwnUsername || isOwnProviderId) {
      logger.info("[WEBHOOK] outbound echo ignored (matches sender account)", {
        senderAccountId: senderAccount.id,
      });
      await prisma.unipileWebhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: UnipileWebhookStatus.IGNORED,
          failReason: "Outbound message echo from sender account",
          processedAt: new Date(),
        },
      });
      return {
        status: 200,
        body: { ok: true, received: true, ignored: true, reason: "OUTBOUND_ECHO", status: "IGNORED" },
      };
    }

    if (messageId) {
      const outboundMatch = await prisma.message.findFirst({
        where: {
          providerMessageId: messageId,
          direction: MessageDirection.OUTBOUND,
        },
        select: { id: true },
      });
      if (outboundMatch) {
        logger.info("[WEBHOOK] outbound echo ignored (matches sent message providerId)", {
          messageId: outboundMatch.id,
        });
        await prisma.unipileWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: {
            status: UnipileWebhookStatus.IGNORED,
            failReason: "Outbound message echo matching providerMessageId",
            processedAt: new Date(),
          },
        });
        return {
          status: 200,
          body: { ok: true, received: true, ignored: true, reason: "OUTBOUND_ECHO", status: "IGNORED" },
        };
      }
    }
  }

  // 5. Match to a Lead
  const cleanUsername = senderUsername?.replace(/^@/, "").trim().toLowerCase();
  let matchedLead = null;

  if (providerSenderId || cleanUsername) {
    matchedLead = await prisma.lead.findFirst({
      where: {
        ...(senderAccount ? { campaign: { userId: senderAccount.userId } } : {}),
        OR: [
          ...(providerSenderId ? [{ instagramUserId: providerSenderId }] : []),
          ...(cleanUsername ? [{ usernameNormalized: cleanUsername }] : []),
          ...(cleanUsername
            ? [{ username: { equals: cleanUsername, mode: "insensitive" as const } }]
            : []),
        ],
      },
      include: {
        campaign: { select: { userId: true } },
      },
    });
  }

  // 6. If no match -> persist to UnmatchedInboundMessage
  if (!matchedLead) {
    logger.warn("[WEBHOOK] inbound message has no matching lead, saving to unmatched", {
      hasSenderAccount: Boolean(senderAccount),
    });

    const unmatched = await prisma.unmatchedInboundMessage.create({
      data: {
        unipileAccountId: accountId || "unknown",
        unipileMessageId: messageId || null,
        unipileChatId: chatId || null,
        providerSenderId: providerSenderId || "unknown",
        username: cleanUsername || null,
        text: rawMessageText,
        receivedAt: validReceivedAt,
      },
    });

    await prisma.unipileWebhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: UnipileWebhookStatus.PROCESSED,
        processedAt: new Date(),
      },
    });

    return {
      status: 200,
      body: {
        ok: true,
        received: true,
        unmatched: true,
        unmatchedId: unmatched.id,
        unmatchedMessageId: unmatched.id,
        status: "PROCESSED",
      },
    };
  }

  // 7. Match found -> Ingestion Flow
  const effectiveUserId = senderAccount?.userId || matchedLead.campaign.userId;
  if (!effectiveUserId) {
    throw new Error(`Cannot ingest inbound message without resolved userId for lead "${matchedLead.id}".`);
  }

  // 7a. Upsert Conversation
  const conversation = await prisma.conversation.upsert({
    where: {
      leadId_channel: {
        leadId: matchedLead.id,
        channel: MessageChannel.INSTAGRAM,
      },
    },
    create: {
      userId: effectiveUserId,
      leadId: matchedLead.id,
      campaignId: matchedLead.campaignId,
      senderAccountId: senderAccount?.id ?? null,
      channel: MessageChannel.INSTAGRAM,
      unipileChatId: chatId || null,
      externalThreadId: chatId || null,
      status: "OPEN",
      requiresHuman: true,
      unreadCount: 1,
      lastMessageAt: validReceivedAt,
      lastInboundAt: validReceivedAt,
    },
    update: {
      unipileChatId: chatId || undefined,
      externalThreadId: chatId || undefined,
      status: "OPEN",
      requiresHuman: true,
      unreadCount: { increment: 1 },
      lastMessageAt: validReceivedAt,
      lastInboundAt: validReceivedAt,
      ...(senderAccount ? { senderAccountId: senderAccount.id } : {}),
    },
  });

  // 7b. Create INBOUND Message row
  const messageRecord = await prisma.message.create({
    data: {
      campaignId: matchedLead.campaignId,
      leadId: matchedLead.id,
      provider: "unipile",
      providerMessageId: messageId || null,
      unipileMessageId: messageId || null,
      unipileChatId: chatId || null,
      status: MessageStatus.SENT,
      direction: MessageDirection.INBOUND,
      channel: MessageChannel.INSTAGRAM,
      messageText: rawMessageText,
      conversationId: conversation.id,
      senderAccountId: senderAccount?.id ?? null,
      receivedAt: validReceivedAt,
      requiresHuman: true,
    },
  });

  // 7c. Transition lead status if eligible
  // Do NOT regress statuses that are already at or past REPLIED.
  // Do NOT change status if lead is in DO_NOT_CONTACT (still record the message).
  const postRepliedStatuses: LeadStatus[] = [
    LeadStatus.REPLIED,
    LeadStatus.INTERESTED,
    LeadStatus.FOLLOW_UP,
    LeadStatus.MEETING,
    LeadStatus.CONVERTED,
    LeadStatus.NOT_INTERESTED,
  ];

  let transitionFired = false;
  if (
    matchedLead.status !== LeadStatus.DO_NOT_CONTACT &&
    !postRepliedStatuses.includes(matchedLead.status)
  ) {
    try {
      await transitionLeadStatus({
        leadId: matchedLead.id,
        to: LeadStatus.REPLIED,
        reason: "Inbound message received via Unipile",
        actor: "unipile_webhook",
      });
      transitionFired = true;
    } catch (err) {
      logger.warn("[WEBHOOK] lead status transition to REPLIED failed", {
        leadId: matchedLead.id,
        currentStatus: matchedLead.status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 7d. Fire onLeadReplied hook
  if (transitionFired || postRepliedStatuses.includes(matchedLead.status)) {
    await onLeadReplied(matchedLead.id, messageRecord.id);
  }

  // 7e. Mark webhook event processed
  await prisma.unipileWebhookEvent.update({
    where: { id: webhookEvent.id },
    data: {
      status: UnipileWebhookStatus.PROCESSED,
      processedAt: new Date(),
    },
  });

  logger.info("[WEBHOOK] inbound message successfully ingested", {
    leadId: matchedLead.id,
    messageId: messageRecord.id,
    transitioned: transitionFired,
  });

  return {
    status: 200,
    body: {
      ok: true,
      received: true,
      success: true,
      messageId: messageRecord.id,
      leadId: matchedLead.id,
      matchedLeadId: matchedLead.id,
      transitioned: transitionFired,
      leadTransitioned: transitionFired,
      status: "PROCESSED",
    },
  };
}
