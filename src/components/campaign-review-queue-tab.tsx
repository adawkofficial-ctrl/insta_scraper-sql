"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  approveDraft,
  bulkApproveDrafts,
  editDraft,
  getQualityStats,
  listReviewQueue,
  regenerateDraft,
  recheckDraft,
  rejectDraft,
  revokeDraftApproval,
  sendApprovedDrafts,
  sendReplyDraft,
  type QualityCheckView,
  type QualityStatsResponse,
  type ReviewQueueItem,
} from "@/lib/api/drafts";
import { listSenderAccounts, type InstagramSenderAccount } from "@/lib/api/senders";
import { startBulkJob } from "@/lib/api/messaging";
import { ApiClientError } from "@/lib/api/client";
import { ConfirmModal } from "@/components/confirm-modal";

const STATUS_FILTERS = ["PENDING_REVIEW", "BLOCKED", "APPROVED", "REJECTED"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number] | "ALL";

const REJECT_REASONS = [
  "TOO_GENERIC",
  "WRONG_FACT",
  "TOO_SALESY",
  "BAD_TONE",
  "NOT_TARGET",
  "TOO_LONG",
  "OTHER",
] as const;

function checkChips(checks: QualityCheckView[] | undefined, tone: "red" | "amber") {
  if (!checks || checks.length === 0) return null;
  const cls =
    tone === "red"
      ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
      : "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return (
    <div className="flex flex-wrap gap-1.5">
      {checks.map((check) => (
        <span
          key={check.id}
          title={check.detail}
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
        >
          {check.id}
        </span>
      ))}
    </div>
  );
}

