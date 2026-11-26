import { NextResponse } from "next/server";
import { sendSingleMessage } from "@/lib/services/messaging";
import { handleRouteError, apiError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const payload =
      body && typeof body === "object"
        ? { ...(body as Record<string, unknown>), enforceFirstMessageName: true }
        : body;
    // Manual one-off send from the lead drawer: the operator chose to send now,
    // so the lead-local working-hours window does not apply (bulk jobs and
    // follow-ups stay gated). Set server-side; clients cannot toggle it.
    const result = await sendSingleMessage(payload, user.id, { bypassWorkingHours: true });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
