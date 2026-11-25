import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { BulkMessageJobStatus } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { dispatchBulkJobQueue } from "../messaging/bulk-messaging-service";
import { dispatchDueFollowUps } from "../messaging/follow-up-service";
import { isOutboundSendingEnabled } from "../messaging/send-gate";

/**
 * In-process outreach scheduler.
 *
 * Bulk workers exit their loop when sending is disabled or a lead is outside
 * working hours, and a server restart kills them. Follow-ups were only
 * dispatched from inside a running bulk worker. This tick:
 *   1. re-kicks every RUNNING bulk job (dispatchBulkJobQueue is idempotent:
 *      one worker per job), and
 *   2. dispatches due follow-ups for all campaigns.
 * Every send still goes through the send gate (kill switch, caps, hours).
 *
 * On by default in production; elsewhere set OUTREACH_SCHEDULER=true.
 * Disable with OUTREACH_SCHEDULER=false.
 */

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function isOutreachSchedulerEnabled(): boolean {
  const flag = process.env.OUTREACH_SCHEDULER?.trim().toLowerCase();
  if (flag === "false" || flag === "0") return false;
  if (flag === "true" || flag === "1") return true;
  return process.env.NODE_ENV === "production";
}

export async function runOutreachTick(): Promise<{ jobsKicked: number; followUpsSent: number }> {
  if (ticking) return { jobsKicked: 0, followUpsSent: 0 };
  ticking = true;
  try {
    if (!isOutboundSendingEnabled()) return { jobsKicked: 0, followUpsSent: 0 };
    const prisma = getPrismaClient();
    const running = await prisma.bulkMessageJob.findMany({
      where: { status: BulkMessageJobStatus.RUNNING },
      select: { id: true },
      take: 50,
    });
    for (const job of running) {
      // Fire and forget; the worker registry prevents duplicates.
      void dispatchBulkJobQueue(job.id).catch((err) =>
        logger.warn("[SCHEDULER] bulk job dispatch failed", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    const followUps = await dispatchDueFollowUps({ limit: 20 });
    if (running.length > 0 || followUps.sent > 0) {
      logger.info("[SCHEDULER] tick", { jobsKicked: running.length, followUpsSent: followUps.sent });
    }
    return { jobsKicked: running.length, followUpsSent: followUps.sent };
  } catch (err) {
    logger.warn("[SCHEDULER] tick failed", { error: err instanceof Error ? err.message : String(err) });
    return { jobsKicked: 0, followUpsSent: 0 };
  } finally {
    ticking = false;
  }
}

export function startOutreachScheduler(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer || !isOutreachSchedulerEnabled()) return;
  timer = setInterval(() => void runOutreachTick(), intervalMs);
  timer.unref?.();
  // First tick shortly after boot so jobs interrupted by a restart resume.
  setTimeout(() => void runOutreachTick(), 30_000).unref?.();
  logger.info("[SCHEDULER] outreach scheduler started", { intervalMs });
}
