import { NextResponse } from "next/server";
import {
  createCampaignTemplate,
  listCampaignTemplates,
} from "@/lib/services/template";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";

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
    const templates = await listCampaignTemplates(campaignId, user.id);
    return NextResponse.json(templates);
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const { campaignId } = await context.params;
    const template = await createCampaignTemplate(campaignId, body, user.id);
    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
