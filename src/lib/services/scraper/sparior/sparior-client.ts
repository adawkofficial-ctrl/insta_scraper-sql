import "server-only";

import { AppError, sanitizeMessage } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import { UsageProvider, type Prisma } from "@/generated/prisma/client";
import { getSpariorConfig } from "@/lib/env";
import type {
  RapidApiRateLimits,
  SpariorCallResult,
  SpariorProfileResponse,
  SpariorSearchResponse,
} from "./sparior-types";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB guard
const MAX_RETRIES = 3;

export type SpariorClientOptions = {
  apiKey?: string;
  apiHost?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export type SpariorRequestContext = {
  operation: "search" | "profile";
  campaignId?: string | null;
  userId?: string | null;
  pageIndex?: number | null;
};

export function maskEnvValue(val: string | undefined): string {
  if (!val || val.trim().length === 0) return "missing";
  return "set";
}

export function logRuntimeSpariorEnv(prefix = "[SPARIOR-RUNTIME-ENV]"): void {
  // Only log Sparior configuration if Sparior is the active provider
  if (process.env.SCRAPER_PROVIDER !== "sparior") {
    return;
  }
  console.log(
    `${prefix} ` +
      `SCRAPER_PROVIDER=sparior ` +
      `SPARIOR_API_KEY=${maskEnvValue(process.env.SPARIOR_API_KEY)} ` +
      `SPARIOR_API_HOST=${maskEnvValue(process.env.SPARIOR_API_HOST)} ` +
      `SPARIOR_BASE_URL=${maskEnvValue(process.env.SPARIOR_BASE_URL)}`,
  );
}

// Module-load log removed per log hygiene requirements.

export class SpariorClient {
  private readonly apiKey: string;
  private readonly apiHost: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options?: SpariorClientOptions) {
    const config = getSpariorConfig(false);
    this.apiKey = options?.apiKey ?? config.apiKey;
    this.apiHost = options?.apiHost ?? config.apiHost;
    this.baseUrl = (options?.baseUrl ?? config.baseUrl).replace(/\/+$/, "");
    this.fetchFn = options?.fetchFn ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    console.log(
      `[SPARIOR-CLIENT-INIT] apiKey=${maskEnvValue(this.apiKey)} apiHost=${maskEnvValue(this.apiHost)} baseUrl=${this.baseUrl}`,
    );
  }

  private parseRateLimitHeaders(headers: Headers): RapidApiRateLimits {
    const getInt = (name: string): number | null => {
      const val = headers.get(name);
      if (!val) return null;
      const num = parseInt(val.trim(), 10);
      return isNaN(num) ? null : num;
    };

    const limit =
      getInt("x-ratelimit-requests-limit") ??
      getInt("x-ratelimit-limit");
    const remaining =
      getInt("x-ratelimit-requests-remaining") ??
      getInt("x-ratelimit-remaining");

    let resetAt: Date | null = null;
    const resetHeader =
      headers.get("x-ratelimit-requests-reset") ??
      headers.get("x-ratelimit-reset");

    if (resetHeader) {
      const resetNum = parseInt(resetHeader.trim(), 10);
      if (!isNaN(resetNum)) {
        // If > 1e11 it's timestamp in ms, else if > 1e9 timestamp in secs, else delta seconds
        if (resetNum > 1e11) {
          resetAt = new Date(resetNum);
        } else if (resetNum > 1e9) {
          resetAt = new Date(resetNum * 1000);
        } else {
          resetAt = new Date(Date.now() + resetNum * 1000);
        }
      }
    }

    return { limit, remaining, resetAt };
  }

  private parseRetryAfter(headers: Headers): number | null {
    const val = headers.get("retry-after");
    if (!val) return null;
    const secs = parseInt(val.trim(), 10);
    if (!isNaN(secs) && secs >= 0) {
      return secs * 1000;
    }
    const date = Date.parse(val.trim());
    if (!isNaN(date) && date > Date.now()) {
      return date - Date.now();
    }
    return null;
  }

  private computeBackoffMs(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null && retryAfterMs > 0) {
      return Math.min(retryAfterMs, 30_000);
    }
    // Exponential backoff: ~500ms, ~1500ms, ~3500ms with jitter
    const base = Math.pow(2, attempt) * 500;
    const jitter = Math.floor(Math.random() * 250);
    return base + jitter;
  }

  private isQuotaExhaustedMessage(status: number, message: string): boolean {
    const upper = message.toUpperCase();
    return (
      upper.includes("EXCEEDED THE MONTHLY QUOTA") ||
      upper.includes("MONTHLY QUOTA EXCEEDED") ||
      upper.includes("QUOTA EXHAUSTED") ||
      upper.includes("HARD LIMIT") ||
      (status === 429 && upper.includes("QUOTA"))
    );
  }

  async request<T>(
    path: string,
    params?: Record<string, string | number | boolean | null | undefined>,
    context?: SpariorRequestContext,
  ): Promise<SpariorCallResult<T>> {
    if (!this.apiKey) {
      throw new AppError(
        401,
        "PROVIDER_AUTH_FAILED",
        "Sparior API key is missing. Set SPARIOR_API_KEY in your environment.",
      );
    }
    if (!this.apiHost) {
      throw new AppError(
        500,
        "CONFIGURATION_ERROR",
        "Sparior API host is missing. Set SPARIOR_API_HOST in your environment.",
      );
    }

    let resolvedPath = path;
    if (
      resolvedPath.startsWith("/v1/") &&
      !resolvedPath.startsWith("/api/v1/instagram/") &&
      !this.baseUrl.includes("/api/v1/instagram")
    ) {
      resolvedPath = `/api/v1/instagram${resolvedPath.slice(3)}`;
    }

    const url = new URL(
      resolvedPath.startsWith("http")
        ? resolvedPath
        : `${this.baseUrl}${resolvedPath}`,
    );
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    let retries = 0;
    const startTime = Date.now();

    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      let durationMs = 0;
      const callStart = Date.now();

      const requestHeaders: Record<string, string> = {
        "x-rapidapi-key": this.apiKey,
        "x-rapidapi-host": this.apiHost,
        Accept: "application/json",
      };

      console.log(
        `[SPARIOR-FETCH-PRECALL] url="${url.toString()}" headerNames=[${Object.keys(requestHeaders).join(", ")}] attempt=${retries + 1}`,
      );

      try {
        response = await this.fetchFn(url.toString(), {
          method: "GET",
          headers: requestHeaders,
          signal: controller.signal,
        });
        durationMs = Date.now() - callStart;
      } catch (err: unknown) {
        clearTimeout(timer);
        durationMs = Date.now() - callStart;

        const errObj = err as Record<string, unknown> | null;
        console.error(`[SPARIOR-FETCH-EXCEPTION] url="${url.toString()}"`, {
          name: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
          code: errObj?.code,
          cause: errObj?.cause,
          type: errObj?.type,
          stack: err instanceof Error ? err.stack : undefined,
        });

        const isAbort =
          err instanceof Error &&
          (err.name === "AbortError" || err.message.includes("abort"));

        if (retries < MAX_RETRIES) {
          retries++;
          const waitMs = this.computeBackoffMs(retries, null);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        if (isAbort) {
          throw new AppError(
            504,
            "NETWORK_ERROR",
            sanitizeMessage(`Sparior request timed out after ${this.timeoutMs}ms`),
            { cause: err },
          );
        }

        throw new AppError(
          502,
          "NETWORK_ERROR",
          sanitizeMessage(
            `Sparior network request failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
          { cause: err },
        );
      } finally {
        clearTimeout(timer);
      }

      console.log(
        `[SPARIOR-FETCH-RESPONSE] status=${response.status} ${response.statusText} ok=${response.ok} url="${url.toString()}"`,
      );

      const rateLimits = this.parseRateLimitHeaders(response.headers);
      const status = response.status;

      // Check for 401 / 403 Authentication failures -> NO retry
      if (status === 401 || status === 403) {
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          // ignore
        }
        console.error(
          `[SPARIOR-AUTH-FAILED] status=${status} url="${url.toString()}" body=${bodyText.slice(0, 500)}`,
        );

        await this.logUsage({
          context,
          status,
          durationMs,
          retries,
          itemsReturned: 0,
          quotaRemaining: rateLimits.remaining,
        });

        if (this.isQuotaExhaustedMessage(status, bodyText)) {
          throw new AppError(
            429,
            "PROVIDER_QUOTA_EXHAUSTED",
            "Sparior monthly request quota has been exhausted according to RapidAPI.",
          );
        }

        throw new AppError(
          status,
          "PROVIDER_AUTH_FAILED",
          sanitizeMessage(`Sparior authentication failed with status ${status}.`),
        );
      }

      // Check for 429 Rate limited
      if (status === 429) {
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          // ignore
        }
        console.error(
          `[SPARIOR-RATE-LIMITED] status=${status} url="${url.toString()}" body=${bodyText.slice(0, 500)}`,
        );

        if (this.isQuotaExhaustedMessage(status, bodyText)) {
          await this.logUsage({
            context,
            status,
            durationMs,
            retries,
            itemsReturned: 0,
            quotaRemaining: rateLimits.remaining ?? 0,
          });
          throw new AppError(
            429,
            "PROVIDER_QUOTA_EXHAUSTED",
            "Sparior monthly request quota has been exhausted according to RapidAPI.",
          );
        }

        if (retries < MAX_RETRIES) {
          retries++;
          const retryAfterMs = this.parseRetryAfter(response.headers);
          const waitMs = this.computeBackoffMs(retries, retryAfterMs);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        await this.logUsage({
          context,
          status,
          durationMs,
          retries,
          itemsReturned: 0,
          quotaRemaining: rateLimits.remaining,
        });

        throw new AppError(
          429,
          "PROVIDER_RATE_LIMITED",
          "Sparior rate limit exceeded after maximum retries.",
        );
      }

      // Check for 5xx Server errors
      if (status >= 500) {
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          // ignore
        }
        console.error(
          `[SPARIOR-SERVER-ERROR] status=${status} url="${url.toString()}" body=${bodyText.slice(0, 500)}`,
        );

        if (retries < MAX_RETRIES) {
          retries++;
          const waitMs = this.computeBackoffMs(retries, null);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        await this.logUsage({
          context,
          status,
          durationMs,
          retries,
          itemsReturned: 0,
          quotaRemaining: rateLimits.remaining,
        });

        throw new AppError(
          502,
          "NETWORK_ERROR",
          sanitizeMessage(`Sparior server error: HTTP ${status}`),
        );
      }

      // Check for other non-2xx errors (e.g. 400, 404, 405) so they are NOT silently parsed as 0 results
      if (!response.ok) {
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          // ignore
        }
        console.error(
          `[SPARIOR-NON-2XX-ERROR] status=${status} ${response.statusText} url="${url.toString()}" body=${bodyText.slice(0, 1000)}`,
        );

        await this.logUsage({
          context,
          status,
          durationMs,
          retries,
          itemsReturned: 0,
          quotaRemaining: rateLimits.remaining,
        });

        throw new AppError(
          status,
          "PROVIDER_ERROR",
          sanitizeMessage(`Sparior request failed with HTTP ${status}: ${bodyText.slice(0, 300)}`),
        );
      }

      // Guard response body size
      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader) {
        const bytes = parseInt(contentLengthHeader, 10);
        if (!isNaN(bytes) && bytes > MAX_RESPONSE_BYTES) {
          throw new AppError(
            502,
            "NETWORK_ERROR",
            `Sparior response exceeds maximum allowed size (${bytes} > ${MAX_RESPONSE_BYTES} bytes).`,
          );
        }
      }

      let parsed: T;
      let text = "";
      try {
        text = await response.text();
        console.log(
          `[SPARIOR-RAW-BODY] status=${status} url="${url.toString()}" bytes=${text.length} snippet=${text.slice(0, 400)}`,
        );
        if (text.length > MAX_RESPONSE_BYTES) {
          throw new AppError(
            502,
            "NETWORK_ERROR",
            `Sparior response text exceeds maximum allowed size (${text.length} > ${MAX_RESPONSE_BYTES} bytes).`,
          );
        }
        parsed = JSON.parse(text) as T;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(
          502,
          "NETWORK_ERROR",
          sanitizeMessage(
            `Failed to parse Sparior JSON response: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
          { cause: err },
        );
      }

      // Calculate items returned for usage logging
      let itemsReturned = 0;
      if (parsed && typeof parsed === "object") {
        const pRecord = parsed as Record<string, unknown>;
        if (Array.isArray(pRecord.body)) {
          itemsReturned = pRecord.body.length;
        } else if (Array.isArray(pRecord.data)) {
          itemsReturned = pRecord.data.length;
        } else if (pRecord.data && typeof pRecord.data === "object") {
          const dRecord = pRecord.data as Record<string, unknown>;
          if (Array.isArray(dRecord.items)) itemsReturned = dRecord.items.length;
          else if (Array.isArray(dRecord.users)) itemsReturned = dRecord.users.length;
          else if (Array.isArray(dRecord.results)) itemsReturned = dRecord.results.length;
          else itemsReturned = 1; // single profile
        } else if (pRecord.username) {
          itemsReturned = 1;
        }
      }

      // Fire-and-forget UsageLog entry
      await this.logUsage({
        context,
        status,
        durationMs,
        retries,
        itemsReturned,
        quotaRemaining: rateLimits.remaining,
      });

      return {
        data: parsed,
        rateLimits,
        durationMs: Date.now() - startTime,
        retries,
      };
    }
  }

  private async logUsage(params: {
    context?: SpariorRequestContext;
    status: number;
    durationMs: number;
    retries: number;
    itemsReturned: number;
    quotaRemaining: number | null;
  }): Promise<void> {
    try {
      const prisma = getPrismaClient();
      await prisma.usageLog.create({
        data: {
          userId: params.context?.userId ?? null,
          campaignId: params.context?.campaignId ?? null,
          provider: UsageProvider.SPARIOR,
          operation: params.context?.operation ?? "search",
          requestCount: 1,
          itemsReturned: params.itemsReturned,
          quotaRemaining: params.quotaRemaining,
          metadata: {
            status: params.status,
            durationMs: params.durationMs,
            retries: params.retries,
            pageIndex: params.context?.pageIndex ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[SpariorClient] Fire-and-forget UsageLog failure:", err);
      }
    }
  }

  async search(
    query: string,
    options?: {
      cursor?: string | null;
      page?: number | null;
      limit?: number | null;
      campaignId?: string | null;
      userId?: string | null;
      pageIndex?: number | null;
    },
  ): Promise<SpariorCallResult<SpariorSearchResponse>> {
    const params: Record<string, string | number | null | undefined> = {
      search: query,
    };
    if (options?.cursor) params.cursor = options.cursor;
    if (options?.page) params.page = options.page;
    if (options?.limit) params.limit = options.limit;

    return this.request<SpariorSearchResponse>(
      "/v1/users/search",
      params,
      {
        operation: "search",
        campaignId: options?.campaignId,
        userId: options?.userId,
        pageIndex: options?.pageIndex,
      },
    );
  }

  async getProfile(
    username: string,
    options?: {
      campaignId?: string | null;
      userId?: string | null;
    },
  ): Promise<SpariorCallResult<SpariorProfileResponse>> {
    const params: Record<string, string> = {
      username,
    };

    return this.request<SpariorProfileResponse>(
      "/v1/profile",
      params,
      {
        operation: "profile",
        campaignId: options?.campaignId,
        userId: options?.userId,
      },
    );
  }
}
