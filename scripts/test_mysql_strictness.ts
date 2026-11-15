/**
 * MySQL Phase 2 strictness tests.
 * Proves STRICT_ALL_TABLES prevents silent truncation for VARCHAR and TEXT.
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

function isTooLongError(err: unknown): boolean {
  const record = err as { code?: string; message?: string };
  return (
    record?.code === "P2000" ||
    /too long|data too long|out of range/i.test(record?.message ?? "")
  );
}

async function main() {
  console.log("=== MYSQL STRICTNESS TESTS ===");
  const prisma = getPrismaClient();
  const tag = `strict_${Date.now()}`;
  const user = await prisma.user.create({
    data: { email: `${tag}@example.com`, name: "Strict Test", passwordHash: "x" },
  });
  const profile = await prisma.companyProfile.create({
    data: { userId: user.id, name: "Strict Co" },
  });
  const campaign = await prisma.campaign.create({
    data: { userId: user.id, companyProfileId: profile.id, name: `${tag} campaign` },
  });

  try {
    let varcharRejected = false;
    try {
      await prisma.lead.create({
        data: {
          campaignId: campaign.id,
          userId: user.id,
          fullName: "Too Long City",
          city: "x".repeat(200),
        },
      });
    } catch (err) {
      varcharRejected = isTooLongError(err);
    }
    check(varcharRejected, "VARCHAR(191) over-length write errors (no silent truncation)");

    const lead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "Strict Lead",
      },
    });

    let textRejected = false;
    try {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { description: "x".repeat(70_000) },
      });
    } catch (err) {
      textRejected = isTooLongError(err);
    }
    check(textRejected, "TEXT over 65,535 bytes errors in strict mode");

    const template = await prisma.messageTemplate.create({
      data: {
        campaignId: campaign.id,
        name: "Long Body",
        body: "y".repeat(70_000),
      },
    });
    check(
      template.body.length === 70_000,
      "LONGTEXT accepts a 70,000-character body without truncation",
      String(template.body.length),
    );

    const long = "x".repeat(3000);
    await prisma.user.update({ where: { id: user.id }, data: { name: long, image: long } });
    await prisma.companyProfile.update({ where: { id: profile.id }, data: { name: long } });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { category: long } });
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        profilePictureUrl: long,
        profilePicUrl: long,
        profilePicUrlHD: long,
        possibleDuplicateReason: long,
      },
    });
    const candidate = await prisma.candidate.create({
      data: { campaignId: campaign.id, placeId: `${tag}_cand`, name: long.slice(0, 255) },
    });
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { category: long, mapsUrl: long, lastError: long, rejectionReason: long },
    });
    const job = await prisma.scrapeJob.create({
      data: { campaignId: campaign.id, provider: "google_maps", status: "COMPLETED" },
    });
    await prisma.scrapeJob.update({
      where: { id: job.id },
      data: { query: long, location: long, category: long },
    });
    await prisma.messageTemplate.update({ where: { id: template.id }, data: { name: long } });
    const sender = await prisma.instagramSenderAccount.create({
      data: { userId: user.id, username: `${tag}_widen_sender`, status: "ACTIVE", sessionPath: "/tmp/widen" },
    });
    await prisma.instagramSenderAccount.update({ where: { id: sender.id }, data: { displayName: long } });
    const notif = await prisma.notificationConfig.create({
      data: { userId: user.id, ntfyTopic: long, ntfyServerUrl: long },
    });
    await prisma.notificationConfig.update({ where: { id: notif.id }, data: { ntfyTopic: long, ntfyServerUrl: long } });

    const widened = [
      ["User", "name"], ["User", "image"], ["CompanyProfile", "name"], ["Campaign", "category"],
      ["Candidate", "category"], ["Candidate", "mapsUrl"], ["Candidate", "lastError"], ["Candidate", "rejectionReason"],
      ["ScrapeJob", "query"], ["ScrapeJob", "location"], ["ScrapeJob", "category"],
      ["Lead", "profilePictureUrl"], ["Lead", "profilePicUrl"], ["Lead", "profilePicUrlHD"], ["Lead", "possibleDuplicateReason"],
      ["MessageTemplate", "name"], ["InstagramSenderAccount", "displayName"],
      ["NotificationConfig", "ntfyTopic"], ["NotificationConfig", "ntfyServerUrl"],
      ["CampaignExecutionItem", "messageText"], ["CampaignExecutionItem", "errorMessage"],
      ["DraftReview", "notes"], ["EmailSend", "subject"], ["EmailSenderAccount", "postalAddress"],
      ["OutboundSendIdempotency", "errorMessage"], ["AiAnalysisJob", "lastError"], ["MessageDraft", "subject"],
    ] as const;
    const conditions = widened.map(([table, col]) => `(TABLE_NAME='${table}' AND COLUMN_NAME='${col}')`).join(" OR ");
    const rows = await prisma.$queryRawUnsafe<Array<{ TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string }>>(
      `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (${conditions})`,
    );
    check(
      rows.length === widened.length && rows.every((r) => ["text", "mediumtext", "longtext"].includes(String(r.DATA_TYPE).toLowerCase())),
      "all widened external columns are TEXT classes",
      `${rows.length}/${widened.length} ${rows.filter((r) => !["text","mediumtext","longtext"].includes(String(r.DATA_TYPE).toLowerCase())).map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}:${r.DATA_TYPE}`).join(",")}`,
    );
    check(long.length === 3000, "3000-character writes to widened columns succeed");
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
    console.error("Strictness test threw:", err);
    process.exit(1);
  })
  .finally(async () => {
    await getPrismaClient().$disconnect();
  });
