import { NextResponse } from "next/server";

import { BadRequestError, handleRouteError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { bulkApproveDrafts } from "@/lib/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ campaignId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;
    let body: { draftIds?: unknown };
    try {
      body = (await request.json()) as { draftIds?: unknown };
    } catch {
      throw new BadRequestError("INVALID_JSON", "Request body must be valid JSON.");
    }
    if (!Array.isArray(body.draftIds)) {
      throw new BadRequestError("MISSING_DRAFT_IDS", '"draftIds" must be an array.');
    }
    const draftIds = body.draftIds.filter((value): value is string => typeof value === "string");
    const result = await bulkApproveDrafts({ userId: user.id, campaignId, draftIds });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
