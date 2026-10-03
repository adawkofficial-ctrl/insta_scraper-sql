import { ERROR_CATALOG, type ErrorCode } from "../errors/error-taxonomy";
import { classifyErrorCode } from "../errors/retry-policy";

/**
 * TASK 7 messaging error taxonomy. Preserved public API, now derived from the
 * single central {@link ERROR_CATALOG} so there is only one source of truth.
 */
export type ClassifiedErrorCode =
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
  | "VALIDATION_ERROR"
  | "DUPLICATE_REQUEST"
  | "UNKNOWN";

export type ClassifiedError = {
  code: ClassifiedErrorCode;
  userFacingMessage: string;
  isFatalPlatformRestriction: boolean;
  canAutoRetry: boolean;
  requiresUserAction: boolean;
};

const MESSAGING_CODES: ReadonlySet<string> = new Set<ClassifiedErrorCode>([
  "AUTH_REQUIRED",
  "SESSION_UNAVAILABLE",
  "RECIPIENT_NOT_FOUND",
  "COMPOSER_NOT_FOUND",
  "SEND_TIMEOUT",
  "RATE_LIMITED",
  "PLATFORM_BLOCKED",
  "CAPTCHA_REQUIRED",
  "ACCOUNT_RESTRICTED",
  "BROWSER_ERROR",
  "NETWORK_ERROR",
  "VALIDATION_ERROR",
  "DUPLICATE_REQUEST",
  "UNKNOWN",
]);

/**
 * Messaging never auto-retries automatically (delivery duplication risk), so
 * canAutoRetry is false for every messaging code. Manual retry is handled by the
 * centralized retry policy.
 */
export const ERROR_DEFINITIONS: Record<
  ClassifiedErrorCode,
  {
    userFacingMessage: string;
    isFatalPlatformRestriction: boolean;
    canAutoRetry: boolean;
    requiresUserAction: boolean;
  }
> = Object.fromEntries(
  Array.from(MESSAGING_CODES).map((code) => {
    const definition = ERROR_CATALOG[code as ErrorCode];
    return [
      code,
      {
        userFacingMessage: definition.userMessage,
        isFatalPlatformRestriction: definition.fatalPlatformRestriction,
        canAutoRetry: false,
        requiresUserAction: definition.requiresUserAction,
      },
    ];
  }),
) as Record<
  ClassifiedErrorCode,
  {
    userFacingMessage: string;
    isFatalPlatformRestriction: boolean;
    canAutoRetry: boolean;
    requiresUserAction: boolean;
  }
>;

/**
 * Classifies an error string or Error instance into standard category metadata.
 */
export function classifyMessagingError(
  rawCodeOrMessage?: string | null,
  rawError?: unknown,
): ClassifiedError {
  const centralCode = classifyErrorCode(rawCodeOrMessage, rawError);
  const code: ClassifiedErrorCode = MESSAGING_CODES.has(centralCode)
    ? (centralCode as ClassifiedErrorCode)
    : "UNKNOWN";

  const definition = ERROR_DEFINITIONS[code];
  return {
    code,
    userFacingMessage: definition.userFacingMessage,
    isFatalPlatformRestriction: definition.isFatalPlatformRestriction,
    canAutoRetry: definition.canAutoRetry,
    requiresUserAction: definition.requiresUserAction,
  };
}
