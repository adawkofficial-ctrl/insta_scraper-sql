import { NextResponse } from "next/server";
import { getScrapeJobById } from "@/lib/services/scrape-job";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { jobId } = await context.params;
    const job = await getScrapeJobById(jobId, user.id);
    return NextResponse.json(job);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
