import { NextResponse } from "next/server";
import { recoverStaleCampaignExecutions } from "@/lib/services/execution";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    // Scoped to the caller's own executions (tenant isolation).
    const result = await recoverStaleCampaignExecutions(undefined, user.id);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
