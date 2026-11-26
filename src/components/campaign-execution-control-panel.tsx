"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  fetchCampaignExecutionStatus,
  startCampaignExecution,
  pauseCampaignExecution,
  resumeCampaignExecution,
  cancelCampaignExecution,
  type CampaignExecutionStatusResponse,
} from "@/lib/api/executions";
import { ApiClientError } from "@/lib/api/client";
import { isTerminalBulkJobStatus } from "@/lib/polling/job-polling";
import { ConfirmModal } from "./confirm-modal";
import { CampaignSendingHours } from "./campaign-sending-hours";

type Props = {
  campaignId: string;
  initialStatus?: string;
  onStateChange?: () => void;
};

export function CampaignExecutionControlPanel({
  campaignId,
  initialStatus,
  onStateChange,
}: Props) {
  const [status, setStatus] = useState<CampaignExecutionStatusResponse | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Confirmation Modals
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showPauseModal, setShowPauseModal] = useState(false);

  // Polling and request safety
  const isFetchingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  const loadStatus = useCallback(
    async (showRefreshIndicator = false) => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      if (showRefreshIndicator) setIsRefreshing(true);

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const data = await fetchCampaignExecutionStatus(campaignId);
        if (!controller.signal.aborted) {
          setStatus(data);
        }
        return data;
      } catch (err: unknown) {
        if (!controller.signal.aborted) {
          console.error("[ExecutionPanel] Failed to fetch execution status:", err);
        }
      } finally {
        isFetchingRef.current = false;
        if (showRefreshIndicator) setIsRefreshing(false);
      }
    },
    [campaignId],
  );

  // Initial fetch and cleanup
  useEffect(() => {
    let ignore = false;
    Promise.resolve().then(() => {
      if (!ignore) loadStatus();
    });
    return () => {
      ignore = true;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [loadStatus]);

  // Live polling rules:
  // - RUNNING: poll every 3000ms
  // - PAUSED: slow refresh every 10000ms
  // - Terminal (COMPLETED, PARTIAL, FAILED, CANCELLED): no interval at all
  // The interval is keyed on the derived poll delay (not on `status`), so a
  // status tick never recreates or duplicates the timer.
  const executionIsRunning =
    status?.executionStatus === "RUNNING" || status?.campaignStatus === "RUNNING";
  const executionIsPaused =
    status?.executionStatus === "PAUSED" || status?.campaignStatus === "PAUSED";
  const pollIntervalMs = executionIsRunning ? 3000 : executionIsPaused ? 10000 : 0;

  useEffect(() => {
    if (pollIntervalMs <= 0) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      const updated = await loadStatus();
      if (cancelled || !updated) return;
      if (
        isTerminalBulkJobStatus(updated.executionStatus) ||
        isTerminalBulkJobStatus(updated.campaignStatus)
      ) {
        onStateChangeRef.current?.();
      }
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollIntervalMs, loadStatus]);

  // Manual refresh button
  const handleManualRefresh = async () => {
    await loadStatus(true);
    onStateChange?.();
  };

  // Execution actions with zero optimistic state mutation
  const handleStart = async (rerun = false) => {
    setActionLoading(rerun ? "rerun" : "start");
    setActionError(null);
    try {
      await startCampaignExecution(campaignId, { rerun });
      await loadStatus();
      onStateChange?.();
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : "Failed to start campaign execution.",
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handlePauseConfirm = async () => {
    setShowPauseModal(false);
    setActionLoading("pause");
    setActionError(null);
    try {
      await pauseCampaignExecution(campaignId);
      await loadStatus();
      onStateChange?.();
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : "Failed to pause campaign execution.",
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleResume = async () => {
    setActionLoading("resume");
    setActionError(null);
    try {
      await resumeCampaignExecution(campaignId);
      await loadStatus();
      onStateChange?.();
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : "Failed to resume campaign execution.",
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancelConfirm = async () => {
    setShowCancelModal(false);
    setActionLoading("cancel");
    setActionError(null);
    try {
      await cancelCampaignExecution(campaignId);
      await loadStatus();
      onStateChange?.();
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : "Failed to cancel campaign execution.",
      );
    } finally {
      setActionLoading(null);
    }
  };

  const currentCampaignStatus = status?.campaignStatus || initialStatus || "DRAFT";
  const currentPhase = status?.currentPhase;
  const overallProgress = status?.overallProgress ?? 0;

  // Format elapsed time
  const formatElapsed = (seconds: number | null | undefined): string => {
    if (seconds == null || seconds < 0) return "—";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins >= 60) {
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      return `${hours}h ${remMins}m ${secs}s`;
    }
    return `${mins}m ${secs}s`;
  };

  const formatTimestamp = (iso: string | null | undefined): string => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return "—";
    }
  };

  const getStatusColor = (st: string) => {
    switch (st) {
      case "RUNNING":
        return "bg-amber-500/10 text-amber-400 border-amber-500/30";
      case "COMPLETED":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
      case "PARTIAL":
        return "bg-cyan-500/10 text-cyan-400 border-cyan-500/30";
      case "PAUSED":
        return "bg-yellow-500/10 text-yellow-400 border-yellow-500/30";
      case "FAILED":
        return "bg-rose-500/10 text-rose-400 border-rose-500/30";
      case "CANCELLED":
        return "bg-zinc-500/10 text-zinc-400 border-zinc-500/30";
      case "READY":
        return "bg-blue-500/10 text-blue-400 border-blue-500/30";
      default:
        return "bg-zinc-800 text-zinc-400 border-zinc-700";
    }
  };

  const getPhaseColor = (phase: string) => {
    switch (phase) {
      case "DISCOVERY":
        return "bg-indigo-500/10 text-indigo-400 border-indigo-500/30";
      case "ENRICHMENT":
        return "bg-purple-500/10 text-purple-400 border-purple-500/30";
      case "READY":
        return "bg-blue-500/10 text-blue-400 border-blue-500/30";
      case "MESSAGING":
        return "bg-pink-500/10 text-pink-400 border-pink-500/30";
      case "FINALIZING":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
      default:
        return "bg-zinc-800 text-zinc-400 border-zinc-700";
    }
  };

  // Phase pipeline order
  const phases = ["DISCOVERY", "ENRICHMENT", "READY", "MESSAGING", "FINALIZING"];
  const currentPhaseIndex = currentPhase ? phases.indexOf(currentPhase) : -1;
  const isTerminal =
    currentCampaignStatus === "COMPLETED" ||
    currentCampaignStatus === "PARTIAL" ||
    currentCampaignStatus === "FAILED" ||
    currentCampaignStatus === "CANCELLED";

  return (
    <div
      id="campaign-execution-panel"
      className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-sm space-y-5"
    >
      {/* 1. Header Bar: Identity, Status, Phase, Refresh, Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-rose-500/20 to-indigo-500/20 text-rose-400 border border-rose-500/30 shrink-0">
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold text-white">Campaign Execution Engine</h2>
              <span
                id="execution-campaign-status-badge"
                role="status"
                aria-label={`Campaign status: ${currentCampaignStatus}`}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold border ${getStatusColor(
                  currentCampaignStatus,
                )}`}
              >
                {currentCampaignStatus === "RUNNING" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-ping" />
                )}
                {currentCampaignStatus}
              </span>
              {currentPhase && (
                <span
                  id="execution-phase-badge"
                  role="status"
                  aria-label={`Current execution phase: ${currentPhase}`}
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-mono font-medium border ${getPhaseColor(
                    currentPhase,
                  )}`}
                >
                  Phase: {currentPhase}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Authoritative server-side orchestration with atomic worker lifecycle and persisted crash recovery.
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 flex-wrap" id="execution-controls">
          {/* Manual Refresh Button */}
          <button
            id="btn-refresh-execution"
            onClick={handleManualRefresh}
            disabled={isRefreshing || Boolean(actionLoading)}
            aria-label="Refresh execution status"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition disabled:opacity-50"
          >
            <svg
              className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin text-rose-400" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>{isRefreshing ? "Refreshing..." : "Refresh"}</span>
          </button>

          {/* START CAMPAIGN: DRAFT or READY */}
          {(currentCampaignStatus === "DRAFT" || currentCampaignStatus === "READY") && (
            <button
              id="btn-start-execution"
              onClick={() => handleStart(false)}
              disabled={Boolean(actionLoading)}
              aria-label="Start campaign execution"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50 transition"
            >
              {actionLoading === "start" ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>Starting...</span>
                </>
              ) : (
                <>
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>Start Campaign</span>
                </>
              )}
            </button>
          )}

          {/* PAUSE & CANCEL: RUNNING */}
          {currentCampaignStatus === "RUNNING" && (
            <>
              <button
                id="btn-pause-execution"
                onClick={() => setShowPauseModal(true)}
                disabled={Boolean(actionLoading)}
                aria-label="Pause campaign execution"
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600/20 border border-amber-500/40 px-3.5 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-600/30 disabled:opacity-50 transition"
              >
                {actionLoading === "pause" ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
                    <span>Pausing...</span>
                  </>
                ) : (
                  <>
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span>Pause</span>
                  </>
                )}
              </button>
              <button
                id="btn-cancel-execution"
                onClick={() => setShowCancelModal(true)}
                disabled={Boolean(actionLoading)}
                aria-label="Cancel campaign execution"
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600/20 border border-rose-500/40 px-3.5 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-600/30 disabled:opacity-50 transition"
              >
                {actionLoading === "cancel" ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-rose-300 border-t-transparent" />
                    <span>Cancelling...</span>
                  </>
                ) : (
                  <>
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    <span>Cancel Campaign</span>
                  </>
                )}
              </button>
            </>
          )}

          {/* RESUME & CANCEL: PAUSED */}
          {currentCampaignStatus === "PAUSED" && (
            <>
              <button
                id="btn-resume-execution"
                onClick={handleResume}
                disabled={Boolean(actionLoading)}
                aria-label="Resume campaign execution"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50 transition"
              >
                {actionLoading === "resume" ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    <span>Resuming...</span>
                  </>
                ) : (
                  <>
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    </svg>
                    <span>Resume</span>
                  </>
                )}
              </button>
              <button
                id="btn-cancel-execution"
                onClick={() => setShowCancelModal(true)}
                disabled={Boolean(actionLoading)}
                aria-label="Cancel campaign execution"
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600/20 border border-rose-500/40 px-3.5 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-600/30 disabled:opacity-50 transition"
              >
                {actionLoading === "cancel" ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-rose-300 border-t-transparent" />
                    <span>Cancelling...</span>
                  </>
                ) : (
                  <>
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    <span>Cancel Campaign</span>
                  </>
                )}
              </button>
            </>
          )}

          {/* RERUN: TERMINAL STATES */}
          {isTerminal && (
            <button
              id="btn-rerun-execution"
              onClick={() => handleStart(true)}
              disabled={Boolean(actionLoading)}
              aria-label="Rerun campaign from start"
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 border border-zinc-700 px-3.5 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 transition"
            >
              {actionLoading === "rerun" ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-transparent" />
                  <span>Restarting...</span>
                </>
              ) : (
                <>
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Rerun Campaign</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* 2. Error & Safe Alert Banners */}
      {actionError && (
        <div
          role="alert"
          className="rounded-xl bg-rose-500/10 border border-rose-500/30 p-3 text-xs text-rose-300 flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-rose-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{actionError}</span>
          </div>
          <button
            onClick={() => setActionError(null)}
            aria-label="Dismiss error"
            className="text-rose-400 hover:text-rose-200 text-sm font-bold ml-2"
          >
            &times;
          </button>
        </div>
      )}

      {status?.safeError && (
        <div
          role="alert"
          className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-300 flex items-start gap-2.5"
        >
          <svg className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <span className="font-semibold font-mono">[{status.safeError.errorCode}]</span>{" "}
            <span>{status.safeError.errorMessage}</span>
          </div>
        </div>
      )}

      {/* Terminal State Notices */}
      {currentCampaignStatus === "COMPLETED" && (
        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 text-xs text-emerald-300 flex items-center gap-2">
          <svg className="h-4 w-4 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="font-medium">Campaign completed. All planned workflow operations finished successfully.</span>
        </div>
      )}
      {currentCampaignStatus === "PARTIAL" && (
        <div className="rounded-xl bg-cyan-500/10 border border-cyan-500/30 p-3 text-xs text-cyan-300 flex items-center gap-2">
          <svg className="h-4 w-4 text-cyan-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-medium">Campaign completed with some failed, skipped, or uncertain work.</span>
        </div>
      )}
      {currentCampaignStatus === "FAILED" && (
        <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 p-3 text-xs text-rose-300 flex items-center gap-2">
          <svg className="h-4 w-4 text-rose-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-medium">Campaign execution failed. Check safe error details above.</span>
        </div>
      )}
      {currentCampaignStatus === "CANCELLED" && (
        <div className="rounded-xl bg-zinc-800 border border-zinc-700 p-3 text-xs text-zinc-300 flex items-center gap-2">
          <svg className="h-4 w-4 text-zinc-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
          <span className="font-medium">Campaign was cancelled. Queued items were not sent. Already completed messages were preserved.</span>
        </div>
      )}

      {/* 3. Execution Timeline */}
      <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3.5">
        <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2.5">
          Execution Phase Pipeline
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
          {phases.map((phase, idx) => {
            const isActive = currentPhase === phase && !isTerminal;
            const isCompleted =
              isTerminal ||
              (currentPhaseIndex > -1 && idx < currentPhaseIndex) ||
              (currentCampaignStatus === "COMPLETED" && phase === "FINALIZING");
            const isSkippedDiscovery =
              phase === "DISCOVERY" && status?.discoveryDetails?.discoverySkipped;

            return (
              <div key={phase} className="flex items-center gap-2 shrink-0">
                <div
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium border transition ${
                    isActive
                      ? "border-amber-500/50 bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/30"
                      : isCompleted
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : isSkippedDiscovery
                      ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
                      : "border-zinc-800 bg-zinc-900/50 text-zinc-500"
                  }`}
                >
                  {isCompleted ? (
                    <svg className="h-3 w-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : isActive ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                  ) : (
                    <span className="font-mono text-[10px] text-zinc-500">{idx + 1}</span>
                  )}
                  <span>
                    {isSkippedDiscovery ? "Discovery: Skipped (Existing Leads)" : phase}
                  </span>
                </div>
                {idx < phases.length - 1 && (
                  <span className="text-zinc-600 font-mono text-xs">&rarr;</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. Overall Deterministic Progress Bar & Timestamps */}
      <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3.5 space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 font-medium text-zinc-300">
            <span>Overall Execution Progress</span>
            <span className="rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200">
              {overallProgress}%
            </span>
          </div>
          <div className="flex items-center gap-4 text-zinc-400 text-[11px] font-mono">
            <span>Started: {formatTimestamp(status?.timestamps.startedAt)}</span>
            <span>Elapsed: {formatElapsed(status?.timestamps.elapsedSeconds)}</span>
            <span>Last Updated: {formatTimestamp(status?.timestamps.updatedAt)}</span>
          </div>
        </div>

        <div className="w-full bg-zinc-800 h-2.5 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${
              currentCampaignStatus === "FAILED"
                ? "bg-rose-500"
                : currentCampaignStatus === "CANCELLED"
                ? "bg-zinc-500"
                : "bg-gradient-to-r from-indigo-500 via-rose-500 to-emerald-500"
            }`}
            style={{ width: `${overallProgress}%` }}
          />
        </div>
      </div>

      {/* 5. Lead Capacity Strip */}
      {status?.leadCapacity && (
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-zinc-300">Lead Capacity:</span>
            <span className="text-zinc-400">
              Limit: <strong className="text-zinc-200">{status.leadCapacity.leadLimit ?? "None"}</strong> &bull; Current:{" "}
              <strong className="text-zinc-200">{status.leadCapacity.currentLeads}</strong>
            </span>
          </div>
          <div>
            {status.leadCapacity.remainingCapacity != null ? (
              status.leadCapacity.remainingCapacity === 0 ? (
                <span className="rounded-md bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-xs font-semibold text-amber-300">
                  Capacity Reached (0 remaining)
                </span>
              ) : (
                <span className="rounded-md bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-xs font-semibold text-emerald-400">
                  {status.leadCapacity.remainingCapacity} leads remaining
                </span>
              )
            ) : (
              <span className="text-zinc-500">Unrestricted</span>
            )}
          </div>
        </div>
      )}

      {/* 5b. Safe Outbound Pacing & Estimated Completion */}
      {status?.estimatedCompletion && (
        <div
          data-testid="campaign-estimated-completion"
          className="rounded-xl border border-indigo-500/20 bg-indigo-950/20 p-3.5 text-xs"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="font-semibold text-zinc-200">
              Safe Outbound Pacing:
            </span>
            <span className="text-zinc-300">
              {status.estimatedCompletion.healthySendersCount} healthy sender{status.estimatedCompletion.healthySendersCount === 1 ? "" : "s"} · {status.estimatedCompletion.dailyCapacity} DMs/day cap · {status.estimatedCompletion.workingHoursWindow}
            </span>
          </div>
          <div className="font-mono text-zinc-300">
            {status.estimatedCompletion.estimatedCompletionDate ? (
              <span>
                Estimated Completion: <strong className="text-emerald-400">{new Date(status.estimatedCompletion.estimatedCompletionDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</strong> ({status.estimatedCompletion.daysRemaining} day{status.estimatedCompletion.daysRemaining === 1 ? "" : "s"} remaining)
              </span>
            ) : (
              <span className="text-zinc-500">No active senders or queue complete</span>
            )}
          </div>
          </div>
          <CampaignSendingHours
            campaignId={campaignId}
            value={status.estimatedCompletion.sendWindow}
            onSaved={() => void loadStatus(true)}
          />
        </div>
      )}

      {/* 6. Real-time Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-center">
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
          <div className="text-[11px] font-medium text-zinc-400">Total Leads</div>
          <div className="mt-1 text-base font-bold text-white font-mono">
            {status?.totalLeads ?? "—"}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
          <div className="text-[11px] font-medium text-zinc-400">Discovered</div>
          <div className="mt-1 text-base font-bold text-indigo-400 font-mono">
            {status?.discoveryProgress?.candidatesDiscovered ?? 0}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
          <div className="text-[11px] font-medium text-zinc-400">Enriched</div>
          <div className="mt-1 text-base font-bold text-purple-400 font-mono">
            {status?.discoveryProgress?.candidatesEnriched ?? 0}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
          <div className="text-[11px] font-medium text-zinc-400">Sent</div>
          <div className="mt-1 text-base font-bold text-emerald-400 font-mono">
            {status?.sent ?? 0}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
          <div className="text-[11px] font-medium text-zinc-400">Failed / Unknown</div>
          <div className="mt-1 text-base font-bold text-rose-400 font-mono">
            {(status?.failed ?? 0) + (status?.unknown ?? 0)}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
          <div className="text-[11px] font-medium text-zinc-400">Queued</div>
          <div className="mt-1 text-base font-bold text-amber-400 font-mono">
            {status?.queued ?? 0}
          </div>
        </div>
      </div>

      {/* 7. Detailed Messaging Breakdown if Available */}
      {status?.messagingProgress && status.messagingProgress.total > 0 && (
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-400 font-mono">
            <span>
              Messaging Queue: {status.messagingProgress.sent + status.messagingProgress.failed + status.messagingProgress.unknown} / {status.messagingProgress.total} processed
            </span>
            <span>{status.messagingProgress.progress}%</span>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center text-xs font-mono">
            <div className="bg-zinc-900/80 rounded-lg p-1.5 border border-zinc-800">
              <span className="text-zinc-500 block text-[10px]">Processing</span>
              <span className="text-blue-400 font-bold">{status.messagingProgress.processing}</span>
            </div>
            <div className="bg-zinc-900/80 rounded-lg p-1.5 border border-zinc-800">
              <span className="text-zinc-500 block text-[10px]">Sent</span>
              <span className="text-emerald-400 font-bold">{status.messagingProgress.sent}</span>
            </div>
            <div className="bg-zinc-900/80 rounded-lg p-1.5 border border-zinc-800">
              <span className="text-zinc-500 block text-[10px]">Failed</span>
              <span className="text-rose-400 font-bold">{status.messagingProgress.failed}</span>
            </div>
            <div className="bg-zinc-900/80 rounded-lg p-1.5 border border-zinc-800">
              <span className="text-zinc-500 block text-[10px]">Unknown</span>
              <span className="text-amber-400 font-bold">{status.messagingProgress.unknown}</span>
            </div>
            <div className="bg-zinc-900/80 rounded-lg p-1.5 border border-zinc-800">
              <span className="text-zinc-500 block text-[10px]">Skipped</span>
              <span className="text-zinc-400 font-bold">{status.messagingProgress.skipped}</span>
            </div>
            <div className="bg-zinc-900/80 rounded-lg p-1.5 border border-zinc-800">
              <span className="text-zinc-500 block text-[10px]">Queued</span>
              <span className="text-zinc-300 font-bold">{status.messagingProgress.queued}</span>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modals */}
      <ConfirmModal
        isOpen={showCancelModal}
        title="Cancel Campaign Execution"
        message="Cancel this campaign? Queued work will not start. Completed messages cannot be undone."
        confirmLabel="Yes, Cancel Campaign"
        cancelLabel="Back"
        isDangerous={true}
        isLoading={actionLoading === "cancel"}
        onConfirm={handleCancelConfirm}
        onCancel={() => setShowCancelModal(false)}
      />

      <ConfirmModal
        isOpen={showPauseModal}
        title="Pause Campaign Execution"
        message="Pause this campaign? No new work will start until resumed. In-flight safe operations will complete."
        confirmLabel="Pause Campaign"
        cancelLabel="Keep Running"
        isDangerous={false}
        isLoading={actionLoading === "pause"}
        onConfirm={handlePauseConfirm}
        onCancel={() => setShowPauseModal(false)}
      />
    </div>
  );
}
