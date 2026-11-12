import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import {
  SESSION_COOKIE_NAME,
  getAuthSecretBytes,
} from "@/lib/services/auth/auth-constants";

const REQUEST_ID_HEADER = "x-request-id";

async function isValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return false;
  try {
    const secretKey = getAuthSecretBytes();
    await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  // Correlation id: reused if the caller supplied one, otherwise generated.
  // Forwarded to route handlers (via request headers) and echoed on the
  // response so clients and server logs can correlate the same request.
  const requestId = req.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);

  const withRequestId = (response: NextResponse): NextResponse => {
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  };

  const forward = () =>
    NextResponse.next({ request: { headers: requestHeaders } });

  const { pathname } = req.nextUrl;

  // Ignore static assets, next internal files, and APIs
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api") ||
    pathname.includes(".") ||
    pathname === "/favicon.ico"
  ) {
    return withRequestId(forward());
  }

  const authenticated = await isValidSession(req);

  // Registration UI is disabled; redirect /register to /login
  if (pathname === "/register") {
    return withRequestId(NextResponse.redirect(new URL("/login", req.url)));
  }

  // Allow unauthenticated access to login page
  if (pathname === "/login") {
    if (authenticated && !req.nextUrl.searchParams.has("force")) {
      return withRequestId(NextResponse.redirect(new URL("/", req.url)));
    }
    return withRequestId(forward());
  }

  // All browser application pages require authentication
  if (!authenticated) {
    const loginUrl = new URL("/login", req.url);
    if (pathname !== "/" && pathname !== "/login" && pathname !== "/register") {
      loginUrl.searchParams.set("redirect", pathname);
    }
    return withRequestId(NextResponse.redirect(loginUrl));
  }

  return withRequestId(forward());
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
