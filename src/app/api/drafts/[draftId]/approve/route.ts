import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { approveDraft } from "@/lib/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ draftId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { draftId } = await context.params;
    let body: { overrideWarnings?: unknown } = {};
    try {
      body = (await request.json()) as { overrideWarnings?: unknown };
    } catch {
      body = {};
    }
    const overrideWarnings = Array.isArray(body.overrideWarnings)
      ? body.overrideWarnings.filter((value): value is string => typeof value === "string")
      : [];
    const result = await approveDraft({ userId: user.id, draftId, overrideWarnings });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
