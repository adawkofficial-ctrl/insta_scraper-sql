import { NextResponse } from "next/server";
import { getCampaignExecutionStatus } from "@/lib/services/execution";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";

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
    const user = await requireAuth(request);
    const { campaignId } = await context.params;
    const status = await getCampaignExecutionStatus(campaignId, user.id);
    return NextResponse.json(status, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
