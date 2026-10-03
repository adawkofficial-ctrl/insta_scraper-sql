import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { sendTestNotification } from "@/lib/services/notifications/ntfy-notifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);

    let body: Record<string, unknown> = {};
    try {
      const parsed = await request.json();
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Body is optional for test route; falls back to saved config
    }

    const topic = typeof body.ntfyTopic === "string" ? body.ntfyTopic.trim() : undefined;
    const serverUrl =
      typeof body.ntfyServerUrl === "string" ? body.ntfyServerUrl.trim() : undefined;
    const accessToken =
      typeof body.ntfyAccessToken === "string" ? body.ntfyAccessToken.trim() : undefined;

    const result = await sendTestNotification({
      userId: user.id,
      topic,
      serverUrl,
      accessToken,
    });

    if (!result.success) {
      return apiError(
        400,
        "NOTIFICATION_DELIVERY_FAILED",
        result.error || "Failed to deliver test notification to ntfy server",
      );
    }

    return NextResponse.json({
      success: true,
      status: result.status,
      latencyMs: result.latencyMs,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
