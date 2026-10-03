export {
  ALL_ERROR_CODES,
  ERROR_CATALOG,
  getErrorDefinition,
  getUserMessage,
  isErrorCode,
  isFatalPlatformRestriction,
  shouldPauseOrStop,
  type ErrorCode,
  type ErrorDefinition,
  type ErrorSeverity,
} from "./error-taxonomy";

export {
  MAX_ATTEMPTS,
  MESSAGING_AUTO_RETRY_CODES,
  classifyErrorCode,
  computeBackoffMs,
  decideStaleRecovery,
  getRetryDecision,
  isAutoRetryable,
  isManualRetryAllowed,
  providerCodeToErrorCode,
  shouldAutoRetryMessageDelivery,
  type MessageItemStatus,
  type OperationDomain,
  type RetryDecision,
  type StaleResolution,
} from "./retry-policy";
