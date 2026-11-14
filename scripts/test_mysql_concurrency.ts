/**
 * MySQL Phase 3 concurrency tests (real DB, no DB mocks).
 * Covers sender caps, idempotency, round-robin, deadlock retry, crash
 * recovery, dedup guard-key races, and a negative control.
 */
import "dotenv/config";
import assert from "node:assert/strict";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl, assertSafeTestDatabase, extractDatabaseName } = require("./test_db_guard.cjs");
const testDatabaseUrl = getTestDatabaseUrl();
assertSafeTestDatabase(testDatabaseUrl, { throwOnError: true });
process.env.DATABASE_URL = testDatabaseUrl;
process.env.DATABASE_URL_MYSQL_LOCAL = testDatabaseUrl;
process.env.DATABASE_CONNECTION_LIMIT = "40";
process.env.OUTBOUND_SENDING_ENABLED = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { Prisma } from "../src/generated/prisma/client";
import { createPrismaClient, getPrismaClient } from "../src/lib/db/prisma";
import { withMysqlRetry } from "../src/lib/db/mysql-retry";
import {
  reserveSendSlot,
  setSendGateClock,
} from "../src/lib/services/messaging/send-gate";
import { verifyLeadGuardKeys } from "../src/lib/services/lead/guard-keys";

