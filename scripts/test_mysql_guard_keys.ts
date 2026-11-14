/**
 * MySQL Phase 2 guard-key tests.
 * Verifies the app-maintained replacement for Postgres partial unique indexes.
 */
import "dotenv/config";
import assert from "node:assert/strict";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl, assertSafeTestDatabase } = require("./test_db_guard.cjs");
const testDatabaseUrl = getTestDatabaseUrl();
assertSafeTestDatabase(testDatabaseUrl, { throwOnError: true });
process.env.DATABASE_URL = testDatabaseUrl;
process.env.DATABASE_URL_MYSQL_LOCAL = testDatabaseUrl;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { getPrismaClient, computeLeadGuardKeys } from "../src/lib/db/prisma";
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

async function expectP2002(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    return (err as { code?: string }).code === "P2002";
  }
}

async function main() {
  console.log("=== MYSQL GUARD-KEY TESTS ===");
  const prisma = getPrismaClient();
  const tag = `guard_${Date.now()}`;

  const user = await prisma.user.create({
    data: { email: `${tag}@example.com`, name: "Guard Test", passwordHash: "x" },
  });
  const profile = await prisma.companyProfile.create({
    data: { userId: user.id, name: "Guard Co" },
  });
  const campaign = await prisma.campaign.create({
    data: { userId: user.id, companyProfileId: profile.id, name: `${tag} campaign` },
  });

  try {
    const first = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "Guard First",
        instagramUserId: `${tag}_ig`,
        emailNormalized: `${tag}@example.com`,
      },
    });
    check(
      first.activeInstagramGuard === `${tag}_ig` &&
        first.activeEmailGuard === `${tag}@example.com`,
      "create computes guard keys",
      JSON.stringify({
        ig: first.activeInstagramGuard,
        email: first.activeEmailGuard,
      }),
    );

    check(
      await expectP2002(() =>
        prisma.lead.create({
          data: {
            campaignId: campaign.id,
            userId: user.id,
            fullName: "Guard Duplicate",
            instagramUserId: `${tag}_ig`,
          },
        }),
      ),
      "duplicate instagramUserId is blocked by the guard unique index",
    );

    const duplicateLinked = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "Guard Duplicate-Linked",
        instagramUserId: `${tag}_ig`,
        duplicateOfLeadId: first.id,
      },
    });
    check(
      duplicateLinked.activeInstagramGuard === null &&
        duplicateLinked.activeUsernameGuard === null &&
        duplicateLinked.activeEmailGuard === null,
      "duplicateOfLeadId rows are outside the guard condition",
    );

    // Two concurrent inserts with the same username guard: exactly one wins.
    const concurrentResults = await Promise.allSettled([
      prisma.lead.create({
        data: {
          campaignId: campaign.id,
          userId: user.id,
          fullName: "Concurrent A",
          usernameNormalized: `${tag}_username`,
        },
      }),
      prisma.lead.create({
        data: {
          campaignId: campaign.id,
          userId: user.id,
          fullName: "Concurrent B",
          usernameNormalized: `${tag}_username`,
        },
      }),
    ]);
    const fulfilled = concurrentResults.filter((r) => r.status === "fulfilled").length;
    const rejected = concurrentResults.filter(
      (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "P2002",
    ).length;
    check(
      fulfilled === 1 && rejected === 1,
      "concurrent duplicate inserts: exactly one succeeds, one is blocked",
      JSON.stringify(concurrentResults.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as { code?: string }).code))),
    );

    // Updating duplicateOfLeadId releases the guard.
    await prisma.lead.update({
      where: { id: first.id },
      data: { duplicateOfLeadId: duplicateLinked.id },
    });
    const released = await prisma.lead.findUniqueOrThrow({ where: { id: first.id } });
    check(
      released.activeInstagramGuard === null && released.activeEmailGuard === null,
      "update recomputes guard keys when duplicateOfLeadId changes",
    );
    const afterRelease = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "After Release",
        instagramUserId: `${tag}_ig`,
      },
    });
    check(
      afterRelease.activeInstagramGuard === `${tag}_ig`,
      "duplicate is allowed after the original is marked as a duplicate",
    );

    // updateMany path: extension must recompute per row.
    const manyA = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "Many A",
        instagramUserId: `${tag}_many_a`,
        usernameNormalized: `${tag}_many_a`,
      },
    });
    const manyB = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "Many B",
        instagramUserId: `${tag}_many_b`,
        usernameNormalized: `${tag}_many_b`,
      },
    });
    await prisma.lead.updateMany({
      where: { id: { in: [manyA.id, manyB.id] } },
      data: { duplicateOfLeadId: duplicateLinked.id },
    });
    const manyRows = await prisma.lead.findMany({
      where: { id: { in: [manyA.id, manyB.id] } },
      select: { activeInstagramGuard: true, activeUsernameGuard: true },
    });
    check(
      manyRows.every(
        (row) => row.activeInstagramGuard === null && row.activeUsernameGuard === null,
      ),
      "updateMany recomputes guard keys for every matched row",
      JSON.stringify(manyRows),
    );

    // Corrupt one guard key with raw SQL, verify the checker finds it, then fix it.
    const expected = computeLeadGuardKeys({
      instagramUserId: `${tag}_many_a`,
      usernameNormalized: `${tag}_many_a`,
      emailNormalized: null,
      duplicateOfLeadId: null,
    });
    await prisma.lead.update({
      where: { id: manyA.id },
      data: { duplicateOfLeadId: null },
    });
    await prisma.$executeRawUnsafe(
      "UPDATE `Lead` SET `activeInstagramGuard` = NULL WHERE `id` = ?",
      manyA.id,
    );
    const beforeFix = await verifyLeadGuardKeys();
    check(
      beforeFix.mismatches.some((m) => m.leadId === manyA.id),
      "verify_guard_keys detects a deliberately corrupted row",
      JSON.stringify(beforeFix.mismatches.filter((m) => m.leadId === manyA.id)),
    );
    await prisma.$executeRawUnsafe(
      "UPDATE `Lead` SET `activeInstagramGuard` = ? WHERE `id` = ?",
      expected.activeInstagramGuard,
      manyA.id,
    );
    const afterFix = await verifyLeadGuardKeys();
    check(
      afterFix.mismatches.length === 0,
      "verify_guard_keys is clean after repairing the row",
      JSON.stringify(afterFix.mismatches),
    );
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }

  console.log("\n=======================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");
  if (failed > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error("Guard-key test threw:", err);
    process.exit(1);
  })
  .finally(async () => {
    await getPrismaClient().$disconnect();
  });
