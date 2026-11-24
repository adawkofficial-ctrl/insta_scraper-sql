import "server-only";

import {
  BulkMessageItemStatus,
  BulkMessageJobStatus,
  LeadStatus,
} from "@/generated/prisma/enums";
import { getPrismaClient } from "@/lib/db/prisma";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkManySuppression, DncChannel } from "@/lib/services/compliance";
import { findPreviouslyContactedLeadIds } from "@/lib/services/dedup";
import { transitionLeadStatus } from "@/lib/services/lead/lead-status-service";
import { findConnectedSenderForDispatch } from "@/lib/services/senders/instagram-sender-service";
import { findSenderAccountOwned } from "@/lib/services/senders/instagram-sender-repository";
import { resolveLeadProfileUrl } from "@/lib/services/lead/profile-url";
import { draftBodyHash } from "@/lib/services/quality";
import type { BulkJobStatusResponse } from "../messaging/bulk-messaging-service";
import {
  calculateContentFingerprint,
  formatScopedIdempotencyKey,
} from "../messaging/idempotency";

const QUEUEABLE_LEAD_STATUSES: readonly LeadStatus[] = [
  LeadStatus.READY_FOR_OUTREACH,
  LeadStatus.QUALIFIED,
  LeadStatus.NEW,
];

async function resolveConnectedSender(
  senderAccountId: string | undefined,
  userId: string,
): Promise<string> {
  if (senderAccountId && senderAccountId.trim().length > 0) {
    const owned = await findSenderAccountOwned(senderAccountId.trim(), userId);
    if (!owned) {
      throw new NotFoundError(
        "SENDER_NOT_FOUND",
        `Instagram sender account "${senderAccountId}" was not found.`,
      );
    }
    if (owned.status !== "CONNECTED") {
      throw new BadRequestError(
        owned.status === "AUTH_REQUIRED" || owned.status === "EXPIRED"
          ? "AUTH_REQUIRED"
          : "SESSION_UNAVAILABLE",
        `Instagram sender @${owned.username} is not connected (status: ${owned.status}).`,
      );
    }
    return owned.id;
  }
  const connected = await findConnectedSenderForDispatch(userId);
  if (!connected) {
    throw new BadRequestError(
      "SENDER_REQUIRED",
      "Connect an Instagram sender account before sending approved drafts.",
    );
  }
  return connected.id;
}

export type DraftSendSummary = {
  totalSelected: number;
  eligibleCount: number;
  skippedCount: number;
  skippedReasons: Array<{ draftId: string; leadId: string; reason: string }>;
};

/**
 * Step 6: creates a BulkMessageJob from APPROVED drafts only.
 *
 * Every item carries draftId + the exact approved body + bodyHash. The lead is
 * moved to QUEUED. Pre-check skips (DNC, duplicate, already contacted, missing
 * sender/profile, stale hash) are reported and never sent.
 */
