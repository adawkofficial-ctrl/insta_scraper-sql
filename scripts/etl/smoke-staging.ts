/**
 * Staging app smoke test. Sending is disabled by the caller.
 * Prints counts only; never prints emails/handles/message bodies.
 */
import fs from "node:fs";
import "dotenv/config";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("../preload_server_only.cjs");

import { checkLeadSuppression } from "../../src/lib/services/compliance/dnc-service";
import { getPrismaClient } from "../../src/lib/db/prisma";
import { DncChannel, DncIdentifierType } from "../../src/generated/prisma/client";

const BASE = process.env.SMOKE_BASE_URL || "http://127.0.0.1:58997";
const EMAIL = process.env.SMOKE_EMAIL || "smoke-admin@staging.local";
const PASSWORD = fs.readFileSync(process.env.SMOKE_PASSWORD_FILE || "", "utf8").trim();

let passed = 0;
let failed = 0;
function check(cond: boolean, name: string, detail?: string) {
  if (cond) { console.log(`PASS ${name}`); passed++; }
  else { console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`); failed++; }
}

async function main() {
  const health = await fetch(`${BASE}/api/health`);
  check(health.status === 200, "health 200", `status=${health.status}`);
  const ready = await fetch(`${BASE}/api/health/ready`);
  check(ready.status === 200, "health/ready 200", `status=${ready.status}`);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const loginBody = await login.json();
  check(login.status === 200 && Boolean(loginBody.user?.id), "login 200", `status=${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const userId = String(loginBody.user?.id ?? "");

  const campaignsRes = await fetch(`${BASE}/api/campaigns`, { headers: { Cookie: cookie } });
  const campaigns = await campaignsRes.json();
  check(campaignsRes.status === 200 && Array.isArray(campaigns) && campaigns.length === 1, "campaign list has 1 real campaign", `count=${Array.isArray(campaigns) ? campaigns.length : "?"}`);
  const campaign = campaigns[0];
  const campaignId = String(campaign?.id ?? "");

  const leadsRes = await fetch(`${BASE}/api/campaigns/${campaignId}/leads?limit=100`, { headers: { Cookie: cookie } });
  const leadsBody = await leadsRes.json();
  check(leadsRes.status === 200 && Number(leadsBody.pagination?.total ?? leadsBody.total) === 223, "campaign lead count = 223", `total=${leadsBody.pagination?.total ?? leadsBody.total}`);
  const firstLeadId = String(leadsBody.items?.[0]?.id ?? "");
  check(Boolean(firstLeadId), "lead list returned a lead");

  const prisma = getPrismaClient();
  const sighting = await prisma.leadSighting.findFirst({
    select: { leadId: true },
    where: { campaignId },
  });
  check(Boolean(sighting), "lead has a sighting row");
  const leadId = sighting?.leadId ?? firstLeadId;
  const detail = await fetch(`${BASE}/api/leads/${leadId}`, { headers: { Cookie: cookie } });
  check(detail.status === 200, "lead detail 200", `status=${detail.status}`);
  const eventCount = await prisma.leadEvent.count({ where: { leadId } });
  check(eventCount >= 0, "lead events readable", `events=${eventCount}`);

  const entries = Array.from({ length: 20 }, (_, i) => ({
    value: `smoke-dnc-${i}@staging.test`,
    identifierType: DncIdentifierType.EMAIL,
    channel: DncChannel.ALL,
  }));
  const addDnc = await fetch(`${BASE}/api/dnc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ entries, source: "IMPORT" }),
  });
  check(addDnc.status === 200 || addDnc.status === 201, "DNC add 20 entries", `status=${addDnc.status}`);

  let suppressed = 0;
  for (const entry of entries) {
    const result = await checkLeadSuppression({
      userId,
      channel: DncChannel.EMAIL,
      lead: { status: "NEW" as never, email: entry.value.toUpperCase() },
    });
    if (result.suppressed) suppressed++;
  }
  check(suppressed === 20, "all 20 DNC identifiers suppressed", `suppressed=${suppressed}`);

  console.log(`SMOKE SUMMARY: ${passed} PASS / ${failed} FAIL`);
  await getPrismaClient().$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("SMOKE ERROR:", err instanceof Error ? err.message : String(err)); process.exit(1); });