export function CampaignReviewQueueTab({
  campaignId,
  onJobStarted,
}: {
  campaignId: string;
  onJobStarted?: (jobId: string) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("PENDING_REVIEW");
  const [kindFilter, setKindFilter] = useState<"ALL" | "OUTREACH" | "REPLY">("ALL");
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeIndex, setActiveIndex] = useState(0);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [rejecting, setRejecting] = useState<ReviewQueueItem | null>(null);
  const [rejectReason, setRejectReason] = useState<string>("TOO_GENERIC");
  const [rejectNotes, setRejectNotes] = useState("");
  const [rejectRegenerate, setRejectRegenerate] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState<ReviewQueueItem | null>(null);

  const [stats, setStats] = useState<QualityStatsResponse | null>(null);
  const [senders, setSenders] = useState<InstagramSenderAccount[]>([]);
  const [senderId, setSenderId] = useState("");
  const [sendLimit, setSendLimit] = useState(100);
  const [sendSummary, setSendSummary] = useState<{ eligible: number; skipped: number } | null>(null);

  const listRef = useRef<HTMLUListElement | null>(null);

  const loadQueue = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listReviewQueue(campaignId, {
        status: statusFilter === "ALL" ? undefined : statusFilter,
        kind: kindFilter === "ALL" ? undefined : kindFilter,
        sort: "score",
        pageSize: 50,
      });
      setItems(result.items);
      setTotal(result.pagination.total);
      setSelectedIds(new Set());
      setActiveIndex(0);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load the review queue.");
    } finally {
      setIsLoading(false);
    }
  }, [campaignId, statusFilter, kindFilter]);

  const loadStats = useCallback(async () => {
    try {
      setStats(await getQualityStats(campaignId));
    } catch {
      setStats(null);
    }
  }, [campaignId]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await listReviewQueue(campaignId, {
          status: statusFilter === "ALL" ? undefined : statusFilter,
          sort: "score",
          pageSize: 50,
        });
        if (cancelled) return;
        setItems(result.items);
        setTotal(result.pagination.total);
        setSelectedIds(new Set());
        setActiveIndex(0);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiClientError ? err.message : "Failed to load the review queue.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
      try {
        const statsResult = await getQualityStats(campaignId);
        if (!cancelled) setStats(statsResult);
      } catch {
        if (!cancelled) setStats(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [campaignId, statusFilter]);

  useEffect(() => {
    void listSenderAccounts()
      .then((accounts) => {
        setSenders(accounts);
        const connected = accounts.find((a) => a.status === "CONNECTED");
        if (connected) setSenderId(connected.id);
      })
      .catch(() => setSenders([]));
  }, []);

  const approvedCount = stats?.counts?.APPROVED ?? 0;

  const runAction = async (item: ReviewQueueItem, action: () => Promise<unknown>, okText: string) => {
    setBusyId(item.id);
    setBanner(null);
    try {
      await action();
      setBanner({ tone: "ok", text: okText });
      await Promise.all([loadQueue(), loadStats()]);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setBanner({ tone: "err", text: `${err.code}: ${err.message}` });
      } else {
        setBanner({ tone: "err", text: "Action failed." });
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleApprove = (item: ReviewQueueItem) => {
    const warnings = item.qualityResult?.warnings ?? [];
    if (warnings.length > 0) {
      setConfirmApprove(item);
      return;
    }
    void runAction(item, () => approveDraft(item.id), "Draft approved.");
  };

  const startEdit = (item: ReviewQueueItem) => {
    setEditingId(item.id);
    setEditBody(item.body);
  };

  const saveEdit = async (item: ReviewQueueItem) => {
    setBusyId(item.id);
    setBanner(null);
    try {
      await editDraft(item.id, editBody);
      setEditingId(null);
      setBanner({ tone: "ok", text: "Draft updated and re-checked." });
      await Promise.all([loadQueue(), loadStats()]);
    } catch (err) {
      setBanner({
        tone: "err",
        text: err instanceof ApiClientError ? `${err.code}: ${err.message}` : "Edit failed.",
      });
    } finally {
      setBusyId(null);
    }
  };

  const submitReject = async () => {
    if (!rejecting) return;
    const item = rejecting;
    setRejecting(null);
    await runAction(
      item,
      () =>
        rejectDraft(item.id, {
          reasonCode: rejectReason,
          notes: rejectNotes || undefined,
          regenerate: rejectRegenerate,
        }),
      "Draft rejected.",
    );
    setRejectNotes("");
    setRejectRegenerate(false);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cleanSelected = items.filter(
    (item) =>
      selectedIds.has(item.id) &&
      item.status === "PENDING_REVIEW" &&
      item.qualityPassed === true &&
      (item.qualityResult?.warnings?.length ?? 0) === 0,
  );

  const handleBulkApprove = async () => {
    if (cleanSelected.length === 0) return;
    setBanner(null);
    try {
      const result = await bulkApproveDrafts(
        campaignId,
        cleanSelected.map((item) => item.id),
      );
      setBanner({ tone: "ok", text: `Approved ${result.approvedCount} clean draft(s).` });
      await Promise.all([loadQueue(), loadStats()]);
    } catch (err) {
      setBanner({
        tone: "err",
        text: err instanceof ApiClientError ? `${err.code}: ${err.message}` : "Bulk approve failed.",
      });
    }
  };

  const handleSendApproved = async () => {
    setBanner(null);
    setSendSummary(null);
    try {
      const selected = Array.from(selectedIds).filter((id) => {
        const item = items.find((candidate) => candidate.id === id);
        return item?.status === "APPROVED";
      });
      const result = await sendApprovedDrafts(campaignId, {
        senderAccountId: senderId || undefined,
        limit: sendLimit,
        draftIds: selected.length > 0 ? selected : undefined,
      });
      setSendSummary({ eligible: result.summary.eligibleCount, skipped: result.summary.skippedCount });
      await startBulkJob(result.job.id);
      if (onJobStarted) onJobStarted(result.job.id);
      setBanner({ tone: "ok", text: `Sending ${result.summary.eligibleCount} approved draft(s).` });
      await Promise.all([loadQueue(), loadStats()]);
    } catch (err) {
      setBanner({
        tone: "err",
        text: err instanceof ApiClientError ? `${err.code}: ${err.message}` : "Send failed.",
      });
    }
  };

  // Keyboard flow: A approve, R reject, E edit, arrows to move.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (editingId || rejecting || confirmApprove) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (items.length === 0) return;
      if (event.key === "ArrowDown") {
        setActiveIndex((index) => Math.min(items.length - 1, index + 1));
      } else if (event.key === "ArrowUp") {
        setActiveIndex((index) => Math.max(0, index - 1));
      } else if (event.key.toLowerCase() === "a") {
        handleApprove(items[activeIndex]);
      } else if (event.key.toLowerCase() === "r") {
        setRejecting(items[activeIndex]);
      } else if (event.key.toLowerCase() === "e") {
        startEdit(items[activeIndex]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, activeIndex, editingId, rejecting, confirmApprove]);

  const cardTone = useMemo(
    () => (item: ReviewQueueItem) =>
      item.status === "BLOCKED" ? "border-rose-500/40" : "border-zinc-800",
    [],
  );

  return (
    <div className="space-y-4">
      {/* Stats card */}
      {stats && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {[
              { label: "Total", value: stats.total },
              { label: "Pending", value: stats.counts.PENDING_REVIEW ?? 0 },
              { label: "Blocked", value: stats.counts.BLOCKED ?? 0 },
              { label: "Approved", value: stats.counts.APPROVED ?? 0 },
              { label: "Rejected", value: stats.counts.REJECTED ?? 0 },
              { label: "Approval %", value: `${Math.round(stats.approvalRate * 100)}%` },
              { label: "Avg score", value: Math.round(stats.averageQualityScore) },
            ].map((metric) => (
              <div key={metric.label} className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5">
                <div className="text-[10px] font-semibold uppercase text-zinc-500">{metric.label}</div>
                <div className="mt-1 text-lg font-bold text-zinc-100">{metric.value}</div>
              </div>
            ))}
          </div>
          {stats.topFailedRules.length > 0 && (
            <div className="mt-3 text-[11px] text-zinc-400">
              Top failed rules:{" "}
              {stats.topFailedRules
                .slice(0, 5)
                .map((rule) => `${rule.ruleId} (${rule.count})`)
                .join(", ")}
            </div>
          )}
        </div>
      )}

      {/* Send approved panel */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase text-zinc-400">Approved drafts</div>
            <div className="text-2xl font-extrabold text-emerald-400">{approvedCount}</div>
          </div>
          <label className="text-xs text-zinc-400">
            Sender
            <select
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
              className="ml-2 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
            >
              <option value="">Auto (connected)</option>
              {senders.map((sender) => (
                <option key={sender.id} value={sender.id}>
                  @{sender.username} ({sender.status})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-zinc-400">
            Limit
            <input
              type="number"
              min={1}
              max={500}
              value={sendLimit}
              onChange={(e) => setSendLimit(Number(e.target.value) || 1)}
              className="ml-2 w-20 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
            />
          </label>
          <button
            type="button"
            id="send-approved-drafts-btn"
            disabled={approvedCount === 0}
            onClick={() => void handleSendApproved()}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-40"
          >
            Send approved
          </button>
          {sendSummary && (
            <span className="text-xs text-zinc-400">
              Eligible {sendSummary.eligible}, skipped {sendSummary.skipped}
            </span>
          )}
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          Only APPROVED drafts whose exact final text matches the approved hash can be sent. Every send re-checks DNC,
          duplicates and blockers at dispatch time.
        </p>
      </div>

        {/* Filter + bulk actions */}
      <div className="flex flex-wrap items-center gap-2">
        {(STATUS_FILTERS as readonly string[]).concat("ALL").map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setStatusFilter(status as StatusFilter)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
              statusFilter === status
                ? "border-rose-500/50 bg-rose-500/10 text-rose-300"
                : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {status}
          </button>
        ))}
        <div className="h-4 w-px bg-zinc-700 mx-1" />
        {(["ALL", "OUTREACH", "REPLY"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => setKindFilter(kind)}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              kindFilter === kind
                ? "border-sky-500/50 bg-sky-500/10 text-sky-300"
                : "border-zinc-800 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {kind === "ALL" ? "All Kinds" : kind === "OUTREACH" ? "Outreach" : "Replies"}
          </button>
        ))}
        <span className="ml-2 text-xs text-zinc-500">{total} draft(s)</span>
        <button
          type="button"
          onClick={() => void handleBulkApprove()}
          disabled={cleanSelected.length === 0}
          className="ml-auto rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 disabled:opacity-40"
        >
          Approve all clean ({cleanSelected.length})
        </button>
        <button
          type="button"
          onClick={() => void loadQueue()}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300"
        >
          Refresh
        </button>
      </div>

      {banner && (
        <div
          className={`rounded-lg border p-3 text-xs ${
            banner.tone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-rose-500/30 bg-rose-500/10 text-rose-300"
          }`}
        >
          {banner.text}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">{error}</div>
      )}

      {isLoading ? (
        <div className="py-10 text-center text-sm text-zinc-500">Loading review queue…</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-500">
          No drafts in this status.
        </div>
      ) : (
        <ul ref={listRef} className="space-y-3">
          {items.map((item, index) => {
            const warnings = item.qualityResult?.warnings ?? [];
            const blockers = item.qualityResult?.blockers ?? [];
            const isActive = index === activeIndex;
            const isEditing = editingId === item.id;
            return (
              <li
                key={item.id}
                onClick={() => setActiveIndex(index)}
                className={`rounded-xl border bg-zinc-900/60 p-4 ${cardTone(item)} ${
                  isActive ? "ring-1 ring-rose-500/40" : ""
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      onChange={() => toggleSelected(item.id)}
                      aria-label="Select draft"
                    />
                    <div>
                      <div className="text-sm font-semibold text-zinc-100">
                        @{item.lead.username}
                        {item.lead.fullName ? <span className="text-zinc-400"> · {item.lead.fullName}</span> : null}
                      </div>
                      <div className="text-[11px] text-zinc-500">
                        {item.lead.followersCount ?? 0} followers · lead score {item.lead.leadScore ?? "—"} · status{" "}
                        {item.lead.status}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.kind === "REPLY" ? (
                      <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-300">
                        REPLY
                      </span>
                    ) : (
                      <span className="rounded-full border border-zinc-700 bg-zinc-800/40 px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
                        OUTREACH
                      </span>
                    )}
                    <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] font-semibold text-zinc-300">
                      {item.status}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        (item.qualityScore ?? 0) >= 80
                          ? "bg-emerald-500/10 text-emerald-300"
                          : "bg-amber-500/10 text-amber-300"
                      }`}
                    >
                      score {item.qualityScore ?? "—"}
                    </span>
                    {item.regenerationCount > 0 && (
                      <span className="text-[10px] text-zinc-500">regen ×{item.regenerationCount}</span>
                    )}
                  </div>
                </div>

                <div className="mt-3">
                  {isEditing ? (
                    <div>
                      <textarea
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        rows={4}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-200"
                      />
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-[11px] text-zinc-500">
                          {editBody.trim().split(/\s+/).filter(Boolean).length} words · {editBody.length}/1000 chars
                        </span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => void saveEdit(item)}
                            className="rounded-lg bg-rose-600 px-3 py-1 text-xs font-semibold text-white"
                          >
                            Save & re-check
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5 text-sm text-zinc-200">
                      {item.body}
                    </p>
                  )}
                </div>

                {(blockers.length > 0 || warnings.length > 0) && (
                  <div className="mt-2 space-y-1.5">
                    {checkChips(blockers, "red")}
                    {checkChips(warnings, "amber")}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={item.status !== "PENDING_REVIEW" || busyId === item.id}
                    onClick={() => handleApprove(item)}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    Approve (A)
                  </button>
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => setRejecting(item)}
                    className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-300 disabled:opacity-40"
                  >
                    Reject (R)
                  </button>
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => startEdit(item)}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300"
                  >
                    Edit (E)
                  </button>
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => void runAction(item, () => regenerateDraft(item.id), "Regenerated.")}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300"
                  >
                    Regenerate
                  </button>
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => void runAction(item, () => recheckDraft(item.id), "Re-checked.")}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300"
                  >
                    Re-check
                  </button>
                  {item.status === "APPROVED" && (
                    <>
                      {item.kind === "REPLY" && (
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => void runAction(item, () => sendReplyDraft(item.id), "Reply message sent successfully.")}
                          className="rounded-lg bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white shadow-xs disabled:opacity-40"
                        >
                          Send Reply
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void runAction(item, () => revokeDraftApproval(item.id), "Approval revoked.")}
                        className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-300"
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Reject modal */}
      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <h3 className="text-sm font-semibold text-zinc-100">Reject draft</h3>
            <label className="mt-3 block text-xs text-zinc-400">
              Reason
              <select
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-200"
              >
                {REJECT_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-xs text-zinc-400">
              Notes
              <textarea
                value={rejectNotes}
                onChange={(e) => setRejectNotes(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-200"
              />
            </label>
            <label className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={rejectRegenerate}
                onChange={(e) => setRejectRegenerate(e.target.checked)}
              />
              Regenerate a new draft with this feedback
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejecting(null)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitReject()}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmApprove !== null}
        title="Approve with warnings"
        message={`This draft has ${confirmApprove?.qualityResult?.warnings?.length ?? 0} warning(s). Approving records an explicit override for each.`}
        confirmLabel="Override & approve"
        onCancel={() => setConfirmApprove(null)}
        onConfirm={() => {
          const item = confirmApprove;
          setConfirmApprove(null);
          if (!item) return;
          const warningIds = (item.qualityResult?.warnings ?? []).map((check) => check.id);
          void runAction(item, () => approveDraft(item.id, warningIds), "Draft approved with overrides.");
        }}
      />
    </div>
  );
}
