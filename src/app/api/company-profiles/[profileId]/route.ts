import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { apiError, handleRouteError, NotFoundError } from "@/lib/errors";
import {
  deleteCompanyProfile,
  getCompanyProfileCompleteness,
  getCompanyProfileRecordById,
  toCompanyProfileDto,
  updateCompanyProfile,
} from "@/lib/services/company-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ profileId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { profileId } = await context.params;
    const record = await getCompanyProfileRecordById(profileId, user.id);
    if (!record) {
      throw new NotFoundError(
        "PROFILE_NOT_FOUND",
        `Company profile "${profileId}" was not found.`,
      );
    }
    const profile = toCompanyProfileDto(record);
    const completeness = getCompanyProfileCompleteness(record);
    return NextResponse.json({ profile, completeness });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { profileId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const profile = await updateCompanyProfile(user.id, profileId, body);
    const completeness = getCompanyProfileCompleteness({
      ...profile,
      userId: user.id,
      services: profile.services,
      preferredLength: profile.preferredLength,
      exampleMessages: profile.exampleMessages,
      createdAt: new Date(profile.createdAt),
      updatedAt: new Date(profile.updatedAt),
    });
    return NextResponse.json({ profile, completeness });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { profileId } = await context.params;
    const result = await deleteCompanyProfile(user.id, profileId);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
