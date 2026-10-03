import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { createAiAnalysisJob } from "@/lib/services/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ campaignId: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;

    let body: {
      limit?: number;
      onlyUnanalyzed?: boolean;
      generateDrafts?: boolean;
      force?: boolean;
    } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }

    const result = await createAiAnalysisJob({
      userId: user.id,
      campaignId,
      options: {
        limit: typeof body.limit === "number" ? body.limit : undefined,
        onlyUnanalyzed: body.onlyUnanalyzed,
        generateDrafts: body.generateDrafts,
        force: body.force,
      },
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
