import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { listNotificationLogs } from "@/lib/services/notifications/notification-config-service";
import {
  NotificationEventType,
  NotificationLogStatus,
} from "@/generated/prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const url = new URL(request.url);

    const page = url.searchParams.get("page")
      ? parseInt(url.searchParams.get("page")!, 10)
      : 1;
    const pageSize = url.searchParams.get("pageSize")
      ? parseInt(url.searchParams.get("pageSize")!, 10)
      : 20;

    const eventTypeParam = url.searchParams.get("eventType");
    const eventType =
      eventTypeParam && Object.values(NotificationEventType).includes(eventTypeParam as NotificationEventType)
        ? (eventTypeParam as NotificationEventType)
        : undefined;

    const statusParam = url.searchParams.get("status");
    const status =
      statusParam && Object.values(NotificationLogStatus).includes(statusParam as NotificationLogStatus)
        ? (statusParam as NotificationLogStatus)
        : undefined;

    const result = await listNotificationLogs(user.id, {
      page: isNaN(page) ? 1 : page,
      pageSize: isNaN(pageSize) ? 20 : pageSize,
      eventType,
      status,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
