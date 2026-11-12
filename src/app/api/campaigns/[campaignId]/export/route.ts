import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { exportCampaignLeads } from "@/lib/services/lead";

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
    const format = url.searchParams.get("format")?.toLowerCase() || "csv";
    const leadIdsParam = url.searchParams.get("leadIds");
    const leadIds = leadIdsParam
      ? leadIdsParam
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : undefined;

    const result = await exportCampaignLeads({
      campaignId,
      userId: user.id,
      leadIds,
    });

    if (format === "json") {
      return NextResponse.json(result);
    }

    return new NextResponse(result.csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
