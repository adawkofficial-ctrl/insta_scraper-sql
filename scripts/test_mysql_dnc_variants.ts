/**
 * MySQL Phase 2 DNC normalization tests.
 * Case, whitespace, URL-wrapped and accent variants must be suppressed.
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

import { getPrismaClient } from "../src/lib/db/prisma";
import {
  addDoNotContact,
  checkLeadSuppression,
  normalizeUsername,
  normalizeEmail,
  normalizeDomain,
} from "../src/lib/services/compliance/dnc-service";
import {
  DncChannel,
  DncIdentifierType,
  LeadStatus,
} from "../src/generated/prisma/client";

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

async function main() {
  console.log("=== MYSQL DNC CASE/WHITESPACE/ACCENT TESTS ===");
  const prisma = getPrismaClient();
  const tag = `dnc_${Date.now()}`;
  const user = await prisma.user.create({
    data: { email: `${tag}@example.com`, name: "DNC Variant", passwordHash: "x" },
  });

  try {
    await addDoNotContact({
      userId: user.id,
      actor: "mysql-dnc-test",
      entries: [
        { value: "  Test@Example.COM ", identifierType: DncIdentifierType.EMAIL, channel: DncChannel.ALL },
        { value: "WWW.Example.COM", identifierType: DncIdentifierType.DOMAIN, channel: DncChannel.ALL },
        { value: "  @MyHandle ", identifierType: DncIdentifierType.USERNAME, channel: DncChannel.INSTAGRAM },
        { value: "(416) 555-1234", identifierType: DncIdentifierType.PHONE, channel: DncChannel.PHONE },
        { value: "café@example.com", identifierType: DncIdentifierType.EMAIL, channel: DncChannel.ALL },
      ],
    });

    const byEmail = await checkLeadSuppression({
      userId: user.id,
      channel: DncChannel.EMAIL,
      lead: {
        status: LeadStatus.NEW,
        email: "TEST@EXAMPLE.COM",
      },
    });
    check(byEmail.suppressed, "DNC email matches case/whitespace variant", JSON.stringify(byEmail.matches));

    const byDomain = await checkLeadSuppression({
      userId: user.id,
      channel: DncChannel.EMAIL,
      lead: {
        status: LeadStatus.NEW,
        website: "https://www.example.com/some/path",
      },
    });
    check(byDomain.suppressed, "DNC domain matches URL/www variant", JSON.stringify(byDomain.matches));

    const byHandle = await checkLeadSuppression({
      userId: user.id,
      channel: DncChannel.INSTAGRAM,
      lead: {
        status: LeadStatus.NEW,
        username: "  @MYHANDLE ",
      },
    });
    check(byHandle.suppressed, "DNC handle matches case/@/whitespace variant", JSON.stringify(byHandle.matches));

    const byPhone = await checkLeadSuppression({
      userId: user.id,
      channel: DncChannel.PHONE,
      lead: {
        status: LeadStatus.NEW,
        phone: "+1 (416) 555-1234",
      },
    });
    check(byPhone.suppressed, "DNC phone matches formatted variant", JSON.stringify(byPhone.matches));

    const byAccent = await checkLeadSuppression({
      userId: user.id,
      channel: DncChannel.EMAIL,
      lead: {
        status: LeadStatus.NEW,
        email: "cafe@EXAMPLE.com",
      },
    });
    check(byAccent.suppressed, "DNC email matches accent variant", JSON.stringify(byAccent.matches));

    const notSuppressed = await checkLeadSuppression({
      userId: user.id,
      channel: DncChannel.EMAIL,
      lead: {
        status: LeadStatus.NEW,
        email: "different@other-domain.test",
        username: "different_handle",
      },
    });
    check(!notSuppressed.suppressed, "different identifiers are not suppressed", JSON.stringify(notSuppressed.matches));

    check(normalizeUsername("  @MyHandle ") === "myhandle", "normalizeUsername lowercases and strips @/space");
    check(normalizeEmail("  CAFÉ@Example.COM ") === "cafe@example.com", "normalizeEmail folds accents");
    check(normalizeDomain("https://WWW.Example.COM/x") === "example.com", "normalizeDomain strips protocol/www/path");
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
    console.error("DNC variant test threw:", err);
    process.exit(1);
  })
  .finally(async () => {
    await getPrismaClient().$disconnect();
  });
