import { NextResponse } from "next/server";
import {
  getTemplateById,
  updateTemplate,
  deleteTemplate,
} from "@/lib/services/template";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ templateId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { templateId } = await context.params;
    const template = await getTemplateById(templateId, user.id);
    return NextResponse.json(template);
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

    const { templateId } = await context.params;
    const updated = await updateTemplate(templateId, body, user.id);
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
    const { templateId } = await context.params;
    const result = await deleteTemplate(templateId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
