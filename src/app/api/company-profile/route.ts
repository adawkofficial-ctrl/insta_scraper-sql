import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { apiError, handleRouteError } from "@/lib/errors";
import {
  getCompanyProfile,
  getCompanyProfileCompletenessForUser,
  upsertCompanyProfile,
} from "@/lib/services/company-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const [profile, completeness] = await Promise.all([
      getCompanyProfile(user.id),
      getCompanyProfileCompletenessForUser(user.id),
    ]);
    return NextResponse.json({ profile, completeness });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }
    const profile = await upsertCompanyProfile(user.id, body);
    const completeness = await getCompanyProfileCompletenessForUser(user.id);
    return NextResponse.json({ profile, completeness });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
