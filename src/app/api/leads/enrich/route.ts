import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { enrichLeadsOnDemand } from "@/lib/services/scraper/profile-enrichment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const { leadIds, leadId } = (body as { leadIds?: string[]; leadId?: string }) || {};
    const ids: string[] = Array.isArray(leadIds)
      ? leadIds
      : typeof leadId === "string" && leadId.trim()
        ? [leadId.trim()]
        : [];

    if (ids.length === 0) {
      return apiError(400, "INVALID_INPUT", "Must provide 'leadIds' array or 'leadId' string.");
    }

    const result = await enrichLeadsOnDemand({
      leadIds: ids,
      userId: user.id,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
