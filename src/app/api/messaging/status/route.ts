import { NextResponse } from "next/server";
import { getMessagingStatus } from "@/lib/services/messaging";
import { handleRouteError } from "@/lib/errors";

import { requireAuth } from "@/lib/services/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAuth(request);
    const status = await getMessagingStatus();
    return NextResponse.json({
      provider: status.provider,
      authenticated: status.authenticated,
      status: status.status,
      message: status.message,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
