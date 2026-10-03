"use client";

import { useEffect, useState, useRef } from "react";
import {
  getBulkJobStatus,
  pauseBulkJob,
  resumeBulkJob,
  cancelBulkJob,
  retryBulkJobItem,
  recoverStaleBulkJob,
  type BulkJobStatusResponse,
} from "@/lib/api/messaging";
import { startJobPolling } from "@/lib/polling/job-polling";

const POLL_INTERVAL_MS = 2500;

type BulkJobProgressPanelProps = {
  jobId: string | null;
  onClose: () => void;
  onJobStatusChange?: (status: string) => void;
};

export function BulkJobProgressPanel({
  jobId,
  onClose,
  onJobStatusChange,
}: BulkJobProgressPanelProps) {
  const [job, setJob] = useState<BulkJobStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);

  // Keep the latest callback in a ref so effect deps never include an inline
  // function prop (that previously caused an endless poll/render loop).
  const onStatusChangeRef = useRef(onJobStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onJobStatusChange;
  }, [onJobStatusChange]);

  // Single self-terminating polling loop, keyed only by jobId.
  useEffect(() => {
    if (!jobId) return;

    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setIsLoading(true);
    });

    const handle = startJobPolling({
      intervalMs: POLL_INTERVAL_MS,
      fetchStatus: async () => {
        const data = await getBulkJobStatus(jobId);
        if (cancelled) return null;
        setJob(data);
        setError(null);
        setIsLoading(false);
        return data.status;
      },
      onStatus: (status) => {
        if (!cancelled) {
          onStatusChangeRef.current?.(status);
        }
      },
      onError: (err: unknown) => {
        if (!cancelled) {
          setIsLoading(false);
          setError(
            err instanceof Error ? err.message : "Failed to fetch job progress",
          );
        }
      },
    });

    return () => {
      cancelled = true;
      // Clears the pending timeout and prevents any further callbacks.
      handle.stop();
    };
  }, [jobId]);

  if (!jobId) return null;

  const handlePause = async () => {
    if (!jobId || actionInProgress) return;
    setActionInProgress("pause");
    try {
      const updated = await pauseBulkJob(jobId);
      setJob(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to pause job";
      setError(message);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleResume = async () => {
    if (!jobId || actionInProgress) return;
    setActionInProgress("resume");
    try {
      const updated = await resumeBulkJob(jobId);
      setJob(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to resume job";
      setError(message);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleCancel = async () => {
    if (!jobId || actionInProgress) return;
    setActionInProgress("cancel");
    try {
      const updated = await cancelBulkJob(jobId);
      setJob(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to cancel job";
      setError(message);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRecoverStale = async () => {
    if (!jobId || actionInProgress) return;
    setActionInProgress("recover");
    try {
      const result = await recoverStaleBulkJob(jobId);
      setJob(result.job);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to recover stale items";
      setError(message);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRetryItem = async (itemId: string, isUnknown: boolean) => {
    if (!jobId || retryingItemId) return;
    if (isUnknown) {
      const confirmed = window.confirm(
        "Delivery could not be confirmed. The message may have already been sent to this recipient. Are you sure you want to retry?",
      );
      if (!confirmed) return;
    }
    setRetryingItemId(itemId);
    try {
      const updated = await retryBulkJobItem(jobId, itemId);
      setJob(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to retry item";
      setError(message);
    } finally {
      setRetryingItemId(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "RUNNING":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-semibold text-blue-400 border border-blue-500/30">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-ping" />
            RUNNING
          </span>
        );
      case "QUEUED":
        return (
          <span className="rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-xs font-semibold text-indigo-400 border border-indigo-500/30">
            QUEUED
          </span>
        );
      case "PAUSED":
        return (
          <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-400 border border-amber-500/30">
            PAUSED
          </span>
        );
      case "COMPLETED":
        return (
          <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-400 border border-emerald-500/30">
            COMPLETED
          </span>
        );
      case "PARTIAL":
        return (
          <span className="rounded-full bg-orange-500/10 px-2.5 py-0.5 text-xs font-semibold text-orange-400 border border-orange-500/30">
            COMPLETED WITH ERRORS
          </span>
        );
      case "FAILED":
        return (
          <span className="rounded-full bg-rose-500/10 px-2.5 py-0.5 text-xs font-semibold text-rose-400 border border-rose-500/30">
            FAILED
          </span>
        );
      case "CANCELLED":
        return (
          <span className="rounded-full bg-zinc-700/50 px-2.5 py-0.5 text-xs font-semibold text-zinc-400 border border-zinc-600/30">
            CANCELLED
          </span>
        );
      default:
        return (
          <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
            {status}
          </span>
        );
    }
  };

  const getItemBadge = (status: string) => {
    switch (status) {
      case "SENT":
        return <span className="text-[11px] font-semibold text-emerald-400">SENT</span>;
      case "FAILED":
        return <span className="text-[11px] font-semibold text-rose-400">FAILED</span>;
      case "UNKNOWN":
        return (
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
            UNKNOWN
          </span>
        );
      case "PROCESSING":
        return (
          <span className="text-[11px] font-semibold text-blue-400 animate-pulse">
            SENDING...
          </span>
        );
      case "QUEUED":
        return <span className="text-[11px] font-semibold text-zinc-500">QUEUED</span>;
      case "SKIPPED":
        return <span className="text-[11px] font-semibold text-amber-500">SKIPPED</span>;
      case "CANCELLED":
        return <span className="text-[11px] font-semibold text-zinc-600">CANCELLED</span>;
      default:
        return <span className="text-[11px] text-zinc-500">{status}</span>;
    }
  };

  const processedCount = job ? job.sent + job.failed + (job.unknown ?? 0) : 0;
  const totalItems = job ? job.total : 0;
  const progressPercent = job?.progress ?? 0;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/95 p-5 shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3.5">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-bold text-zinc-100">
            Bulk Messaging Job
          </h4>
          {job && getStatusBadge(job.status)}
        </div>

        <div className="flex items-center gap-2">
          {job && (job.status === "RUNNING" || job.status === "QUEUED") && (
            <>
              <button
                type="button"
                id="btn-pause-job"
                disabled={Boolean(actionInProgress)}
                onClick={handlePause}
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300 transition hover:bg-amber-500/20 disabled:opacity-50"
              >
                {actionInProgress === "pause" ? "Pausing..." : "Pause"}
              </button>
              <button
                type="button"
                id="btn-cancel-job"
                disabled={Boolean(actionInProgress)}
                onClick={handleCancel}
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-50"
              >
                {actionInProgress === "cancel" ? "Cancelling..." : "Cancel"}
              </button>
            </>
          )}

          {job && job.status === "PAUSED" && (
            <>
              <button
                type="button"
                id="btn-resume-job"
                disabled={Boolean(actionInProgress)}
                onClick={handleResume}
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {actionInProgress === "resume" ? "Resuming..." : "Resume"}
              </button>
              <button
                type="button"
                id="btn-cancel-paused-job"
                disabled={Boolean(actionInProgress)}
                onClick={handleCancel}
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-50"
              >
                {actionInProgress === "cancel" ? "Cancelling..." : "Cancel"}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition hover:text-zinc-200"
          >
            Close Panel
          </button>
        </div>
      </div>

      {isLoading && !job ? (
        <div className="py-6 text-center text-xs text-zinc-500 animate-pulse">
          Loading bulk job details...
        </div>
      ) : error ? (
        <div className="my-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
          {error}
        </div>
      ) : job ? (
        <div className="mt-4 space-y-4">
          {/* Progress Bar */}
          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-zinc-400 font-medium">
                Progress: <strong className="text-zinc-100">{processedCount} / {totalItems}</strong> ({progressPercent}%)
              </span>
              <span className="text-[11px] text-zinc-500">
                Job ID: {job.id.slice(0, 10)}...
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  job.status === "COMPLETED"
                    ? "bg-emerald-500"
                    : job.status === "PARTIAL"
                    ? "bg-orange-500"
                    : job.status === "FAILED"
                    ? "bg-rose-500"
                    : "bg-rose-600"
                }`}
                style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
              />
            </div>
          </div>

          {/* Counts Grid */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center text-xs">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-2.5">
              <span className="text-[10px] uppercase font-semibold text-zinc-500 block">Total</span>
              <span className="text-base font-bold text-zinc-200">{job.total}</span>
            </div>
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/20 p-2.5">
              <span className="text-[10px] uppercase font-semibold text-emerald-400 block">Sent</span>
              <span className="text-base font-bold text-emerald-300">{job.sent}</span>
            </div>
            <div className="rounded-xl border border-rose-500/20 bg-rose-950/20 p-2.5">
              <span className="text-[10px] uppercase font-semibold text-rose-400 block">Failed</span>
              <span className="text-base font-bold text-rose-300">{job.failed}</span>
            </div>
            <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-2.5">
              <span className="text-[10px] uppercase font-semibold text-amber-400 block">Unknown</span>
              <span className="text-base font-bold text-amber-300">{job.unknown ?? 0}</span>
            </div>
            <div className="rounded-xl border border-indigo-500/20 bg-indigo-950/20 p-2.5">
              <span className="text-[10px] uppercase font-semibold text-indigo-400 block">Queued</span>
              <span className="text-base font-bold text-indigo-300">{job.queued}</span>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-2.5">
              <span className="text-[10px] uppercase font-semibold text-zinc-500 block">Cancelled</span>
              <span className="text-base font-bold text-zinc-400">{job.cancelled}</span>
            </div>
          </div>

          {/* Error Summary Alert if stopped or paused due to safety */}
          {job.errorSummary && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300 flex items-start gap-2">
              <span className="text-base leading-none">⚠️</span>
              <div>
                <strong className="block font-semibold">Job Paused or Stopped:</strong>
                <span>{job.errorSummary}</span>
              </div>
            </div>
          )}

          {/* Terminal State Notices */}
          {job.status === "COMPLETED" && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300 text-center font-medium">
              ✓ Completed — All {job.total} recipients successfully processed ({job.sent} sent, {job.failed} failed)
            </div>
          )}

          {job.status === "PARTIAL" && (
            <div className="rounded-xl border border-orange-500/30 bg-orange-500/10 p-3 text-xs text-orange-300 text-center font-medium">
              Completed with errors — {job.sent} sent, {job.failed} failed
            </div>
          )}

          {/* Item Level Activity Feed */}
          {job.items && job.items.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase text-zinc-400">
                  Recipient Activity ({job.items.length})
                </span>
                {(job.status === "RUNNING" || job.status === "PAUSED") && (
                  <button
                    type="button"
                    onClick={handleRecoverStale}
                    disabled={Boolean(actionInProgress)}
                    className="text-[10px] text-zinc-400 hover:text-zinc-200 underline disabled:opacity-50"
                  >
                    Check Stale Work
                  </button>
                )}
              </div>
              <div className="max-h-56 overflow-y-auto space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-950 p-2 text-xs">
                {job.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between rounded-lg border border-zinc-800/60 bg-zinc-900/60 px-3 py-1.5"
                  >
                    <div className="flex items-center gap-2 overflow-hidden mr-2">
                      <span className="font-mono text-zinc-200 shrink-0">@{item.username}</span>
                      {item.errorMessage && (
                        <span className="text-[10px] text-rose-400 truncate max-w-xs" title={item.errorMessage}>
                          ({item.errorMessage})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {getItemBadge(item.status)}
                      {(item.status === "FAILED" || item.status === "UNKNOWN") && (
                        <button
                          type="button"
                          disabled={Boolean(retryingItemId)}
                          onClick={() => handleRetryItem(item.id, item.status === "UNKNOWN")}
                          title={
                            item.status === "UNKNOWN"
                              ? "Warning: message may have been sent. Click to confirm retry."
                              : "Retry sending to this recipient"
                          }
                          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-300 hover:bg-zinc-700 hover:text-white disabled:opacity-50"
                        >
                          {retryingItemId === item.id ? "Retrying..." : "Retry"}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
