import { normalizeForExactDuplicate } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** EXACT_DUPLICATE_MESSAGE (BLOCKER): same normalized body as another draft/message (90d). */
export const exactDuplicateMessageCheck: QualityCheck = (ctx) => {
  const normalized = normalizeForExactDuplicate(ctx.draft.body);
  if (normalized.length === 0) {
    return pass("EXACT_DUPLICATE_MESSAGE", "BLOCKER", "ok_empty");
  }
  if (ctx.history.exactDuplicateBodies.includes(normalized)) {
    return fail("EXACT_DUPLICATE_MESSAGE", "BLOCKER", "exact_duplicate");
  }
  return pass("EXACT_DUPLICATE_MESSAGE", "BLOCKER", "ok");
};
