import { NextResponse } from "next/server";
import { resumeCampaignExecution } from "@/lib/services/execution";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";

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
    const result = await resumeCampaignExecution(campaignId, user.id);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
