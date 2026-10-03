import { NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { ProviderError } from "@/lib/services/provider-error";
import { ScrapeInputError } from "@/lib/services/scraper";
import {
  ERROR_CATALOG,
  getUserMessage,
  isErrorCode,
  providerCodeToErrorCode,
  type ErrorCode,
  type ErrorSeverity,
} from "@/lib/services/errors";
import { sanitizeMessage } from "@/lib/services/errors/sanitize";

export { sanitizeMessage } from "@/lib/services/errors/sanitize";

export type AppErrorOptions = {
  /** Safe client-facing message. Defaults to the taxonomy message for the code. */
  userMessage?: string;
  retryable?: boolean;
  safeToRetry?: boolean;
  severity?: ErrorSeverity;
  /** Safe, non-sensitive debugging context (never returned to clients). */
  metadata?: Record<string, unknown>;
  /** Internal cause — never serialized to the client. */
  cause?: unknown;
};

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly severity: ErrorSeverity;
  readonly metadata?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: AppErrorOptions,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;

    const known = isErrorCode(code) ? ERROR_CATALOG[code] : undefined;
    this.userMessage = options?.userMessage ?? known?.userMessage ?? message;
    this.retryable = options?.retryable ?? known?.retryable ?? false;
    this.safeToRetry = options?.safeToRetry ?? known?.safeToRetry ?? false;
    this.severity = options?.severity ?? known?.severity ?? "error";
    this.metadata = options?.metadata;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  get statusCode(): number {
    return this.status;
  }
}

export class NotFoundError extends AppError {
  constructor(code = "NOT_FOUND", message = "Resource not found", options?: AppErrorOptions) {
    super(404, code, message, options);
  }
}

export class BadRequestError extends AppError {
  constructor(code = "BAD_REQUEST", message = "Invalid request", options?: AppErrorOptions) {
    super(400, code, message, options);
  }
}

