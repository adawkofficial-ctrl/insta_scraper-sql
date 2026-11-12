/**
 * Preflight verification script.
 * Runs before any real manual discovery or sending run.
 * Checks environment, DB isolation, migration status, credentials, and cost guards.
 *
 * Usage: npm run preflight (or npx tsx scripts/preflight.ts)
 */

import { execSync } from "node:child_process";
import * as dotenv from "dotenv";
dotenv.config();

// Stub server-only for standalone script execution
try {
  const serverOnlyPath = require.resolve("server-only");
  require.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    exports: {},
  } as unknown as NodeModule;
} catch {}

type CheckResult = {
  item: string;
  status: "PASS" | "FAIL" | "WARN";
  detail: string;
  isBlocker?: boolean;
};

async function runPreflight() {
  console.log("=================================================");
  console.log("         SYSTEM PREFLIGHT READINESS CHECK        ");
  console.log("=================================================");

  const { getPrismaClient } = await import("../src/lib/db/prisma");
  const { isOutboundSendingEnabled } = await import("../src/lib/services/messaging");

  const results: CheckResult[] = [];
  const prisma = getPrismaClient();

  // 1. NODE_ENV
  const nodeEnv = process.env.NODE_ENV || "development";
  results.push({
    item: "NODE_ENV",
    status: "PASS",
    detail: nodeEnv,
  });

  // 2. Database URL & Isolation Check
  const dbUrl = process.env.DATABASE_URL || "";
  let dbName = "unknown";
  try {
    const url = new URL(dbUrl);
    dbName = url.pathname.replace(/^\//, "");
  } catch {
    const match = dbUrl.match(/\/([^/?]+)(\?|$)/);
    if (match) dbName = match[1];
  }

  const isTestDb = dbName === "insta_scraper_test" || dbName.includes("test");
  if (isTestDb && nodeEnv !== "test") {
    results.push({
      item: "Database Target",
      status: "FAIL",
      detail: `Targeting test DB (${dbName}) outside test environment!`,
      isBlocker: true,
    });
  } else {
    results.push({
      item: "Database Target",
      status: "PASS",
      detail: `${dbName} (isolated from test DB)`,
    });
  }

  // 3. Database Migration Status
  try {
    const migrationOutput = execSync("npx prisma migrate status", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    if (
      migrationOutput.includes("Database schema is up to date") ||
      migrationOutput.includes("following migration have not yet been applied") === false
    ) {
      results.push({
        item: "Migrations Status",
        status: "PASS",
        detail: "Schema is up to date",
      });
    } else {
      results.push({
        item: "Migrations Status",
        status: "FAIL",
        detail: "Unapplied migrations detected",
        isBlocker: true,
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Database schema is up to date")) {
      results.push({
        item: "Migrations Status",
        status: "PASS",
        detail: "Schema is up to date",
      });
    } else {
      results.push({
        item: "Migrations Status",
        status: "FAIL",
        detail: "Migration check failed (run `npx prisma migrate status`)",
        isBlocker: true,
      });
    }
  }

  // 4. APIFY Token
  const apifyToken = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN;
  const hasApifyToken = Boolean(apifyToken && apifyToken.trim().length > 0);
  results.push({
    item: "APIFY_TOKEN",
    status: hasApifyToken ? "PASS" : "FAIL",
    detail: hasApifyToken ? "set" : "missing",
    isBlocker: !hasApifyToken,
  });

  // 5. Gemini API Key
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const hasGeminiKey = Boolean(geminiKey && geminiKey.trim().length > 0);
  results.push({
    item: "GEMINI_API_KEY",
    status: hasGeminiKey ? "PASS" : "WARN",
    detail: hasGeminiKey ? "set" : "missing (discovery can run without Gemini)",
  });

  // 6. Apify Dry Run
  const wantsRealRun = process.argv.includes("--real");
  const isApifyDryRun = process.env.APIFY_DRY_RUN === "true" || process.env.APIFY_DRY_RUN === "1";
  if (wantsRealRun && isApifyDryRun) {
    results.push({
      item: "Apify Dry Run Mode",
      status: "FAIL",
      detail: "BLOCKED: --real run requested, but APIFY_DRY_RUN is enabled! Set APIFY_DRY_RUN=false in .env before running a live scrape.",
      isBlocker: true,
    });
  } else {
    results.push({
      item: "Apify Dry Run Mode",
      status: isApifyDryRun ? "WARN" : "PASS",
      detail: isApifyDryRun ? "ON (APIFY_DRY_RUN=true - real paid scraping disabled)" : "OFF (Live paid scraping enabled)",
    });
  }

  // 7. Unipile Mocks & Gemini Mocks
  const isUnipileMock = process.env.MOCK_UNIPILE === "true";
  const isGeminiMock = process.env.MOCK_GEMINI === "true";
  results.push({
    item: "Provider Mocks",
    status: isUnipileMock || isGeminiMock ? "WARN" : "PASS",
    detail: `Unipile Mock: ${isUnipileMock ? "ON" : "OFF"}, Gemini Mock: ${isGeminiMock ? "ON" : "OFF"}`,
  });

  // 8. Outbound Sending Kill Switch
  const sendingEnabled = isOutboundSendingEnabled();
  results.push({
    item: "OUTBOUND_SENDING_ENABLED",
    status: "PASS",
    detail: sendingEnabled ? "true (SENDING ACTIVE)" : "false (SENDING DISABLED - Stage 2 Discovery Only)",
  });

  // 9. Connected Sender Accounts
  try {
    const connectedSenders = await prisma.instagramSenderAccount.count({
      where: { status: "CONNECTED" },
    });
    const totalSenders = await prisma.instagramSenderAccount.count();
    results.push({
      item: "Sender Accounts",
      status: connectedSenders > 0 ? "PASS" : "WARN",
      detail: `${connectedSenders} connected (${totalSenders} total registered)`,
    });
  } catch (err) {
    results.push({
      item: "Sender Accounts",
      status: "WARN",
      detail: `Could not query sender accounts: ${(err as Error).message}`,
    });
  }

  // 10. Cost Ceilings
  const maxJobUsd = Number.parseFloat(process.env.DISCOVERY_MAX_JOB_USD || "0.60");
  const stage = process.env.DISCOVERY_STAGE || "pilot_small";
  const maxPlaces = Number.parseInt(process.env.GMAPS_MAX_TOTAL_PLACES || "15", 10);
  const maxCities = Number.parseInt(process.env.GMAPS_MAX_CITIES || "1", 10);
  const maxLeads = stage === "pilot_small" ? 10 : 100;

  results.push({
    item: "Cost Ceilings",
    status: "PASS",
    detail: `Max Job: $${maxJobUsd.toFixed(2)} | Max Places: ${maxPlaces} | Max Cities: ${maxCities} | Stage: ${stage} (maxLeads=${maxLeads})`,
  });

  // 11. DB Connection Probe (Readiness)
  try {
    await prisma.$queryRaw`SELECT 1`;
    results.push({
      item: "DB Connection Probe",
      status: "PASS",
      detail: "PostgreSQL responding cleanly",
    });
  } catch (err) {
    results.push({
      item: "DB Connection Probe",
      status: "FAIL",
      detail: `PostgreSQL connection failed: ${(err as Error).message}`,
      isBlocker: true,
    });
  }

  // Print Summary Table
  console.log("\nCHECKLIST:");
  let hasBlocker = false;
  for (const r of results) {
    const badge = r.status === "PASS" ? " [PASS] " : r.status === "FAIL" ? "![FAIL]!" : " [WARN] ";
    console.log(`${badge} ${r.item.padEnd(26)} : ${r.detail}`);
    if (r.status === "FAIL" && r.isBlocker) {
      hasBlocker = true;
    }
  }

  console.log("\n=================================================");
  if (hasBlocker) {
    console.error(" PREFLIGHT CHECK FAILED: Resolve blockers above before running.");
    console.log("=================================================\n");
    process.exit(1);
  } else {
    console.log(" PREFLIGHT CHECK PASSED: Ready for Stage 2 discovery run.");
    console.log("=================================================\n");
    process.exit(0);
  }
}

runPreflight().catch((err) => {
  console.error("Preflight fatal error:", err);
  process.exit(1);
});
