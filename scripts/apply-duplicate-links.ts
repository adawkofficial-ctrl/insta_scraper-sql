/**
 * Step 4 apply duplicate links. NON-DESTRUCTIVE.
 *
 * Run order:
 *   1. backfill-identity --dry-run
 *   2. backfill-identity
 *   3. report-duplicates   (review the output!)
 *   4. apply-duplicate-links --dry-run
 *   5. apply-duplicate-links --apply
 *
 * HARD groups (same usernameNormalized OR same emailNormalized within a user)
 * set duplicateOfLeadId = canonical on non-canonical members. Website-only
 * groups become possibleDuplicateOfLeadId flags. Rows and Messages are NEVER
 * deleted or moved. If a non-canonical lead has its own SENT messages the link
 * is still applied but reported for manual review.
 *
 * Usage: npx tsx scripts/apply-duplicate-links.ts [--dry-run|--apply]
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";
import { MessageDirection, MessageStatus } from "../src/generated/prisma/enums";

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

const CONTACTED_OR_LATER = new Set([
  "CONTACTED", "REPLIED", "INTERESTED", "FOLLOW_UP", "MEETING", "CONVERTED", "NOT_INTERESTED",
]);

type LeadRow = {
  id: string;
  userId: string | null;
  campaignId: string;
  usernameNormalized: string | null;
  emailNormalized: string | null;
  websiteKey: string | null;
  status: string;
  createdAt: Date;
  lastContactedAt: Date | null;
  duplicateOfLeadId: string | null;
  possibleDuplicateOfLeadId: string | null;
};

async function main() {
  const prisma = createPrismaClient();

  const leads = (await prisma.lead.findMany({
    select: {
      id: true, userId: true, campaignId: true, usernameNormalized: true,
      emailNormalized: true, websiteKey: true, status: true, createdAt: true,
      lastContactedAt: true, duplicateOfLeadId: true, possibleDuplicateOfLeadId: true,
    },
  })) as LeadRow[];

  const sentCounts = new Map<string, number>();
  for (const row of await prisma.message.groupBy({
    by: ["leadId"],
    where: { direction: MessageDirection.OUTBOUND, status: MessageStatus.SENT },
    _count: { _all: true },
  })) {
    sentCounts.set(row.leadId, row._count._all);
  }

  const pickCanonical = (members: LeadRow[]) =>
    [...members].sort((a, b) => {
      const aC = a.lastContactedAt !== null || CONTACTED_OR_LATER.has(a.status);
      const bC = b.lastContactedAt !== null || CONTACTED_OR_LATER.has(b.status);
      if (aC !== bC) return aC ? -1 : 1;
      const aM = (sentCounts.get(a.id) ?? 0) > 0;
      const bM = (sentCounts.get(b.id) ?? 0) > 0;
      if (aM !== bM) return aM ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    })[0];

  const group = (keyOf: (l: LeadRow) => string | null) => {
    const map = new Map<string, LeadRow[]>();
    for (const lead of leads) {
      const key = keyOf(lead);
      if (!key) continue;
      const keyed = `${lead.userId ?? "-"}::${key}`;
      const existing = map.get(keyed);
      if (existing) existing.push(lead);
      else map.set(keyed, [lead]);
    }
    return [...map.values()].filter((m) => m.length > 1);
  };

  const hardLinked = new Set<string>();
  let hardLinks = 0;
  let websiteFlags = 0;
  const sentOnNonCanonical: string[] = [];

  const linkGroup = async (members: LeadRow[], matchedBy: string) => {
    const canonical = pickCanonical(members);
    hardLinked.add(canonical.id);
    for (const member of members) {
      if (member.id === canonical.id) continue;
      hardLinked.add(member.id);
      if (member.duplicateOfLeadId === canonical.id) continue;
      hardLinks++;
      if ((sentCounts.get(member.id) ?? 0) > 0) sentOnNonCanonical.push(member.id);
      if (!DRY_RUN) {
        await prisma.lead.update({
          where: { id: member.id },
          data: { duplicateOfLeadId: canonical.id, dedupMatchedBy: matchedBy },
        });
      }
    }
  };

  for (const members of group((l) => l.usernameNormalized)) {
    await linkGroup(members, "USERNAME");
  }
  for (const members of group((l) => l.emailNormalized)) {
    await linkGroup(members, "EMAIL");
  }

  // Website-only groups: flag possible duplicates (soft), unless already hard-linked.
  for (const members of group((l) => l.websiteKey)) {
    if (members.some((m) => hardLinked.has(m.id))) continue;
    const canonical = pickCanonical(members);
    for (const member of members) {
      if (member.id === canonical.id) continue;
      if (member.possibleDuplicateOfLeadId === canonical.id) continue;
      websiteFlags++;
      if (!DRY_RUN) {
        await prisma.lead.update({
          where: { id: member.id },
          data: {
            possibleDuplicateOfLeadId: canonical.id,
            possibleDuplicateReason: "WEBSITE_KEY",
            dedupFlaggedAt: new Date(),
          },
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: DRY_RUN ? "dry-run" : "apply",
        hardLinks,
        websiteFlags,
        nonCanonicalWithSentMessages: sentOnNonCanonical.length,
        nonCanonicalWithSentMessagesSample: sentOnNonCanonical.slice(0, 10),
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
