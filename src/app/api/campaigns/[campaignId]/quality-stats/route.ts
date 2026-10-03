import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { getReviewStats } from "@/lib/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ campaignId: string }> };

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;
    const url = new URL(request.url);
    const stats = await getReviewStats({
      userId: user.id,
      campaignId,
      from: parseDate(url.searchParams.get("from")),
      to: parseDate(url.searchParams.get("to")),
    });
    return NextResponse.json(stats);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
