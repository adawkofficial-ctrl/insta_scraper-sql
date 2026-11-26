/**
 * Send queue "Remove" (per item) and "Abort all" (per job) controls.
 */
import "./preload_server_only.cjs";
import "dotenv/config";

import { getTestDatabaseUrl } from "./test_db_guard.cjs";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  cancelBulkMessageItem,
  cancelBulkMessageJob,
} from "../src/lib/services/messaging/bulk-messaging-service";

process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.DATABASE_URL_MYSQL_LOCAL = process.env.DATABASE_URL;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

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

async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "UNKNOWN";
  }
}

async function main() {
  const tag = `qrm_${Date.now()}`;
  const user = await prisma.user.create({ data: { email: `${tag}@example.com`, passwordHash: "x" } });
  const other = await prisma.user.create({ data: { email: `${tag}_other@example.com`, passwordHash: "x" } });
  const profile = await prisma.companyProfile.create({ data: { userId: user.id, name: `${tag} profile` } });
  const campaign = await prisma.campaign.create({
    data: { userId: user.id, companyProfileId: profile.id, name: `${tag} campaign`, category: "Dentist" },
  });

  const mkLead = (n: string) =>
    prisma.lead.create({
      data: { campaignId: campaign.id, userId: user.id, username: `${tag}_${n}`, fullName: n, status: "QUEUED" },
    });
  const [l1, l2, l3, l4] = await Promise.all([mkLead("a"), mkLead("b"), mkLead("c"), mkLead("d")]);
  await prisma.leadStatusHistory.createMany({
    data: [l1, l2, l3, l4].map((l) => ({
      leadId: l.id,
      fromStatus: "NEW",
      toStatus: "QUEUED",
      reason: "test",
      actor: "test",
    })),
  });

  const job = await prisma.bulkMessageJob.create({
    data: { campaignId: campaign.id, userId: user.id, status: "RUNNING", total: 3, queued: 3 },
  });
  const mkItem = (leadId: string, status: "QUEUED" | "PROCESSING" = "QUEUED", jobId = job.id) =>
    prisma.bulkMessageItem.create({ data: { jobId, leadId, renderedMessage: "Hi", status } });
  const i1 = await mkItem(l1.id);
  const i2 = await mkItem(l2.id);
  const iBusy = await mkItem(l3.id, "PROCESSING");

  try {
    console.log("\n[1] Remove one queued item");
    const res = await cancelBulkMessageItem(job.id, i1.id, user.id);
    const it1 = await prisma.bulkMessageItem.findUnique({ where: { id: i1.id } });
    const lead1 = await prisma.lead.findUnique({ where: { id: l1.id } });
    check(it1?.status === "CANCELLED", "item is CANCELLED", it1?.status);
    check(lead1?.status === "NEW", "lead returns to NEW", lead1?.status);
    check(res.status === "RUNNING", "job keeps running while others remain", res.status);

    console.log("\n[2] Guards");
    check(
      (await errorCode(() => cancelBulkMessageItem(job.id, i1.id, user.id))) === "ITEM_NOT_QUEUED",
      "removing it twice is rejected",
    );
    check(
      (await errorCode(() => cancelBulkMessageItem(job.id, iBusy.id, user.id))) === "ITEM_NOT_QUEUED",
      "an item being sent right now cannot be removed",
    );
    check(
      (await errorCode(() => cancelBulkMessageItem(job.id, i2.id, other.id))) === "JOB_NOT_FOUND",
      "another user cannot remove items from this job",
    );
    const it2 = await prisma.bulkMessageItem.findUnique({ where: { id: i2.id } });
    check(it2?.status === "QUEUED", "item untouched after the rejected cross-user call", it2?.status);

    console.log("\n[3] Removing the last item closes the job");
    await prisma.bulkMessageItem.update({ where: { id: iBusy.id }, data: { status: "FAILED" } });
    const last = await cancelBulkMessageItem(job.id, i2.id, user.id);
    check(last.status === "CANCELLED", "job is CANCELLED when nothing was sent", last.status);

    console.log("\n[4] Abort all (job cancel) removes every queued item");
    const job2 = await prisma.bulkMessageJob.create({
      data: { campaignId: campaign.id, userId: user.id, status: "RUNNING", total: 1, queued: 1 },
    });
    const j2item = await mkItem(l4.id, "QUEUED", job2.id);
    const aborted = await cancelBulkMessageJob(job2.id, user.id);
    const j2after = await prisma.bulkMessageItem.findUnique({ where: { id: j2item.id } });
    check(aborted.status === "CANCELLED", "job is CANCELLED", aborted.status);
    check(j2after?.status === "CANCELLED", "its queued item is CANCELLED", j2after?.status);
  } finally {
    await prisma.bulkMessageItem.deleteMany({ where: { job: { campaignId: campaign.id } } });
    await prisma.bulkMessageJob.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.leadStatusHistory.deleteMany({ where: { leadId: { in: [l1.id, l2.id, l3.id, l4.id] } } });
    await prisma.lead.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.campaign.deleteMany({ where: { id: campaign.id } });
    await prisma.companyProfile.deleteMany({ where: { id: profile.id } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
  }

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
