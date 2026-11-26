"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listCampaignBulkJobs,
  type BulkJobItemRecord,
  type BulkJobStatusResponse,
  type BulkSenderTimer,
} from "@/lib/api/messaging";

const POLL_MS = 5000;
const ACTIVE = new Set(["RUNNING", "QUEUED", "PAUSED"]);

function formatCountdown(targetIso: string | null | undefined, nowMs: number): string {
  if (!targetIso) return "—";
  const diff = new Date(targetIso).getTime() - nowMs;
  if (!Number.isFinite(diff) || diff <= 0) return "now";
  const total = Math.floor(diff / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Plain-language reason a queued item is waiting (from the worker's note). */
function waitReason(item: BulkJobItemRecord): string | null {
  const msg = item.errorMessage ?? "";
  if (msg.includes("working hours")) return "waiting for lead's local 9 AM";
  if (msg.includes("campaign send window")) return "outside campaign window";
  if (msg.includes("next account")) return "all accounts cooling down";
  if (msg.includes("DAILY_CAP")) return "daily cap reached";
  if (msg.includes("HOURLY_CAP")) return "hourly cap reached";
  if (msg.includes("disabled")) return "sending disabled";
  return null;
}

type QueueRow = BulkJobItemRecord & { jobId: string; jobStatus: string };

/**
 * Every lead waiting in an active bulk job for this campaign, with a live
 * countdown to its send and the account that will send it.
 */
export function CampaignSendQueue({ campaignId }: { campaignId: string }) {
  const [jobs, setJobs] = useState<BulkJobStatusResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const all = await listCampaignBulkJobs(campaignId);
      setJobs(all.filter((j) => ACTIVE.has(j.status)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the send queue.");
    }
  }, [campaignId]);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (!stopped) await load();
    };
    void tick();
    const poll = setInterval(tick, POLL_MS);
    const clock = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      stopped = true;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  const rows: QueueRow[] = (jobs ?? [])
    .flatMap((j) =>
      (j.items ?? [])
        .filter((it) => it.status === "QUEUED" || it.status === "PROCESSING")
        .map((it) => ({ ...it, jobId: j.id, jobStatus: j.status })),
    )
    .sort((a, b) => {
      if (a.status === "PROCESSING") return -1;
      if (b.status === "PROCESSING") return 1;
      const ta = a.etaAt ? new Date(a.etaAt).getTime() : Infinity;
      const tb = b.etaAt ? new Date(b.etaAt).getTime() : Infinity;
      return ta - tb;
    });

  // One timer row per account (first active job that reports it).
  const timers = new Map<string, BulkSenderTimer>();
  for (const j of jobs ?? []) {
    for (const t of j.senderTimers ?? []) {
      if (!timers.has(t.senderAccountId)) timers.set(t.senderAccountId, t);
    }
  }

  const sentToday = (jobs ?? []).reduce((n, j) => n + j.sent, 0);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase text-zinc-400">Send queue</div>
          <div className="text-xs text-zinc-500">
            Leads waiting in running bulk jobs. Template jobs skip draft review, so they show here, not in the drafts list.
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-zinc-400">
            Queued <strong className="text-orange-300">{rows.filter((r) => r.status === "QUEUED").length}</strong>
          </span>
          <span className="text-zinc-400">
            Sent in active jobs <strong className="text-emerald-300">{sentToday}</strong>
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:text-white"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300">{error}</div>
      )}

      {jobs === null && !error ? (
        <div className="text-xs text-zinc-500 animate-pulse">Loading send queue...</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-zinc-500">Nothing queued. Start a bulk send or approve drafts to fill the queue.</div>
      ) : (
        <>
          {timers.size > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
              {[...timers.values()].map((t) => {
                const canSend = t.availableAt !== null;
                const ready = canSend && new Date(t.availableAt!).getTime() <= nowMs;
                return (
                  <div
                    key={t.senderAccountId}
                    className="flex items-center justify-between rounded-lg border border-zinc-800/60 bg-zinc-950/60 px-2.5 py-1.5 text-[11px]"
                  >
                    <div className="flex items-center gap-1.5 overflow-hidden">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          !canSend ? "bg-rose-500" : ready ? "bg-emerald-400" : "bg-orange-400"
                        }`}
                      />
                      <span className="font-mono text-zinc-200 truncate">@{t.username}</span>
                      <span className="text-zinc-500 shrink-0">{t.sentToday}/{t.dailyCap} today</span>
                    </div>
                    <span
                      className={`font-mono tabular-nums shrink-0 ${
                        !canSend ? "text-rose-400" : ready ? "text-emerald-400" : "text-orange-300"
                      }`}
                    >
                      {!canSend ? t.reason : ready ? "Ready" : formatCountdown(t.availableAt, nowMs)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="max-h-72 overflow-y-auto space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-xs">
            {rows.map((row) => {
              const reason = waitReason(row);
              return (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/60 px-3 py-1.5"
                >
                  <div className="flex items-center gap-2 overflow-hidden">
                    <span className="font-mono text-zinc-100 shrink-0">@{row.username}</span>
                    {row.senderUsername && (
                      <span className="text-[10px] text-zinc-500 shrink-0">
                        {row.status === "PROCESSING" ? "via" : "â†’"} @{row.senderUsername}
                      </span>
                    )}
                    {reason && row.status === "QUEUED" && (
                      <span className="text-[10px] text-zinc-500 truncate">({reason})</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {row.status === "PROCESSING" ? (
                      <span className="text-[11px] font-semibold text-blue-400 animate-pulse">SENDING...</span>
                    ) : (
                      <>
                        <span className="font-mono tabular-nums text-orange-300">
                          {row.jobStatus === "PAUSED" ? "paused" : `in ${formatCountdown(row.etaAt, nowMs)}`}
                        </span>
                        {row.etaAt && <span className="text-[10px] text-zinc-500">{formatClock(row.etaAt)}</span>}
                        <span className="text-[11px] font-semibold text-zinc-500">QUEUED</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
