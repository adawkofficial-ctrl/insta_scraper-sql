import { NextResponse } from "next/server";
import { loginUser, SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "@/lib/services/auth";
import { checkRateLimit, getClientIp } from "@/lib/services/auth/rate-limiter";
import { handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    // Rate limit: 10 attempts per minute per IP
    const clientIp = getClientIp(request);
    const rateCheck = checkRateLimit(`login:${clientIp}`, 10, 60_000);

    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many login attempts. Please try again in a few moments.",
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
