import { NextResponse } from "next/server";

import { getPrismaClient, checkPrismaClientDbSync } from "@/lib/db/prisma";
import { getServerEnv } from "@/lib/env";
import { isOutboundSendingEnabled } from "@/lib/services/messaging";
import { getActiveProviderSummary } from "@/lib/services/scraper/provider-switch";

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
    checks.auth_secret = isProduction ? "missing_or_too_short" : "development-fallback";
    if (isProduction) ready = false;
  } else {
    checks.auth_secret = "configured";
  }

  const adminPassword = getServerEnv("ADMIN_PASSWORD") || process.env.ADMIN_PASSWORD;
  const weakAdminPasswords = new Set([
    "admin",
    "password",
    "12345678",
    "AdminPass2026!Secure",
    "Admin123!",
    "ChangeMe123!",
    "root",
    "adminpass",
  ]);
  if (!adminPassword || adminPassword.length < 8 || weakAdminPasswords.has(adminPassword)) {
    checks.admin_password = isProduction ? "weak_or_default" : "development-default";
    if (isProduction) ready = false;
  } else {
    checks.admin_password = "configured";
  }

  const disableRateLimit = process.env.DISABLE_AUTH_RATE_LIMIT;
  if (disableRateLimit && disableRateLimit !== "0" && disableRateLimit !== "false") {
    checks.rate_limiting = isProduction ? "disabled_in_production" : "disabled";
    if (isProduction) ready = false;
  } else {
    checks.rate_limiting = "enforced";
  }

  const cookieSecure = process.env.COOKIE_SECURE;
  if (cookieSecure === "false" || cookieSecure === "0") {
    checks.cookie_secure = isProduction ? "insecure_http_rejected" : "insecure_http_allowed";
    if (isProduction) ready = false;
  } else {
    checks.cookie_secure = "secure";
  }

  // Provider configuration presence checks (presence only, no live calls)
  checks.provider_apify = Boolean(process.env.APIFY_API_TOKEN) ? "configured" : "missing";
  checks.provider_gemini = Boolean(process.env.GEMINI_API_KEY) ? "configured" : "missing";
  checks.provider_sparior = Boolean(process.env.SPARIOR_API_KEY) ? "configured" : "missing";
  checks.provider_unipile = Boolean(process.env.UNIPILE_API_KEY && process.env.UNIPILE_DSN) ? "configured" : "missing";

  // Active provider modes (informational only; no live calls, no secrets)
  try {
    const providers = getActiveProviderSummary();
    checks.discovery_provider = providers.discoveryProvider;
    checks.enrichment_provider = providers.enrichmentProvider;
    checks.discovery_actor = providers.discoveryActor;
    checks.enrichment_actor = providers.enrichmentActor;
    checks.disabled_actors = [
      providers.mapsActorDisabled ? "google_maps" : null,
      providers.profileActorDisabled ? "instagram_profile_scraper" : null,
    ]
      .filter(Boolean)
      .join(",") || "none";
  } catch {
    checks.discovery_provider = "invalid_config";
    ready = false;
  }

  // Global sending kill switch (informational check)
  checks.outbound_sending = isOutboundSendingEnabled() ? "enabled" : "disabled";

  // Production Safety: Mock mode or dry run flags are strictly prohibited in production
  if (isProduction) {
    if (process.env.MOCK_UNIPILE === "1") {
      checks.mock_unipile = "mock_mode_prohibited_in_production";
      ready = false;
    }
    if (process.env.APIFY_DRY_RUN === "true" || process.env.APIFY_DRY_RUN === "1") {
      checks.apify_dry_run = "dry_run_prohibited_in_production";
      ready = false;
    }
    if (process.env.MOCK_GEMINI === "1") {
      checks.mock_gemini = "mock_mode_prohibited_in_production";
      ready = false;
    }
  }

  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    checks.database = "connected";

    // Check database migration table status
    try {
      const migrations = await getPrismaClient().$queryRaw<Array<{ migration_name: string; rolled_back_at: Date | null }>>`
        SELECT migration_name, rolled_back_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1
      `;
      if (migrations && migrations.length > 0 && !migrations[0].rolled_back_at) {
        checks.database_migrations = "up_to_date";
      } else {
        checks.database_migrations = "pending_or_rolled_back";
        if (isProduction) ready = false;
      }
    } catch {
      checks.database_migrations = "unverified";
    }

    // Verify generated Prisma Client matches DB columns (e.g. isDryRun, campaignId)
    const syncCheck = await checkPrismaClientDbSync();
    if (syncCheck.synced) {
      checks.client_schema_sync = "synced";
    } else {
      checks.client_schema_sync = "run prisma generate / migrate deploy";
      ready = false;
    }
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
