import {
  ERROR_CATALOG,
  getErrorDefinition,
  isErrorCode,
  isFatalPlatformRestriction,
  type ErrorCode,
} from "./error-taxonomy";

export const MAX_ATTEMPTS = 3;

export type OperationDomain = "messaging" | "discovery" | "enrichment" | "worker";

/** Only these codes may ever be auto-retried for message delivery. */
export const MESSAGING_AUTO_RETRY_CODES: ReadonlySet<ErrorCode> = new Set([
  "NETWORK_ERROR",
]);

/** Bounded backoff for genuinely retryable infrastructure failures (ms). */
const BACKOFF_SCHEDULE_MS = [1000, 4000, 9000];

export function computeBackoffMs(attempt: number): number {
  const index = Math.max(0, Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1));
  return BACKOFF_SCHEDULE_MS[index];
}

/**
 * Deterministic classification from a code/message string. Reused by the
 * messaging classifier and by infrastructure services.
 */
export function classifyErrorCode(
  rawCodeOrMessage?: string | null,
  rawError?: unknown,
): ErrorCode {
  // An explicit, recognized taxonomy code is authoritative. Previously the
  // classified code could be overridden by incidental words in the message
  // text (e.g. the DM message "private, restricted, or messaging is
  // unavailable" was reclassified to ACCOUNT_RESTRICTED even though the
  // detected recipient state was RECIPIENT_NOT_FOUND).
  // "UNKNOWN" is excluded so callers that pass it still get message-based
  // heuristic classification.
  if (
    typeof rawCodeOrMessage === "string" &&
    rawCodeOrMessage !== "UNKNOWN" &&
    isErrorCode(rawCodeOrMessage)
  ) {
    return rawCodeOrMessage;
  }

  const text = `${rawCodeOrMessage ?? ""} ${
    rawError instanceof Error ? rawError.message : String(rawError ?? "")
  }`.toUpperCase();

  const has = (...needles: string[]) => needles.some((needle) => text.includes(needle));

  if (has("CONFIGURATION", "NOT_CONFIGURED", "MISSING_CREDENTIALS", "APIFY_API_TOKEN")) {
    return "CONFIGURATION_ERROR";
  }
  if (has("QUOTA", "MONTHLY USAGE", "HARD LIMIT", "INSUFFICIENT FUNDS")) {
    return "PROVIDER_QUOTA_EXHAUSTED";
  }
  if (has("SESSION_UNAVAILABLE", "NO ACTIVE INSTAGRAM SESSION", "NO SESSION")) {
    return "SESSION_UNAVAILABLE";
  }
  if (has("AUTH_REQUIRED", "UNAUTHORIZED", "NOT LOGGED IN", "LOGIN REQUIRED", "LOGIN")) {
    return "AUTH_REQUIRED";
  }
  if (has("RATE_LIMITED", "RATE LIMIT", "TOO MANY REQUESTS", "TRY AGAIN LATER")) {
    return "RATE_LIMITED";
  }
  if (has("CAPTCHA", "CHALLENGE", "SECURITY CHECK")) {
    return "CAPTCHA_REQUIRED";
  }
  if (has("ACCOUNT_RESTRICTED", "RESTRICTED", "SUSPENDED", "CHECKPOINT")) {
    return "ACCOUNT_RESTRICTED";
  }
  if (has("PLATFORM_BLOCKED", "ACTION BLOCKED", "SPAM BLOCK")) {
    return "PLATFORM_BLOCKED";
  }
  if (has("RECIPIENT_NOT_FOUND", "USER NOT FOUND", "PAGE NOT FOUND")) {
    return "RECIPIENT_NOT_FOUND";
  }
  if (has("COMPOSER_NOT_FOUND", "MESSAGE BUTTON NOT FOUND", "NO DM")) {
    return "COMPOSER_NOT_FOUND";
  }
  if (has("SEND_TIMEOUT", "TIMED OUT", "TIMEOUT")) {
    return "SEND_TIMEOUT";
  }
  if (has("DUPLICATE", "ALREADY SENT", "IDEMPOTENCY")) {
    return "DUPLICATE_REQUEST";
  }
  if (
    has(
      "VALIDATION",
      "UNSUPPORTED_VARIABLES",
      "MESSAGE_TOO_LONG",
      "EMPTY_MESSAGE",
      "INVALID_INPUT",
      "INVALID_",
    )
  ) {
    return "VALIDATION_ERROR";
  }
  if (
    has(
      "NETWORK",
      "CONNECTION",
      "ECONNRESET",
      "ENOTFOUND",
      "ETIMEDOUT",
      "ERR_CONNECTION",
      "FETCH FAILED",
      "DISCONNECTED",
      "RESET",
    )
  ) {
    return "NETWORK_ERROR";
  }
  if (has("PLAYWRIGHT", "BROWSER", "TARGET CRASHED")) {
    return "BROWSER_ERROR";
  }
  if (has("DISCOVERY", "SEARCH ACTOR", "DISCOVERY_ACTOR", "SEARCH_ACTOR")) {
    return "DISCOVERY_ERROR";
  }
  if (has("ENRICHMENT", "PROFILE_SCRAPER", "SCRAPE", "DATASET_FAILED", "ACTOR_FAILED")) {
    return "ENRICHMENT_ERROR";
  }
  if (has("WORKER", "LEASE", "HEARTBEAT", "STALE")) {
    return "WORKER_ERROR";
  }

  return "UNKNOWN";
}

