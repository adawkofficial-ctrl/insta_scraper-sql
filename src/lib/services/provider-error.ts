export class ProviderError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly code: string;

  constructor(
    provider: string,
    operation: string,
    message: string,
    options?: { cause?: unknown; code?: string },
  ) {
    super(`[${provider}] ${operation}: ${message}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.operation = operation;
    this.code = options?.code ?? "provider_error";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function toProviderError(
  provider: string,
  operation: string,
  error: unknown,
  code = "provider_error",
): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(provider, operation, message, { cause: error, code });
}
