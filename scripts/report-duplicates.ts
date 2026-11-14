/**
 * Step 4 duplicate report (READ-ONLY).
 *
 * Run order:
 *   1. backfill-identity --dry-run
 *   2. backfill-identity
 *   3. report-duplicates            <-- this script
 *   4. apply-duplicate-links --dry-run
 *   5. apply-duplicate-links --apply
 *
 * Groups existing leads per user by usernameNormalized, emailNormalized and
 * websiteKey. Prints counts and masked samples; writes the FULL report to
 * ./tmp/report-duplicates-<timestamp>.json (gitignored).
 *
 * Usage: npx tsx scripts/report-duplicates.ts
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";
import { MessageDirection, MessageStatus } from "../src/generated/prisma/enums";

const CONTACTED_OR_LATER = new Set([
  "CONTACTED", "REPLIED", "INTERESTED", "FOLLOW_UP", "MEETING", "CONVERTED", "NOT_INTERESTED",
]);

function mask(value: string | null): string {
  if (!value) return "-";
  if (value.length <= 2) return "*".repeat(value.length);
  return `${value.slice(0, 2)}***${value.slice(-1)}`;
}

async function main() {
  const prisma = createPrismaClient();

  const leads = await prisma.lead.findMany({
    select: {
      id: true,
      userId: true,
      campaignId: true,
      username: true,
      usernameNormalized: true,
      emailNormalized: true,
      websiteKey: true,
      status: true,
      createdAt: true,
      lastContactedAt: true,
      duplicateOfLeadId: true,
    },
  });

  const sentCounts = new Map<string, number>();
  const grouped = await prisma.message.groupBy({
    by: ["leadId"],
    where: { direction: MessageDirection.OUTBOUND, status: MessageStatus.SENT },
    _count: { _all: true },
  });
  for (const row of grouped) sentCounts.set(row.leadId, row._count._all);

  const pickCanonical = (members: typeof leads) =>
    [...members].sort((a, b) => {
      const aC = a.lastContactedAt !== null || CONTACTED_OR_LATER.has(a.status);
      const bC = b.lastContactedAt !== null || CONTACTED_OR_LATER.has(b.status);
      if (aC !== bC) return aC ? -1 : 1;
      const aM = (sentCounts.get(a.id) ?? 0) > 0;
      const bM = (sentCounts.get(b.id) ?? 0) > 0;
      if (aM !== bM) return aM ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    })[0];

  const buildGroups = (keyOf: (lead: (typeof leads)[number]) => string | null) => {
    const map = new Map<string, typeof leads>();
    for (const lead of leads) {
      const key = keyOf(lead);
      if (!key) continue;
      const keyed = `${lead.userId ?? "-"}::${key}`;
      const list = map.get(keyed) ?? [];
      list.push(lead);
      map.set(keyed, list);
    }
    return [...map.entries()].filter(([, members]) => members.length > 1);
  };

  const usernameGroups = buildGroups((l) => l.usernameNormalized);
  const emailGroups = buildGroups((l) => l.emailNormalized);
  const websiteGroups = buildGroups((l) => l.websiteKey);

  const report = {
    generatedAt: new Date().toISOString(),
    totals: {
      leads: leads.length,
      usernameGroups: usernameGroups.length,
      emailGroups: emailGroups.length,
      websiteGroups: websiteGroups.length,
    },
    usernameGroups: usernameGroups.map(([key, members]) => ({
      key,
      canonicalLeadId: pickCanonical(members).id,
      members: members.map((m) => ({
        id: m.id,
        username: m.username,
        campaignId: m.campaignId,
        status: m.status,
        sentMessages: sentCounts.get(m.id) ?? 0,
        duplicateOfLeadId: m.duplicateOfLeadId,
      })),
    })),
    emailGroups: emailGroups.map(([key, members]) => ({
      key,
      canonicalLeadId: pickCanonical(members).id,
      memberIds: members.map((m) => m.id),
    })),
    websiteGroups: websiteGroups.map(([key, members]) => ({
      key,
      proposedCanonicalLeadId: pickCanonical(members).id,
      memberIds: members.map((m) => m.id),
    })),
  };

  const tmpDir = path.resolve(process.cwd(), "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const outFile = path.join(tmpDir, `report-duplicates-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

  console.log("=== Step 4 duplicate report (masked) ===");
  console.log(`leads=${leads.length}`);
  console.log(
    `groups: username=${usernameGroups.length} email=${emailGroups.length} website=${websiteGroups.length}`,
  );
  for (const [key, members] of usernameGroups.slice(0, 10)) {
    const canonical = pickCanonical(members);
    console.log(
      `  usernameGroup members=${members.length} sample=${mask(canonical.usernameNormalized ?? key)} canonical=${canonical.id} canonicalSent=${sentCounts.get(canonical.id) ?? 0}`,
    );
  }
  console.log(`fullReport=${path.relative(process.cwd(), outFile)}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
