import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { NotFoundError } from "@/lib/errors";

import { ScrapeJobStatus } from "@/generated/prisma/client";

export type ListScrapeJobsOptions = {
  page?: number;
  limit?: number;
  status?: string;
};

export async function listCampaignScrapeJobs(
  campaignId: string,
  options?: ListScrapeJobsOptions,
  userId?: string,
): Promise<unknown[]> {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: { id: true },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", "Campaign not found");
  }

  const validStatuses = Object.values(ScrapeJobStatus);
  const statusFilter =
    options?.status && validStatuses.includes(options.status.toUpperCase() as ScrapeJobStatus)
      ? (options.status.toUpperCase() as ScrapeJobStatus)
      : undefined;

  const limit = options?.limit ? Math.min(Math.max(Number(options.limit), 1), 100) : 50;
  const page = options?.page ? Math.max(Number(options.page), 1) : 1;
  const skip = (page - 1) * limit;

  const jobs = await prisma.scrapeJob.findMany({
    where: {
      campaignId,
      ...(statusFilter ? { status: statusFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    skip,
    take: limit,
    select: {
      id: true,
      status: true,
      provider: true,
      inputCount: true,
      processedCount: true,
      errorMessage: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      query: true,
      location: true,
      category: true,
      discoveryActor: true,
      enrichmentActor: true,
      requestedLimit: true,
      candidatesDiscovered: true,
      candidatesEnriched: true,
      candidatesSkipped: true,
      isDryRun: true,
      usage: true,
      stopReason: true,
      costUsd: true,
      costBreakdown: true,
    },
  });

  return jobs;
}

export async function getScrapeJobById(
  jobId: string,
  userId?: string,
): Promise<unknown> {
  const prisma = getPrismaClient();

  const job = await prisma.scrapeJob.findFirst({
    where: {
      id: jobId,
      ...(userId ? { campaign: { userId } } : {}),
    },
    include: {
      campaign: {
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
        },
      },
    },
  });

  if (!job) {
    throw new NotFoundError("SCRAPE_JOB_NOT_FOUND", "Scrape job not found");
  }

  return job;
}
