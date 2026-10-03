import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import {
  recoverStaleProcessingItems,
  getBulkMessageJobStatus,
} from "@/lib/services/messaging/bulk-messaging-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { jobId } = await context.params;

    // Verify ownership
    await getBulkMessageJobStatus(jobId, user.id);

    const recoveryResult = await recoverStaleProcessingItems(jobId);
    const updatedStatus = await getBulkMessageJobStatus(jobId, user.id);

    return NextResponse.json({
      recovery: recoveryResult,
      job: updatedStatus,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
