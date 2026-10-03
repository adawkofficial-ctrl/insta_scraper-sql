/**
 * Central error taxonomy (TASK 11). Reuses the TASK 7 messaging codes and adds
 * the infrastructure codes so discovery, enrichment, workers, messaging and the
 * API layer all speak one vocabulary. Do not create parallel code lists.
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "SESSION_UNAVAILABLE"
  | "RECIPIENT_NOT_FOUND"
  | "COMPOSER_NOT_FOUND"
  | "SEND_TIMEOUT"
  | "RATE_LIMITED"
  | "PLATFORM_BLOCKED"
  | "CAPTCHA_REQUIRED"
  | "ACCOUNT_RESTRICTED"
  | "BROWSER_ERROR"
  | "NETWORK_ERROR"
  | "DISCOVERY_ERROR"
  | "ENRICHMENT_ERROR"
  | "WORKER_ERROR"
  | "DUPLICATE_REQUEST"
  | "CONFIGURATION_ERROR"
  | "DNC_SUPPRESSED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_QUOTA_EXHAUSTED"
  | "UNKNOWN";

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export type ErrorDefinition = {
  /** Safe, non-technical message safe to return to clients. */
  userMessage: string;
  /** Whether the operation class is retryable at all (domain rules refine this). */
  retryable: boolean;
  /** Whether retrying can never duplicate a delivery. */
  safeToRetry: boolean;
  severity: ErrorSeverity;
  requiresUserAction: boolean;
  /** Platform restriction that must stop/pause messaging immediately. */
  fatalPlatformRestriction: boolean;
  httpStatus: number;
};

