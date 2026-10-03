import { NextResponse } from "next/server";
import { registerUser, SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const { user, token } = await registerUser(body);

    const response = NextResponse.json(
      {
        user,
        token,
      },
      { status: 201 },
    );

    response.cookies.set(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
    return response;
  } catch (error) {
    return handleRouteError(request, error);
  }
}
