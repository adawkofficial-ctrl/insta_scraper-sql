import { createHash } from "node:crypto";
import { getPrismaClient } from "@/lib/db/prisma";

/**
 * Normalizes message text for deterministic fingerprinting (trims, normalizes line breaks and whitespace).
 */
export function normalizeMessageText(text: string): string {
  return text
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Calculates a SHA-256 fingerprint from non-sensitive messaging identifiers and normalized content.
 */
export function calculateContentFingerprint(
  campaignId: string,
  leadId: string,
  messageText: string
): string {
  const normalized = normalizeMessageText(messageText);
  return createHash("sha256")
    .update(`${campaignId}:${leadId}:${normalized}`)
    .digest("hex");
}

/**
 * Generates or formats a scoped idempotency key.
 */
export function formatScopedIdempotencyKey(
  rawKeyOrRequestId: string | undefined,
  campaignId: string,
  leadId: string,
  attemptNumber?: number | string
): string {
  const attemptSuffix = attemptNumber !== undefined ? `:attempt-${attemptNumber}` : "";
  if (rawKeyOrRequestId && rawKeyOrRequestId.trim()) {
    return `${campaignId}:${leadId}:${rawKeyOrRequestId.trim()}${attemptSuffix}`;
  }
  return `${campaignId}:${leadId}:${Date.now()}${attemptSuffix}`;
}

/**
 * Checks for a cached attempt with the exact idempotency key.
 * If found and already SENT, returns the existing record (safe deduplication).
 * If in progress (SENDING / PROCESSING), indicates a concurrent request conflict.
 */
export async function findIdempotentAttempt(scopedKey: string) {
  const prisma = getPrismaClient();
  return prisma.messageAttempt.findFirst({
    where: { idempotencyKey: scopedKey },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Checks for a recent identical message sent to the same lead within a short cooldown window (e.g. 15s).
 * Prevents rapid double clicks or client retries while allowing legitimate later follow-ups.
 */
export async function findRecentDuplicateAttempt(
  leadId: string,
  contentHash: string,
  cooldownSeconds: number = 15
) {
  const prisma = getPrismaClient();
  const cutoff = new Date(Date.now() - cooldownSeconds * 1000);

  return prisma.messageAttempt.findFirst({
    where: {
      leadId,
      contentHash,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
  });
}
