import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { startSenderConnect, connectSenderWithSessionId } from "@/lib/services/senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ senderAccountId: string }>;
};

/**
 * Connects an Instagram sender account either via Unipile hosted auth link
 * or directly via Instagram sessionid cookie.
 */
export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { senderAccountId } = await context.params;

    let body: { sessionId?: string; userAgent?: string } | null = null;
    try {
      body = (await request.json()) as { sessionId?: string; userAgent?: string };
    } catch {
      // Empty or non-JSON body is valid for default hosted link connect
    }

    if (body?.sessionId && typeof body.sessionId === "string" && body.sessionId.trim().length > 0) {
      const result = await connectSenderWithSessionId(
        senderAccountId,
        user.id,
        body.sessionId.trim(),
        body.userAgent,
      );
      return NextResponse.json(result, { status: 200 });
    }

    const result = await startSenderConnect(senderAccountId, user.id);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

