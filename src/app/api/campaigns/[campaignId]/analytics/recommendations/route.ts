import { NextResponse } from "next/server";
import { getCampaignRecommendations } from "@/lib/services/analytics";
import { handleRouteError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireAuth(request);
    const { campaignId } = await context.params;

    const recommendations = await getCampaignRecommendations(campaignId);
    return NextResponse.json(recommendations);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
