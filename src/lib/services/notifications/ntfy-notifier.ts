import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import {
  NotificationEventType,
  NotificationLogStatus,
} from "@/generated/prisma/client";
import { getNotificationMaxPerMinute } from "@/lib/env";

export { NotificationEventType, NotificationLogStatus };

export type NotificationPriority = "min" | "low" | "default" | "high" | "urgent";

export type SendNotificationParams = {
  userId: string;
  eventType: NotificationEventType;
  leadId?: string | null;
  title: string;
  body: string;
  tags?: string[];
  priority?: NotificationPriority;
};

export type SendNotificationResult = {
  success: boolean;
  status: NotificationLogStatus;
  error?: string;
  latencyMs?: number;
};

// Event-specific default priorities
export const EVENT_DEFAULT_PRIORITIES: Record<NotificationEventType, NotificationPriority> = {
  [NotificationEventType.LEAD_REPLIED]: "high",
  [NotificationEventType.HIGH_VALUE_LEAD]: "urgent",
  [NotificationEventType.SENDER_ERROR]: "high",
  [NotificationEventType.SESSION_EXPIRED]: "high",
  [NotificationEventType.SYSTEM_ERROR]: "urgent",
  [NotificationEventType.DAILY_SUMMARY]: "default",
};

// Event-specific default tags (emojis) for ntfy
export const EVENT_DEFAULT_TAGS: Record<NotificationEventType, string[]> = {
  [NotificationEventType.LEAD_REPLIED]: ["speech_balloon", "incoming_envelope"],
  [NotificationEventType.HIGH_VALUE_LEAD]: ["star", "fire"],
  [NotificationEventType.SENDER_ERROR]: ["warning", "instagram"],
  [NotificationEventType.SESSION_EXPIRED]: ["lock", "key"],
  [NotificationEventType.SYSTEM_ERROR]: ["rotating_light", "x"],
  [NotificationEventType.DAILY_SUMMARY]: ["bar_chart", "calendar"],
};

type BurstWindowState = {
  windowStart: number;
  count: number;
  collapsedCount: number;
  hasSentSummary: boolean;
};

// In-memory rolling-window tracker for rate limiting / burst collapse per user
const userBurstMap = new Map<string, BurstWindowState>();

export function resetBurstGuard(userId?: string): void {
  if (userId) {
    userBurstMap.delete(userId);
  } else {
    userBurstMap.clear();
  }
}

function checkBurstGuard(userId: string, maxPerMinute: number): {
  allowed: boolean;
  sendSummaryNotice: boolean;
  collapsedCount: number;
} {
  const now = Date.now();
  const state = userBurstMap.get(userId);

  if (!state || now - state.windowStart >= 60_000) {
    userBurstMap.set(userId, {
      windowStart: now,
      count: 1,
      collapsedCount: 0,
      hasSentSummary: false,
    });
    return { allowed: true, sendSummaryNotice: false, collapsedCount: 0 };
  }

  if (state.count < maxPerMinute) {
    state.count++;
    return { allowed: true, sendSummaryNotice: false, collapsedCount: 0 };
  }

  // Limit exceeded: collapse
  state.collapsedCount++;
  if (!state.hasSentSummary) {
    state.hasSentSummary = true;
    return {
      allowed: false,
      sendSummaryNotice: true,
      collapsedCount: state.collapsedCount,
    };
  }

  return {
    allowed: false,
    sendSummaryNotice: false,
    collapsedCount: state.collapsedCount,
  };
}

let customFetchFn: typeof fetch | null = null;

