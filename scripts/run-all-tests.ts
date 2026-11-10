/**
 * TASK 13 — unified test runner.
 *
 * Reuses the project's existing tsx-based suites (no new framework). Suites that
 * need the dev server are marked `needsServer`; suites that call Apify or a real
 * browser are only executed when RUN_EXTERNAL=1, otherwise they are reported as
 * SKIPPED (external) — never silently counted as passing.
 *
 * Usage:
 *   npm test                 (requires a running server at TEST_BASE_URL)
 *   RUN_EXTERNAL=1 npm test  (also run Apify/browser suites)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3005";
const RUN_EXTERNAL = process.env.RUN_EXTERNAL === "1";

const SUITES: Suite[] = [
  { file: "test_step1_schema.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step2_dnc.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step3_sparior.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task24_sparior_keyword_discovery.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task16_discovery_relevance.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task_intent_and_continuation.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_lead_pipeline_optimization.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_national_accounts_and_social_links.ts", category: "unit", kind: "deterministic", needsServer: false },
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
  { file: "test_auth_production_readiness.ts", category: "security", kind: "deterministic", needsServer: false },
  { file: "test_step8_unipile_webhooks.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_step9_reply_intent_and_drafts.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_step9_reply_send.ts", category: "unit", kind: "deterministic", needsServer: false },
  { file: "test_task22_campaign_no_poll.ts", category: "e2e", kind: "deterministic", needsServer: true },
  { file: "test_task17_bulk_template_loading.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_task18b_sender_api_idor.ts", category: "security", kind: "deterministic", needsServer: true },
  { file: "test_task19_sender_ui_lifecycle.ts", category: "e2e", kind: "deterministic", needsServer: true },
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
  { file: "test_task8_execution_engine.ts", category: "api", kind: "deterministic", needsServer: true },
  { file: "test_task9_ui_execution_hardening.ts", category: "e2e", kind: "deterministic", needsServer: true },
];

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.status === 200;
  } catch {
    return false;
  }
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

function runSuite(suite: Suite): { result: Result; passed: number | null; failed: number | null; note: string } {
  // Relative, unquoted path: NODE_OPTIONS rejects quoted/space-containing values.
  const env = {
    ...process.env,
    TEST_BASE_URL: BASE_URL,
    NODE_OPTIONS: "--require ./scripts/preload_server_only.cjs --max-old-space-size=4096",
  };
  const started = Date.now();
  const proc = spawnSync(
    `npx --yes tsx "scripts/${suite.file}"`,
    { shell: true, env, encoding: "utf8", timeout: suite.timeoutMs ?? 300000, maxBuffer: 20 * 1024 * 1024 },
  );
  const output = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  const { passed, failed } = parseCounts(output);
  const blocked = /ECONNREFUSED|fetch failed|server health/i.test(output) && proc.status !== 0;
  const result: Result = blocked ? "BLOCKED" : proc.status === 0 && (failed === null || failed === 0) ? "PASS" : "FAIL";
  const tail = result === "FAIL" ? output.trim().split("\n").slice(-3).join(" | ").slice(0, 300) : "";
  return {
    result,
    passed,
    failed,
    note: `exit=${proc.status} ${Math.round((Date.now() - started) / 1000)}s${tail ? ` :: ${tail}` : ""}`,
  };
}

async function main() {
  const up = await serverUp();
  console.log("================================================================");
  console.log(" TASK 13 TEST RUNNER");
  console.log(` Server: ${BASE_URL} (${up ? "UP" : "DOWN"})  RUN_EXTERNAL=${RUN_EXTERNAL}`);
  console.log("================================================================");

  const rows: Array<Suite & { result: Result; passed: number | null; failed: number | null; note: string }> = [];

  for (const suite of SUITES) {
    let result: Result;
    let passed: number | null = null;
    let failed: number | null = null;
    let note = "";

    if (!suite.needsServer || up) {
      if (suite.kind === "deterministic" || RUN_EXTERNAL) {
        const r = runSuite(suite);
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

    rows.push({ ...suite, result, passed, failed, note });
    const counts = passed !== null ? ` (${passed} passed/${failed ?? 0} failed)` : "";
    console.log(`[${result.padEnd(7)}] ${suite.category.padEnd(8)} ${suite.file}${counts} ${note}`);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
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
  console.log("----------------------------------------------------------------");

  if (summary.totals.fail > 0) process.exit(1);
}

main();
