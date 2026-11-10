export const SESSION_COOKIE_NAME = "insta_session";

export const DEFAULT_AUTH_SECRET =
  "insta_scraper_default_super_secret_signing_key_32_chars";

/**
 * Whether to mark session cookies as Secure.
 *
 * Defaults to true in production. If you are serving the app over plain HTTP
 * (e.g. behind a LAN proxy or on a non-HTTPS dev/staging host), set the
 * environment variable  COOKIE_SECURE=false  to allow the browser to store
 * the cookie over HTTP.  Never set this to false in a public HTTPS deployment.
 */
function isCookieSecure(): boolean {
  // Explicit override wins
  const override = process.env.COOKIE_SECURE;
  if (override !== undefined) {
    return override.trim().toLowerCase() !== "false";
  }
  return process.env.NODE_ENV === "production";
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  get secure() {
    return isCookieSecure();
  },
  sameSite: "lax" as const,
  path: "/",
  maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
};

export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "AUTH_SECRET must be configured (at least 32 characters) in production.",
      );
    }
    return DEFAULT_AUTH_SECRET;
  }
  return secret;
}

export function getAuthSecretBytes(): Uint8Array {
  return new TextEncoder().encode(getAuthSecret());
}
