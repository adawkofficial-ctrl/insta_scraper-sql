import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/errors";
import { requireAuth, requireCampaignOwner } from "@/lib/services/auth";
import { getAutoApprovalEligibility } from "@/lib/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ campaignId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;
    await requireCampaignOwner(campaignId, user.id);
    const eligibility = await getAutoApprovalEligibility(campaignId);
    return NextResponse.json(eligibility);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
