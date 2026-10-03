import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  CampaignStatus,
  DncChannel,
  DraftKind,
  DraftStatus,
  MessageChannel,
  MessageDirection,
  MessageStatus,
} from "@/generated/prisma/enums";
import {
  BadRequestError,
  ConflictError,
  DncSuppressedError,
  NotFoundError,
  QualityBlockedError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkLeadSuppression } from "@/lib/services/compliance";
import { resolveSenderForDispatch } from "@/lib/services/senders/instagram-sender-service";
import { evaluateDraftDispatch } from "./draft-dispatch-guard";
import { classifyMessagingError, type ClassifiedErrorCode } from "./error-classifier";
import { activeDispatches, getMessagingProvider } from "./messaging-service";

export type SendApprovedReplyInput = {
  userId: string;
  draftId: string;
};

export type SendApprovedReplyResult =
  | {
      success: true;
      messageId: string;
      draftId: string;
      leadId: string;
      status: "SENT";
      sentAt: string;
    }
  | {
      success: false;
      messageId?: string;
      draftId: string;
      leadId: string;
      status: "FAILED" | "UNKNOWN";
      errorCode: ClassifiedErrorCode | string;
      error: string;
      isFatalPlatformRestriction?: boolean;
    };

/**
 * Dispatches an APPROVED reply draft into the recipient's existing chat thread.
 *
 * Reuses the existing dispatch/provider routing, draft integrity checks,
 * DNC suppression, and sender-health validation from the outreach pipeline.
 */
