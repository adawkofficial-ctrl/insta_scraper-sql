import { NEAR_DUPLICATE_BLOCKER, NEAR_DUPLICATE_WARNING } from "../rules";
import { maxShingleSimilarity } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** NEAR_DUPLICATE_MESSAGE (BLOCKER >= 0.85, WARNING >= 0.65): 3-shingle Jaccard. */
export const nearDuplicateMessageCheck: QualityCheck = (ctx) => {
  const others = ctx.history.recentOutboundTexts;
  if (others.length === 0) {
    return pass("NEAR_DUPLICATE_MESSAGE", "BLOCKER", "ok_no_history", { maxSimilarity: 0 });
  }
  const maxSimilarity = maxShingleSimilarity(ctx.draft.body, others);
  if (maxSimilarity >= NEAR_DUPLICATE_BLOCKER) {
    return fail("NEAR_DUPLICATE_MESSAGE", "BLOCKER", "near_duplicate", {
      maxSimilarity: round(maxSimilarity),
    });
  }
  if (maxSimilarity >= NEAR_DUPLICATE_WARNING) {
    return fail("NEAR_DUPLICATE_MESSAGE", "WARNING", "near_duplicate", {
      maxSimilarity: round(maxSimilarity),
    });
  }
  return pass("NEAR_DUPLICATE_MESSAGE", "BLOCKER", "ok", { maxSimilarity: round(maxSimilarity) });
};
