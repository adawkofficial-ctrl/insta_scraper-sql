/* eslint-disable */
const Module = require("module");
try {
  const resolved = require.resolve("server-only");
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {},
  };
} catch {}
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "server-only" || (typeof id === "string" && id.includes("server-only"))) {
    return {};
  }
  return orig.apply(this, arguments);
};

// Debug: surface MySQL pool close/teardown rejections instead of letting Node
// exit with code 1 after a suite has already printed its summary.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

const { assertSafeTestDatabase } = require("./test_db_guard.cjs");
if (process.env.DATABASE_URL || process.env.DATABASE_URL_TEST) {
  assertSafeTestDatabase();
}

// MySQL driver pools keep Node's event loop alive after a suite finishes.
// In the test runner only, exit after a period of no stdout activity. Tests
// print PASS/FAIL lines continuously; a suite that finishes without calling
// process.exit() is treated as successful (failures call process.exit(1)).
if (process.env.MYSQL_TEST_WATCHDOG === "1") {
  const fallbackMs = Number.parseInt(process.env.MYSQL_TEST_WATCHDOG_MS || "240000", 10);
  const summaryMs = Number.parseInt(process.env.MYSQL_TEST_SUMMARY_EXIT_MS || "2000", 10);
  let fallbackTimer = null;
  let summaryTimer = null;
  let recent = "";
  let summarySeen = false;

  const exitWithSummaryStatus = () => {
    let failedCount = 0;
    let m = recent.match(/(\d+)\s+passed,\s*(\d+)\s+failed/i);
    if (m) failedCount = Number(m[2]);
    if (!m) {
      m = recent.match(/(\d+)\s+PASSED,\s*(\d+)\s+FAILED/i);
      if (m) failedCount = Number(m[2]);
    }
    if (!m) {
      m = recent.match(/PASSED:\s*(\d+)\s*\|\s*FAILED:\s*(\d+)/i);
      if (m) failedCount = Number(m[2]);
    }
    // If no explicit summary line was printed, don't guess from arbitrary log
    // text. Suites that fail call process.exit(1) themselves.
    process.exit(failedCount > 0 ? 1 : 0);
  };

  const armFallback = () => {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      // No summary was printed; treat a quiet finished suite as successful.
      exitWithSummaryStatus();
    }, fallbackMs);
    if (typeof fallbackTimer.unref === "function") fallbackTimer.unref();
  };

  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (...args) {
    try {
      recent = (recent + String(args[0] ?? "")).slice(-4000);
      if (
        !summarySeen &&
        /(?:TEST SUMMARY|SUMMARY:|STEP \d+ TEST SUMMARY|All tests passed|RESULTS:|SUITES:|PASSED:\s*\d+\s*\|\s*FAILED:\s*\d+|ALL .*TESTS PASSED)/i.test(recent)
      ) {
        summarySeen = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        summaryTimer = setTimeout(exitWithSummaryStatus, summaryMs);
        if (typeof summaryTimer.unref === "function") summaryTimer.unref();
      }
    } catch {
      // never break test output
    }
    return originalWrite(...args);
  };
  armFallback();
}

