import { NextResponse } from "next/server";
import { approveExecutionItem } from "@/lib/services/execution";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ executionId: string; itemId: string }>;
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

    const { executionId, itemId } = await context.params;
    const result = await approveExecutionItem(executionId, itemId, body, user.id);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
