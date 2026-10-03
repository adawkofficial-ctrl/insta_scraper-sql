import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { revokeApproval } from "@/lib/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ draftId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { draftId } = await context.params;
    const result = await revokeApproval({ userId: user.id, draftId });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
