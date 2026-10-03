import { NextResponse } from "next/server";
import {
  getLeadById,
  updateLead,
  deleteLead,
} from "@/lib/services/lead";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ leadId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { leadId } = await context.params;
    const lead = await getLeadById(leadId, user.id);
    return NextResponse.json(lead);
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function PATCH(
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

    const { leadId } = await context.params;
    const updated = await updateLead(leadId, body, user.id);
    return NextResponse.json(updated);
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { leadId } = await context.params;
    const result = await deleteLead(leadId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
