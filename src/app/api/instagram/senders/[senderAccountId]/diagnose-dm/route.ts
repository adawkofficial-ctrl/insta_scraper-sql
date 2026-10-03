import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { diagnoseSenderDm } from "@/lib/services/senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ senderAccountId: string }>;
};

/**
 * Read-only DM composer diagnostic. Opens the target profile in the sender's
 * authenticated persistent session and reports whether the conversation and
 * composer were detected. It NEVER types or sends a message.
 */
export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { senderAccountId } = await context.params;

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // Empty body is acceptable; the service will report MISSING_TARGET.
    }

    const diagnostics = await diagnoseSenderDm(senderAccountId, user.id, body);
    return NextResponse.json({ diagnostics }, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
