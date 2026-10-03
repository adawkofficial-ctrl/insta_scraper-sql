import { UNVERIFIABLE_CLAIM_PHRASES } from "../rules";
import { findPhrases, normalizeForComparison } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/**
 * UNVERIFIABLE_CLAIMS (BLOCKER): claims of having seen/read lead content that
 * was not provided to the model. Post/caption context is currently never
 * provided, so any such claim is unverifiable.
 */
export const unverifiableClaimsCheck: QualityCheck = (ctx) => {
  if (ctx.lead.hasPostContext) {
    return pass("UNVERIFIABLE_CLAIMS", "BLOCKER", "ok_post_context");
  }
  const text = normalizeForComparison(ctx.draft.body);
  const hits = findPhrases(text, UNVERIFIABLE_CLAIM_PHRASES);
  if (hits.length > 0) {
    return fail("UNVERIFIABLE_CLAIMS", "BLOCKER", "unverifiable_claim", {
      count: hits.length,
      phrases: hits,
    });
  }
  return pass("UNVERIFIABLE_CLAIMS", "BLOCKER", "ok");
};
