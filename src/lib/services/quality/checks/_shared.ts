import type { QualityCheckId, QualityCheckResult, QualitySeverity } from "../types";

export function pass(
  id: QualityCheckId,
  severity: QualitySeverity = "WARNING",
  detail = "ok",
  data?: Record<string, unknown>,
): QualityCheckResult {
  return { id, severity, passed: true, detail, data };
}

export function fail(
  id: QualityCheckId,
  severity: QualitySeverity,
  detail: string,
  data?: Record<string, unknown>,
): QualityCheckResult {
  return { id, severity, passed: false, detail, data };
}