/**
 * Maps an Apify/ProviderError code + operation to the central taxonomy.
 */
export function providerCodeToErrorCode(
  operation: string | undefined,
  code: string,
): ErrorCode {
  const domain: ErrorCode =
    operation === "discover" ? "DISCOVERY_ERROR" : "ENRICHMENT_ERROR";

  switch (code) {
    case "missing_credentials":
    case "authentication_failed":
      return "CONFIGURATION_ERROR";
    case "quota_exhausted":
      return "PROVIDER_QUOTA_EXHAUSTED";
    case "rate_limited":
      return "PROVIDER_RATE_LIMITED";
    case "invalid_input":
      return "VALIDATION_ERROR";
    case "run_timeout":
    case "actor_start_failed":
    case "actor_failed":
    case "dataset_failed":
    case "actor_status_failed":
    case "run_not_found":
      return domain;
    default:
      return domain;
  }
}

export type RetryDecision = {
  retry: boolean;
  safeToRetry: boolean;
  withinAttemptLimit: boolean;
  delayMs: number;
  reason: string;
};

/**
 * Central retry decision. Domain rules refine the catalog defaults. Messaging
 * only auto-retries a transient network failure when the delivery outcome is
 * known (i.e. the message failed BEFORE it was handed to the platform).
 */
export function getRetryDecision(input: {
  code: ErrorCode;
  attempt: number;
  domain: OperationDomain;
  outcomeKnown?: boolean;
  maxAttempts?: number;
}): RetryDecision {
  const { code, attempt, domain, outcomeKnown = true } = input;
  const maxAttempts = input.maxAttempts ?? MAX_ATTEMPTS;
  const definition = getErrorDefinition(code);

  let allowed = definition.retryable;

  if (domain === "messaging") {
    allowed = MESSAGING_AUTO_RETRY_CODES.has(code) && outcomeKnown;
  }

  const withinAttemptLimit = attempt < maxAttempts;
  const retry = allowed && withinAttemptLimit;

  let reason: string;
  if (!allowed) {
    reason = isFatalPlatformRestriction(code)
      ? "Platform/auth restriction: never auto-retry."
      : domain === "messaging"
        ? "Unsafe or unconfirmed message outcome: never auto-retry."
        : "Error is not retryable.";
  } else if (!withinAttemptLimit) {
    reason = `Retry limit reached (max ${maxAttempts} attempts).`;
  } else {
    reason = "Transient failure: safe to retry with backoff.";
  }

  return {
    retry,
    safeToRetry: allowed,
    withinAttemptLimit,
    delayMs: retry ? computeBackoffMs(attempt) : 0,
    reason,
  };
}

export type StaleResolution =
  | "RESOLVED_SENT"
  | "RESOLVED_FAILED"
  | "MARKED_UNKNOWN"
  | "RETURNED_TO_QUEUED";

/**
 * Pure decision for stale PROCESSING recovery. Message delivery that cannot be
 * proven is always UNKNOWN and is never returned to the queue.
 */
export function decideStaleRecovery(
  latestAttemptStatus?: string | null,
): StaleResolution {
  switch (latestAttemptStatus) {
    case "SENT":
      return "RESOLVED_SENT";
    case "FAILED":
      return "RESOLVED_FAILED";
    case "UNKNOWN":
    case "SENDING":
    case "PROCESSING":
      return "MARKED_UNKNOWN";
    default:
      return "RETURNED_TO_QUEUED";
  }
}

/** Manual retry is only allowed for explicitly retryable/failed states. */
export function isManualRetryAllowed(itemStatus: string): boolean {
  return itemStatus === "FAILED" || itemStatus === "UNKNOWN";
}

export type MessageItemStatus =
  | "QUEUED"
  | "PROCESSING"
  | "SENT"
  | "FAILED"
  | "SKIPPED"
  | "CANCELLED"
  | "UNKNOWN";

/**
 * Message-specific auto-retry guard (TASK 11 §11). Delivery duplication is the
 * top risk: only a failure that was confirmed BEFORE the platform received the
 * message may auto-retry, and never for platform/auth restrictions.
 */
export function shouldAutoRetryMessageDelivery(input: {
  itemStatus: MessageItemStatus;
  errorCode?: ErrorCode | null;
  outcomeKnown?: boolean;
}): boolean {
  // CONFIRMED SENT and UNKNOWN outcomes are never auto-retried.
  if (input.itemStatus === "SENT" || input.itemStatus === "UNKNOWN") {
    return false;
  }
  // Only a confirmed failed-before-send attempt may auto-retry.
  if (input.itemStatus !== "FAILED") {
    return false;
  }
  if (!input.errorCode || !MESSAGING_AUTO_RETRY_CODES.has(input.errorCode)) {
    return false;
  }
  // Outcome must be known (the message never reached the platform).
  return input.outcomeKnown === true;
}

export function isAutoRetryable(code: ErrorCode): boolean {
  return ERROR_CATALOG[code].retryable;
}
