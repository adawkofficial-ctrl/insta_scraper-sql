import { NextResponse } from "next/server";
import { getCampaignMessages } from "@/lib/services/analytics";
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
    const user = await requireAuth(request);
    const { campaignId } = await context.params;
    const url = new URL(request.url);
    const messages = await getCampaignMessages(campaignId, url.searchParams, user.id);
    return NextResponse.json(messages);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
