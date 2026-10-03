import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

import {
  PlaywrightSenderSessionDriver,
  isSenderProfileLaunchFailedError,
} from "../src/lib/services/senders";

let passed = 0;
let failed = 0;
function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

function readMarker(profileDir: string): string | null {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(profileDir, ".sender-engine"), "utf8")) as {
        engine?: string;
      }
    ).engine ?? null;
  } catch {
    return null;
  }
}

/**
 * REAL Playwright persistent-profile launch test (no mocks) for the sender
 * driver: fresh launch, same-profile reopen, stale-lock recovery, corrupt
 * profile error, and secret-free diagnostics.
 */
async function main() {
  const root = path.resolve(process.cwd(), "data/instagram-sessions");
  fs.mkdirSync(root, { recursive: true });
  const freshDir = path.join(root, "_task20-fresh");
  const lockDir = path.join(root, "_task20-lock");
  const blocker = path.join(root, "_task20-blocker");
  for (const dir of [freshDir, lockDir, blocker]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const driver = new PlaywrightSenderSessionDriver();

  console.log("=================================================================");
  console.log("   TASK 20: REAL PERSISTENT PROFILE LAUNCH (PLAYWRIGHT)          ");
  console.log("=================================================================\n");
  console.log(`  playwright chromium: ${chromium.executablePath()}`);

  // 1. Fresh bundled persistent launch.
  fs.mkdirSync(freshDir, { recursive: true });
  const first = await driver.launchHeadless(freshDir);
  check(first.mode === "headless", "[real] fresh persistent context launched");
  check(readMarker(freshDir) === "bundled", "[real] bundled Chromium used and recorded in marker");
  await first.close();

  // 2. Reopen the SAME profile -> same engine, marker unchanged.
  const second = await driver.launchHeadless(freshDir);
  check(readMarker(freshDir) === "bundled", "[real] same profile reopened with the SAME engine");
  await second.close();

  // 3. Profile held by a stale browser -> driver cleans it and recovers.
  fs.mkdirSync(lockDir, { recursive: true });
  const holder = await chromium.launchPersistentContext(lockDir, {
    headless: true,
    channel: "chromium",
  });
  let recovered = false;
  try {
    const recoveredSession = await driver.launchHeadless(lockDir);
    recovered = true;
    await recoveredSession.close();
  } catch {
    recovered = false;
  }
  check(recovered, "[real] stale profile lock detected, cleaned, and launch recovered");
  await holder.close().catch(() => undefined);

  // 4. Corrupt/unusable profile path -> SENDER_PROFILE_LAUNCH_FAILED.
  fs.writeFileSync(blocker, "not-a-directory", "utf8");
  let corruptCode: string | null = null;
  let corruptMessage = "";
  try {
    const bad = await driver.launchHeadless(path.join(blocker, "sub"));
    await bad.close();
  } catch (error) {
    corruptCode = isSenderProfileLaunchFailedError(error) ? error.code : null;
    corruptMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    corruptCode === "SENDER_PROFILE_LAUNCH_FAILED",
    "[real] corrupt profile returns SENDER_PROFILE_LAUNCH_FAILED",
  );
  check(
    corruptMessage.includes("Disconnect this sender and reconnect"),
    "[real] corrupt profile message is actionable",
  );

  // 5. No secrets in the diagnostic surface.
  check(
    !/cookie|sessionid|password|token|storage[-_ ]?state/i.test(corruptMessage),
    "[real] diagnostics contain no cookies/passwords/tokens",
  );

  // Cleanup.
  for (const dir of [freshDir, lockDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(blocker, { force: true });

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Unexpected failure:", error);
  process.exit(1);
});
