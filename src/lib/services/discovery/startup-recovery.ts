import "server-only";

import { ScrapeJobStatus } from "@/generated/prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { resumeScrapeJob } from "./resume-service";

export type StartupRecoveryResult = {
  scanned: number;
  resumed: number;
  failed: number;
  jobIds: string[];
};

/**
 * Resume unfinished discovery jobs after a process/host restart.
 * Resume only processes candidates already in the DB; it never starts a paid
 * Maps actor run. Safe to run repeatedly (resume is idempotent).
 */
export async function recoverUnfinishedScrapeJobs(): Promise<StartupRecoveryResult> {
  if (process.env.DISABLE_STARTUP_RECOVERY === "1") {
    return { scanned: 0, resumed: 0, failed: 0, jobIds: [] };
  }
  const prisma = getPrismaClient();
  const jobs = await prisma.scrapeJob.findMany({
    where: { status: { in: [ScrapeJobStatus.PENDING, ScrapeJobStatus.RUNNING] } },
    select: { id: true, campaign: { select: { userId: true } } },
    take: 25,
  });
  let resumed = 0;
  let failed = 0;
  const jobIds: string[] = [];
  for (const job of jobs) {
    try {
      await resumeScrapeJob(job.id, job.campaign?.userId, { skipEnrichment: true });
      resumed++;
      jobIds.push(job.id);
    } catch {
      failed++;
    }
  }
  return { scanned: jobs.length, resumed, failed, jobIds };
}
