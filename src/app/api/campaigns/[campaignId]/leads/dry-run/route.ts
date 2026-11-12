import { NextResponse } from "next/server";
import { deleteDryRunLeads } from "@/lib/services/lead";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;
    const result = await deleteDryRunLeads(campaignId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}

