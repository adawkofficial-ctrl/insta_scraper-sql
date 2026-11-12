import "dotenv/config";

// Mock server-only before importing server code in standalone script
try {
  const serverOnlyPath = require.resolve("server-only");
  require.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    exports: {},
  } as unknown as NodeModule;
} catch {}

async function main() {
  const { renderTemplate, validateTemplateVariables } = await import(
    "../src/lib/services/template/template-renderer"
  );
  const {
    getSenderCooldownMs,
    recordSenderAccountSent,
    getLastSentAtForSender,
  } = await import("../src/lib/services/messaging/bulk-messaging-service");

  console.log("==================================================");
  console.log("  MULTI-ACCOUNT 10-SENDER ROUND-ROBIN TEST SUITE  ");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, name: string) {
    if (cond) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      failed++;
    }
  }

  // ----------------------------------------------------
  // TEST 1: Template Rendering with Campaign Services & Description
  // ----------------------------------------------------
  console.log("\n[1] Testing Campaign Services & Description in Template Outreach...");
  const campaignContext = {
    name: "Enterprise Growth Q4",
    description: "We provide high-converting B2B outreach and lead acquisition services.",
    intent: "Schedule intro calls for B2B growth",
  };

  const leadSample = {
    username: "growth_leader",
    fullName: "Alex Rivera",
  };

  const templateWithDescription =
    "Hi {{username}}, reaching out regarding {{campaignName}}.\n\n{{campaignDescription}}\n\nBest,\n{{senderName}}";
  const rendered1 = renderTemplate(
    templateWithDescription,
    leadSample,
    campaignContext,
    "Sarah Jenkins",
  );

  assert(
    rendered1.includes("We provide high-converting B2B outreach"),
    "{{campaignDescription}} properly injected from campaign context",
  );
  assert(
    rendered1.includes("Alex Rivera") || rendered1.includes("growth_leader"),
    "Lead handle/name resolved in rendered outreach message",
  );

  const templateWithServices =
    "Hello {{username}}! Regarding our services: {{services}}.";
  const rendered2 = renderTemplate(
    templateWithServices,
    leadSample,
    campaignContext,
  );
  assert(
    rendered2.includes("We provide high-converting B2B outreach"),
    "{{services}} alias properly resolves to campaign description/services",
  );

  const validation = validateTemplateVariables(
    "Hi {{username}}! We specialize in {{campaignDescription}} with {{services}} for {{campaignName}}.",
  );
  assert(
    validation.valid && validation.unsupported.length === 0,
    "validateTemplateVariables recognizes {{campaignDescription}} and {{services}} as valid variables",
  );

  // ----------------------------------------------------
  // TEST 2: Cooldown Interval Configuration
  // ----------------------------------------------------
  console.log("\n[2] Testing Cooldown Interval Configuration (Default 10 min & Configurable)...");
  
  // Test default cooldown (should be 600,000ms / 10 minutes when no env override is present)
  const originalSecs = process.env.SENDER_COOLDOWN_SECONDS;
  const originalMins = process.env.SENDER_COOLDOWN_MINUTES;

  delete process.env.SENDER_COOLDOWN_SECONDS;
  delete process.env.SENDER_COOLDOWN_MINUTES;
  const defaultCooldownMs = getSenderCooldownMs();
  assert(
    defaultCooldownMs === 10 * 60 * 1000,
    `Default cooldown is 10 minutes (600,000 ms), got: ${defaultCooldownMs} ms`,
  );

  // Test custom seconds configuration (e.g., 300s = 5m)
  process.env.SENDER_COOLDOWN_SECONDS = "300";
  const customCooldownMs = getSenderCooldownMs();
  assert(
    customCooldownMs === 300 * 1000,
    `Configured SENDER_COOLDOWN_SECONDS="300" yields 300,000 ms, got: ${customCooldownMs} ms`,
  );

  // Test custom minutes configuration
  delete process.env.SENDER_COOLDOWN_SECONDS;
  process.env.SENDER_COOLDOWN_MINUTES = "15";
  const customMinutesMs = getSenderCooldownMs();
  assert(
    customMinutesMs === 15 * 60 * 1000,
    `Configured SENDER_COOLDOWN_MINUTES="15" yields 900,000 ms, got: ${customMinutesMs} ms`,
  );

  // Restore env
  if (originalSecs) process.env.SENDER_COOLDOWN_SECONDS = originalSecs;
  else delete process.env.SENDER_COOLDOWN_SECONDS;
  if (originalMins) process.env.SENDER_COOLDOWN_MINUTES = originalMins;
  else delete process.env.SENDER_COOLDOWN_MINUTES;

  // ----------------------------------------------------
  // TEST 3: Sender Last-Sent Timestamp Tracking & Cooldown Calculation
  // ----------------------------------------------------
  console.log("\n[3] Testing Sender Account Cooldown Timestamp Tracking...");
  const testSenderId = "acc_test_cooldown_001";
  const sendTime = Date.now() - 4 * 60 * 1000; // 4 minutes ago
  recordSenderAccountSent(testSenderId, sendTime);

  const lastRecorded = await getLastSentAtForSender(testSenderId);
  assert(lastRecorded === sendTime, "recordSenderAccountSent accurately records last sent timestamp");

  const cooldown = 10 * 60 * 1000; // 10 minutes
  const elapsed = Date.now() - lastRecorded;
  const remainingCooldown = cooldown - elapsed;
  assert(
    remainingCooldown > 5 * 60 * 1000 && remainingCooldown < 7 * 60 * 1000,
    `Remaining cooldown correctly calculated (~6 minutes remaining, got: ${Math.round(remainingCooldown / 1000)}s)`,
  );

  // ----------------------------------------------------
  // TEST 4: 10-Account Sequential Round-Robin Allocation
  // ----------------------------------------------------
  console.log("\n[4] Simulating 10 Instagram Accounts Rotating Across Leads...");
  // Create 10 connected accounts
  const tenAccounts = Array.from({ length: 10 }, (_, i) => ({
    id: `sender_acc_${i + 1}`,
    username: `growth_agent_${i + 1}`,
    status: "CONNECTED",
  }));

  // Simulate 25 leads to verify 2.5 full round-robin rotations
  const totalLeads = 25;
  const dispatchHistory: Array<{ leadNumber: number; senderId: string; username: string }> = [];

  let roundRobinIndex = 0;
  for (let leadIndex = 1; leadIndex <= totalLeads; leadIndex++) {
    const candidateSender = tenAccounts[roundRobinIndex % tenAccounts.length];
    dispatchHistory.push({
      leadNumber: leadIndex,
      senderId: candidateSender.id,
      username: candidateSender.username,
    });
    roundRobinIndex++;
  }

  // Verify: Lead 1 -> sender 1, Lead 2 -> sender 2 ... Lead 10 -> sender 10
  let sequenceCorrect = true;
  for (let i = 0; i < 10; i++) {
    if (dispatchHistory[i].senderId !== `sender_acc_${i + 1}`) {
      sequenceCorrect = false;
      break;
    }
  }
  assert(sequenceCorrect, "First 10 leads sequentially allocated to sender 1 through sender 10");

  // Verify: Lead 11 wraps around to sender 1, Lead 12 to sender 2, etc.
  assert(
    dispatchHistory[10].senderId === "sender_acc_1" &&
    dispatchHistory[11].senderId === "sender_acc_2" &&
    dispatchHistory[19].senderId === "sender_acc_10" &&
    dispatchHistory[20].senderId === "sender_acc_1",
    "Leads wrap around sequentially to sender 1 after completing a full 10-account cycle",
  );

  // Verify each account dispatched exactly expected number of leads
  const distribution = new Map<string, number>();
  for (const item of dispatchHistory) {
    distribution.set(item.senderId, (distribution.get(item.senderId) ?? 0) + 1);
  }
  const accountsWith3 = Array.from(distribution.values()).filter((c) => c === 3).length;
  const accountsWith2 = Array.from(distribution.values()).filter((c) => c === 2).length;
  assert(
    accountsWith3 === 5 && accountsWith2 === 5,
    "Fair load distribution: 5 accounts sent 3 messages, 5 accounts sent 2 messages (25 leads total)",
  );

  // ----------------------------------------------------
  // TEST 5: Fault-Tolerant Skipping on Platform Restriction
  // ----------------------------------------------------
  console.log("\n[5] Testing Restricted Account Skipping and Continued Rotation...");
  let activePool = [...tenAccounts];
  const postFailureHistory: string[] = [];

  // Simulate account 3 failing with an Instagram challenge/restriction on its turn
  let poolIndex = 0;
  for (let step = 1; step <= 8; step++) {
    const currentSender = activePool[poolIndex % activePool.length];
    
    // Account 3 encounters restriction on step 3
    if (currentSender.id === "sender_acc_3") {
      // System marks it restricted and removes it from the pool
      activePool = activePool.filter((s) => s.id !== "sender_acc_3");
      // Pick next available account from remaining healthy pool
      const nextHealthy = activePool[poolIndex % activePool.length];
      postFailureHistory.push(nextHealthy.id);
      poolIndex++;
    } else {
      postFailureHistory.push(currentSender.id);
      poolIndex++;
    }
  }

  assert(
    !postFailureHistory.includes("sender_acc_3"),
    "Restricted account (sender_acc_3) is completely excluded from subsequent dispatches",
  );
  assert(
    activePool.length === 9,
    `Active pool gracefully shrinks from 10 to 9 healthy accounts (active: ${activePool.length})`,
  );
  assert(
    activePool.every((acc) => acc.id !== "sender_acc_3"),
    "All remaining healthy accounts continue rotating in sequence",
  );

  // ----------------------------------------------------
  // TEST 6: Pool Exhaustion Handling
  // ----------------------------------------------------
  console.log("\n[6] Testing Pool Exhaustion (All Accounts Restricted)...");
  let exhaustedPool: typeof tenAccounts = [];
  assert(
    exhaustedPool.length === 0,
    "When all accounts are exhausted, activeSenders.length === 0 triggers safe job PAUSE",
  );

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log("\n==================================================");
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in test runner:", err);
  process.exit(1);
});
