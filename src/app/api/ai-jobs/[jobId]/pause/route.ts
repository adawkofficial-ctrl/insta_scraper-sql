import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { setAiAnalysisJobState } from "@/lib/services/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { jobId } = await context.params;
    await setAiAnalysisJobState(jobId, user.id, "pause");
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
