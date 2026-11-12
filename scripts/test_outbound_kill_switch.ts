import "dotenv/config";
(process.env as Record<string, string>).NODE_ENV = "test";
import assert from "node:assert";

// Mock server-only before importing server code
try {
  const serverOnlyPath = require.resolve("server-only");
  require.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    exports: {},
  } as unknown as NodeModule;
} catch {}

async function run() {
  const {
    canSendNow,
    reserveSendSlot,
    isOutboundSendingEnabled,
    setOutboundSendingEnabledForTesting,
    isDryRunLead,
    setSendGateClock,
  } = await import("../src/lib/services/messaging/send-gate");
  const { GET: readyProbe } = await import("../src/app/api/health/ready/route");

  console.log("=== OUTBOUND KILL SWITCH & DRY-RUN LEAD GUARD TEST SUITE ===");

  // Ensure consistent 12:00 working hour clock for tests
  setSendGateClock(() => new Date(2026, 4, 15, 12, 0, 0));

  let passed = 0;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Kill switch defaults to false when OUTBOUND_SENDING_ENABLED="false"
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Kill switch blocking");
    setOutboundSendingEnabledForTesting(false);
    assert.strictEqual(isOutboundSendingEnabled(), false, "isOutboundSendingEnabled must be false");
    passed++;

    const check1 = await canSendNow("fake-sender-id");
    assert.strictEqual(check1.allowed, false, "canSendNow must not allow when kill switch is off");
    assert.strictEqual(check1.reason, "SENDING_DISABLED", "canSendNow reason must be SENDING_DISABLED");
    passed++;

    const reserve1 = await reserveSendSlot({
      senderAccountId: "fake-sender-id",
      campaignId: "fake-camp-id",
      leadId: "fake-lead-id",
    });
    assert.strictEqual(reserve1.success, false, "reserveSendSlot must fail when kill switch is off");
    assert.strictEqual(reserve1.allowed, false, "reserveSendSlot allowed must be false");
    assert.strictEqual(reserve1.reason, "SENDING_DISABLED", "reserveSendSlot reason must be SENDING_DISABLED");
    passed++;
    console.log("  PASS: Outbound sending is blocked when OUTBOUND_SENDING_ENABLED is false");

    // -------------------------------------------------------------------------
    // TEST 2: Kill switch allows sending when enabled
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Kill switch enabling");
    setOutboundSendingEnabledForTesting(true);
    assert.strictEqual(isOutboundSendingEnabled(), true, "isOutboundSendingEnabled must be true");
    passed++;

    // When enabled, evaluation proceeds beyond SENDING_DISABLED check
    const check2 = await canSendNow("fake-sender-id");
    assert.notStrictEqual(check2.reason, "SENDING_DISABLED", "Reason should no longer be SENDING_DISABLED when enabled");
    passed++;
    console.log("  PASS: Kill switch permits gate evaluation when enabled");

    // -------------------------------------------------------------------------
    // TEST 3: Dry-run lead detection and blocking
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Dry-run lead isolation guard");
    assert.strictEqual(isDryRunLead({ source: "dry_run" }), true, "source: dry_run must be identified as dry-run");
    assert.strictEqual(isDryRunLead({ source: "sample" }), true, "source: sample must be identified as dry-run");
    assert.strictEqual(isDryRunLead({ username: "sample_fitness_hub" }), true, "sample_ prefix must be identified as dry-run");
    assert.strictEqual(isDryRunLead({ source: "google_maps", username: "real_gym" }), false, "real lead must not be dry-run");
    passed++;

    // Even when kill switch is true, dry run leads MUST be blocked from sending
    setOutboundSendingEnabledForTesting(true);

    const checkDry1 = await canSendNow("fake-sender-id", { lead: { source: "dry_run" } });
    assert.strictEqual(checkDry1.allowed, false, "Dry run lead must not be allowed to send");
    assert.strictEqual(checkDry1.reason, "DRY_RUN_LEAD_CANNOT_BE_SENT", "Must report DRY_RUN_LEAD_CANNOT_BE_SENT");
    passed++;

    const checkDry2 = await canSendNow("fake-sender-id", { lead: { source: "sample" } });
    assert.strictEqual(checkDry2.allowed, false, "Sample lead must not be allowed to send");
    assert.strictEqual(checkDry2.reason, "DRY_RUN_LEAD_CANNOT_BE_SENT");
    passed++;

    const checkDry3 = await canSendNow("fake-sender-id", { lead: { username: "sample_crossfit" } });
    assert.strictEqual(checkDry3.allowed, false, "sample_ prefixed lead must not be allowed to send");
    assert.strictEqual(checkDry3.reason, "DRY_RUN_LEAD_CANNOT_BE_SENT");
    passed++;

    const reserveDry = await reserveSendSlot({
      senderAccountId: "fake-sender-id",
      campaignId: "fake-camp-id",
      leadId: "recipient-1",
      lead: { id: "recipient-1", source: "dry_run" },
    });
    assert.strictEqual(reserveDry.success, false, "reserveSendSlot must block dry run lead");
    assert.strictEqual(reserveDry.reason, "DRY_RUN_LEAD_CANNOT_BE_SENT");
    passed++;
    console.log("  PASS: Dry-run and sample leads are unconditionally blocked from outbound sending");

    // -------------------------------------------------------------------------
    // TEST 4: /api/health/ready reporting
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Readiness probe reporting");
    setOutboundSendingEnabledForTesting(false);
    const readyResDisabled = await readyProbe();
    const readyBodyDisabled = await readyResDisabled.json();
    assert.strictEqual(
      readyBodyDisabled.checks?.outbound_sending,
      "disabled",
      "Readiness probe must report outbound_sending='disabled'"
    );
    passed++;

    setOutboundSendingEnabledForTesting(true);
    const readyResEnabled = await readyProbe();
    const readyBodyEnabled = await readyResEnabled.json();
    assert.strictEqual(
      readyBodyEnabled.checks?.outbound_sending,
      "enabled",
      "Readiness probe must report outbound_sending='enabled'"
    );
    passed++;
    console.log("  PASS: /api/health/ready reports accurate outbound_sending state");

  } finally {
    // Clean up
    setOutboundSendingEnabledForTesting(null);
    setSendGateClock(null);
  }

  console.log("\n========================================");
  console.log("OUTBOUND KILL SWITCH SUITE: ALL PASSED");
  console.log(`PASSED: ${passed} | FAILED: 0`);
  console.log("========================================");
  process.exit(0);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
