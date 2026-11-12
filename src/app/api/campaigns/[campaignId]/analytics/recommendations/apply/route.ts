import { NextResponse } from "next/server";
import { applyCampaignRecommendation } from "@/lib/services/analytics";
import { handleRouteError, apiError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";

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
    await requireAuth(request);
    const { campaignId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const { recommendationId } = (body as { recommendationId?: string }) || {};
    if (!recommendationId || typeof recommendationId !== "string") {
      return apiError(400, "MISSING_RECOMMENDATION_ID", '"recommendationId" is required.');
    }

    const result = await applyCampaignRecommendation(campaignId, recommendationId);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
