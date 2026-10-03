import { NextResponse } from "next/server";
import { listCampaignScrapeJobs } from "@/lib/services/scrape-job";
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
    const { searchParams } = new URL(request.url);

    const pageParam = searchParams.get("page");
    const limitParam = searchParams.get("limit");
    const statusParam = searchParams.get("status");

    const jobs = await listCampaignScrapeJobs(
      campaignId,
      {
        page: pageParam ? parseInt(pageParam, 10) : undefined,
        limit: limitParam ? parseInt(limitParam, 10) : undefined,
        status: statusParam || undefined,
      },
      user.id,
    );

    return NextResponse.json(jobs);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
