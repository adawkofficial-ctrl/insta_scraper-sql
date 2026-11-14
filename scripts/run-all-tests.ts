/**
 * TASK 13 — unified test runner.
 *
 * Reuses the project's existing tsx-based suites (no new framework). Suites that
 * need the dev server are marked `needsServer`; suites that call Apify or a real
 * browser are only executed when RUN_EXTERNAL=1, otherwise they are reported as
 * SKIPPED (external) — never silently counted as passing.
 *
 * Usage:
 *   npm test                 (always starts its own isolated server on a free port)
 *   RUN_EXTERNAL=1 npm test  (also run Apify/browser suites)
 */
import "dotenv/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl, assertSafeTestDatabase, extractDatabaseName } = require("./test_db_guard.cjs");

// Enforce test database isolation. Tests must always target the dedicated test DB.
const REQUIRED_TEST_DB_NAME = "insta_scraper_mysql_test";
const testDatabaseUrl = getTestDatabaseUrl();
assertSafeTestDatabase(testDatabaseUrl, { prodDbUrl: process.env.DATABASE_URL, nodeEnv: process.env.NODE_ENV });
const testDbName = extractDatabaseName(testDatabaseUrl);
if (testDbName !== REQUIRED_TEST_DB_NAME) {
  console.error(
    `FATAL: Tests must run against the dedicated test database "${REQUIRED_TEST_DB_NAME}", but DATABASE_URL_TEST resolves to "${testDbName || "<unknown>"}".`,
  );
  process.exit(1);
}
process.env.ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = testDatabaseUrl;
// The central factory prefers this local override; keep every suite pinned to
// the test DB rather than a developer's dev DB.
process.env.DATABASE_URL_MYSQL_LOCAL = testDatabaseUrl;


type Category = "unit" | "api" | "security" | "e2e";
type Kind = "deterministic" | "external-provider" | "browser";

type Suite = {
  file: string;
  category: Category;
  kind: Kind;
  needsServer: boolean;
  timeoutMs?: number;
};

type Result = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";

const RUN_EXTERNAL = process.env.RUN_EXTERNAL === "1";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function stopTestServer(proc: ChildProcess): void {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync(`taskkill /pid ${proc.pid} /T /F`, { shell: true, stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    // ignore
  }
}

async function getServerHealth(url: string): Promise<{ up: boolean; dbName: string | null }> {
  try {
    const res = await fetch(`${url}/api/health`);
    if (res.status !== 200) return { up: false, dbName: null };
    const body = (await res.json()) as { services?: { databaseName?: unknown } };
    const dbName = typeof body.services?.databaseName === "string" ? body.services.databaseName : null;
    return { up: true, dbName };
  } catch {
    return { up: false, dbName: null };
  }
}

async function serverUp(url: string): Promise<boolean> {
  return (await getServerHealth(url)).up;
}

function parseCounts(output: string): { passed: number | null; failed: number | null } {
  let m = output.match(/(\d+)\s+passed,\s+(\d+)\s+failed/i);
  if (m) return { passed: Number(m[1]), failed: Number(m[2]) };
  m = output.match(/(\d+)\s+PASSED,\s+(\d+)\s+FAILED/i);
  if (m) return { passed: Number(m[1]), failed: Number(m[2]) };
  m = output.match(/PASSED:\s*(\d+)\s*\|\s*FAILED:\s*(\d+)/i);
  if (m) return { passed: Number(m[1]), failed: Number(m[2]) };
  return { passed: null, failed: null };
}

function runSuite(suite: Suite, baseUrl: string): { result: Result; passed: number | null; failed: number | null; note: string } {
  // Relative, unquoted path: NODE_OPTIONS rejects quoted/space-containing values.
  const env = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    DATABASE_URL_MYSQL_LOCAL: testDatabaseUrl,
    NODE_ENV: "test" as const,
    TEST_BASE_URL: baseUrl,
    DISABLE_AUTH_RATE_LIMIT: "1",
    APIFY_DRY_RUN: "true",
    APIFY_ALLOW_LIVE_SCRIPTS: "false",
    APIFY_COST_LIMITS_ENABLED: "true",
    MOCK_GEMINI: "1",
    MOCK_UNIPILE: "1",
    APIFY_API_TOKEN: process.env.APIFY_API_TOKEN || "mock-apify-test-token",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "mock-gemini-test-key",
    UNIPILE_API_KEY: process.env.UNIPILE_API_KEY || "mock-unipile-test-key",
    SKIP_SEND_DELAYS: "1",
    OUTBOUND_SENDING_ENABLED: process.env.OUTBOUND_SENDING_ENABLED || "true",
    NODE_OPTIONS: "--require ./scripts/preload_server_only.cjs --max-old-space-size=4096",
  };
  const started = Date.now();
  const proc = spawnSync(
    `npx --yes tsx "scripts/${suite.file}"`,
    [],
    { shell: true, env, encoding: "utf8", timeout: suite.timeoutMs ?? 300000, maxBuffer: 20 * 1024 * 1024 },
  );
  const output = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  const { passed, failed } = parseCounts(output);
  const blocked = /ECONNREFUSED|fetch failed/i.test(output) && proc.status !== 0 && !failed;
  const result: Result = blocked ? "BLOCKED" : proc.status === 0 && (failed === null || failed === 0) ? "PASS" : "FAIL";
  const tail = result === "FAIL" ? output.trim().split("\n").slice(-3).join(" | ").slice(0, 300) : "";
  return {
    result,
    passed,
    failed,
    note: `exit=${proc.status} ${Math.round((Date.now() - started) / 1000)}s${tail ? ` :: ${tail}` : ""}`,
  };
}

