import { NextResponse } from "next/server";

import { BadRequestError, handleRouteError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { rejectDraft } from "@/lib/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ draftId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { draftId } = await context.params;
    let body: { reasonCode?: unknown; notes?: unknown; regenerate?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new BadRequestError("INVALID_JSON", "Request body must be valid JSON.");
    }
    if (typeof body.reasonCode !== "string" || body.reasonCode.trim().length === 0) {
      throw new BadRequestError("MISSING_REASON", '"reasonCode" is required.');
    }
    const result = await rejectDraft({
      userId: user.id,
      draftId,
      reasonCode: body.reasonCode.trim(),
      notes: typeof body.notes === "string" ? body.notes : undefined,
      regenerate: body.regenerate === true,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
