import { DraftStatus } from "@/generated/prisma/enums";
import { getPrismaClient } from "@/lib/db/prisma";
import { draftBodyHash, loadQualityContext, runBlockerChecks } from "@/lib/services/quality";

export type DraftDispatchDecision =
  | { action: "SEND"; draftId: string; messageText: string; promptVersion: string }
  | {
      action: "SKIP";
      code: "DRAFT_NOT_FOUND" | "DRAFT_CHANGED" | "QUALITY_BLOCKED_AT_SEND";
      reasons: string[];
    };

/**
 * Step 6 dispatch-time re-verification for draft-based items.
 *
 * The item is sent ONLY while the draft is APPROVED and its exact final body
 * still matches the approved hash. It also re-runs the deterministic gate
 * BLOCKERS (fresh DNC / duplicate / contact / content state). A skip here never
 * counts as a sender failure.
 */
export async function evaluateDraftDispatch(draftId: string): Promise<DraftDispatchDecision> {
  const prisma = getPrismaClient();
  const draft = await prisma.messageDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      status: true,
      body: true,
      editedBody: true,
      approvedBodyHash: true,
      promptVersion: true,
    },
  });
  if (!draft) {
    return { action: "SKIP", code: "DRAFT_NOT_FOUND", reasons: [] };
  }

  const finalBody = draft.editedBody ?? draft.body;
  const hashMatches =
    draft.status === DraftStatus.APPROVED &&
    Boolean(draft.approvedBodyHash) &&
    draftBodyHash(finalBody) === draft.approvedBodyHash;
  if (!hashMatches) {
    return { action: "SKIP", code: "DRAFT_CHANGED", reasons: ["APPROVED_HASH_MISMATCH"] };
  }

  const { ctx } = await loadQualityContext({ draftId });
  const blockers = runBlockerChecks(ctx);
  if (blockers.length > 0) {
    return {
      action: "SKIP",
      code: "QUALITY_BLOCKED_AT_SEND",
      reasons: blockers.map((check) => check.id),
    };
  }

  return {
    action: "SEND",
    draftId: draft.id,
    messageText: finalBody,
    promptVersion: draft.promptVersion,
  };
}
