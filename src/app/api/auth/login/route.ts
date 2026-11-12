import { NextResponse } from "next/server";
import { loginUser, SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "@/lib/services/auth";
import { checkAuthRateLimit, getClientIp } from "@/lib/services/auth/rate-limiter";
import { handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_JSON",
            message: "Invalid JSON request body.",
          },
        },
        { status: 400 },
      );
    }

    const payload = (body && typeof body === "object" ? body : {}) as { email?: string; password?: string };

    // Rate limit: 5 attempts per 15 minutes per IP and email
    const clientIp = getClientIp(request);
    const rateCheck = checkAuthRateLimit("login", clientIp, payload.email);

    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many login attempts. Please try again later.",
          },
        },
        {
          status: 429,
          headers: {
            "Retry-After": Math.ceil(rateCheck.resetMs / 1000).toString(),
          },
        },
      );
    }

    const { user, token } = await loginUser(
      (body && typeof body === "object" ? body : {}) as { email?: string; password?: string },
    );

    const response = NextResponse.json(
      {
        user,
        token,
      },
      { status: 200 },
    );

    response.cookies.set(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
    return response;
  } catch (error) {
    return handleRouteError(request, error);
  }
}
