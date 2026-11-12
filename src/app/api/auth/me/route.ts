import { NextResponse } from "next/server";
import {
  requireAuth,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      role: user.role,
      createdAt: user.createdAt,
    });
  } catch (error) {
    const errorResponse = handleRouteError(request, error);
    // Clear stale or invalid session cookie to prevent infinite redirect loops
    errorResponse.cookies.set(SESSION_COOKIE_NAME, "", {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: 0,
      expires: new Date(0),
    });
    return errorResponse;
  }
}
