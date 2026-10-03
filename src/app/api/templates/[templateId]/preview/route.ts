import { NextResponse } from "next/server";

import { previewTemplateForLeads } from "@/lib/services/template";
import { requireAuth } from "@/lib/services/auth";
import { apiError, handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ templateId: string }>;
};

/**
 * POST /api/templates/[templateId]/preview
 *
 * Draft preview ONLY: renders the template against real campaign leads using
 * actual Lead data. Never creates or dispatches a message.
 */
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

    const { templateId } = await context.params;
    const result = await previewTemplateForLeads(templateId, body, user.id);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
