import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { clearPossibleDuplicateFlag } from "@/lib/services/dedup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ leadId: string }>;
};

/**
 * Explicit user action: mark a "possible duplicate" lead as NOT a duplicate.
 * Clears the soft-duplicate flag only; never merges or deletes anything.
 */
export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { leadId } = await context.params;
    const result = await clearPossibleDuplicateFlag(leadId, user.id);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
