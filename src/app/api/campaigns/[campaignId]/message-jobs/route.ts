import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import {
  createBulkMessageJob,
  listCampaignBulkJobs,
} from "@/lib/services/messaging/bulk-messaging-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;

    let body: {
      leadIds?: string[];
      selection?: "selected" | "allEligible";
      filters?: Record<string, unknown>;
      templateId?: string;
      senderAccountId?: string;
    } | null = null;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const { leadIds, selection, filters, templateId, senderAccountId } = body || {};

    if (!templateId) {
      return apiError(400, "MISSING_FIELD", "templateId is required.");
    }

    const result = await createBulkMessageJob(
      campaignId,
      {
        templateId,
        leadIds,
        selection,
        filters,
        senderAccountId,
      },
      user.id,
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;

    const jobs = await listCampaignBulkJobs(campaignId, user.id);
    return NextResponse.json({ jobs });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
