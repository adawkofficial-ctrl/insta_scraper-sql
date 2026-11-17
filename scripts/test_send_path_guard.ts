import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");
const ALLOWED = new Set([
  "lib/services/messaging/messaging-service.ts",
  "lib/services/messaging/follow-up-service.ts",
  "lib/services/messaging/reply-send-service.ts",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const offenders: string[] = [];
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (rel === "lib/services/messaging/messaging-provider.ts") continue;
  const content = readFileSync(file, "utf8");
  if (!/\.sendMessage\s*\(/.test(content)) continue;
  if (!ALLOWED.has(rel)) offenders.push(rel);
}

const checks: Array<[string, boolean]> = [];
checks.push([
  "provider.sendMessage is only called from the three guarded DM services",
  offenders.length === 0,
]);
for (const rel of ALLOWED) {
  const content = readFileSync(join(ROOT, rel), "utf8");
  checks.push([`${rel} uses reserveSendSlot`, /reserveSendSlot\s*\(/.test(content)]);
  checks.push([
    `${rel} uses DNC/suppression checks`,
    /checkLeadSuppression|DNC_SUPPRESSED|DNC/.test(content),
  ]);
}
const messaging = readFileSync(
  join(ROOT, "lib/services/messaging/messaging-service.ts"),
  "utf8",
);
checks.push([
  "first-message name validator runs in the shared send service",
  /validateFirstMessageText\s*\(/.test(messaging),
]);
checks.push([
  "first-contact ledger runs in the shared send service",
  /reserveFirstContact\s*\(/.test(messaging),
]);
const execution = readFileSync(
  join(ROOT, "lib/services/execution/campaign-execution-service.ts"),
  "utf8",
);
checks.push([
  "campaign execution delegates to sendSingleMessage (no direct provider send)",
  /sendSingleMessage\s*\(/.test(execution) && !/\.sendMessage\s*\(/.test(execution),
]);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failed++;
}
if (offenders.length > 0) {
  console.log(`  offender files: ${offenders.join(", ")}`);
}
console.log(`SUMMARY: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
