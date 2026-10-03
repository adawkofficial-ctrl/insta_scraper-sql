import "server-only";

import { DraftStatus } from "@/generated/prisma/enums";
import { getPrismaClient } from "@/lib/db/prisma";
import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { generateDraft } from "../ai/draft-service";
import { FIXABLE_BLOCKER_IDS, runQualityGate, type QualityGateResult } from "../quality";

export type GenerateAndCheckResult = {
  draftId: string;
  status: DraftStatus;
  passed: boolean;
  blocked: boolean;
  score: number;
  regenerationCount: number;
  blockers: Array<{ id: string; detail: string }>;
  warnings: Array<{ id: string; detail: string }>;
};

function clampRegenerations(value: number | null | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 2;
  return Math.max(0, Math.min(5, Math.trunc(value)));
}

function summarize(
  draftId: string,
  result: QualityGateResult,
  status: DraftStatus,
  regenerationCount: number,
): GenerateAndCheckResult {
  return {
    draftId,
    status,
    passed: result.passed,
    blocked: status === DraftStatus.BLOCKED,
    score: result.score,
    regenerationCount,
    blockers: result.blockers.map((check) => ({ id: check.id, detail: check.detail })),
    warnings: result.warnings.map((check) => ({ id: check.id, detail: check.detail })),
  };
}

/**
 * Step 5 generateDraft -> Step 6 quality gate -> bounded auto-regeneration.
 *
 * Fixable blockers are fed back as regeneration reasons (up to the campaign's
 * `qualityMaxRegenerations`). Non-fixable blockers (DNC/duplicate/contact/
 * eligibility) stop immediately with BLOCKED. Lead status is never changed here.
 */
export async function generateAndCheckDraft(input: {
  userId: string;
  leadId: string;
}): Promise<GenerateAndCheckResult> {
  const prisma = getPrismaClient();
  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, campaign: { userId: input.userId } },
    include: { campaign: { select: { qualityMaxRegenerations: true } } },
  });
  if (!lead) {
    throw new NotFoundError("LEAD_NOT_FOUND", `Lead "${input.leadId}" was not found.`);
  }
  const maxRegenerations = clampRegenerations(lead.campaign.qualityMaxRegenerations);

  let regenerationReason: string | undefined;
  let lastDraftId = "";
  let lastResult: QualityGateResult | null = null;

  for (let attempt = 0; attempt <= maxRegenerations; attempt += 1) {
    const generated = await generateDraft({
      userId: input.userId,
      leadId: input.leadId,
      regenerationReason,
    });
    lastDraftId = generated.draftId;
    if (attempt > 0) {
      await prisma.messageDraft.update({
        where: { id: lastDraftId },
        data: { regenerationCount: attempt },
      });
    }

    lastResult = await runQualityGate({ draftId: lastDraftId, applyStatus: false });

    if (lastResult.passed) {
      await prisma.messageDraft.update({
        where: { id: lastDraftId },
        data: { status: DraftStatus.PENDING_REVIEW },
      });
      return summarize(lastDraftId, lastResult, DraftStatus.PENDING_REVIEW, attempt);
    }

    const blockerIds = lastResult.blockers.map((check) => check.id);
    const nonFixable = blockerIds.filter((id) => !FIXABLE_BLOCKER_IDS.has(id));
    if (nonFixable.length > 0) {
      await prisma.messageDraft.update({
        where: { id: lastDraftId },
        data: { status: DraftStatus.BLOCKED, regenerationCount: attempt },
      });
      return summarize(lastDraftId, lastResult, DraftStatus.BLOCKED, attempt);
    }

    regenerationReason = [
      `Fix these issues and rewrite the message: ${blockerIds.join(", ")}.`,
      ...lastResult.blockers.map((check) => check.detail),
    ].join(" ");
  }

  if (!lastResult) {
    throw new NotFoundError("DRAFT_NOT_FOUND", "Draft generation did not produce a draft.");
  }
  await prisma.messageDraft.update({
    where: { id: lastDraftId },
    data: { status: DraftStatus.BLOCKED, regenerationCount: maxRegenerations },
  });
  logger.info("[QUALITY] draft blocked after regeneration limit", {
    draftId: lastDraftId,
    leadId: input.leadId,
    blockers: lastResult.blockers.map((check) => check.id),
  });
  return summarize(lastDraftId, lastResult, DraftStatus.BLOCKED, maxRegenerations);
}
