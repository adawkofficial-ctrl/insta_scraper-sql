import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { verifySenderAccount } from "@/lib/services/senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ senderAccountId: string }>;
};

/**
 * Verifies the account's stored Instagram session. Returns only sanitized sender
 * metadata; cookies/session state are never exposed.
 */
export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { senderAccountId } = await context.params;
    const sender = await verifySenderAccount(senderAccountId, user.id);
    return NextResponse.json({ sender }, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
