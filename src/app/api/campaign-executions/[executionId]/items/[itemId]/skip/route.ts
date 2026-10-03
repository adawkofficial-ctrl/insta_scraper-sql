import { NextResponse } from "next/server";
import { skipExecutionItem } from "@/lib/services/execution";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";

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
    const { executionId, itemId } = await context.params;
    const result = await skipExecutionItem(executionId, itemId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
