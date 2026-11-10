/**
 * Observability & structured logging for discovery pipeline stages.
 * Automatically redacts PII (emails, phones, full bios, API keys).
 */

import { logger } from "@/lib/logger";
import type { RejectionDetail } from "./types";

/**
 * Redacts personal identifiable information and secrets from log metadata.
 */
export function redactPii<T>(obj: T): T;
export function redactPii(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    // Redact email
    let redacted = obj.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, "[EMAIL_REDACTED]");
    // Redact phone numbers (e.g. +1 555-123-4567, 555-123-4567)
    redacted = redacted.replace(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, "[PHONE_REDACTED]");
    // Redact token / key patterns
    redacted = redacted.replace(/(apify_api_|unipile_|bearer\s+|key-)[a-zA-Z0-9_-]+/gi, "$1[REDACTED]");
    return redacted;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactPii(item));
  }
  if (typeof obj === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("secret") ||
        lowerKey.includes("password") ||
        lowerKey.includes("token") ||
        lowerKey.includes("apikey") ||
        lowerKey.includes("authorization")
      ) {
        clean[key] = "[REDACTED]";
      } else if (lowerKey === "phone" || lowerKey === "telephone" || lowerKey === "phonenumber") {
        clean[key] = val ? "[PHONE_REDACTED]" : null;
      } else if (lowerKey === "email") {
        clean[key] = val ? "[EMAIL_REDACTED]" : null;
      } else if (lowerKey === "biography" || lowerKey === "bio") {
        clean[key] = typeof val === "string" ? `${val.slice(0, 30)}... [TRUNCATED]` : val;
      } else {
        clean[key] = redactPii(val);
      }
    }
    return clean;
  }
  return obj;
}

/**
 * Builds a reject-reason histogram from rejected items.
 */
export function buildRejectHistogram(rejected: RejectionDetail[]): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const item of rejected) {
    const reasonKey = item.reason || "UNKNOWN";
    histogram[reasonKey] = (histogram[reasonKey] ?? 0) + 1;
  }
  return histogram;
}

/**
 * Structured log per pipeline stage with counts, spend, duration, and reject histogram.
 */
export function logStageObservability(
  jobId: string,
  stage: string,
  counts: { in: number; out: number },
  spendUsd: number,
  durationMs: number,
  rejected: RejectionDetail[],
): void {
  const histogram = buildRejectHistogram(rejected);
  const logPayload = redactPii({
    jobId,
    stage,
    countIn: counts.in,
    countOut: counts.out,
    spendUsd: Number(spendUsd.toFixed(4)),
    durationMs,
    rejectedCount: rejected.length,
    rejectReasons: histogram,
  });

  logger.info(`[PIPELINE_STAGE] stage=${stage} in=${counts.in} out=${counts.out} spend=$${spendUsd.toFixed(4)} dur=${durationMs}ms`, logPayload);
}
