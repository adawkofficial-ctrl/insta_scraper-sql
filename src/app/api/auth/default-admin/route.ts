import { NextResponse } from "next/server";
import { getAdminCredentials } from "@/lib/env";
import { ensureAdminUser } from "@/lib/services/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns the configured default administrator account details from .env.
 * Automatically ensures the administrator account exists in the database.
 */
export async function GET(): Promise<Response> {
  const isDevMode = process.env.NODE_ENV !== "production";
  const { email, password } = getAdminCredentials();

  // Lazily ensure the admin user exists in DB with the latest credentials
  try {
    await ensureAdminUser();
  } catch {
    // Non-fatal if DB is temporarily unreachable during preflight
  }

  return NextResponse.json({
    email,
    password: isDevMode ? password : "",
  });
}
