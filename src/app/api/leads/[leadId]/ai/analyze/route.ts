import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { analyzeLead } from "@/lib/services/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ leadId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { leadId } = await context.params;
    let body: { force?: boolean } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }
    const result = await analyzeLead({
      userId: user.id,
      leadId,
      force: body.force === true,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
