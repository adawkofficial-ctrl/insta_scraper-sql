import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { AiAnalysisJobStatus, AiStatus } from "@/generated/prisma/enums";
import {
  BadRequestError,
  CompanyProfileIncompleteError,
  NotFoundError,
} from "@/lib/errors";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  getCompanyProfileCompleteness,
  resolveCompanyProfileForCampaign,
} from "../company-profile";
import { analyzeLead } from "./lead-analysis-service";
import { generateAndCheckDraft } from "../drafts/draft-pipeline-service";

const DEFAULT_MAX_LEADS_PER_JOB = 500;

export type AiAnalysisJobOptions = {
  limit?: number;
  onlyUnanalyzed?: boolean;
  generateDrafts?: boolean;
  force?: boolean;
};

export function getAiAnalysisMaxLeadsPerJob(): number {
  const raw = Number(getServerEnv("AI_ANALYSIS_MAX_LEADS_PER_JOB") ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_MAX_LEADS_PER_JOB;
}

async function assertCompleteProfile(userId: string, campaignId: string): Promise<void> {
  const profile = await resolveCompanyProfileForCampaign(campaignId, userId);
  const completeness = getCompanyProfileCompleteness(profile);
  if (!completeness.complete) {
    throw new CompanyProfileIncompleteError(completeness.missingFields, completeness.warnings);
  }
}

/** Creates the job. The completeness gate runs BEFORE any Gemini call. */
export async function createAiAnalysisJob(input: {
  userId: string;
  campaignId: string;
  options?: AiAnalysisJobOptions;
}): Promise<{ jobId: string; total: number; capped: boolean }> {
  const prisma = getPrismaClient();
  const campaign = await prisma.campaign.findFirst({
    where: { id: input.campaignId, userId: input.userId },
    select: { id: true },
  });
  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign "${input.campaignId}" was not found.`);
  }

  await assertCompleteProfile(input.userId, input.campaignId);

  const options = input.options ?? {};
  const cap = getAiAnalysisMaxLeadsPerJob();
  const requested = options.limit && options.limit > 0 ? options.limit : cap;
  const effectiveLimit = Math.min(requested, cap);

  const where: Prisma.LeadWhereInput = {
    campaignId: input.campaignId,
    duplicateOfLeadId: null,
    status: { not: "DO_NOT_CONTACT" },
    ...(options.onlyUnanalyzed === false ? {} : { aiStatus: AiStatus.PENDING }),
    ...(options.generateDrafts === true
      ? {
          OR: [
            { qualityTier: null },
            { qualityTier: { notIn: ["D", "C"] } },
          ],
        }
      : {}),
  };
  const eligible = await prisma.lead.count({ where });

  const job = await prisma.aiAnalysisJob.create({
    data: {
      userId: input.userId,
      campaignId: input.campaignId,
      status: AiAnalysisJobStatus.PENDING,
      total: Math.min(eligible, effectiveLimit),
      options: {
        limit: effectiveLimit,
        onlyUnanalyzed: options.onlyUnanalyzed !== false,
        generateDrafts: options.generateDrafts === true,
        force: options.force === true,
      },
    },
  });

  void runAiAnalysisJob(job.id).catch((error) => {
    logger.error("AI_JOB_FAILED", error, { jobId: job.id });
  });

  return { jobId: job.id, total: job.total, capped: eligible > effectiveLimit };
}

/** Pure per-lead unit so Step 7 can wrap this in a BullMQ worker unchanged. */
export async function processLead(input: {
  userId: string;
  leadId: string;
  force?: boolean;
  generateDrafts?: boolean;
}): Promise<{ analyzed: boolean; drafted: boolean; skipped: boolean; draftId?: string; draftStatus?: string }> {
  const analysis = await analyzeLead({
    userId: input.userId,
    leadId: input.leadId,
    force: input.force,
  });
  if (analysis.status !== "DONE") {
    return { analyzed: false, drafted: false, skipped: analysis.status === "SKIPPED" };
  }
  if (input.generateDrafts) {
    try {
      // Step 6: gate + bounded regeneration instead of storing a raw draft.
      const result = await generateAndCheckDraft({ userId: input.userId, leadId: input.leadId });
      return {
        analyzed: true,
        drafted: true,
        skipped: false,
        draftId: result.draftId,
        draftStatus: result.status,
      };
    } catch (error) {
      if (error instanceof CompanyProfileIncompleteError) throw error;
      return { analyzed: true, drafted: false, skipped: false };
    }
  }
  return { analyzed: true, drafted: false, skipped: false };
}

/** In-process runner with pause/cancel support (checks flags between leads). */
export async function runAiAnalysisJob(jobId: string): Promise<void> {
  const prisma = getPrismaClient();
  const job = await prisma.aiAnalysisJob.findUnique({ where: { id: jobId } });
  if (!job || job.status === AiAnalysisJobStatus.RUNNING) return;

  await prisma.aiAnalysisJob.update({
    where: { id: jobId },
    data: { status: AiAnalysisJobStatus.RUNNING, startedAt: new Date(), lastError: null },
  });

  const options = (job.options ?? {}) as AiAnalysisJobOptions;
  const where: Prisma.LeadWhereInput = {
    campaignId: job.campaignId,
    duplicateOfLeadId: null,
    status: { not: "DO_NOT_CONTACT" },
    ...(options.onlyUnanalyzed === false ? {} : { aiStatus: AiStatus.PENDING }),
    ...(options.generateDrafts === true
      ? {
          OR: [
            { qualityTier: null },
            { qualityTier: { notIn: ["D", "C"] } },
          ],
        }
      : {}),
  };
  const leads = await prisma.lead.findMany({
    where,
    orderBy: [{ qualityScore: "desc" }, { createdAt: "asc" }],
    take: job.total > 0 ? job.total : getAiAnalysisMaxLeadsPerJob(),
    select: { id: true },
  });

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const lead of leads) {
    const current = await prisma.aiAnalysisJob.findUnique({
      where: { id: jobId },
      select: { status: true, cancelRequested: true },
    });
    if (!current || current.cancelRequested || current.status === AiAnalysisJobStatus.PAUSED) {
      await prisma.aiAnalysisJob.update({
        where: { id: jobId },
        data: {
          status: current?.cancelRequested
            ? AiAnalysisJobStatus.CANCELLED
            : AiAnalysisJobStatus.PAUSED,
          processed,
          succeeded,
          failed,
          skipped,
          finishedAt: new Date(),
        },
      });
      return;
    }

    try {
      const result = await processLead({
        userId: job.userId,
        leadId: lead.id,
        force: options.force,
        generateDrafts: options.generateDrafts,
      });
      if (result.skipped) skipped += 1;
      else succeeded += 1;
    } catch (error) {
      if (error instanceof CompanyProfileIncompleteError) {
        await prisma.aiAnalysisJob.update({
          where: { id: jobId },
          data: {
            status: AiAnalysisJobStatus.FAILED,
            lastError: "COMPANY_PROFILE_INCOMPLETE",
            processed,
            succeeded,
            failed,
            skipped,
            finishedAt: new Date(),
          },
        });
        return;
      }
      // Fatal AI errors stop the job immediately with a clear reason.
      const code = (error as { code?: string }).code ?? "";
      if (code === "AI_AUTH_FAILED" || code === "AI_QUOTA_EXHAUSTED") {
        await prisma.aiAnalysisJob.update({
          where: { id: jobId },
          data: {
            status: AiAnalysisJobStatus.FAILED,
            lastError: code,
            processed,
            succeeded,
            failed,
            skipped,
            finishedAt: new Date(),
          },
        });
        return;
      }
      failed += 1;
    }

    processed += 1;
    await prisma.aiAnalysisJob.update({
      where: { id: jobId },
      data: { processed, succeeded, failed, skipped },
    });
  }

  await prisma.aiAnalysisJob.update({
    where: { id: jobId },
    data: { status: AiAnalysisJobStatus.COMPLETED, finishedAt: new Date() },
  });
}

export async function getAiAnalysisJob(jobId: string, userId: string) {
  const job = await getPrismaClient().aiAnalysisJob.findFirst({
    where: { id: jobId, userId },
  });
  if (!job) {
    throw new NotFoundError("AI_JOB_NOT_FOUND", `AI job "${jobId}" was not found.`);
  }
  return job;
}

export async function setAiAnalysisJobState(
  jobId: string,
  userId: string,
  action: "cancel" | "pause" | "resume",
): Promise<void> {
  const job = await getAiAnalysisJob(jobId, userId);
  const prisma = getPrismaClient();
  if (action === "cancel") {
    await prisma.aiAnalysisJob.update({
      where: { id: job.id },
      data: { cancelRequested: true, status: AiAnalysisJobStatus.CANCELLED, finishedAt: new Date() },
    });
    return;
  }
  if (action === "pause") {
    if (job.status !== AiAnalysisJobStatus.RUNNING) {
      throw new BadRequestError("AI_JOB_NOT_RUNNING", "Only a running job can be paused.");
    }
    await prisma.aiAnalysisJob.update({
      where: { id: job.id },
      data: { status: AiAnalysisJobStatus.PAUSED },
    });
    return;
  }
  // resume
  await prisma.aiAnalysisJob.update({
    where: { id: job.id },
    data: { status: AiAnalysisJobStatus.PENDING, cancelRequested: false },
  });
  void runAiAnalysisJob(job.id).catch(() => undefined);
}
