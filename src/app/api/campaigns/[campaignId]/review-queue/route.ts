import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { listReviewQueue } from "@/lib/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ campaignId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const rawKind = url.searchParams.get("kind");
    const kind = rawKind === "OUTREACH" || rawKind === "REPLY" ? rawKind : undefined;
    const minScoreRaw = url.searchParams.get("minScore");
    const minScore = minScoreRaw !== null && minScoreRaw.trim() !== "" ? Number(minScoreRaw) : undefined;
    const sort = url.searchParams.get("sort") === "created" ? "created" : "score";
    const page = Number(url.searchParams.get("page") ?? "1");
    const pageSize = Number(url.searchParams.get("pageSize") ?? "25");

    const result = await listReviewQueue({
      userId: user.id,
      campaignId,
      status,
      kind,
      minScore: Number.isFinite(minScore) ? minScore : undefined,
      sort,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 25,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
