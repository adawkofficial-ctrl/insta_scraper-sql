import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { getSpariorUsageSummary } from "@/lib/services/scraper/sparior";
import { handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);

    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from") ?? undefined;
    const to = searchParams.get("to") ?? undefined;

    const summary = await getSpariorUsageSummary({
      userId: user.id,
      from,
      to,
    });

    return NextResponse.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
