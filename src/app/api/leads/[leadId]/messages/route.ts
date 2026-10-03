import { NextResponse } from "next/server";
import { getLeadMessages } from "@/lib/services/messaging";
import { handleRouteError } from "@/lib/errors";

import { requireAuth } from "@/lib/services/auth";

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
    const messages = await getLeadMessages(leadId, user.id);
    return NextResponse.json(messages);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
