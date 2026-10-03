import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { createDraftSendJob } from "@/lib/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ campaignId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;
    let body: { senderAccountId?: unknown; limit?: unknown; draftIds?: unknown } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }
    const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? body.limit : undefined;
    const draftIds = Array.isArray(body.draftIds)
      ? body.draftIds.filter((value): value is string => typeof value === "string")
      : undefined;

    const result = await createDraftSendJob({
      userId: user.id,
      campaignId,
      senderAccountId: typeof body.senderAccountId === "string" ? body.senderAccountId : undefined,
      limit,
      draftIds,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
