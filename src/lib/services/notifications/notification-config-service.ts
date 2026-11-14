import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  NotificationEventType,
  NotificationLogStatus,
} from "@/generated/prisma/client";
import { sendNotification } from "./ntfy-notifier";
import { getNotificationHighScoreThreshold } from "@/lib/env";
import { parseNotificationEventTypes } from "../lead/json-lists";

export type PublicNotificationConfig = {
  id: string;
  userId: string;
  ntfyTopic: string;
  ntfyServerUrl: string;
  hasAccessToken: boolean;
  maskedAccessToken: string | null;
  enabled: boolean;
  eventTypes: NotificationEventType[];
  createdAt: Date;
  updatedAt: Date;
};

export function maskAccessToken(token?: string | null): string | null {
  if (!token || !token.trim()) return null;
  const trimmed = token.trim();
  if (trimmed.length <= 4) return "****";
  return `****${trimmed.slice(-4)}`;
}

export async function getNotificationConfig(
  userId: string,
): Promise<PublicNotificationConfig | null> {
  const prisma = getPrismaClient();
  const config = await prisma.notificationConfig.findUnique({
    where: { userId },
  });

  if (!config) return null;

  return {
    id: config.id,
    userId: config.userId,
    ntfyTopic: config.ntfyTopic,
    ntfyServerUrl: config.ntfyServerUrl,
    hasAccessToken: Boolean(config.ntfyAccessToken && config.ntfyAccessToken.trim().length > 0),
    maskedAccessToken: maskAccessToken(config.ntfyAccessToken),
    enabled: config.enabled,
    eventTypes: parseNotificationEventTypes(config.eventTypes),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

export type UpsertNotificationConfigInput = {
  ntfyTopic: string;
  ntfyServerUrl?: string;
  ntfyAccessToken?: string | null;
  enabled?: boolean;
  eventTypes?: NotificationEventType[];
};

export async function upsertNotificationConfig(
  userId: string,
  input: UpsertNotificationConfigInput,
): Promise<PublicNotificationConfig> {
  const prisma = getPrismaClient();

  const updateData: {
    ntfyTopic: string;
    ntfyServerUrl?: string;
    ntfyAccessToken?: string | null;
    enabled?: boolean;
    eventTypes?: NotificationEventType[];
  } = {
    ntfyTopic: input.ntfyTopic.trim(),
  };

  if (input.ntfyServerUrl !== undefined) {
    updateData.ntfyServerUrl = input.ntfyServerUrl.trim() || "https://ntfy.sh";
  }

  // Only update token if explicitly provided (null/empty clears it, string sets it)
  if (input.ntfyAccessToken !== undefined) {
    updateData.ntfyAccessToken = input.ntfyAccessToken?.trim() || null;
  }

  if (input.enabled !== undefined) {
    updateData.enabled = input.enabled;
  }

  if (input.eventTypes !== undefined) {
    updateData.eventTypes = input.eventTypes;
  }

  const saved = await prisma.notificationConfig.upsert({
    where: { userId },
    create: {
      userId,
      ntfyTopic: input.ntfyTopic.trim(),
      ntfyServerUrl: input.ntfyServerUrl?.trim() || "https://ntfy.sh",
      ntfyAccessToken: input.ntfyAccessToken?.trim() || null,
      enabled: input.enabled ?? true,
      eventTypes: input.eventTypes ?? [
        NotificationEventType.LEAD_REPLIED,
        NotificationEventType.HIGH_VALUE_LEAD,
        NotificationEventType.SENDER_ERROR,
        NotificationEventType.SYSTEM_ERROR,
      ],
    },
    update: updateData,
  });

  return {
    id: saved.id,
    userId: saved.userId,
    ntfyTopic: saved.ntfyTopic,
    ntfyServerUrl: saved.ntfyServerUrl,
    hasAccessToken: Boolean(saved.ntfyAccessToken && saved.ntfyAccessToken.trim().length > 0),
    maskedAccessToken: maskAccessToken(saved.ntfyAccessToken),
    enabled: saved.enabled,
    eventTypes: parseNotificationEventTypes(saved.eventTypes),
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}

export type NotificationLogFilter = {
  eventType?: NotificationEventType;
  status?: NotificationLogStatus;
  page?: number;
  pageSize?: number;
};

export async function listNotificationLogs(
  userId: string,
  filter?: NotificationLogFilter,
) {
  const prisma = getPrismaClient();
  const page = Math.max(1, filter?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter?.pageSize ?? 20));
  const skip = (page - 1) * pageSize;

  const where = {
    userId,
    ...(filter?.eventType ? { eventType: filter.eventType } : {}),
    ...(filter?.status ? { status: filter.status } : {}),
  };

  const [total, logs] = await Promise.all([
    prisma.notificationLog.count({ where }),
    prisma.notificationLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
      select: {
        id: true,
        eventType: true,
        leadId: true,
        status: true,
        errorReason: true,
        latencyMs: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    logs,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

/**
 * Builds and dispatches a daily summary push notification for a user.
 */
export async function sendDailySummaryNotification(userId: string): Promise<boolean> {
  const prisma = getPrismaClient();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Aggregate user stats for past 24 hours
  const [newLeadsCount, sentMessagesCount, inboundRepliesCount, highValueCount] =
    await Promise.all([
      prisma.lead.count({
        where: {
          campaign: { userId },
          createdAt: { gte: oneDayAgo },
        },
      }),
      prisma.message.count({
        where: {
          campaign: { userId },
          direction: "OUTBOUND",
          status: "SENT",
          createdAt: { gte: oneDayAgo },
        },
      }),
      prisma.message.count({
        where: {
          campaign: { userId },
          direction: "INBOUND",
          createdAt: { gte: oneDayAgo },
        },
      }),
      prisma.lead.count({
        where: {
          campaign: { userId },
          leadScore: { gte: getNotificationHighScoreThreshold() },
          aiAnalyzedAt: { gte: oneDayAgo },
        },
      }),
    ]);

  const body = [
    `📊 24h Activity Summary:`,
    `• New Leads: ${newLeadsCount}`,
    `• High-Value (Score ≥${getNotificationHighScoreThreshold()}): ${highValueCount}`,
    `• DMs Sent: ${sentMessagesCount}`,
    `• Replies Received: ${inboundRepliesCount}`,
  ].join("\n");

  const res = await sendNotification({
    userId,
    eventType: NotificationEventType.DAILY_SUMMARY,
    title: "Daily Lead Activity Summary",
    body,
  });

  return res.success;
}
