import { NextResponse } from "next/server";
import { getDashboardOverview } from "@/lib/services/analytics";
import { handleRouteError } from "@/lib/errors";

import { requireAuth } from "@/lib/services/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const overview = await getDashboardOverview(user.id);
    return NextResponse.json(overview);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
