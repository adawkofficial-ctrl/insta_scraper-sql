import { SENSITIVE_INFERENCE_TERMS } from "../rules";
import { findPhrases, normalizeForComparison } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** SENSITIVE_INFERENCE (BLOCKER): references to protected/sensitive lead traits. */
export const sensitiveInferenceCheck: QualityCheck = (ctx) => {
  const text = normalizeForComparison(ctx.draft.body);
  const hits = findPhrases(text, SENSITIVE_INFERENCE_TERMS);
  if (hits.length > 0) {
    return fail("SENSITIVE_INFERENCE", "BLOCKER", "sensitive_inference", {
      count: hits.length,
      terms: hits,
    });
  }
  return pass("SENSITIVE_INFERENCE", "BLOCKER", "ok");
};
