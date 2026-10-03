import { NextResponse } from "next/server";

import { BadRequestError, handleRouteError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { editDraft, getDraftWithReviews } from "@/lib/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ draftId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { draftId } = await context.params;
    const draft = await getDraftWithReviews({ userId: user.id, draftId });
    return NextResponse.json({ draft });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { draftId } = await context.params;
    let body: { body?: unknown };
    try {
      body = (await request.json()) as { body?: unknown };
    } catch {
      throw new BadRequestError("INVALID_JSON", "Request body must be valid JSON.");
    }
    if (typeof body.body !== "string") {
      throw new BadRequestError("MISSING_BODY", '"body" is required and must be a string.');
    }
    const result = await editDraft({ userId: user.id, draftId, newBody: body.body });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