export async function createDraftSendJob(input: {
  userId: string;
  campaignId: string;
  senderAccountId?: string;
  limit?: number;
  draftIds?: string[];
}): Promise<{ job: BulkJobStatusResponse; summary: DraftSendSummary }> {
  const prisma = getPrismaClient();
  const campaign = await prisma.campaign.findFirst({
    where: { id: input.campaignId, userId: input.userId },
    select: { id: true },
  });
  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign "${input.campaignId}" was not found.`);
  }

  const senderAccountId = await resolveConnectedSender(input.senderAccountId, input.userId);
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));

  const drafts = await prisma.messageDraft.findMany({
    where: {
      campaignId: campaign.id,
      userId: input.userId,
      status: "APPROVED",
      ...(input.draftIds && input.draftIds.length > 0 ? { id: { in: input.draftIds } } : {}),
    },
    include: { lead: true },
    orderBy: { approvedAt: "asc" },
    take: limit,
  });
  if (drafts.length === 0) {
    throw new BadRequestError("NO_APPROVED_DRAFTS", "No approved drafts are available to send.");
  }

  const draftIds = drafts.map((draft) => draft.id);
  const [existingItems, sentMessages, previouslyContacted, suppressionMap] = await Promise.all([
    prisma.bulkMessageItem.findMany({
      where: { draftId: { in: draftIds } },
      select: { draftId: true },
    }),
    prisma.message.findMany({
      where: { draftId: { in: draftIds }, status: "SENT", direction: "OUTBOUND" },
      select: { draftId: true },
    }),
    findPreviouslyContactedLeadIds(drafts.map((draft) => draft.leadId)),
    checkManySuppression({
      userId: input.userId,
      leads: drafts.map((draft) => draft.lead),
      channel: DncChannel.INSTAGRAM,
    }),
  ]);

  const attachedDrafts = new Set(existingItems.map((item) => item.draftId).filter(Boolean) as string[]);
  const sentDrafts = new Set(sentMessages.map((message) => message.draftId).filter(Boolean) as string[]);

  const prepared: Array<{
    draftId: string;
    leadId: string;
    leadStatus: LeadStatus;
    body: string;
    bodyHash: string;
  }> = [];
  const skippedReasons: Array<{ draftId: string; leadId: string; reason: string }> = [];

  for (const draft of drafts) {
    const lead = draft.lead;
    const body = draft.editedBody ?? draft.body;
    const hash = draftBodyHash(body);
    const skip = (reason: string) => skippedReasons.push({ draftId: draft.id, leadId: lead.id, reason });

    if (!draft.approvedBodyHash || hash !== draft.approvedBodyHash) {
      skip("DRAFT_CHANGED");
      continue;
    }
    if (attachedDrafts.has(draft.id)) {
      skip("ALREADY_QUEUED");
      continue;
    }
    if (sentDrafts.has(draft.id)) {
      skip("ALREADY_SENT");
      continue;
    }
    if (lead.duplicateOfLeadId) {
      skip("DUPLICATE_LEAD");
      continue;
    }
    if (suppressionMap.get(lead.id)?.suppressed) {
      skip("SUPPRESSED_DNC");
      continue;
    }
    if (previouslyContacted.has(lead.id)) {
      skip("ALREADY_CONTACTED");
      continue;
    }
    const url = resolveLeadProfileUrl(lead);
    if (!url) {
      skip("MISSING_PROFILE_URL");
      continue;
    }

    prepared.push({ draftId: draft.id, leadId: lead.id, leadStatus: lead.status, body, bodyHash: hash });
  }

  if (prepared.length === 0) {
    throw new BadRequestError(
      "NO_ELIGIBLE_DRAFTS",
      "None of the approved drafts passed the pre-send checks.",
    );
  }

  const createdJob = await prisma.$transaction(async (tx) => {
    const job = await tx.bulkMessageJob.create({
      data: {
        campaignId: campaign.id,
        userId: input.userId,
        templateId: null,
        senderAccountId,
        status: BulkMessageJobStatus.QUEUED,
        total: prepared.length,
        queued: prepared.length,
        skipped: skippedReasons.length,
      },
    });

    await tx.bulkMessageItem.createMany({
      data: prepared.map((item) => ({
        jobId: job.id,
        leadId: item.leadId,
        renderedMessage: item.body,
        renderedBody: item.body,
        bodyHash: item.bodyHash,
        draftId: item.draftId,
        status: BulkMessageItemStatus.QUEUED,
        contentHash: calculateContentFingerprint(job.campaignId, item.leadId, item.body),
        idempotencyKey: formatScopedIdempotencyKey(undefined, job.campaignId, item.leadId, 1),
      })),
    });

    for (const item of prepared) {
      if (QUEUEABLE_LEAD_STATUSES.includes(item.leadStatus)) {
        await transitionLeadStatus({
          leadId: item.leadId,
          to: LeadStatus.QUEUED,
          reason: "draft_send_job_queued",
          actor: `user:${input.userId}`,
          tx,
        });
      }
    }

    return job;
  });

  logger.info("[QUALITY] draft send job created", {
    jobId: createdJob.id,
    campaignId: campaign.id,
    eligible: prepared.length,
    skipped: skippedReasons.length,
  });

  return {
    job: {
      id: createdJob.id,
      campaignId: createdJob.campaignId,
      templateId: createdJob.templateId,
      senderAccountId: createdJob.senderAccountId,
      status: createdJob.status,
      total: createdJob.total,
      queued: createdJob.queued,
      processing: 0,
      sent: 0,
      failed: 0,
      skipped: createdJob.skipped,
      cancelled: 0,
      unknown: 0,
      progress: 0,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: createdJob.createdAt.toISOString(),
    },
    summary: {
      totalSelected: drafts.length,
      eligibleCount: prepared.length,
      skippedCount: skippedReasons.length,
      skippedReasons,
    },
  };
}
