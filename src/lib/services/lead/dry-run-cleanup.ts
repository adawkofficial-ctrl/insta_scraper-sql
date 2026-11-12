import { getPrismaClient } from "@/lib/db/prisma";
import type { Prisma } from "@/generated/prisma/client";

export interface DryRunCounts {
  dryLeads: number;
  dryScrapeJobs: number;
  drySightings: number;
}

export interface DryRunCleanupResult {
  deletedLeads: number;
  deletedScrapeJobs: number;
  deletedSightings: number;
}

/**
 * Gets exact counts of dry-run and mock items currently stored in the database.
 */
export async function getDryRunCounts(userId?: string): Promise<DryRunCounts> {
  const prisma = getPrismaClient();

  const userLeadFilter = userId ? { campaign: { userId } } : {};
  const userJobFilter = userId ? { campaign: { userId } } : {};

  const dryLeads = await prisma.lead.count({
    where: {
      AND: [
        userLeadFilter,
        {
          OR: [
            { isDryRun: true },
            { source: { in: ["dry_run", "sample"] } },
            { source: { startsWith: "sample_" } },
            { username: { startsWith: "sample_business_" } },
            { username: { startsWith: "sample_ig_place_" } },
            { website: { contains: "example.com" } },
            { website: { endsWith: ".example" } },
            { phone: { contains: "555-01" } },
            { phone: { contains: "55501" } },
            { gmapsPlaceId: { startsWith: "ChIJmockPlace" } },
          ],
        },
      ],
    },
  });

  const dryScrapeJobs = await prisma.scrapeJob.count({
    where: {
      AND: [
        userJobFilter,
        {
          OR: [
            { isDryRun: true },
            { provider: { in: ["dry_run", "mock"] } },
          ],
        },
      ],
    },
  });

  const drySightings = await prisma.leadSighting.count({
    where: {
      OR: [
        { lead: { isDryRun: true } },
        { source: { in: ["dry_run", "sample"] } },
      ],
    },
  });

  return { dryLeads, dryScrapeJobs, drySightings };
}

/**
 * Permanently removes dry-run leads, sightings, and scrape jobs.
 * NEVER deletes or alters any real lead or job (where isDryRun is false and real provider).
 */
export async function deleteDryRunData(options?: { userId?: string }): Promise<DryRunCleanupResult> {
  const prisma = getPrismaClient();
  const userId = options?.userId;

  const userLeadFilter = userId ? { campaign: { userId } } : {};
  const userJobFilter = userId ? { campaign: { userId } } : {};

  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Locate all dry-run lead IDs
    const dryLeads = await tx.lead.findMany({
      where: {
        AND: [
          userLeadFilter,
          {
            OR: [
              { isDryRun: true },
              { source: { in: ["dry_run", "sample"] } },
              { source: { startsWith: "sample_" } },
              { username: { startsWith: "sample_business_" } },
              { username: { startsWith: "sample_ig_place_" } },
              { website: { contains: "example.com" } },
              { website: { endsWith: ".example" } },
              { phone: { contains: "555-01" } },
              { phone: { contains: "55501" } },
              { gmapsPlaceId: { startsWith: "ChIJmockPlace" } },
            ],
          },
        ],
      },
      select: { id: true },
    });

    const leadIds = dryLeads.map((l: { id: string }) => l.id);

    // 2. Locate all dry-run ScrapeJobs
    const allJobs = await tx.scrapeJob.findMany({
      where: userJobFilter,
      select: { id: true, isDryRun: true, provider: true, usage: true },
    });

    const dryJobIds: string[] = [];
    for (const job of allJobs) {
      const u = job.usage as Record<string, unknown> | null;
      const isUsageDry =
        u?.isDryRun === true ||
        (Array.isArray(u?.runIds) && u.runIds.some((r: unknown) => typeof r === "string" && r.startsWith("dry_run_")));
      if (job.isDryRun || job.provider === "dry_run" || job.provider === "mock" || isUsageDry) {
        dryJobIds.push(job.id);
      }
    }

    // 3. Delete dependent rows for dry-run leads
    let deletedSightings = 0;
    if (leadIds.length > 0) {
      const sightingsRes = await tx.leadSighting.deleteMany({
        where: { leadId: { in: leadIds } },
      });
      deletedSightings = sightingsRes.count;

      await tx.leadEvent.deleteMany({
        where: { leadId: { in: leadIds } },
      });

      await tx.message.deleteMany({
        where: { leadId: { in: leadIds } },
      });

      await tx.followUpMessage.deleteMany({
        where: { leadId: { in: leadIds } },
      });

      await tx.leadStatusHistory.deleteMany({
        where: { leadId: { in: leadIds } },
      });
    }

    // 4. Delete the dry-run leads
    let deletedLeads = 0;
    if (leadIds.length > 0) {
      const deleteLeadsRes = await tx.lead.deleteMany({
        where: { id: { in: leadIds } },
      });
      deletedLeads = deleteLeadsRes.count;
    }

    // 5. Delete the dry-run scrape jobs
    let deletedScrapeJobs = 0;
    if (dryJobIds.length > 0) {
      const deleteJobsRes = await tx.scrapeJob.deleteMany({
        where: { id: { in: dryJobIds } },
      });
      deletedScrapeJobs = deleteJobsRes.count;
    }

    return {
      deletedLeads,
      deletedScrapeJobs,
      deletedSightings,
    };
  });
}