export class UnauthorizedError extends AppError {
  constructor(
    code = "AUTH_REQUIRED",
    message = "Authentication required",
    options?: AppErrorOptions,
  ) {
    super(401, code, message, {
      userMessage: getUserMessage("AUTH_REQUIRED"),
      ...options,
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(code = "FORBIDDEN", message = "Access denied", options?: AppErrorOptions) {
    super(403, code, message, options);
  }
}

export class ConflictError extends AppError {
  constructor(
    code = "CONFLICT",
    message = "Resource conflict",
    options?: AppErrorOptions,
  ) {
    super(409, code, message, options);
  }
}

export class DncSuppressedError extends AppError {
  constructor(
    message = "Recipient is on the Do Not Contact suppression list.",
    options?: AppErrorOptions,
  ) {
    super(409, "DNC_SUPPRESSED", message, options);
  }
}

/**
 * Step 6: thrown when a draft cannot be approved because the fresh quality gate
 * found one or more BLOCKER failures. Carries the rule ids (no message text).
 */
export class QualityBlockedError extends AppError {
  readonly ruleIds: string[];

  constructor(ruleIds: string[], message = "The draft failed the quality gate and cannot be approved.") {
    super(422, "QUALITY_BLOCKED", message, {
      userMessage: message,
      metadata: { ruleIds },
    });
    this.name = "QualityBlockedError";
    this.ruleIds = ruleIds;
  }
}

/**
 * Step 6: thrown when a draft has unresolved WARNINGS and the caller did not
 * explicitly override each one. Carries the warning rule ids.
 */
export class QualityWarningsRequiredError extends AppError {
  readonly warningIds: string[];

  constructor(
    warningIds: string[],
    message = "The draft has quality warnings. Confirm every override to approve it.",
  ) {
    super(422, "QUALITY_WARNINGS_REQUIRED", message, {
      userMessage: message,
      metadata: { warningIds },
    });
    this.name = "QualityWarningsRequiredError";
    this.warningIds = warningIds;
  }
}

/**
 * Thrown before any Gemini call when the user's CompanyProfile is missing
 * required fields. Returns HTTP 422 with `details.missingFields`.
 */
export class CompanyProfileIncompleteError extends AppError {
  readonly missingFields: string[];
  readonly warnings: string[];

  constructor(missingFields: string[], warnings: string[] = []) {
    super(
      422,
      "COMPANY_PROFILE_INCOMPLETE",
      "Your company profile is incomplete. Fill in the required fields in Settings before running AI.",
      {
        userMessage:
          "Your company profile is incomplete. Fill in the required fields in Settings before running AI.",
        metadata: { missingFields, warnings },
        severity: "warning",
      },
    );
    this.name = "CompanyProfileIncompleteError";
    this.missingFields = missingFields;
    this.warnings = warnings;
  }
}

export function getRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header !== null && header.trim().length > 0) {
    return header.trim();
  }
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message: sanitizeMessage(message),
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
}

function apiErrorWithRequestId(
  status: number,
  code: string,
  message: string,
  requestId?: string,
  details?: Record<string, unknown>,
): NextResponse {
  const response = apiError(status, code, message, details);
  if (requestId !== undefined) {
    response.headers.set("x-request-id", requestId);
  }
  return response;
}

export type ApiErrorContext = {
  requestId?: string;
  userId?: string;
  campaignId?: string;
  executionId?: string;
  jobId?: string;
  leadId?: string;
  operation?: string;
};

/**
 * Single server-side error-to-response mechanism. Logs a sanitized structured
 * record and returns only safe information to the client.
 */
export function handleApiError(
  error: unknown,
  fallbackMessage = "An unexpected error occurred.",
  context: ApiErrorContext = {},
): NextResponse {
  const requestId = context.requestId;

  if (error instanceof AppError) {
    logger.error(error.code, error, {
      ...context,
      severity: error.severity,
      retryable: error.retryable,
      safeToRetry: error.safeToRetry,
    });
    return apiErrorWithRequestId(
      error.status,
      error.code,
      error.userMessage,
      requestId,
      error.metadata,
    );
  }

  if (error instanceof ScrapeInputError) {
    const code = isErrorCode(error.code) ? error.code : "VALIDATION_ERROR";
    logger.error(code, error, { ...context, severity: "warning" });
    return apiErrorWithRequestId(400, error.code, error.message, requestId);
  }

  if (error instanceof ProviderError) {
    const taxonomyCode = providerCodeToErrorCode(error.operation, error.code);
    const { status, code } = mapProviderError(error);
    logger.error(taxonomyCode, error, {
      ...context,
      operation: error.operation,
      provider: error.provider,
    });
    return apiErrorWithRequestId(
      status,
      code,
      getPublicProviderMessage(error),
      requestId,
    );
  }

  // Prisma errors that bubble up
  if (typeof error === "object" && error !== null && "code" in error) {
    const prismaError = error as { code: string };
    if (prismaError.code === "P2025") {
      return apiErrorWithRequestId(
        404,
        "NOT_FOUND",
        "The requested record was not found.",
        requestId,
      );
    }
    if (prismaError.code === "P2002") {
      return apiErrorWithRequestId(
        409,
        "ALREADY_EXISTS",
        "A record with this identifier already exists.",
        requestId,
      );
    }
  }

  logger.error("UNKNOWN", error, { ...context, severity: "error" });

  return apiErrorWithRequestId(500, "INTERNAL_ERROR", fallbackMessage, requestId);
}

/**
 * Route-level helper: guarantees the response and structured log share the
 * request's correlation id (`x-request-id`).
 */
export function handleRouteError(
  request: Request,
  error: unknown,
  context: Omit<ApiErrorContext, "requestId"> = {},
): NextResponse {
  return handleApiError(error, "An unexpected error occurred.", {
    ...context,
    requestId: getRequestId(request),
  });
}

function mapProviderError(error: ProviderError): { status: number; code: string } {
  switch (error.code) {
    case "missing_credentials":
      return { status: 500, code: "APIFY_NOT_CONFIGURED" };
    case "authentication_failed":
      return { status: 502, code: "APIFY_AUTH_FAILED" };
    case "quota_exhausted":
      return { status: 429, code: "APIFY_QUOTA_EXHAUSTED" };
    case "rate_limited":
      return { status: 429, code: "APIFY_RATE_LIMITED" };
    case "run_timeout":
      return { status: 504, code: "APIFY_TIMEOUT" };
    case "actor_failed":
      return { status: 502, code: "APIFY_RUN_FAILED" };
    case "actor_start_failed":
      return { status: 502, code: "APIFY_START_FAILED" };
    case "dataset_failed":
      return { status: 502, code: "APIFY_DATASET_FAILED" };
    case "actor_status_failed":
    case "run_not_found":
      return { status: 502, code: "APIFY_STATUS_FAILED" };
    case "invalid_input":
      return { status: 400, code: "INVALID_INPUT" };
    default:
      return { status: 502, code: "APIFY_FAILED" };
  }
}

function getPublicProviderMessage(error: ProviderError): string {
  switch (error.code) {
    case "missing_credentials":
      return "The scraper provider is not configured on the server.";
    case "authentication_failed":
      return "The scraper provider rejected the server credentials.";
    case "quota_exhausted":
      return "The Apify account has reached its monthly usage limit. Raise the plan limit, add credit, or wait for the usage cycle to reset.";
    case "rate_limited":
      return "The scraper provider rate limit was reached. Please try again in a few minutes.";
    case "run_timeout":
      return "The provider run did not finish within the time limit.";
    case "actor_failed":
      return "The provider run finished with a failure status.";
    case "actor_start_failed":
      return "The provider run could not be started.";
    case "dataset_failed":
      return "The provider results could not be retrieved.";
    default:
      return "The scraper provider request failed.";
  }
}

export type { ErrorCode };
