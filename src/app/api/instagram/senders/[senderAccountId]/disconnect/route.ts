import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { disconnectSenderAccount } from "@/lib/services/senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ senderAccountId: string }>;
};

/**
 * Closes the sender's browser session and deletes its local profile directory.
 * Only the owning user's account is affected.
 */
export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { senderAccountId } = await context.params;
    const sender = await disconnectSenderAccount(senderAccountId, user.id);
    return NextResponse.json({ sender }, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
