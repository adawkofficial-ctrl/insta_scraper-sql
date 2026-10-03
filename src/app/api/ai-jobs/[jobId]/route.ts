import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { getAiAnalysisJob } from "@/lib/services/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { jobId } = await context.params;
    const job = await getAiAnalysisJob(jobId, user.id);
    return NextResponse.json({
      job: {
        id: job.id,
        campaignId: job.campaignId,
        status: job.status,
        total: job.total,
        processed: job.processed,
        succeeded: job.succeeded,
        failed: job.failed,
        skipped: job.skipped,
        cancelRequested: job.cancelRequested,
        lastError: job.lastError,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        createdAt: job.createdAt,
      },
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
