import { NextResponse } from "next/server";
import { getCampaignOutcomeAnalytics } from "@/lib/services/analytics";
import { handleRouteError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { MessageChannel } from "@/generated/prisma/enums";

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

    const url = new URL(request.url);
    const startDateParam = url.searchParams.get("startDate");
    const endDateParam = url.searchParams.get("endDate");
    const channelParam = url.searchParams.get("channel");

    const startDate = startDateParam ? new Date(startDateParam) : undefined;
    const endDate = endDateParam ? new Date(endDateParam) : undefined;
    const channel =
      channelParam && Object.values(MessageChannel).includes(channelParam as MessageChannel)
        ? (channelParam as MessageChannel)
        : undefined;

    const data = await getCampaignOutcomeAnalytics({
      campaignId,
      startDate,
      endDate,
      channel,
    });

    return NextResponse.json(data);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