export function setNotificationFetchFn(fn: typeof fetch | null): void {
  customFetchFn = fn;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class NtfyNotifier {
  private readonly timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Dispatches a notification for the specified user and event type.
   * Safe execution: Never throws. An ntfy outage will never disrupt lead processing or messaging.
   */
  async send(params: SendNotificationParams): Promise<SendNotificationResult> {
    const { userId, eventType, leadId, title, body } = params;
    const startMs = Date.now();

    try {
      const prisma = getPrismaClient();

      // 1. Load user notification config
      const config = await prisma.notificationConfig.findUnique({
        where: { userId },
      });

      // 2. Check if notifications are enabled and subscribed to this event
      if (
        !config ||
        !config.enabled ||
        !config.ntfyTopic ||
        !config.eventTypes.includes(eventType)
      ) {
        await this.recordLog({
          userId,
          eventType,
          leadId,
          status: NotificationLogStatus.SKIPPED_DISABLED,
          latencyMs: Date.now() - startMs,
        });

        return {
          success: false,
          status: NotificationLogStatus.SKIPPED_DISABLED,
        };
      }

      // 3. Burst guard rate limiting
      const maxPerMinute = getNotificationMaxPerMinute();
      const burstCheck = checkBurstGuard(userId, maxPerMinute);

      if (!burstCheck.allowed) {
        // Send a single summary notice if we just crossed the burst threshold
        if (burstCheck.sendSummaryNotice) {
          await this.executeHttpSend({
            serverUrl: config.ntfyServerUrl,
            topic: config.ntfyTopic,
            accessToken: config.ntfyAccessToken,
            title: "Notifications Rate-Limited",
            body: `Rate limit reached (${maxPerMinute}/min). Further notifications for this minute are collapsed to prevent alert fatigue.`,
            priority: "low",
            tags: ["warning", "hourglass"],
          }).catch(() => undefined);
        }

        await this.recordLog({
          userId,
          eventType,
          leadId,
          status: NotificationLogStatus.SKIPPED_DISABLED,
          errorReason: "BURST_LIMIT_EXCEEDED",
          latencyMs: Date.now() - startMs,
        });

        return {
          success: false,
          status: NotificationLogStatus.SKIPPED_DISABLED,
          error: "BURST_LIMIT_EXCEEDED",
        };
      }

      // 4. Resolve tags & priority
      const priority = params.priority || EVENT_DEFAULT_PRIORITIES[eventType] || "default";
      const tags = params.tags || EVENT_DEFAULT_TAGS[eventType] || [];

      // 5. Execute HTTP POST with retry
      const httpResult = await this.executeHttpSend({
        serverUrl: config.ntfyServerUrl,
        topic: config.ntfyTopic,
        accessToken: config.ntfyAccessToken,
        title,
        body,
        priority,
        tags,
      });

      const latencyMs = Date.now() - startMs;

      // 6. Write notification delivery audit log (no PII or message body stored)
      await this.recordLog({
        userId,
        eventType,
        leadId,
        status: httpResult.ok ? NotificationLogStatus.SENT : NotificationLogStatus.FAILED,
        errorReason: httpResult.error,
        latencyMs,
      });

      logger.info("[NOTIFICATION] send attempt completed", {
        userId,
        eventType,
        leadId: leadId ?? undefined,
        status: httpResult.ok ? "SENT" : "FAILED",
        latencyMs,
      });

      return {
        success: httpResult.ok,
        status: httpResult.ok ? NotificationLogStatus.SENT : NotificationLogStatus.FAILED,
        error: httpResult.error,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      const errorMsg = err instanceof Error ? err.message : String(err);

      logger.error("[NOTIFICATION] unexpected exception in notifier", {
        userId,
        eventType,
        leadId: leadId ?? undefined,
        error: errorMsg,
      });

      await this.recordLog({
        userId,
        eventType,
        leadId,
        status: NotificationLogStatus.FAILED,
        errorReason: errorMsg,
        latencyMs,
      }).catch(() => undefined);

      return {
        success: false,
        status: NotificationLogStatus.FAILED,
        error: errorMsg,
        latencyMs,
      };
    }
  }

  private async executeHttpSend(options: {
    serverUrl: string;
    topic: string;
    accessToken?: string | null;
    title: string;
    body: string;
    priority: NotificationPriority;
    tags: string[];
  }): Promise<{ ok: boolean; status?: number; error?: string }> {
    const fetchFn = customFetchFn ?? fetch;
    const cleanServer = options.serverUrl.replace(/\/+$/, "");
    const cleanTopic = options.topic.trim().replace(/^\/+/, "");
    const url = `${cleanServer}/${encodeURIComponent(cleanTopic)}`;

    const headers: Record<string, string> = {
      Title: options.title,
      Priority: options.priority,
      "Content-Type": "text/plain; charset=utf-8",
    };

    if (options.tags && options.tags.length > 0) {
      headers.Tags = options.tags.join(",");
    }

    if (options.accessToken && options.accessToken.trim().length > 0) {
      headers.Authorization = `Bearer ${options.accessToken.trim()}`;
    }

    // Execute with 1 retry on 5xx or network/timeout
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers,
          body: options.body,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          return { ok: true, status: response.status };
        }

        // 4xx client errors (401, 403, 404, etc.): do NOT retry
        if (response.status >= 400 && response.status < 500) {
          const text = await response.text().catch(() => "");
          return {
            ok: false,
            status: response.status,
            error: `HTTP ${response.status}: ${text.slice(0, 100) || "Client error"}`,
          };
        }

        // 5xx server error: retry once
        lastError = `HTTP ${response.status}: Server error`;
      } catch (err) {
        clearTimeout(timer);
        const isAbort =
          err instanceof Error &&
          (err.name === "AbortError" || err.message.toLowerCase().includes("abort"));
        lastError = isAbort
          ? `Request timed out after ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      }

      if (attempt === 1) {
        // Short delay before single retry
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    return { ok: false, error: lastError ?? "Delivery failed after retry" };
  }

  private async recordLog(data: {
    userId: string;
    eventType: NotificationEventType;
    leadId?: string | null;
    status: NotificationLogStatus;
    errorReason?: string | null;
    latencyMs?: number;
  }): Promise<void> {
    try {
      const prisma = getPrismaClient();
      await prisma.notificationLog.create({
        data: {
          userId: data.userId,
          eventType: data.eventType,
          leadId: data.leadId ?? null,
          status: data.status,
          errorReason: data.errorReason ? data.errorReason.slice(0, 255) : null,
          latencyMs: data.latencyMs ?? null,
        },
      });
    } catch (logErr) {
      logger.warn("[NOTIFICATION] failed to write NotificationLog audit row", {
        error: logErr instanceof Error ? logErr.message : String(logErr),
      });
    }
  }

  async sendTest(params: {
    userId: string;
    topic?: string;
    serverUrl?: string;
    accessToken?: string | null;
  }): Promise<SendNotificationResult> {
    const startMs = Date.now();
    try {
      const prisma = getPrismaClient();
      const config = await prisma.notificationConfig.findUnique({
        where: { userId: params.userId },
      });

      const topic = params.topic?.trim() || config?.ntfyTopic;
      const serverUrl = params.serverUrl?.trim() || config?.ntfyServerUrl || "https://ntfy.sh";
      const accessToken =
        params.accessToken !== undefined ? params.accessToken : config?.ntfyAccessToken;

      if (!topic) {
        return {
          success: false,
          status: NotificationLogStatus.SKIPPED_DISABLED,
          error: "No topic configured to send test notification",
        };
      }

      const httpResult = await this.executeHttpSend({
        serverUrl,
        topic,
        accessToken,
        title: "🔔 Test Notification",
        body: "Your ntfy push notifications are correctly connected and active!",
        priority: "default",
        tags: ["bell", "white_check_mark"],
      });

      const latencyMs = Date.now() - startMs;

      await this.recordLog({
        userId: params.userId,
        eventType: NotificationEventType.DAILY_SUMMARY,
        status: httpResult.ok ? NotificationLogStatus.SENT : NotificationLogStatus.FAILED,
        errorReason: httpResult.error,
        latencyMs,
      });

      return {
        success: httpResult.ok,
        status: httpResult.ok ? NotificationLogStatus.SENT : NotificationLogStatus.FAILED,
        error: httpResult.error,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        status: NotificationLogStatus.FAILED,
        error: errorMsg,
        latencyMs,
      };
    }
  }
}

export const ntfyNotifier = new NtfyNotifier();

export async function sendNotification(
  params: SendNotificationParams,
): Promise<SendNotificationResult> {
  return ntfyNotifier.send(params);
}

export async function sendTestNotification(params: {
  userId: string;
  topic?: string;
  serverUrl?: string;
  accessToken?: string | null;
}): Promise<SendNotificationResult> {
  return ntfyNotifier.sendTest(params);
}
