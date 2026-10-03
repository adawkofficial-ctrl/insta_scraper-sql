import { NextResponse } from "next/server";

import { getPrismaClient } from "@/lib/db/prisma";
import { getServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe: verifies required configuration and dependency availability
 * without exposing any secret values (only "configured"/"missing" states).
 */
export async function GET(): Promise<Response> {
  const isProduction = process.env.NODE_ENV === "production";
  const checks: Record<string, string> = {};
  let ready = true;

  if (getServerEnv("DATABASE_URL") === undefined) {
    checks.database_url = "missing";
    ready = false;
  } else {
    checks.database_url = "configured";
  }

  const authSecret = getServerEnv("AUTH_SECRET");
  if (authSecret === undefined || authSecret.length < 32) {
    checks.auth_secret = isProduction ? "missing" : "development-fallback";
    if (isProduction) ready = false;
  } else {
    checks.auth_secret = "configured";
  }

  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    checks.database = "connected";
  } catch {
    checks.database = "disconnected";
    ready = false;
  }

  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      timestamp: new Date().toISOString(),
      checks,
    },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    },
  );
}
