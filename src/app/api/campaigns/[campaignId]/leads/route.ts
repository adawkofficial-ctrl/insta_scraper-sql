import { NextResponse } from "next/server";
import { listCampaignLeads, deleteLeads } from "@/lib/services/lead";
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
    const url = new URL(request.url);
    const result = await listCampaignLeads(campaignId, url.searchParams, user.id);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function DELETE(
  request: Request,
  _context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const body = (await request.json().catch(() => ({}))) as { leadIds?: string[] };
    const leadIds = Array.isArray(body?.leadIds) ? body.leadIds : [];

    if (leadIds.length === 0) {
      return NextResponse.json(
        { error: "No leadIds provided for deletion" },
        { status: 400 },
      );
    }

    const result = await deleteLeads(leadIds, user.id);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}

