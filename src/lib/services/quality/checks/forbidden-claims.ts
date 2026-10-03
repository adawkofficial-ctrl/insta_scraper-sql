import { findPhrases, normalizeForComparison } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** FORBIDDEN_CLAIMS (BLOCKER): any CompanyProfile.forbiddenClaims term present. */
export const forbiddenClaimsCheck: QualityCheck = (ctx) => {
  const text = normalizeForComparison(ctx.draft.body);
  const hits = findPhrases(text, ctx.company.forbiddenClaims);
  if (hits.length > 0) {
    return fail("FORBIDDEN_CLAIMS", "BLOCKER", "forbidden_claim", {
      count: hits.length,
      terms: hits,
    });
  }
  return pass("FORBIDDEN_CLAIMS", "BLOCKER", "ok");
};
