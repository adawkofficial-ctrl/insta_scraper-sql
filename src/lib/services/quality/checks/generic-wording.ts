import { GENERIC_PHRASES, GENERIC_WORDING_BLOCKER_HITS } from "../rules";
import { findPhrases, normalizeForComparison } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** GENERIC_WORDING (WARNING at 1-2 hits, BLOCKER at >= 3 hits). */
export const genericWordingCheck: QualityCheck = (ctx) => {
  const text = normalizeForComparison(ctx.draft.body);
  const hits = findPhrases(text, GENERIC_PHRASES);
  if (hits.length >= GENERIC_WORDING_BLOCKER_HITS) {
    return fail("GENERIC_WORDING", "BLOCKER", "generic_wording", {
      hits: hits.length,
      phrases: hits,
    });
  }
  if (hits.length >= 1) {
    return fail("GENERIC_WORDING", "WARNING", "generic_wording", {
      hits: hits.length,
      phrases: hits,
    });
  }
  return pass("GENERIC_WORDING", "BLOCKER", "ok");
};
