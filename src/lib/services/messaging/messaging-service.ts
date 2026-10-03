import { getPrismaClient } from "@/lib/db/prisma";
import { MessageStatus, LeadStatus, DraftStatus } from "@/generated/prisma/enums";
import { BadRequestError, NotFoundError, ConflictError, DncSuppressedError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkLeadSuppression, DncChannel } from "@/lib/services/compliance";
import { validateTemplateVariables } from "@/lib/services/template/template-renderer";
import { resolveSenderForDispatch } from "@/lib/services/senders/instagram-sender-service";
import { transitionLeadStatus } from "@/lib/services/lead/lead-status-service";
import type { MessagingProvider, MessagingProviderStatus } from "./messaging-provider";
import { PlaywrightMessagingProvider } from "./playwright-provider";
import { UnipileMessagingProvider } from "./unipile-provider";
import { getServerEnv } from "@/lib/env";
import {
  classifyMessagingError,
  type ClassifiedErrorCode,
} from "./error-classifier";
import {
  calculateContentFingerprint,
  formatScopedIdempotencyKey,
  findIdempotentAttempt,
  findRecentDuplicateAttempt,
} from "./idempotency";

const MAX_MESSAGE_LENGTH = 1000;

// Centralized provider instance & mock override
let providerInstance: MessagingProvider | null = null;

export function getMessagingProvider(
  sender?: { connectionMethod?: string | null } | null,
): MessagingProvider {
  if (providerInstance) {
    return providerInstance;
  }
  if (sender?.connectionMethod === "UNIPILE") {
    return new UnipileMessagingProvider();
  }
  if (sender?.connectionMethod === "PLAYWRIGHT") {
    return new PlaywrightMessagingProvider();
  }
  const providerName = getServerEnv("MESSAGING_PROVIDER")?.toLowerCase();
  if (providerName === "unipile") {
    return new UnipileMessagingProvider();
  }
  return new PlaywrightMessagingProvider();
}

export function setMessagingProvider(customProvider: MessagingProvider | null): void {
  providerInstance = customProvider;
}

// In-flight dispatch set to prevent concurrent duplicate sends to the same lead
export const activeDispatches = new Set<string>();

export type SingleMessageSendResult =
  | {
      success: true;
      messageId: string;
      leadId: string;
      status: "SENT";
      sentAt: string;
      attemptNumber?: number;
    }
  | {
      success: false;
      messageId?: string;
      leadId: string;
      status: "FAILED" | "UNKNOWN";
      errorCode: ClassifiedErrorCode | string;
      error: string;
      isFatalPlatformRestriction?: boolean;
      attemptNumber?: number;
    };

export type SendTestMessageResult = {
  success: boolean;
  messageId: string;
  status: "SENT" | "FAILED" | "UNKNOWN";
  error?: {
    code: string;
    message: string;
  };
};

