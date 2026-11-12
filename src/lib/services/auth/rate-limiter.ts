/**
 * In-memory sliding-window rate limiter for sensitive authentication endpoints.
 * Protects against brute-force attacks and credential stuffing in production.
 */

type RateLimitRecord = {
  timestamps: number[];
};

const store = new Map<string, RateLimitRecord>();

// Clean up old entries periodically to prevent memory growth
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 60_000;

function cleanupOldEntries(windowMs: number) {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, record] of store.entries()) {
    record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);
    if (record.timestamps.length === 0) {
      store.delete(key);
    }
  }
}

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
};

export const AUTH_RATE_LIMIT_MAX = 5;
export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  // Allow disabling via explicit env flag only outside production
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.DISABLE_AUTH_RATE_LIMIT === "1"
  ) {
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetMs: 0,
    };
  }

  cleanupOldEntries(windowMs);

  const now = Date.now();
  let record = store.get(key);
  if (!record) {
    record = { timestamps: [] };
    store.set(key, record);
  }

  // Filter timestamps within the current sliding window
  record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);

  if (record.timestamps.length >= limit) {
    const oldestTimestamp = record.timestamps[0];
    const resetMs = Math.max(0, windowMs - (now - oldestTimestamp));
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetMs,
    };
  }

  record.timestamps.push(now);
  return {
    allowed: true,
    limit,
    remaining: limit - record.timestamps.length,
    resetMs: windowMs,
  };
}

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  if (cfConnectingIp) return cfConnectingIp.trim();

  return "127.0.0.1";
}

/**
 * Enforces rate limiting per IP and per Email for authentication endpoints:
 * 5 attempts / 15 min per IP and email. Disabled when NODE_ENV=test.
 */
export function checkAuthRateLimit(
  action: "login" | "register",
  clientIp: string,
  email?: string | null,
): RateLimitResult {
  const ipCheck = checkRateLimit(
    `${action}:ip:${clientIp}`,
    AUTH_RATE_LIMIT_MAX,
    AUTH_RATE_LIMIT_WINDOW_MS,
  );
  if (!ipCheck.allowed) {
    return ipCheck;
  }

  if (email && typeof email === "string") {
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail) {
      const emailCheck = checkRateLimit(
        `${action}:email:${normalizedEmail}`,
        AUTH_RATE_LIMIT_MAX,
        AUTH_RATE_LIMIT_WINDOW_MS,
      );
      if (!emailCheck.allowed) {
        return emailCheck;
      }
    }
  }

  return ipCheck;
}