const SUITES: Suite[] = [
  { file: "test_step1_schema.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step2_dnc.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step3_sparior.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task24_sparior_keyword_discovery.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task16_discovery_relevance.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task_intent_and_continuation.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_lead_discovery_gates.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_google_maps_discovery.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_gmaps_toronto_pipeline.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_google_maps_cost_reduction.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_email_channel.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_post_maps_pipeline.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_gmaps_handle_waterfall.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_dm_no_handle_block.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_handle_waterfall_fixes.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_enrichment_persistence_resume.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_website_enrichment.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_instagram_places_discovery.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_instagram_all_in_one.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_discovery_runaway_guard.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_apify_cost_guard.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_lead_pipeline_optimization.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_lead_quality_score.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_national_accounts_and_social_links.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_pre_enrichment_filter.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_lazy_profile_enrichment.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_enrichment_criteria_pipeline.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_contact_extraction_pipeline.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_ntfy_notifications.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step4_dedup.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step5_gemini.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step6_quality_approval.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step_company_profile_per_campaign.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_campaign_approval_ui.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task18_instagram_sender.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task20_sender_profile_launch.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task21_polling.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task23_dm_composer.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_unipile_integration.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_multi_account_round_robin.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_csv_upload_leads.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_lead_deletion.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_auth_production_readiness.ts", category: "security", kind: "deterministic", needsServer: false },
  { file: "test_admin_user_management.ts", category: "security", kind: "deterministic", needsServer: false },
  { file: "test_admin_env_auth.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step8_unipile_webhooks.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_step9_reply_intent_and_drafts.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step9_reply_send.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task22_campaign_no_poll.ts", category: "e2e", kind: "browser", needsServer: true },
  { file: "test_task17_bulk_template_loading.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_task18b_sender_api_idor.ts", category: "security", kind: "deterministic", needsServer: true },
  { file: "test_task19_sender_ui_lifecycle.ts", category: "e2e", kind: "browser", needsServer: true },
  { file: "test_task11_errors.ts", category: "security", kind: "deterministic", needsServer: true },
  { file: "test_task12_security_qa.ts", category: "security", kind: "deterministic", needsServer: true },
  { file: "test_task13_e2e_regression.ts", category: "e2e", kind: "deterministic", needsServer: true },
  { file: "test_task4_templates.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_task10_analytics_hardening.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_step11_auth.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_task2_rich_profile_leads.ts", category: "api", kind: "external-provider", needsServer: true },
  { file: "test_task3_lead_limits_hardening.ts", category: "api", kind: "external-provider", needsServer: true },
  { file: "test_step14_discovery.ts", category: "api", kind: "external-provider", needsServer: true },
  { file: "test_step15_e2e_discovery_flow.ts", category: "e2e", kind: "external-provider", needsServer: true },
  { file: "test_task5_single_lead_messaging.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_task6_bulk_messaging.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_task7_messaging_safety.ts", category: "security", kind: "deterministic", needsServer: true },
  { file: "test_outbound_send_safety.ts", category: "security", kind: "deterministic", needsServer: false },
  { file: "test_outcome_tracking_and_analytics.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_discovery_pipeline_stages.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_e2e_full_pipeline.ts", category: "e2e", kind: "deterministic", needsServer: false },
  { file: "test_follow_up_messages.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_pre_pilot_safety.ts", category: "security", kind: "deterministic", needsServer: false },
  { file: "test_outbound_kill_switch.ts", category: "security", kind: "deterministic", needsServer: false },
  { file: "test_dry_run_isolation_and_messages.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_discovery_fixes.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task8_execution_engine.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_task9_ui_execution_hardening.ts", category: "e2e", kind: "deterministic", needsServer: true },
];