export const ERROR_CATALOG: Record<ErrorCode, ErrorDefinition> = {
  VALIDATION_ERROR: {
    userMessage: "The request failed validation requirements.",
    retryable: false,
    safeToRetry: false,
    severity: "warning",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 400,
  },
  AUTH_REQUIRED: {
    userMessage: "Your Instagram session requires authentication before messaging can continue.",
    retryable: false,
    safeToRetry: false,
    severity: "critical",
    requiresUserAction: true,
    fatalPlatformRestriction: true,
    httpStatus: 401,
  },
  SESSION_UNAVAILABLE: {
    userMessage: "No authenticated Instagram browser session is available.",
    retryable: false,
    safeToRetry: false,
    severity: "critical",
    requiresUserAction: true,
    fatalPlatformRestriction: true,
    httpStatus: 409,
  },
  RECIPIENT_NOT_FOUND: {
    userMessage: "The Instagram recipient profile could not be found or does not accept messages.",
    retryable: false,
    safeToRetry: false,
    severity: "warning",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 400,
  },
  COMPOSER_NOT_FOUND: {
    userMessage: "Unable to open the Instagram message composer for this recipient.",
    retryable: false,
    safeToRetry: false,
    severity: "warning",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 409,
  },
  SEND_TIMEOUT: {
    userMessage: "Timed out waiting for Instagram to confirm the message was sent.",
    retryable: false,
    safeToRetry: false,
    severity: "error",
    requiresUserAction: true,
    fatalPlatformRestriction: false,
    httpStatus: 504,
  },
  RATE_LIMITED: {
    userMessage: "Messaging has been paused because the platform reported a rate limit.",
    retryable: false,
    safeToRetry: false,
    severity: "critical",
    requiresUserAction: true,
    fatalPlatformRestriction: true,
    httpStatus: 429,
  },
  PLATFORM_BLOCKED: {
    userMessage: "Messaging has stopped because Instagram temporarily blocked direct messaging.",
    retryable: false,
    safeToRetry: false,
    severity: "critical",
    requiresUserAction: true,
    fatalPlatformRestriction: true,
    httpStatus: 409,
  },
  CAPTCHA_REQUIRED: {
    userMessage: "Messaging stopped because a CAPTCHA or challenge requires manual intervention.",
    retryable: false,
    safeToRetry: false,
    severity: "critical",
    requiresUserAction: true,
    fatalPlatformRestriction: true,
    httpStatus: 409,
  },
  ACCOUNT_RESTRICTED: {
    userMessage: "Messaging stopped because the account reported a restriction.",
    retryable: false,
    safeToRetry: false,
    severity: "critical",
    requiresUserAction: true,
    fatalPlatformRestriction: true,
    httpStatus: 409,
  },
  BROWSER_ERROR: {
    userMessage: "A browser automation failure occurred during execution.",
    retryable: false,
    safeToRetry: false,
    severity: "error",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 500,
  },
  NETWORK_ERROR: {
    userMessage: "A temporary network error occurred. The operation may be retried safely.",
    retryable: true,
    safeToRetry: true,
    severity: "warning",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 502,
  },
  DISCOVERY_ERROR: {
    userMessage: "Lead discovery could not be completed because the provider failed.",
    retryable: true,
    safeToRetry: true,
    severity: "error",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 502,
  },
  ENRICHMENT_ERROR: {
    userMessage: "Profile enrichment could not be completed because the provider failed.",
    retryable: true,
    safeToRetry: true,
    severity: "error",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 502,
  },
  WORKER_ERROR: {
    userMessage: "A background worker error occurred. The job can be recovered safely.",
    retryable: true,
    safeToRetry: true,
    severity: "error",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 500,
  },
  DUPLICATE_REQUEST: {
    userMessage: "A duplicate request was detected and rejected to protect your account.",
    retryable: false,
    safeToRetry: true,
    severity: "info",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 409,
  },
  CONFIGURATION_ERROR: {
    userMessage: "The server is missing required configuration for this operation.",
    retryable: false,
    safeToRetry: false,
    severity: "critical",
    requiresUserAction: true,
    fatalPlatformRestriction: false,
    httpStatus: 500,
  },
  DNC_SUPPRESSED: {
    userMessage: "Recipient is on the Do Not Contact suppression list.",
    retryable: false,
    safeToRetry: false,
    severity: "warning",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 409,
  },
  PROVIDER_AUTH_FAILED: {
    userMessage: "Provider authentication failed. Please check your API credentials.",
    retryable: false,
    safeToRetry: false,
    severity: "critical",
    requiresUserAction: true,
    fatalPlatformRestriction: false,
    httpStatus: 401,
  },
  PROVIDER_RATE_LIMITED: {
    userMessage: "The provider rate limit was exceeded. Please try again later.",
    retryable: true,
    safeToRetry: true,
    severity: "warning",
    requiresUserAction: false,
    fatalPlatformRestriction: false,
    httpStatus: 429,
  },
  PROVIDER_QUOTA_EXHAUSTED: {
    userMessage: "The provider monthly quota has been exhausted.",
    retryable: false,
    safeToRetry: false,
    severity: "critical",
    requiresUserAction: true,
    fatalPlatformRestriction: false,
    httpStatus: 429,
  },
  UNKNOWN: {
    userMessage:
      "The result could not be confirmed. This message will not be automatically resent.",
    retryable: false,
    safeToRetry: false,
    severity: "error",
    requiresUserAction: true,
    fatalPlatformRestriction: false,
    httpStatus: 502,
  },
};

export const ALL_ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

const ERROR_CODE_SET = new Set<string>(ALL_ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

export function getErrorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_CATALOG[code];
}

/** Safe user-facing message for a code (never contains secrets). */
export function getUserMessage(code: ErrorCode): string {
  return ERROR_CATALOG[code].userMessage;
}

export function isFatalPlatformRestriction(code: ErrorCode): boolean {
  return ERROR_CATALOG[code].fatalPlatformRestriction;
}

/** Critical platform/auth conditions that must pause or stop messaging. */
export function shouldPauseOrStop(code: ErrorCode): boolean {
  return ERROR_CATALOG[code].fatalPlatformRestriction;
}
