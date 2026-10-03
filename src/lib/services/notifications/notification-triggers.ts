import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import {
  NotificationEventType,
  InstagramSenderStatus,
} from "@/generated/prisma/client";
import { sendNotification } from "./ntfy-notifier";
import { getNotificationHighScoreThreshold } from "@/lib/env";

/**
 * Triggers a push notification when a lead sends an inbound reply.
 * Safe execution: never throws, never logs PII.
 */
export async function notifyLeadReplied(params: {
  leadId: string;
  messageId: string;
}): Promise<void> {
  try {
    const prisma = getPrismaClient();

    const [lead, message] = await Promise.all([
      prisma.lead.findUnique({
        where: { id: params.leadId },
        select: {
          id: true,
          username: true,
          campaign: {
            select: {
              userId: true,
              name: true,
            },
          },
        },
      }),
      prisma.message.findUnique({
        where: { id: params.messageId },
        select: {
          id: true,
          messageText: true,
        },
      }),
    ]);

    if (!lead || !lead.campaign?.userId) {
      return;
    }

    const preview = message?.messageText
      ? message.messageText.trim().replace(/\s+/g, " ").slice(0, 150)
      : "(No message text)";

    const title = `💬 Reply from @${lead.username}`;
    const body = `${preview}\n\nCampaign: ${lead.campaign.name}`;

    await sendNotification({
      userId: lead.campaign.userId,
      eventType: NotificationEventType.LEAD_REPLIED,
      leadId: lead.id,
      title,
      body,
    });
  } catch (err) {
    logger.warn("[NOTIFICATION_TRIGGER] notifyLeadReplied failed safely", {
      leadId: params.leadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Triggers a push notification when a lead crosses the high-value score threshold for the first time.
 */
export async function notifyHighValueLead(params: {
  leadId: string;
  userId: string;
  username: string;
  score: number;
  quality?: string | null;
  campaignName?: string | null;
}): Promise<void> {
  try {
    const threshold = getNotificationHighScoreThreshold();
    if (params.score < threshold) {
      return;
    }

    const title = `⭐ High-Value Lead: @${params.username}`;
    const details = [
      `Lead Score: ${params.score}/100`,
      params.quality ? `Quality: ${params.quality}` : null,
      params.campaignName ? `Campaign: ${params.campaignName}` : null,
    ]
      .filter(Boolean)
      .join(" • ");

    await sendNotification({
      userId: params.userId,
      eventType: NotificationEventType.HIGH_VALUE_LEAD,
      leadId: params.leadId,
      title,
      body: details,
    });
  } catch (err) {
    logger.warn("[NOTIFICATION_TRIGGER] notifyHighValueLead failed safely", {
      leadId: params.leadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Triggers a push notification when an Instagram sender account changes to an error or expired status.
 */
export async function notifySenderStatusChange(params: {
  userId: string;
  senderUsername: string;
  previousStatus?: InstagramSenderStatus | null;
  newStatus: InstagramSenderStatus;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    // Only notify on transitions into problem states
    if (
      params.newStatus !== InstagramSenderStatus.ERROR &&
      params.newStatus !== InstagramSenderStatus.AUTH_REQUIRED &&
      params.newStatus !== InstagramSenderStatus.EXPIRED
    ) {
      return;
    }

    if (params.previousStatus === params.newStatus) {
      return; // Avoid repeated alerts for the same status
    }

    const isSessionExpired =
      params.newStatus === InstagramSenderStatus.AUTH_REQUIRED ||
      params.newStatus === InstagramSenderStatus.EXPIRED;

    const eventType = isSessionExpired
      ? NotificationEventType.SESSION_EXPIRED
      : NotificationEventType.SENDER_ERROR;

    const title = isSessionExpired
      ? `🔑 Session Expired: @${params.senderUsername}`
      : `⚠️ Sender Account Error: @${params.senderUsername}`;

    const body = [
      `Account @${params.senderUsername} requires attention.`,
      `Status: ${params.newStatus}`,
      params.errorMessage ? `Details: ${params.errorMessage}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await sendNotification({
      userId: params.userId,
      eventType,
      title,
      body,
    });
  } catch (err) {
    logger.warn("[NOTIFICATION_TRIGGER] notifySenderStatusChange failed safely", {
      userId: params.userId,
      senderUsername: params.senderUsername,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Triggers a push notification when an external provider experiences quota exhaustion or auth failure.
 */
export async function notifySystemError(params: {
  userId: string;
  provider: "Apify" | "Sparior" | "Gemini" | "Unipile" | string;
  errorType: "QUOTA_EXHAUSTED" | "AUTH_FAILED" | "RATE_LIMITED" | string;
  details?: string | null;
}): Promise<void> {
  try {
    const title = `🚨 System Alert: ${params.provider} ${params.errorType.replace(/_/g, " ")}`;
    const body = [
      `Provider: ${params.provider}`,
      `Issue: ${params.errorType}`,
      params.details ? `Details: ${params.details}` : null,
      "Please check your API key / quota balance.",
    ]
      .filter(Boolean)
      .join("\n");

    await sendNotification({
      userId: params.userId,
      eventType: NotificationEventType.SYSTEM_ERROR,
      title,
      body,
    });
  } catch (err) {
    logger.warn("[NOTIFICATION_TRIGGER] notifySystemError failed safely", {
      userId: params.userId,
      provider: params.provider,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