export async function sendSingleMessage(
  input: unknown,
  userId?: string,
): Promise<SingleMessageSendResult> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }

  const record = input as Record<string, unknown>;

  // 1. Validate leadId
  if (!record.leadId || typeof record.leadId !== "string" || !record.leadId.trim()) {
    throw new BadRequestError("MISSING_LEAD_ID", '"leadId" is required.');
  }
  const leadId = record.leadId.trim();

  // 2. Validate message text
  if (!record.message || typeof record.message !== "string") {
    throw new BadRequestError("MISSING_MESSAGE", '"message" is required.');
  }
  const messageText = record.message.trim();
  if (messageText.length === 0) {
    throw new BadRequestError("EMPTY_MESSAGE", '"message" cannot be empty.');
  }
  if (messageText.length > MAX_MESSAGE_LENGTH) {
    throw new BadRequestError(
      "MESSAGE_TOO_LONG",
      `"message" cannot exceed ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }

  // 3. Validate template variables (no unsupported variables allowed)
  const varCheck = validateTemplateVariables(messageText);
  if (!varCheck.valid) {
    throw new BadRequestError(
      "UNSUPPORTED_VARIABLES",
      `Message contains unsupported template variable(s): {{${varCheck.unsupported.join("}}, {{")}}}.`,
    );
  }

  // 4. Validate campaignId if supplied in request
  let optionalCampaignId: string | null = null;
  if (record.campaignId !== undefined && record.campaignId !== null) {
    if (typeof record.campaignId !== "string" || !record.campaignId.trim()) {
      throw new BadRequestError("INVALID_CAMPAIGN_ID", '"campaignId" must be a non-empty string if provided.');
    }
    optionalCampaignId = record.campaignId.trim();
  }

  // Extract optional idempotency key, requestId, jobId, itemId
  const rawIdempotencyKey =
    typeof record.idempotencyKey === "string" && record.idempotencyKey.trim()
      ? record.idempotencyKey.trim()
      : typeof record.requestId === "string" && record.requestId.trim()
      ? record.requestId.trim()
      : undefined;

  const optionalJobId =
    typeof record.jobId === "string" && record.jobId.trim()
      ? record.jobId.trim()
      : undefined;

  const optionalItemId =
    typeof record.itemId === "string" && record.itemId.trim()
      ? record.itemId.trim()
      : undefined;

  const explicitAttemptNumber =
    typeof record.attemptNumber === "number" && record.attemptNumber > 0
      ? record.attemptNumber
      : undefined;

  // Step 6: optional draft linkage. When present, the Message is linked to the
  // draft, marked aiGenerated, and the draft moves to SENT on success.
  const optionalDraftId =
    typeof record.draftId === "string" && record.draftId.trim().length > 0
      ? record.draftId.trim()
      : undefined;
  const aiGenerated = record.aiGenerated === true;
  const promptVersion =
    typeof record.promptVersion === "string" && record.promptVersion.trim().length > 0
      ? record.promptVersion.trim()
      : undefined;

  // 5. In-flight concurrency guard (prevent double-clicks & simultaneous sends)
  if (activeDispatches.has(leadId)) {
    throw new ConflictError(
      "SEND_IN_PROGRESS",
      "A message is currently being dispatched to this lead. Please wait for it to complete.",
    );
  }

  const prisma = getPrismaClient();

  // 6. Load lead and verify ownership / IDOR protection
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      campaign: {
        select: {
          id: true,
          userId: true,
        },
      },
    },
  });

  if (!lead) {
    throw new NotFoundError("LEAD_NOT_FOUND", `Lead with ID "${leadId}" was not found.`);
  }

  // Verify campaign belongs to the authenticated user
  const effectiveUserId = userId || lead.campaign.userId;
  if (userId && lead.campaign.userId !== userId) {
    throw new NotFoundError("LEAD_NOT_FOUND", `Lead with ID "${leadId}" was not found.`);
  }

  // If campaignId was specified in request, ensure it strictly matches lead.campaignId
  if (optionalCampaignId && lead.campaignId !== optionalCampaignId) {
    throw new BadRequestError(
      "CAMPAIGN_MISMATCH",
      `Lead "${leadId}" does not belong to campaign "${optionalCampaignId}".`,
    );
  }

  // Step 4 dedup: a duplicate-linked lead must never be messaged directly.
  if (lead.duplicateOfLeadId) {
    throw new BadRequestError(
      "DUPLICATE_LEAD",
      "This lead is a duplicate of another lead; message the canonical lead instead.",
    );
  }

  // 6a. Do Not Contact (DNC) suppression check - defense in depth across all single send paths
  const suppression = await checkLeadSuppression({
    userId: effectiveUserId,
    lead,
    channel: DncChannel.INSTAGRAM,
  });
  if (suppression.suppressed) {
    throw new DncSuppressedError(
      "Recipient is on the Do Not Contact suppression list.",
    );
  }

  // 6c. Step 6: a draft may be sent at most once (checked before other guards so
  // a double-click reports DRAFT_ALREADY_SENT rather than a generic duplicate).
  if (optionalDraftId) {
    const alreadySentDraft = await prisma.message.findFirst({
      where: { draftId: optionalDraftId, status: MessageStatus.SENT, direction: "OUTBOUND" },
      select: { id: true },
    });
    if (alreadySentDraft) {
      throw new ConflictError("DRAFT_ALREADY_SENT", "This draft has already been sent.");
    }
  }

  // 6b. Resolve the authoritative Instagram sender account. The client-provided
  // id is never trusted: it must belong to the authenticated user.
  const requestedSenderAccountId =
    typeof record.senderAccountId === "string" &&
    record.senderAccountId.trim().length > 0
      ? record.senderAccountId.trim()
      : null;

  const senderResolution = await resolveSenderForDispatch(
    requestedSenderAccountId,
    effectiveUserId,
  );
  const resolvedSender =
    senderResolution.kind === "ready" ? senderResolution.sender : null;
  const senderAccountId =
    resolvedSender ? resolvedSender.id : null;
  const senderPreDispatchFailure =
    senderResolution.kind === "not_ready"
      ? { code: senderResolution.code, message: senderResolution.reason }
      : null;

  if (senderResolution.kind === "not_ready") {
    logger.warn("[SENDER] session unavailable", {
      campaignId: lead.campaignId,
      leadId: lead.id,
      senderAccountId: senderResolution.sender?.id ?? null,
      code: senderResolution.code,
    });
  }

  // 7. Calculate content fingerprint
  const contentHash = calculateContentFingerprint(lead.campaignId, lead.id, messageText);

  // 8. Server-side Idempotency Check
  const scopedIdempotencyKey = formatScopedIdempotencyKey(
    rawIdempotencyKey,
    lead.campaignId,
    lead.id
  );

  if (rawIdempotencyKey) {
    const existingAttempt = await findIdempotentAttempt(scopedIdempotencyKey);
    if (existingAttempt) {
      if (existingAttempt.status === MessageStatus.SENT) {
        return {
          success: true,
          messageId: existingAttempt.messageId || existingAttempt.id,
          leadId: lead.id,
          status: "SENT",
          sentAt: (existingAttempt.completedAt || existingAttempt.createdAt).toISOString(),
          attemptNumber: existingAttempt.attemptNumber,
        };
      }
      if (existingAttempt.status === MessageStatus.SENDING) {
        throw new ConflictError(
          "SEND_IN_PROGRESS",
          "A message dispatch with this idempotency key is already in progress.",
        );
      }
      return {
        success: false,
        messageId: existingAttempt.messageId || existingAttempt.id,
        leadId: lead.id,
        status: existingAttempt.status === MessageStatus.UNKNOWN ? "UNKNOWN" : "FAILED",
        errorCode: existingAttempt.errorCode || "IDEMPOTENT_RECORD",
        error: existingAttempt.errorMessage || "Message already processed for this request.",
        attemptNumber: existingAttempt.attemptNumber,
      };
    }
  }

  // 9. Rapid Duplicate Send Guard (cooldown of 15 seconds for identical message to same lead)
  const recentDuplicate = await findRecentDuplicateAttempt(lead.id, contentHash, 15);
  if (recentDuplicate) {
    throw new ConflictError(
      "DUPLICATE_MESSAGE_DETECTED",
      "An identical message was recently dispatched to this lead. Please wait before retrying.",
    );
  }

  // 10. Resolve recipient strictly from trusted DB record
  if (!lead.profileUrl || !lead.profileUrl.trim()) {
    throw new BadRequestError(
      "MISSING_PROFILE_URL",
      `Lead @${lead.username} does not have a valid Instagram profile URL.`,
    );
  }

  // 11. Calculate attempt number
  const priorAttemptsCount = await prisma.messageAttempt.count({
    where: { leadId: lead.id, campaignId: lead.campaignId },
  });
  const currentAttemptNumber = explicitAttemptNumber || priorAttemptsCount + 1;

  const provider = getMessagingProvider(resolvedSender);

  // 12. Create initial MessageAttempt record in SENDING status
  const attemptRecord = await prisma.messageAttempt.create({
    data: {
      userId: effectiveUserId,
      campaignId: lead.campaignId,
      leadId: lead.id,
      jobId: optionalJobId,
      itemId: optionalItemId,
      direction: "OUTBOUND",
      status: MessageStatus.SENDING,
      messageText,
      provider: provider.name,
      attemptNumber: currentAttemptNumber,
      idempotencyKey: rawIdempotencyKey ? scopedIdempotencyKey : null,
      contentHash,
      startedAt: new Date(),
      senderAccountId,
    },
  });

  // 13. Acquire in-flight lock and dispatch message
  activeDispatches.add(leadId);

  let dispatchResult: {
    success: boolean;
    provider?: string;
    providerMessageId?: string;
    error?: { code: string; message: string };
    isUncertain?: boolean;
  };

  logger.info("[MESSAGE] dispatch started", {
    campaignId: lead.campaignId,
    leadId: lead.id,
    senderAccountId,
    attemptNumber: currentAttemptNumber,
  });

  try {
    if (senderPreDispatchFailure) {
      dispatchResult = {
        success: false,
        provider: provider.name,
        error: {
          code: senderPreDispatchFailure.code,
          message: senderPreDispatchFailure.message,
        },
        isUncertain: false,
      };
    } else {
      const rawResult = await provider.sendMessage({
        profileUrl: lead.profileUrl,
        message: messageText,
        senderAccountId: senderAccountId ?? undefined,
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
    }
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    const upper = errorText.toUpperCase();
    // Check if failure happened after click or delivery is unknown
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
    activeDispatches.delete(leadId);
  }

  // 14. Classify outcome
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

  // Structured classification decision (sanitized): what the provider detected,
  // which classifier finalized it, and whether it is a fatal platform
  // restriction. Never includes message content.
  logger.info("[MESSAGE] classification", {
    campaignId: lead.campaignId,
    leadId: lead.id,
    detectedCode: dispatchResult.error?.code ?? null,
    finalCode: classifiedCode,
    sourceClassifier: "messaging-error-classifier",
    isFatalPlatformRestriction: isFatalRestriction,
  });

  if (finalStatus === MessageStatus.SENT) {
    logger.info("[MESSAGE] dispatch succeeded", {
      campaignId: lead.campaignId,
      leadId: lead.id,
      senderAccountId,
    });
  } else {
    logger.warn("[MESSAGE] dispatch failed", {
      campaignId: lead.campaignId,
      leadId: lead.id,
      senderAccountId,
      code: classifiedCode,
    });
  }

  // 15. Create or update audit Message record
  const messageRecord = await prisma.message.create({
    data: {
      campaignId: lead.campaignId,
      leadId: lead.id,
      provider: provider.name,
      providerMessageId: dispatchResult.providerMessageId || null,
      status: finalStatus,
      messageText,
      errorCode: finalStatus !== MessageStatus.SENT ? classifiedCode : null,
      errorMessage: userFacingErrorMessage,
      idempotencyKey: rawIdempotencyKey ? scopedIdempotencyKey : null,
      contentHash,
      sentAt: finalStatus === MessageStatus.SENT ? completedAt : null,
      senderAccountId,
      draftId: optionalDraftId ?? null,
      aiGenerated,
      promptVersion: promptVersion ?? null,
    },
  });

  // 16. Update MessageAttempt record with final status, linking to Message
  await prisma.messageAttempt.update({
    where: { id: attemptRecord.id },
    data: {
      status: finalStatus,
      messageId: messageRecord.id,
      providerMessageId: dispatchResult.providerMessageId || null,
      errorCode: finalStatus !== MessageStatus.SENT ? classifiedCode : null,
      errorMessage: userFacingErrorMessage,
      completedAt,
    },
  });

  // 16b. Step 6: mark the approved draft SENT once its message is sent.
  if (finalStatus === MessageStatus.SENT && optionalDraftId) {
    await prisma.messageDraft
      .updateMany({
        where: { id: optionalDraftId, status: DraftStatus.APPROVED },
        data: { status: DraftStatus.SENT },
      })
      .catch((draftErr) => {
        logger.warn("[MESSAGE] Failed to mark draft SENT", {
          draftId: optionalDraftId,
          error: draftErr instanceof Error ? draftErr.message : String(draftErr),
        });
      });
  }

  // 17. Return structured result
  if (finalStatus === MessageStatus.SENT) {
    try {
      await transitionLeadStatus({
        leadId: lead.id,
        to: LeadStatus.CONTACTED,
        reason: "outbound_message_sent",
        actor: effectiveUserId ? `user:${effectiveUserId}` : "worker",
      });
    } catch (statusErr) {
      logger.warn("[MESSAGE] Lead status transition to CONTACTED failed", {
        leadId: lead.id,
        error: statusErr instanceof Error ? statusErr.message : String(statusErr),
      });
    }

    return {
      success: true,
      messageId: messageRecord.id,
      leadId: lead.id,
      status: "SENT",
      sentAt: completedAt.toISOString(),
      attemptNumber: currentAttemptNumber,
    };
  }

  return {
    success: false,
    messageId: messageRecord.id,
    leadId: lead.id,
    status: finalStatus === MessageStatus.UNKNOWN ? "UNKNOWN" : "FAILED",
    errorCode: classifiedCode,
    error: userFacingErrorMessage || "Message dispatch failed.",
    isFatalPlatformRestriction: isFatalRestriction,
    attemptNumber: currentAttemptNumber,
  };
}

export async function sendTestMessage(
  input: unknown,
  userId?: string,
): Promise<SendTestMessageResult> {
  const result = await sendSingleMessage(input, userId);

  if (result.success) {
    return {
      success: true,
      messageId: result.messageId,
      status: "SENT",
    };
  }

  return {
    success: false,
    messageId: result.messageId || "",
    status: result.status,
    error: {
      code: result.errorCode,
      message: result.error,
    },
  };
}

export async function getLeadMessages(
  leadId: string,
  userId?: string,
): Promise<unknown[]> {
  const prisma = getPrismaClient();

  const lead = await prisma.lead.findFirst({
    where: {
      id: leadId,
      ...(userId ? { campaign: { userId } } : {}),
    },
    select: { id: true },
  });

  if (!lead) {
    throw new NotFoundError("LEAD_NOT_FOUND", "Lead not found");
  }

  const messages = await prisma.message.findMany({
    where: { leadId },
    orderBy: { createdAt: "desc" },
    include: {
      attempts: {
        orderBy: { attemptNumber: "desc" },
        select: {
          id: true,
          attemptNumber: true,
          status: true,
          errorCode: true,
          errorMessage: true,
          startedAt: true,
          completedAt: true,
        },
      },
      replyDrafts: {
        where: { status: { not: "SUPERSEDED" } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          body: true,
          status: true,
          qualityScore: true,
          qualityPassed: true,
          kind: true,
        },
      },
    },
  });

  return messages;
}

export async function getMessagingStatus(): Promise<MessagingProviderStatus> {
  const provider = getMessagingProvider();
  return provider.getStatus();
}