async function main() {
  const port = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : await getFreePort();
  const baseUrl = `http://localhost:${port}`;
  let testServerProc: ChildProcess | null = null;

  // `next dev` appends its dist types to tsconfig.json / rewrites next-env.d.ts.
  // Snapshot them so the test run never leaves churn in the working tree.
  const generatedConfigFiles = ["tsconfig.json", "next-env.d.ts"].map((file) => {
    const filePath = path.join(process.cwd(), file);
    return { filePath, content: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null };
  });

  // Always launch a dedicated server. Never reuse a developer's running server
  // (it may point at the production database).
  console.log(`Starting isolated test server on ${baseUrl} (database=${testDbName})...`);

  const serverEnv = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: testDatabaseUrl,
    DATABASE_URL_MYSQL_LOCAL: testDatabaseUrl,
    NODE_ENV: "test" as const,
    APIFY_DRY_RUN: "true",
    APIFY_ALLOW_LIVE_SCRIPTS: "false",
    APIFY_COST_LIMITS_ENABLED: "true",
    MOCK_GEMINI: "1",
    MOCK_UNIPILE: "1",
    APIFY_API_TOKEN: process.env.APIFY_API_TOKEN || "mock-apify-test-token",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "mock-gemini-test-key",
    UNIPILE_API_KEY: process.env.UNIPILE_API_KEY || "mock-unipile-test-key",
    DISABLE_AUTH_RATE_LIMIT: "1",
    SKIP_SEND_DELAYS: "1",
    OUTBOUND_SENDING_ENABLED: "true",
    NEXT_DIST_DIR: ".next/test-runner",
    NODE_OPTIONS: "--max-old-space-size=4096",
  };

  const serverLogs: string[] = [];
  testServerProc = spawn("npx", ["next", "dev", "--webpack", "-p", String(port)], {
    shell: true,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  testServerProc.stdout?.on("data", (d) => serverLogs.push(d.toString()));
  testServerProc.stderr?.on("data", (d) => serverLogs.push(d.toString()));

  const cleanup = () => {
    if (testServerProc) {
      stopTestServer(testServerProc);
      testServerProc = null;
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(1); });
  process.on("SIGTERM", () => { cleanup(); process.exit(1); });

  const startWait = Date.now();
  let serverHealth: { up: boolean; dbName: string | null } = { up: false, dbName: null };
  while (Date.now() - startWait < 120000) {
    serverHealth = await getServerHealth(baseUrl);
    if (serverHealth.up) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!serverHealth.up) {
    console.error(`ERROR: Test server failed to respond on ${baseUrl}/api/health within 120s`);
    if (serverLogs.length > 0) {
      console.error("Test server output:\n" + serverLogs.join(""));
    }
    cleanup();
    process.exit(1);
  }

  // Refuse to test against a server that is not connected to the test DB.
  if (serverHealth.dbName !== REQUIRED_TEST_DB_NAME) {
    console.error(
      `FATAL: Test server reports database "${serverHealth.dbName ?? "<unknown>"}", expected "${REQUIRED_TEST_DB_NAME}". Refusing to run tests.`,
    );
    cleanup();
    process.exit(1);
  }
  console.log(`Test server is UP at ${baseUrl} (reported database=${serverHealth.dbName})`);

  try {
    const up = await serverUp(baseUrl);
    console.log("================================================================");
    console.log(" TASK 13 TEST RUNNER");
    console.log(` Server: ${baseUrl} (${up ? "UP" : "DOWN"})  RUN_EXTERNAL=${RUN_EXTERNAL}`);
    console.log(` Database: ${serverHealth.dbName} (verified via /api/health)`);
    console.log("================================================================");

    const rows: Array<Suite & { result: Result; passed: number | null; failed: number | null; note: string; dbName: string }> = [];
    const filter = process.env.SUITE_FILTER || process.argv[2];
    const suitesToRun = filter ? SUITES.filter((s) => s.file.includes(filter)) : SUITES;

    for (const suite of suitesToRun) {
      let result: Result;
      let passed: number | null = null;
      let failed: number | null = null;
      let note = "";

      if (!suite.needsServer || up) {
        if (suite.kind === "deterministic" || RUN_EXTERNAL) {
          const r = runSuite(suite, baseUrl);
          result = r.result;
          passed = r.passed;
          failed = r.failed;
          note = r.note;
        } else {
          result = "SKIPPED";
          note = `requires ${suite.kind === "browser" ? "authenticated browser session" : "real Apify provider"}`;
        }
      } else if (suite.needsServer) {
        result = "BLOCKED";
        note = "server not reachable";
      } else {
        result = "SKIPPED";
      }

      rows.push({ ...suite, result, passed, failed, note, dbName: testDbName });
      const counts = passed !== null ? ` (${passed} passed/${failed ?? 0} failed)` : "";
      console.log(`[${result.padEnd(7)}] ${suite.category.padEnd(8)} ${suite.file}${counts} ${note}`);
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      baseUrl,
      database: serverHealth.dbName,
      runExternal: RUN_EXTERNAL,
      totals: {
        pass: rows.filter((r) => r.result === "PASS").length,
        fail: rows.filter((r) => r.result === "FAIL").length,
        blocked: rows.filter((r) => r.result === "BLOCKED").length,
        skipped: rows.filter((r) => r.result === "SKIPPED").length,
        assertionsPassed: rows.reduce((a, r) => a + (r.passed ?? 0), 0),
        assertionsFailed: rows.reduce((a, r) => a + (r.failed ?? 0), 0),
      },
      suites: rows,
    };

    fs.writeFileSync(path.join(process.cwd(), "test-results.json"), JSON.stringify(summary, null, 2));

    console.log("----------------------------------------------------------------");
    console.log(
      ` SUITES: ${summary.totals.pass} PASS / ${summary.totals.fail} FAIL / ${summary.totals.blocked} BLOCKED / ${summary.totals.skipped} SKIPPED`,
    );
    console.log(
      ` ASSERTIONS: ${summary.totals.assertionsPassed} passed / ${summary.totals.assertionsFailed} failed`,
    );
    console.log(` DATABASE: ${summary.database} (all suites)`);
    const lastFour = rows.slice(-4);
    if (lastFour.length > 0) {
      console.log(" LAST 4 SUITES DATABASE:");
      for (const row of lastFour) {
        console.log(`   ${row.file} -> ${row.dbName}`);
      }
    }
    console.log("----------------------------------------------------------------");

    if (summary.totals.fail > 0 || summary.totals.blocked > 0) {
      process.exit(1);
    }
  } finally {
    if (testServerProc) {
      stopTestServer(testServerProc);
      testServerProc = null;
    }
    for (const snapshot of generatedConfigFiles) {
      if (snapshot.content === null) continue;
      try {
        if (fs.readFileSync(snapshot.filePath, "utf8") !== snapshot.content) {
          fs.writeFileSync(snapshot.filePath, snapshot.content);
        }
      } catch {
        // ignore restore failures
      }
    }
  }
}

main();
