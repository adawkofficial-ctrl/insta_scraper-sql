import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { sendDailySummaryNotification } from "@/lib/services/notifications/notification-config-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const success = await sendDailySummaryNotification(user.id);

    if (!success) {
      return apiError(
        400,
        "DAILY_SUMMARY_FAILED",
        "Failed to send daily summary notification. Check if notifications are enabled and configured.",
      );
    }

    return NextResponse.json({ success: true, message: "Daily summary sent successfully" });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
