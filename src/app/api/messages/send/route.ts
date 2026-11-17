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
    const result = await sendSingleMessage(payload, user.id);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
