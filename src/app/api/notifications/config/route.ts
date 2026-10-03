import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import {
  getNotificationConfig,
  upsertNotificationConfig,
} from "@/lib/services/notifications/notification-config-service";
import { NotificationEventType } from "@/generated/prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const config = await getNotificationConfig(user.id);

    return NextResponse.json({
      config: config ?? {
        userId: user.id,
        ntfyTopic: "",
        ntfyServerUrl: "https://ntfy.sh",
        hasAccessToken: false,
        maskedAccessToken: null,
        enabled: false,
        eventTypes: [
          NotificationEventType.LEAD_REPLIED,
          NotificationEventType.HIGH_VALUE_LEAD,
          NotificationEventType.SENDER_ERROR,
          NotificationEventType.SESSION_EXPIRED,
          NotificationEventType.SYSTEM_ERROR,
          NotificationEventType.DAILY_SUMMARY,
        ],
      },
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    if (!body || typeof body !== "object") {
      return apiError(400, "INVALID_INPUT", "Request body must be an object.");
    }

    const input = body as Record<string, unknown>;

    if (typeof input.ntfyTopic !== "string" || !input.ntfyTopic.trim()) {
      return apiError(400, "VALIDATION_ERROR", "ntfyTopic is required and cannot be empty.");
    }

    const ntfyTopic = input.ntfyTopic.trim();
    if (ntfyTopic.length > 64) {
      return apiError(400, "VALIDATION_ERROR", "ntfyTopic must be 64 characters or fewer.");
    }

    let ntfyServerUrl: string | undefined;
    if (input.ntfyServerUrl !== undefined) {
      if (typeof input.ntfyServerUrl !== "string") {
        return apiError(400, "VALIDATION_ERROR", "ntfyServerUrl must be a string.");
      }
      try {
        const parsed = new URL(input.ntfyServerUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return apiError(400, "VALIDATION_ERROR", "ntfyServerUrl must be HTTP or HTTPS.");
        }
        ntfyServerUrl = input.ntfyServerUrl.trim();
      } catch {
        return apiError(400, "VALIDATION_ERROR", "ntfyServerUrl is not a valid URL.");
      }
    }

    let ntfyAccessToken: string | null | undefined;
    if (input.ntfyAccessToken !== undefined) {
      if (input.ntfyAccessToken === null || input.ntfyAccessToken === "") {
        ntfyAccessToken = null;
      } else if (typeof input.ntfyAccessToken === "string") {
        ntfyAccessToken = input.ntfyAccessToken.trim();
      } else {
        return apiError(400, "VALIDATION_ERROR", "ntfyAccessToken must be a string or null.");
      }
    }

    let enabled: boolean | undefined;
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") {
        return apiError(400, "VALIDATION_ERROR", "enabled must be a boolean.");
      }
      enabled = input.enabled;
    }

    let eventTypes: NotificationEventType[] | undefined;
    if (input.eventTypes !== undefined) {
      if (!Array.isArray(input.eventTypes)) {
        return apiError(400, "VALIDATION_ERROR", "eventTypes must be an array.");
      }
      const validEventTypes = Object.values(NotificationEventType);
      for (const ev of input.eventTypes) {
        if (!validEventTypes.includes(ev)) {
          return apiError(400, "VALIDATION_ERROR", `Invalid eventType: ${String(ev)}`);
        }
      }
      eventTypes = input.eventTypes as NotificationEventType[];
    }

    const saved = await upsertNotificationConfig(user.id, {
      ntfyTopic,
      ntfyServerUrl,
      ntfyAccessToken,
      enabled,
      eventTypes,
    });

    return NextResponse.json({ config: saved });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
