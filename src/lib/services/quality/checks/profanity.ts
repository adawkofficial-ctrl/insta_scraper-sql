import { PROFANITY_TERMS } from "../rules";
import { findPhrases, normalizeForComparison } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** PROFANITY_OR_HARASSMENT (BLOCKER): small data-driven list. */
export const profanityCheck: QualityCheck = (ctx) => {
  const text = normalizeForComparison(ctx.draft.body);
  const hits = findPhrases(text, PROFANITY_TERMS);
  if (hits.length > 0) {
    return fail("PROFANITY_OR_HARASSMENT", "BLOCKER", "profanity", { count: hits.length });
  }
  return pass("PROFANITY_OR_HARASSMENT", "BLOCKER", "ok");
};
