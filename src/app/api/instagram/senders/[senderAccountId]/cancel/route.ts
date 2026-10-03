import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { cancelSenderLogin } from "@/lib/services/senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ senderAccountId: string }>;
};

/**
 * Cancels an in-progress manual login: closes only this sender's interactive
 * browser and moves CONNECTING -> AUTH_REQUIRED. The persisted profile is kept.
 */
export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { senderAccountId } = await context.params;
    const sender = await cancelSenderLogin(senderAccountId, user.id);
    return NextResponse.json({ sender }, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
