import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { UsageProvider } from "@/generated/prisma/enums";

export type GeminiErrorCode =
  | "AI_AUTH_FAILED"
  | "AI_RATE_LIMITED"
  | "AI_QUOTA_EXHAUSTED"
  | "AI_BAD_OUTPUT"
  | "AI_BLOCKED"
  | "AI_TIMEOUT"
  | "AI_UNAVAILABLE";

export class GeminiApiError extends Error {
  readonly code: GeminiErrorCode;
  readonly status: number | null;
  constructor(code: GeminiErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "GeminiApiError";
    this.code = code;
    this.status = status;
  }
}

export type GeminiOperation =
  | "lead_analysis"
  | "draft_generation"
  | "regenerate_draft"
  | "reply_classification"
  | "reply_draft_generation"
  | "relevance_check";

export type GeminiUsage = { inputTokens: number; outputTokens: number };

export type GeminiStructuredResult<T> = {
  data: T;
  usage: GeminiUsage;
  latencyMs: number;
  model: string;
  finishReason: string | null;
};

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;

function getModel(): string {
  return getServerEnv("GEMINI_MODEL") ?? DEFAULT_MODEL;
}
function getTimeoutMs(): number {
  const raw = Number(getServerEnv("AI_GEMINI_TIMEOUT_MS") ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}
function getMaxConcurrency(): number {
  const raw = Number(getServerEnv("AI_MAX_CONCURRENCY") ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 3;
}
function getMaxRequestsPerMinute(): number {
  const raw = Number(getServerEnv("GEMINI_MAX_REQUESTS_PER_MINUTE") ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 12;
}
function getPricePer1M(name: string): number {
  const raw = Number(getServerEnv(name) ?? "0");
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

// ---------------------------------------------------------------------------
// Concurrency + per-minute rate limiting (shared per process)
// ---------------------------------------------------------------------------

let activeRequests = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeRequests < getMaxConcurrency()) {
    activeRequests += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeRequests += 1;
}
function releaseSlot(): void {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waiters.shift();
  if (next) next();
}

let windowStartedAt = Date.now();
let requestsInWindow = 0;

async function acquireRateSlot(): Promise<void> {
  const maxPerMinute = getMaxRequestsPerMinute();
  for (;;) {
    const now = Date.now();
    if (now - windowStartedAt >= 60_000) {
      windowStartedAt = now;
      requestsInWindow = 0;
    }
    if (requestsInWindow < maxPerMinute) {
      requestsInWindow += 1;
      return;
    }
    const waitMs = 60_000 - (now - windowStartedAt) + 10;
    await new Promise((resolve) => setTimeout(resolve, Math.max(20, waitMs)));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fence) {
    return fence[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, isRateLimit = false): number {
  if (isRateLimit) {
    return Math.min(15_000, 3000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 500);
  }
  const base = Math.min(4000, 500 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

async function recordUsage(params: {
  operation: GeminiOperation;
  usage: GeminiUsage;
  latencyMs: number;
  model: string;
  attempt: number;
  ok: boolean;
  userId?: string;
  campaignId?: string;
  promptVersion: string;
}): Promise<void> {
  const inputPrice = getPricePer1M("GEMINI_PRICE_INPUT_PER_1M_USD");
  const outputPrice = getPricePer1M("GEMINI_PRICE_OUTPUT_PER_1M_USD");
  const estimatedCostUsd =
    inputPrice === 0 && outputPrice === 0
      ? null
      : (params.usage.inputTokens / 1_000_000) * inputPrice +
        (params.usage.outputTokens / 1_000_000) * outputPrice;

  try {
    await getPrismaClient().usageLog.create({
      data: {
        provider: UsageProvider.GEMINI,
        operation: params.operation,
        inputTokens: params.usage.inputTokens,
        outputTokens: params.usage.outputTokens,
        estimatedCostUsd,
        campaignId: params.campaignId ?? null,
        userId: params.userId ?? null,
        metadata: {
          model: params.model,
          promptVersion: params.promptVersion,
          latencyMs: params.latencyMs,
          attempt: params.attempt,
          ok: params.ok,
        },
      },
    });
  } catch (error) {
    // A UsageLog failure must never fail the AI call.
    logger.warn("[GEMINI] UsageLog write failed", {
      operation: params.operation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Structured generation
// ---------------------------------------------------------------------------

export type GenerateStructuredParams<T> = {
  systemInstruction: string;
  userText: string;
  responseSchema: unknown;
  validate: (data: unknown) => T;
  operation: GeminiOperation;
  promptVersion: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  userId?: string;
  campaignId?: string;
};

export async function generateStructured<T>(
  params: GenerateStructuredParams<T>,
): Promise<GeminiStructuredResult<T>> {
  const apiKey = getServerEnv("GEMINI_API_KEY");
  if (!apiKey) {
    throw new GeminiApiError("AI_AUTH_FAILED", "GEMINI_API_KEY is not configured.");
  }
  const model = getModel();

  await acquireSlot();
  try {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await acquireRateSlot();
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            signal: controller.signal,
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: params.systemInstruction }] },
              contents: [{ role: "user", parts: [{ text: params.userText }] }],
              generationConfig: {
                temperature: params.temperature ?? 0.4,
                topP: params.topP ?? 0.9,
                maxOutputTokens: params.maxOutputTokens ?? 2048,
                responseMimeType: "application/json",
                responseSchema: params.responseSchema,
              },
            }),
          },
        );

        const latencyMs = Date.now() - startedAt;

        if (!response.ok) {
          const bodyText = await response.text().catch(() => "");
          const status = response.status;
          const bodySnippet = bodyText.slice(0, 500);
          logger.warn(`[GEMINI] HTTP ${status} error on attempt ${attempt}/${MAX_ATTEMPTS}`, {
            operation: params.operation,
            status,
            body: bodySnippet,
          });
          if (status === 401 || status === 403) {
            throw new GeminiApiError("AI_AUTH_FAILED", "Gemini rejected the API key.", status);
          }
          if (status === 404) {
            throw new GeminiApiError("AI_UNAVAILABLE", `Gemini model not found (404): ${bodySnippet}`, status);
          }
          if (status === 400) {
            // 400 can be a schema/request error — retryable in case of transient issues
            lastError = new GeminiApiError("AI_BAD_OUTPUT", `Gemini rejected the request (400): ${bodySnippet}`, status);
            if (attempt < MAX_ATTEMPTS) {
              await sleep(backoffMs(attempt));
              continue;
            }
            throw lastError;
          }
          if (status === 429) {
            const retryAfter = Number(response.headers.get("retry-after") ?? "");
            lastError = new GeminiApiError("AI_RATE_LIMITED", "Gemini rate limited the request.", status);
            if (attempt < MAX_ATTEMPTS) {
              const waitMs =
                Number.isFinite(retryAfter) && retryAfter > 0
                  ? retryAfter * 1000
                  : Math.max(12_000, backoffMs(attempt, true));
              logger.warn(`[GEMINI] rate limit 429 encountered, backing off ${waitMs}ms before retry ${attempt + 1}/${MAX_ATTEMPTS}`);
              await sleep(waitMs);
              continue;
            }
            throw lastError;
          }
          if (status >= 500) {
            lastError = new GeminiApiError("AI_UNAVAILABLE", `Gemini returned ${status}: ${bodySnippet}`, status);
            if (attempt < MAX_ATTEMPTS) {
              await sleep(backoffMs(attempt));
              continue;
            }
            throw lastError;
          }
          throw new GeminiApiError("AI_UNAVAILABLE", `Gemini returned ${status}: ${bodySnippet}`, status);
        }

        const payload = (await response.json()) as {
          candidates?: Array<{
            finishReason?: string;
            content?: { parts?: Array<{ text?: string }> };
          }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };

        const candidate = payload.candidates?.[0];
        const finishReason = candidate?.finishReason ?? null;
        const usage: GeminiUsage = {
          inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
        };

        if (finishReason === "SAFETY" || finishReason === "RECITATION" || finishReason === "PROHIBITED_CONTENT") {
          await recordUsage({ ...params, usage, latencyMs, model, attempt, ok: false });
          throw new GeminiApiError("AI_BLOCKED", "Gemini blocked the response for safety reasons.");
        }

        const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
        if (text.trim().length === 0) {
          await recordUsage({ ...params, usage, latencyMs, model, attempt, ok: false });
          throw new GeminiApiError(
            "AI_BAD_OUTPUT",
            finishReason === "MAX_TOKENS"
              ? "Gemini response was truncated before producing JSON."
              : "Gemini returned an empty response.",
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(stripCodeFences(text));
        } catch {
          await recordUsage({ ...params, usage, latencyMs, model, attempt, ok: false });
          throw new GeminiApiError("AI_BAD_OUTPUT", "Gemini returned malformed JSON.");
        }

        const data = params.validate(parsed);
        await recordUsage({ ...params, usage, latencyMs, model, attempt, ok: true });
        return { data, usage, latencyMs, model, finishReason };
      } catch (error) {
        if (error instanceof GeminiApiError) {
          if (
            error.code === "AI_RATE_LIMITED" ||
            error.code === "AI_UNAVAILABLE"
          ) {
            if (attempt < MAX_ATTEMPTS) {
              await sleep(backoffMs(attempt));
              continue;
            }
          }
          throw error;
        }
        // Network/abort errors are retryable.
        const isAbort = error instanceof Error && error.name === "AbortError";
        lastError = new GeminiApiError(
          isAbort ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
          isAbort ? "Gemini request timed out." : "Gemini request failed.",
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof GeminiApiError
      ? lastError
      : new GeminiApiError("AI_UNAVAILABLE", "Gemini request failed.");
  } finally {
    releaseSlot();
  }
}
