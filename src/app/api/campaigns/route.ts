import { NextResponse } from "next/server";
import { createCampaign, listCampaigns } from "@/lib/services/campaign";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";

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

    const campaign = await createCampaign(body, user.id);
    return NextResponse.json(campaign, { status: 201 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const campaigns = await listCampaigns(user.id);
    return NextResponse.json(campaigns);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
