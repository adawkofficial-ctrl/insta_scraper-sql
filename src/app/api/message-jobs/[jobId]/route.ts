import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { getBulkMessageJobStatus } from "@/lib/services/messaging/bulk-messaging-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { jobId } = await context.params;

    const jobStatus = await getBulkMessageJobStatus(jobId, user.id);
    return NextResponse.json(jobStatus);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
