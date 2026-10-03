import { ApifyApiError } from "apify-client";

/**
 * Specific provider error codes we can distinguish from an Apify failure.
 * Returns `null` when it is not one of these (caller supplies its own fallback).
 */
export type ApifyClassifiedCode = "authentication_failed" | "quota_exhausted" | "rate_limited";

/** Apify `error.type` values that mean the account ran out of usage/credits. */
const QUOTA_ERROR_TYPES = new Set([
  "platform-feature-disabled", // "Monthly usage hard limit exceeded"
  "insufficient-funds",
  "monthly-usage-limit-exceeded",
  "usage-limit-exceeded",
]);

const RATE_LIMIT_ERROR_TYPES = new Set(["rate-limit-exceeded", "rate-limit-reached"]);

/**
 * Classifies an Apify error thrown while starting/polling an actor run.
 *
 * IMPORTANT: an HTTP 403 is NOT automatically an authentication failure. Apify
 * returns 403 with `type: "platform-feature-disabled"` when the account's
 * monthly usage hard limit is reached, which must surface as a quota/billing
 * problem, never as "invalid credentials".
 */
export function classifyApifyProviderError(error: unknown): ApifyClassifiedCode | null {
  if (error instanceof ApifyApiError) {
    const type = typeof error.type === "string" ? error.type : "";
    if (error.statusCode === 401) {
      return "authentication_failed";
    }
    if (error.statusCode === 402 || QUOTA_ERROR_TYPES.has(type)) {
      return "quota_exhausted";
    }
    if (error.statusCode === 429 || RATE_LIMIT_ERROR_TYPES.has(type)) {
      return "rate_limited";
    }
    if (error.statusCode === 403) {
      // A genuine permission/auth rejection, not a quota problem.
      return "authentication_failed";
    }
    return null;
  }

  // Fallback for wrapped/non-SDK errors (e.g. re-thrown messages).
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  if (
    message.includes("monthly usage") ||
    message.includes("hard limit") ||
    message.includes("insufficient funds") ||
    message.includes("quota")
  ) {
    return "quota_exhausted";
  }
  if (message.includes("rate limit")) {
    return "rate_limited";
  }
  return null;
}
