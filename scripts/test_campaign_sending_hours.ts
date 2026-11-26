/**
 * Campaign sending hours (Safe Outbound Pacing editor).
 *
 * When a campaign has its own sending window, that window decides when DMs
 * go out: it replaces the default 09:00-18:00 working hours (lead-local or
 * sender time), and sends outside it are deferred with a retryAt at the next
 * window start. Manual one-off sends bypass it.
 */
import "./preload_server_only.cjs";
import "dotenv/config";

import { getTestDatabaseUrl } from "./test_db_guard.cjs";
import { getPrismaClient } from "../src/lib/db/prisma";
import { canSendNow } from "../src/lib/services/messaging/send-gate";
import { getCampaignExecutionStatus } from "../src/lib/services/execution/campaign-execution-service";

process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.DATABASE_URL_MYSQL_LOCAL = process.env.DATABASE_URL;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.OUTBOUND_SENDING_ENABLED = "true";
delete process.env.WORKING_HOURS_START;
delete process.env.WORKING_HOURS_END;

const prisma = getPrismaClient();
let passed = 0;
let failed = 0;

function check(condition: boolean, label: string, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

async function main() {
  const tag = `sendhrs_${Date.now()}`;
  const user = await prisma.user.create({ data: { email: `${tag}@example.com`, passwordHash: "x" } });
  const profile = await prisma.companyProfile.create({ data: { userId: user.id, name: `${tag} profile` } });
  const campaign = await prisma.campaign.create({
    data: { userId: user.id, companyProfileId: profile.id, name: `${tag} campaign`, category: "Dentist" },
  });
  const sender = await prisma.instagramSenderAccount.create({
    data: {
      userId: user.id,
      username: `${tag}_sender`,
      sessionPath: `test/${tag}/s`,
      status: "CONNECTED",
      dailyCap: 25,
      warmupEnabled: false,
      timezone: "UTC",
      workingHoursStart: 9,
      workingHoursEnd: 18,
    },
  });
  // Toronto lead: lead-local 09:00-18:00 = 14:00-23:00 UTC.
  const lead = await prisma.lead.create({
    data: {
      campaignId: campaign.id,
      userId: user.id,
      username: `${tag}_lead`,
      fullName: "Jane Doe",
      city: "Toronto",
      status: "NEW",
    },
  });

  const gate = (iso: string, extra: Record<string, unknown> = {}) =>
    canSendNow({
      senderAccountId: sender.id,
      leadId: lead.id,
      lead,
      campaignId: campaign.id,
      now: new Date(iso),
      ...extra,
    });

  try {
    console.log("\n[1] No custom hours: default lead-local working hours apply");
    const early = await gate("2026-11-26T11:00:00Z"); // 06:00 Toronto
    check(early.reason === "OUTSIDE_WORKING_HOURS", "06:00 Toronto is blocked by default hours", early.reason);

    console.log("\n[2] Custom hours 10:00-16:00 Asia/Karachi replace default hours");
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        sendWindowEnabled: true,
        sendWindowStart: "10:00",
        sendWindowEnd: "16:00",
        sendWindowDays: [0, 1, 2, 3, 4, 5, 6],
        sendWindowTimezone: "Asia/Karachi",
      },
    });
    // 11:00 UTC = 16:00 PKT -> outside (end exclusive); 06:00 UTC = 11:00 PKT -> inside.
    const inside = await gate("2026-11-26T06:00:00Z"); // 11:00 PKT, 01:00 Toronto
    check(inside.allowed, "11:00 PKT sends even though it is 01:00 in Toronto", inside.reason);

    const before = await gate("2026-11-26T04:30:00Z"); // 09:30 PKT
    check(before.reason === "OUTSIDE_CAMPAIGN_WINDOW", "09:30 PKT is before the window", before.reason);
    check(
      before.retryAt?.toISOString() === "2026-11-26T05:00:00.000Z",
      "retryAt is 10:00 PKT the same day",
      before.retryAt?.toISOString(),
    );

    const after = await gate("2026-11-26T11:00:00Z"); // 16:00 PKT
    check(after.reason === "OUTSIDE_CAMPAIGN_WINDOW", "16:00 PKT (window end) is blocked", after.reason);
    check(
      after.retryAt?.toISOString() === "2026-11-27T05:00:00.000Z",
      "retryAt is 10:00 PKT next day",
      after.retryAt?.toISOString(),
    );

    console.log("\n[3] Manual one-off send bypasses the window");
    const manual = await gate("2026-11-26T11:00:00Z", { bypassWorkingHours: true });
    check(manual.allowed, "manual send at 16:00 PKT is allowed", manual.reason);

    console.log("\n[4] Days filter");
    await prisma.campaign.update({ where: { id: campaign.id }, data: { sendWindowDays: [1, 2, 3, 4, 5] } });
    const saturday = await gate("2026-11-28T06:00:00Z"); // Sat 11:00 PKT
    check(saturday.reason === "OUTSIDE_CAMPAIGN_WINDOW", "Saturday blocked when only Mon-Fri chosen", saturday.reason);
    const thursday = await gate("2026-11-26T06:00:00Z"); // Thu 11:00 PKT
    check(thursday.allowed, "Thursday inside window allowed", thursday.reason);

    console.log("\n[5] Pacing panel reports the window");
    const status = await getCampaignExecutionStatus(campaign.id, user.id);
    const ec = status.estimatedCompletion;
    check(ec?.workingHoursWindow === "10:00 - 16:00 (Asia/Karachi)", "pacing label shows custom hours", ec?.workingHoursWindow);
    check(
      ec?.sendWindow?.enabled === true &&
        ec.sendWindow.start === "10:00" &&
        ec.sendWindow.end === "16:00" &&
        JSON.stringify(ec.sendWindow.days) === "[1,2,3,4,5]",
      "pacing payload carries the editable window",
      ec?.sendWindow,
    );

    console.log("\n[6] Turning custom hours off restores default hours");
    await prisma.campaign.update({ where: { id: campaign.id }, data: { sendWindowEnabled: false } });
    const offEarly = await gate("2026-11-26T11:00:00Z");
    check(offEarly.reason === "OUTSIDE_WORKING_HOURS", "default lead-local hours apply again", offEarly.reason);
  } finally {
    await prisma.lead.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.instagramSenderAccount.deleteMany({ where: { id: sender.id } });
    await prisma.campaign.deleteMany({ where: { id: campaign.id } });
    await prisma.companyProfile.deleteMany({ where: { id: profile.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
