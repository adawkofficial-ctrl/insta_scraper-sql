import { NextResponse } from "next/server";
import { previewBulkMessageJob } from "@/lib/services/messaging";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const preview = await previewBulkMessageJob(campaignId, body, user.id);
    return NextResponse.json(preview, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
