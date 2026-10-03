import "server-only";

import { sanitizeMessage } from "./services/errors/sanitize";

type LogMetadata = Record<string, unknown>;

function redactSensitiveData(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return sanitizeMessage(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveData);
  }

  if (typeof obj === "object") {
    const redacted: Record<string, unknown> = {};
    const sensitiveKeys = new Set([
      "password",
      "passwordhash",
      "token",
      "secret",
      "cookie",
      "authorization",
      "sessionid",
      "auth_secret",
      "apify_api_token",
      "openai_api_key",
      "gemini_api_key",
      "unipile_api_key",
      "unipile_webhook_path_secret",
      "webhook_secret",
    ]);

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (sensitiveKeys.has(key.toLowerCase())) {
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = redactSensitiveData(value);
      }
    }
    return redacted;
  }

  return obj;
}

export const logger = {
  info(message: string, meta?: LogMetadata) {
    const timestamp = new Date().toISOString();
    if (meta) {
      console.log(`[INFO] [${timestamp}] ${sanitizeMessage(message)}`, JSON.stringify(redactSensitiveData(meta)));
    } else {
      console.log(`[INFO] [${timestamp}] ${sanitizeMessage(message)}`);
    }
  },

  warn(message: string, meta?: LogMetadata) {
    const timestamp = new Date().toISOString();
    if (meta) {
      console.warn(`[WARN] [${timestamp}] ${sanitizeMessage(message)}`, JSON.stringify(redactSensitiveData(meta)));
    } else {
      console.warn(`[WARN] [${timestamp}] ${sanitizeMessage(message)}`);
    }
  },

  error(message: string, error?: unknown, meta?: LogMetadata) {
    const timestamp = new Date().toISOString();
    const safeError = error instanceof Error ? error.message : String(error || "");
    const payload = {
      errorMessage: sanitizeMessage(safeError),
      ...((meta ? redactSensitiveData(meta) : {}) as Record<string, unknown>),
    };
    console.error(`[ERROR] [${timestamp}] ${sanitizeMessage(message)}`, JSON.stringify(payload));
  },
};
