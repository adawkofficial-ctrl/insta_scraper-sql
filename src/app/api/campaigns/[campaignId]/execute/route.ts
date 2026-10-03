import { NextResponse } from "next/server";
import { startCampaignExecution } from "@/lib/services/execution";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);

    let body: unknown = undefined;
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      try {
        body = await request.json();
      } catch {
        return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
      }
    }

    const { campaignId } = await context.params;

    let templateId: string | undefined;
    let rerun = false;

    if (body && typeof body === "object" && !Array.isArray(body)) {
      const rec = body as Record<string, unknown>;
      if (typeof rec.templateId === "string" && rec.templateId.trim()) {
        templateId = rec.templateId.trim();
      }
      if (rec.rerun === true) {
        rerun = true;
      }
    }

    const result = await startCampaignExecution(campaignId, user.id, { templateId, rerun });
    return NextResponse.json(result, { status: result.isNew ? 201 : 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