export async function sendApprovedReply(
  input: SendApprovedReplyInput,
): Promise<SendApprovedReplyResult> {
  const { userId, draftId } = input;
  const prisma = getPrismaClient();

  // 1. Load draft with lead, campaign, and relations
  const draft = await prisma.messageDraft.findUnique({
    where: { id: draftId },
    include: {
      lead: {
        include: {
          campaign: true,
          conversations: true,
        },
      },
      replyToMessage: true,
    },
  });

  if (!draft) {
    throw new NotFoundError("DRAFT_NOT_FOUND", `Draft "${draftId}" was not found.`);
  }

  // IDOR & ownership check
  const effectiveUserId = userId || draft.lead.campaign.userId;
  if (userId && draft.userId !== userId && draft.lead.campaign.userId !== userId) {
    throw new NotFoundError("DRAFT_NOT_FOUND", `Draft "${draftId}" was not found.`);
  }

  // Kind verification
  if (draft.kind !== DraftKind.REPLY) {
    throw new BadRequestError(
      "INVALID_DRAFT_KIND",
      "Only reply drafts can be dispatched via sendApprovedReply.",
    );
  }

  // Already sent check (draft status or existing outbound message)
  if (draft.status === DraftStatus.SENT) {
    throw new ConflictError("DRAFT_ALREADY_SENT", "This draft has already been sent.");
  }

  const alreadySentMessage = await prisma.message.findFirst({
    where: { draftId: draft.id, status: MessageStatus.SENT, direction: MessageDirection.OUTBOUND },
    select: { id: true },
  });
  if (alreadySentMessage) {
    throw new ConflictError("DRAFT_ALREADY_SENT", "This draft has already been sent.");
  }

  // Double-reply check: avoid sending duplicate replies to the same inbound message
  if (draft.replyToMessageId) {
    const existingReplySent = await prisma.message.findFirst({
      where: {
        direction: MessageDirection.OUTBOUND,
        status: MessageStatus.SENT,
        draft: {
          replyToMessageId: draft.replyToMessageId,
          id: { not: draft.id },
        },
      },
      select: { id: true },
    });
    if (existingReplySent) {
      throw new ConflictError(
        "ALREADY_RESPONDED",
        "An outbound reply has already been sent for this inbound message.",
      );
    }
  }

  // 2. Pause controls
  if (draft.lead.campaign.status === CampaignStatus.PAUSED) {
    throw new BadRequestError(
      "CAMPAIGN_PAUSED",
      "Campaign is currently paused. Resume the campaign before sending replies.",
    );
  }

  if (
    process.env.PAUSE_ALL_MESSAGING === "true" ||
    process.env.EMERGENCY_STOP === "true"
  ) {
    throw new BadRequestError(
      "SYSTEM_PAUSED",
      "Outbound messaging is globally paused by system emergency control.",
    );
  }

  // 3. Draft status must be APPROVED
  if (draft.status !== DraftStatus.APPROVED) {
    throw new BadRequestError(
      "DRAFT_NOT_APPROVED",
      `Draft "${draft.id}" is in status "${draft.status}". Only APPROVED drafts can be sent.`,
    );
  }

  // 4. In-flight dispatch lock (prevents double-clicks & concurrent dispatches to same lead)
  if (activeDispatches.has(draft.leadId)) {
    throw new ConflictError(
      "SEND_IN_PROGRESS",
      "A message is currently being dispatched to this lead. Please wait for it to complete.",
    );
  }

  // 5. Dispatch-time integrity recheck via evaluateDraftDispatch:
  // Re-verifies approvedBodyHash matches final body and re-runs deterministic BLOCKERS.
  // Quality gate blocker rules for kind=REPLY (ALREADY_CONTACTED, DUPLICATE_LEAD, etc.)
  // are exempted; fresh DNC / brand claims remain enforced.
  const dispatchDecision = await evaluateDraftDispatch(draft.id);
  if (dispatchDecision.action === "SKIP") {
    if (dispatchDecision.code === "DRAFT_CHANGED") {
      throw new ConflictError(
        "DRAFT_CHANGED",
        "Draft content does not match the approved body hash.",
      );
    }
    if (dispatchDecision.code === "QUALITY_BLOCKED_AT_SEND") {
      if (dispatchDecision.reasons.includes("DNC_SUPPRESSED")) {
        throw new DncSuppressedError("Recipient is on the Do Not Contact suppression list.");
      }
      throw new QualityBlockedError(dispatchDecision.reasons);
    }
    throw new BadRequestError("DRAFT_NOT_SENDABLE", `Draft dispatch skipped: ${dispatchDecision.code}`);
  }

  const finalMessageText = dispatchDecision.messageText;

  // 6. Fresh DNC suppression re-check (defense in depth)
  const suppression = await checkLeadSuppression({
    userId: effectiveUserId,
    lead: draft.lead,
    channel: DncChannel.INSTAGRAM,
  });
  if (suppression.suppressed) {
    throw new DncSuppressedError("Recipient is on the Do Not Contact suppression list.");
  }

  // 7. Resolve sender account
  // Precedence: inbound message sender account -> conversation sender account -> default connected sender
  const requestedSenderAccountId =
    draft.replyToMessage?.senderAccountId ||
    draft.lead.conversations[0]?.senderAccountId ||
    null;

  const senderResolution = await resolveSenderForDispatch(
    requestedSenderAccountId,
    effectiveUserId,
  );

  if (senderResolution.kind === "not_ready") {
    logger.warn("[REPLY_SEND] sender account not ready", {
      draftId: draft.id,
      leadId: draft.leadId,
      code: senderResolution.code,
      reason: senderResolution.reason,
    });
    throw new BadRequestError(senderResolution.code, senderResolution.reason);
  }

  const resolvedSender = senderResolution.kind === "ready" ? senderResolution.sender : null;
  const provider = getMessagingProvider(resolvedSender);

  // 8. Resolve Conversation and chat thread identifier
  let conversation =
    draft.lead.conversations.find((c) => c.channel === MessageChannel.INSTAGRAM) ||
    (draft.replyToMessage?.conversationId
      ? await prisma.conversation.findUnique({
          where: { id: draft.replyToMessage.conversationId },
        })
      : null);

  if (!conversation) {
    // If no conversation row exists yet, upsert one
    conversation = await prisma.conversation.upsert({
      where: {
        leadId_channel: {
          leadId: draft.leadId,
          channel: MessageChannel.INSTAGRAM,
        },
      },
      create: {
        userId: effectiveUserId,
        leadId: draft.leadId,
        campaignId: draft.campaignId,
        senderAccountId: resolvedSender?.id ?? null,
        channel: MessageChannel.INSTAGRAM,
        unipileChatId: draft.replyToMessage?.unipileChatId ?? null,
        externalThreadId: draft.replyToMessage?.unipileChatId ?? null,
        status: "OPEN",
        requiresHuman: false,
        unreadCount: 0,
        lastMessageAt: new Date(),
      },
      update: {
        ...(resolvedSender ? { senderAccountId: resolvedSender.id } : {}),
      },
    });
  }

  const threadId =
    conversation.unipileChatId ||
    draft.replyToMessage?.unipileChatId ||
    conversation.externalThreadId ||
    undefined;

  // 9. Dispatch via provider
  activeDispatches.add(draft.leadId);

  let dispatchResult: {
    success: boolean;
    provider?: string;
    providerMessageId?: string;
    error?: { code: string; message: string };
    isUncertain?: boolean;
  };

  logger.info("[REPLY_SEND] dispatching reply", {
    draftId: draft.id,
    leadId: draft.leadId,
    senderAccountId: resolvedSender?.id,
    provider: provider.name,
    hasThreadId: Boolean(threadId),
  });

  try {
    const rawResult = await provider.sendMessage({
      profileUrl: draft.lead.profileUrl,
      message: finalMessageText,
      senderAccountId: resolvedSender?.id,
      chatId: threadId,
    });

    const rawRecord = rawResult as Record<string, unknown>;
    const extractedMessageId =
      typeof rawRecord.providerMessageId === "string"
        ? rawRecord.providerMessageId
        : typeof rawRecord.messageId === "string"
        ? rawRecord.messageId
        : undefined;

    dispatchResult = {
      success: rawResult.success,
      provider: rawResult.provider,
      providerMessageId: extractedMessageId,
      error: rawResult.error,
      isUncertain: false,
    };
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    const upper = errorText.toUpperCase();
    const isUncertain =
      upper.includes("TIMEOUT AFTER SEND") ||
      upper.includes("DISCONNECTED AFTER SUBMIT") ||
      upper.includes("BROWSER CRASHED AFTER") ||
      upper.includes("UNKNOWN DELIVERY");

    dispatchResult = {
      success: false,
      provider: provider.name,
      error: {
        code: isUncertain ? "UNKNOWN" : "DISPATCH_EXCEPTION",
        message: errorText,
      },
      isUncertain,
    };
  } finally {
    activeDispatches.delete(draft.leadId);
  }

  // 10. Classify outcome
  let finalStatus: MessageStatus = MessageStatus.SENT;
  let classifiedCode: ClassifiedErrorCode = "UNKNOWN";
  let userFacingErrorMessage: string | null = null;
  let isFatalRestriction = false;

  if (dispatchResult.success) {
    finalStatus = MessageStatus.SENT;
  } else if (dispatchResult.isUncertain || dispatchResult.error?.code === "UNKNOWN") {
    finalStatus = MessageStatus.UNKNOWN;
    const classified = classifyMessagingError("UNKNOWN", dispatchResult.error?.message);
    classifiedCode = classified.code;
    userFacingErrorMessage = classified.userFacingMessage;
    isFatalRestriction = classified.isFatalPlatformRestriction;
  } else {
    finalStatus = MessageStatus.FAILED;
    const classified = classifyMessagingError(
      dispatchResult.error?.code,
      dispatchResult.error?.message,
    );
    classifiedCode = classified.code;
    userFacingErrorMessage = classified.userFacingMessage;
    isFatalRestriction = classified.isFatalPlatformRestriction;
  }

  const completedAt = new Date();

  // 11. Create OUTBOUND audit Message record
  const messageRecord = await prisma.message.create({
    data: {
      campaignId: draft.campaignId,
      leadId: draft.leadId,
      provider: provider.name,
      providerMessageId: dispatchResult.providerMessageId || null,
      unipileChatId: threadId || null,
      status: finalStatus,
      direction: MessageDirection.OUTBOUND,
      channel: MessageChannel.INSTAGRAM,
      messageText: finalMessageText,
      errorCode: finalStatus !== MessageStatus.SENT ? classifiedCode : null,
      errorMessage: userFacingErrorMessage,
      sentAt: finalStatus === MessageStatus.SENT ? completedAt : null,
      senderAccountId: resolvedSender?.id ?? null,
      draftId: draft.id,
      conversationId: conversation.id,
      aiGenerated: true,
      promptVersion: draft.promptVersion ?? null,
    },
  });

  // 12. On Success: finalize draft, conversation, and unactioned state
  if (finalStatus === MessageStatus.SENT) {
    // Mark draft SENT
    await prisma.messageDraft.update({
      where: { id: draft.id },
      data: { status: DraftStatus.SENT },
    });

    // Determine if any other pending items remain on this lead's conversation
    const otherPendingDrafts = await prisma.messageDraft.count({
      where: {
        leadId: draft.leadId,
        kind: DraftKind.REPLY,
        status: { in: [DraftStatus.PENDING_REVIEW, DraftStatus.APPROVED] },
        id: { not: draft.id },
      },
    });

    const otherUnactionedInbound = await prisma.message.count({
      where: {
        leadId: draft.leadId,
        direction: MessageDirection.INBOUND,
        requiresHuman: true,
        id: { not: draft.replyToMessageId ?? "" },
      },
    });

    const shouldClearRequiresHuman =
      otherPendingDrafts === 0 && otherUnactionedInbound === 0;

    // Update conversation
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: completedAt,
        unreadCount: 0,
        ...(shouldClearRequiresHuman ? { requiresHuman: false } : {}),
      },
    });

    // Mark the inbound message as resolved/actioned
    if (draft.replyToMessageId) {
      await prisma.message.update({
        where: { id: draft.replyToMessageId },
        data: { requiresHuman: false },
      }).catch(() => undefined);
    }

    logger.info("[REPLY_SEND] reply dispatched successfully", {
      draftId: draft.id,
      leadId: draft.leadId,
      messageId: messageRecord.id,
      senderAccountId: resolvedSender?.id,
    });

    return {
      success: true,
      messageId: messageRecord.id,
      draftId: draft.id,
      leadId: draft.leadId,
      status: "SENT",
      sentAt: completedAt.toISOString(),
    };
  }

  // 13. On Failure: draft stays APPROVED for manual resolution/retry; return failure result
  logger.warn("[REPLY_SEND] reply dispatch failed", {
    draftId: draft.id,
    leadId: draft.leadId,
    messageId: messageRecord.id,
    status: finalStatus,
    code: classifiedCode,
    error: userFacingErrorMessage,
  });

  return {
    success: false,
    messageId: messageRecord.id,
    draftId: draft.id,
    leadId: draft.leadId,
    status: finalStatus === MessageStatus.UNKNOWN ? "UNKNOWN" : "FAILED",
    errorCode: classifiedCode,
    error: userFacingErrorMessage || "Reply dispatch failed.",
    isFatalPlatformRestriction: isFatalRestriction,
  };
}