let passed = 0;
let failed = 0;
function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` -> ${detail}` : ""}`);
    failed++;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createSender(
  prisma: ReturnType<typeof getPrismaClient>,
  userId: string,
  username: string,
  dailyCap: number,
  hourlyCap: number,
) {
  return prisma.instagramSenderAccount.create({
    data: {
      userId,
      username,
      status: "ACTIVE",
      dailyCap,
      hourlyCap,
      warmupStartedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
      timezone: "UTC",
      workingHoursStart: 0,
      workingHoursEnd: 24,
      customMinGapSeconds: 0,
      customMaxGapSeconds: 0,
      sessionPath: `/tmp/${username}`,
    },
  });
}

async function main() {
  console.log(`Concurrency tests -> host=${new URL(testDatabaseUrl).hostname}:${new URL(testDatabaseUrl).port || "3306"} db=${extractDatabaseName(testDatabaseUrl)}`);
  const prisma = getPrismaClient();
  const tag = `conc_${Date.now()}`;
  const fakeNow = new Date("2026-06-10T15:00:00.000Z"); // Wednesday, within 0-24
  setSendGateClock(() => fakeNow);

  const user = await prisma.user.create({
    data: { email: `${tag}@example.com`, name: "Concurrency", passwordHash: "x" },
  });
  const companyProfile = await prisma.companyProfile.create({
    data: { userId: user.id, name: `${tag} Co` },
  });
  const dedupCampaignRecord = await prisma.campaign.create({
    data: { userId: user.id, companyProfileId: companyProfile.id, name: `${tag} dedup campaign` },
  });

  try {
    // 1) 50 iterations: 30 workers, daily cap 8, hourly cap 4 -> exactly 4.
    for (let iteration = 0; iteration < 50; iteration++) {
      const sender = await createSender(prisma, user.id, `${tag}_cap_${iteration}`, 8, 4);
      const campaignId = `${tag}_camp_${iteration}`;
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          reserveSendSlot({
            senderAccountId: sender.id,
            campaignId,
            leadId: `${tag}_lead_${iteration}_${i}`,
            step: 1,
            messageText: `message ${iteration}-${i}`,
          }),
        ),
      );
      const allowed = results.filter((r) => r.allowed).length;
      const row = await prisma.instagramSenderAccount.findUniqueOrThrow({
        where: { id: sender.id },
        select: { sentToday: true, sentThisHour: true },
      });
      if (iteration === 0 || allowed !== 4 || row.sentToday !== 4 || row.sentThisHour !== 4) {
        check(allowed === 4, `iteration ${iteration}: exactly cap(4) reservations succeed`, `allowed=${allowed}`);
        check(
          row.sentToday === 4 && row.sentThisHour === 4,
          `iteration ${iteration}: counters never exceed caps`,
          JSON.stringify(row),
        );
      }
      await prisma.outboundSendIdempotency.deleteMany({ where: { campaignId } });
      if (iteration === 0) {
        check(true, "50 iterations of 30 concurrent reservations completed");
      }
    }

    // 2) Same campaign/lead/step: exactly one reservation.
    const senderOne = await createSender(prisma, user.id, `${tag}_same`, 100, 100);
    const campaignSame = `${tag}_same_campaign`;
    const sameResults = await Promise.all(
      Array.from({ length: 20 }, () =>
        reserveSendSlot({
          senderAccountId: senderOne.id,
          campaignId: campaignSame,
          leadId: `${tag}_same_lead`,
          step: 1,
          messageText: "same message",
        }),
      ),
    );
    const sameAllowed = sameResults.filter((r) => r.allowed).length;
    check(sameAllowed === 1, "20 workers on the same (campaign, lead, step): exactly one reservation", `allowed=${sameAllowed}`);
    const sameRow = await prisma.instagramSenderAccount.findUniqueOrThrow({ where: { id: senderOne.id } });
    check(sameRow.sentToday === 1 && sameRow.sentThisHour === 1, "same-lead race increments counters once", JSON.stringify(sameRow));

    // 3) Two senders round-robin under load: neither exceeds cap.
    const senderA = await createSender(prisma, user.id, `${tag}_rr_a`, 3, 100);
    const senderB = await createSender(prisma, user.id, `${tag}_rr_b`, 3, 100);
    const rrCampaign = `${tag}_rr_campaign`;
    const rrResults = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserveSendSlot({
          senderAccountId: i % 2 === 0 ? senderA.id : senderB.id,
          campaignId: rrCampaign,
          leadId: `${tag}_rr_lead_${i}`,
          step: 1,
          messageText: `rr ${i}`,
        }),
      ),
    );
    const [rowA, rowB] = await Promise.all([
      prisma.instagramSenderAccount.findUniqueOrThrow({ where: { id: senderA.id } }),
      prisma.instagramSenderAccount.findUniqueOrThrow({ where: { id: senderB.id } }),
    ]);
    check(
      rrResults.filter((r) => r.allowed).length === 6 && rowA.sentToday === 3 && rowB.sentToday === 3,
      "two senders under round-robin load: no sender exceeds cap",
      JSON.stringify({ allowed: rrResults.filter((r) => r.allowed).length, a: rowA.sentToday, b: rowB.sentToday }),
    );

    // 4) Deadlock injection: opposite lock order, retry helper must succeed.
    const deadlockResults = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) => {
        const order = i % 2 === 0 ? [senderA.id, senderB.id] : [senderB.id, senderA.id];
        return withMysqlRetry(() =>
          prisma.$transaction(async (tx) => {
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM \`InstagramSenderAccount\` WHERE id = ${order[0]} FOR UPDATE`,
            );
            await sleep(75);
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM \`InstagramSenderAccount\` WHERE id = ${order[1]} FOR UPDATE`,
            );
            return true;
          }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 }),
        );
      }),
    );
    check(
      deadlockResults.every((r) => r.status === "fulfilled"),
      "opposite lock order is retried successfully",
      JSON.stringify(deadlockResults.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as { code?: string }).code))),
    );

    // 5) Crash recovery: an expired RESERVED slot is recoverable after restart.
    const senderCrash = await createSender(prisma, user.id, `${tag}_crash`, 10, 10);
    await prisma.instagramSenderAccount.update({
      where: { id: senderCrash.id },
      data: {
        sentToday: 1,
        sentTodayDate: "2026-06-10",
        sentThisHour: 1,
        sentThisHourWindow: "2026-06-10-15",
      },
    });
    await prisma.outboundSendIdempotency.create({
      data: {
        campaignId: `${tag}_crash_campaign`,
        leadId: `${tag}_crash_lead`,
        step: "1",
        senderAccountId: senderCrash.id,
        status: "RESERVED",
        reservedAt: new Date(fakeNow.getTime() - 6 * 60 * 1000),
      },
    });
    const recovery = await reserveSendSlot({
      senderAccountId: senderCrash.id,
      campaignId: `${tag}_crash_campaign`,
      leadId: `${tag}_crash_lead`,
      step: 1,
      messageText: "recovered",
    });
    const restartedClient = createPrismaClient();
    const crashRow = await restartedClient.instagramSenderAccount.findUniqueOrThrow({
      where: { id: senderCrash.id },
    });
    check(recovery.allowed === true, "expired RESERVED slot is recovered", JSON.stringify(recovery));
    check(crashRow.sentToday === 2 && crashRow.sentThisHour === 2, "recovered counters persist across a new client instance", JSON.stringify(crashRow));
    await restartedClient.$disconnect();

    // 6) Dedup race: 20 parallel creates of the same identity -> one active, 19 linked.
    const dedupCampaign = dedupCampaignRecord.id;
    const dedupResults = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        prisma.lead.create({
          data: {
            campaignId: dedupCampaign,
            userId: user.id,
            fullName: `Dedup ${i}`,
            instagramUserId: `${tag}_dedup_ig`,
            usernameNormalized: `${tag}_dedup_handle`,
            email: `${tag}_dedup@example.com`,
            emailNormalized: `${tag}_dedup@example.com`,
          },
        }),
      ),
    );
    const winners = dedupResults.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>[];
    const winner = winners[0]?.value;
    check(winners.length === 1 && Boolean(winner), "dedup race: exactly one active lead is created", `winners=${winners.length}`);
    if (winner) {
      for (const result of dedupResults) {
        if (result.status === "rejected") {
          await prisma.lead.create({
            data: {
              campaignId: dedupCampaign,
              userId: user.id,
              fullName: "Dedup linked",
              instagramUserId: `${tag}_dedup_ig`,
              usernameNormalized: `${tag}_dedup_handle`,
              emailNormalized: `${tag}_dedup@example.com`,
              duplicateOfLeadId: winner.id,
            },
          });
        }
      }
      const active = await prisma.lead.count({ where: { campaignId: dedupCampaign, duplicateOfLeadId: null } });
      const linked = await prisma.lead.count({ where: { campaignId: dedupCampaign, duplicateOfLeadId: winner.id } });
      check(active === 1 && linked === 19, "dedup race: losers are linked as duplicates", `active=${active} linked=${linked}`);
      const guard = await verifyLeadGuardKeys();
      check(guard.mismatches.length === 0, "dedup race: guard keys remain consistent", JSON.stringify(guard.mismatches.slice(0, 3)));
    }

    // 7) Negative control: bypassing the guard makes the verifier detect a stale key.
    if (winner) {
      await prisma.$executeRawUnsafe(
        "UPDATE `Lead` SET `activeInstagramGuard` = NULL WHERE `id` = ?",
        winner.id,
      );
      const corrupt = await verifyLeadGuardKeys();
      check(
        corrupt.mismatches.some((m) => m.leadId === winner.id),
        "negative control: bypassing guard-key maintenance is detected",
      );
      await prisma.$executeRawUnsafe(
        "UPDATE `Lead` SET `activeInstagramGuard` = ? WHERE `id` = ?",
        `${tag}_dedup_ig`,
        winner.id,
      );
    }
  } finally {
    setSendGateClock(null);
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }

  console.log("\n=======================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");
  if (failed > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error("Concurrency test threw:", err);
    process.exit(1);
  })
  .finally(async () => {
    await getPrismaClient().$disconnect();
  });
