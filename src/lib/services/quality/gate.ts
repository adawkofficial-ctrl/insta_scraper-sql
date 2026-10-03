import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { DraftStatus } from "@/generated/prisma/enums";
import { getPrismaClient } from "@/lib/db/prisma";
import { loadQualityContext } from "./context";
import { runQualityChecks } from "./runner";
import type { QualityGateResult } from "./types";

/**
 * Runs the full quality gate for a draft and persists the result.
 *
 * Status handling (applyStatus !== false):
 * - passed -> PENDING_REVIEW
 * - failed -> DRAFT, or BLOCKED when `finalizeBlocked` is true
 * Never touches lead status. Callers that manage status themselves (approval)
 * pass `applyStatus: false`.
 */
export async function runQualityGate(input: {
  draftId: string;
  finalizeBlocked?: boolean;
  applyStatus?: boolean;
  tx?: Prisma.TransactionClient;
}): Promise<QualityGateResult> {
  const client = input.tx ?? getPrismaClient();
  const { ctx } = await loadQualityContext({ draftId: input.draftId, tx: input.tx });
  const result = runQualityChecks(ctx);

  const qualityData: Prisma.MessageDraftUpdateInput = {
    qualityVersion: result.qualityVersion,
    qualityScore: result.score,
    qualityPassed: result.passed,
    qualityResult: result as unknown as Prisma.InputJsonValue,
    qualityCheckedAt: new Date(),
    bodyHash: result.bodyHash,
  };

  if (input.applyStatus !== false) {
    qualityData.status = result.passed
      ? DraftStatus.PENDING_REVIEW
      : input.finalizeBlocked
        ? DraftStatus.BLOCKED
        : DraftStatus.DRAFT;
  }

  await client.messageDraft.update({ where: { id: input.draftId }, data: qualityData });
  return result;
}

/** Pure evaluation of an already-loaded context (no persistence). */
export { runQualityChecks, runBlockerChecks } from "./runner";
