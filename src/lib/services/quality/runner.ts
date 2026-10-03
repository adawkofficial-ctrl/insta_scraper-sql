import { BLOCKER_CHECKS, QUALITY_CHECKS } from "./checks";
import { draftBodyHash } from "./hash";
import { CHECK_WEIGHTS, QUALITY_VERSION } from "./rules";
import type { QualityCheck, QualityCheckResult, QualityContext, QualityGateResult } from "./types";

/**
 * Runs the checks against a pre-loaded context and scores the result.
 * Pure and deterministic — the same context always yields the same result.
 */
export function runQualityChecks(
  ctx: QualityContext,
  checks: readonly QualityCheck[] = QUALITY_CHECKS,
): QualityGateResult {
  const results: QualityCheckResult[] = checks.map((check) => check(ctx));
  const blockers = results.filter((result) => !result.passed && result.severity === "BLOCKER");
  const warnings = results.filter((result) => !result.passed && result.severity === "WARNING");

  let score = 100;
  for (const result of results) {
    if (result.passed) continue;
    const weight = CHECK_WEIGHTS[result.id];
    score -= result.severity === "BLOCKER" ? weight.blocker : weight.warning;
  }
  score = Math.max(0, Math.min(100, score));

  return {
    passed: blockers.length === 0,
    score,
    qualityVersion: QUALITY_VERSION,
    bodyHash: draftBodyHash(ctx.draft.body),
    blockers,
    warnings,
    checks: results,
  };
}

/** Re-runs only the blocker-capable checks (dispatch-time cheap verification). */
export function runBlockerChecks(ctx: QualityContext): QualityCheckResult[] {
  return BLOCKER_CHECKS.map((check) => check(ctx)).filter(
    (result) => !result.passed && result.severity === "BLOCKER",
  );
}
