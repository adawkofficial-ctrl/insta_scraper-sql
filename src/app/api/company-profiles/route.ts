import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { apiError, handleRouteError } from "@/lib/errors";
import {
  createCompanyProfile,
  getCompanyProfileCompleteness,
  listCompanyProfiles,
} from "@/lib/services/company-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const profiles = await listCompanyProfiles(user.id);
    return NextResponse.json({ profiles });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const profile = await createCompanyProfile(user.id, body);
    const completeness = getCompanyProfileCompleteness({
      ...profile,
      userId: user.id,
      services: profile.services,
      preferredLength: profile.preferredLength,
      exampleMessages: profile.exampleMessages,
      createdAt: new Date(profile.createdAt),
      updatedAt: new Date(profile.updatedAt),
    });
    return NextResponse.json({ profile, completeness }, { status: 201 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
