import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { generateAndCheckDraft } from "@/lib/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ leadId: string }> };

/**
 * Step 6: the per-lead draft endpoint now runs the full pipeline
 * (generate -> quality gate -> bounded regeneration).
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { leadId } = await context.params;
    const result = await generateAndCheckDraft({ userId: user.id, leadId });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
