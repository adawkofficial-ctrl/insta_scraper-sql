import "dotenv/config";
import type { Prisma } from "../src/generated/prisma/client";
import { getPrismaClient } from "../src/lib/db/prisma";
import { LeadStatus } from "../src/generated/prisma/enums";

export type BackfillOptions = {
  dryRun?: boolean;
  batchSize?: number;
};

export type BackfillResult = {
  dryRun: boolean;
  totalExamined: number;
  totalUpdated: number;
  totalSkipped: number;
  countsByStatus: Record<string, number>;
};

type LeadRow = Prisma.LeadGetPayload<{
  include: {
    messages: {
      select: {
        id: true;
        status: true;
        direction: true;
        sentAt: true;
        createdAt: true;
      };
    };
    bulkMessageItems: {
      select: {
        id: true;
        status: true;
        createdAt: true;
      };
    };
    statusHistory: {
      take: 1;
      select: { id: true };
    };
  };
}>;

/**
 * Idempotent lead status backfill script.
 * Computes stored status from related Message and BulkMessageItem rows,
 * and creates initial LeadStatusHistory entries.
 */
export async function runBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  const isDryRun = options.dryRun ?? process.argv.includes("--dry-run");
  const batchSize = options.batchSize ?? 500;

  const prisma = getPrismaClient();

  const countsByStatus: Record<string, number> = {
    [LeadStatus.CONTACTED]: 0,
    [LeadStatus.QUEUED]: 0,
    [LeadStatus.NEW]: 0,
  };

  let totalExamined = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  let cursorId: string | undefined = undefined;

  console.log(`\n========================================`);
  console.log(`  LEAD STATUS BACKFILL (${isDryRun ? "DRY RUN" : "LIVE EXECUTION"})`);
  console.log(`========================================\n`);

  while (true) {
    const leads: LeadRow[] = await prisma.lead.findMany({
      take: batchSize,
      skip: cursorId ? 1 : 0,
      cursor: cursorId ? { id: cursorId } : undefined,
      orderBy: { id: "asc" },
      include: {
        messages: {
          select: {
            id: true,
            status: true,
            direction: true,
            sentAt: true,
            createdAt: true,
          },
        },
        bulkMessageItems: {
          select: {
            id: true,
            status: true,
            createdAt: true,
          },
        },
        statusHistory: {
          take: 1,
          select: { id: true },
        },
      },
    });

    if (leads.length === 0) {
      break;
    }

    cursorId = leads[leads.length - 1].id;
    totalExamined += leads.length;

    for (const lead of leads) {
      // Skip leads that already have a status history row, or are non-NEW with history
      if (lead.statusHistory.length > 0) {
        totalSkipped++;
        continue;
      }

      // Compute target status
      const sentOutboundMessages = lead.messages.filter(
        (m: { status: string; direction: string }) => m.status === "SENT" && m.direction !== "INBOUND",
      );

      let targetStatus: LeadStatus = LeadStatus.NEW;
      let lastContactedAt: Date | null = null;

      if (sentOutboundMessages.length > 0) {
        targetStatus = LeadStatus.CONTACTED;
        // Find latest sent message timestamp
        const sorted = sentOutboundMessages.sort((a: { sentAt: Date | null; createdAt: Date }, b: { sentAt: Date | null; createdAt: Date }) => {
          const timeA = (a.sentAt ?? a.createdAt).getTime();
          const timeB = (b.sentAt ?? b.createdAt).getTime();
          return timeB - timeA;
        });
        lastContactedAt = sorted[0].sentAt ?? sorted[0].createdAt;
      } else {
        const hasActiveMessage = lead.messages.some(
          (m: { status: string }) => m.status === "SENDING" || m.status === "DRAFT",
        );
        const hasActiveBulkItem = lead.bulkMessageItems.some(
          (item: { status: string }) => item.status === "QUEUED" || item.status === "PROCESSING",
        );

        if (hasActiveMessage || hasActiveBulkItem) {
          targetStatus = LeadStatus.QUEUED;
        } else {
          // Has only FAILED/UNKNOWN or no messages -> stays NEW
          targetStatus = LeadStatus.NEW;
        }
      }

      countsByStatus[targetStatus] = (countsByStatus[targetStatus] ?? 0) + 1;
      totalUpdated++;

      if (!isDryRun) {
        await prisma.$transaction(async (tx) => {
          await tx.lead.update({
            where: { id: lead.id },
            data: {
              status: targetStatus,
              statusUpdatedAt: new Date(),
              lastContactedAt: lastContactedAt ?? lead.lastContactedAt,
            },
          });

          await tx.leadStatusHistory.create({
            data: {
              leadId: lead.id,
              fromStatus: null,
              toStatus: targetStatus,
              reason: "backfill",
              actor: "system",
            },
          });
        });
      }
    }
  }

  console.log(`Backfill Summary:`);
  console.log(`  Mode:           ${isDryRun ? "DRY RUN (no database changes written)" : "LIVE EXECUTION"}`);
  console.log(`  Total Examined: ${totalExamined}`);
  console.log(`  Total Updated:  ${totalUpdated}`);
  console.log(`  Total Skipped:  ${totalSkipped}`);
  console.log(`  Status Breakdown:`);
  for (const [st, count] of Object.entries(countsByStatus)) {
    console.log(`    - ${st.padEnd(12)}: ${count}`);
  }
  console.log(`\n========================================\n`);

  return {
    dryRun: isDryRun,
    totalExamined,
    totalUpdated,
    totalSkipped,
    countsByStatus,
  };
}

if (require.main === module) {
  runBackfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Backfill failed:", err);
      process.exit(1);
    });
}
