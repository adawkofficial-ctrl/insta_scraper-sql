import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { cancelBulkMessageItem } from "@/lib/services/messaging/bulk-messaging-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ jobId: string; itemId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { jobId, itemId } = await context.params;

    const result = await cancelBulkMessageItem(jobId, itemId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
