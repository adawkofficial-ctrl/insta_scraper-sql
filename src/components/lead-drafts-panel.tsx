"use client";

import { useEffect, useState } from "react";

import { getLeadDrafts, type LeadDraftSummary } from "@/lib/api/drafts";

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-zinc-500/10 text-zinc-300 border-zinc-600",
  PENDING_REVIEW: "bg-amber-500/10 text-amber-300 border-amber-500/40",
  BLOCKED: "bg-rose-500/10 text-rose-300 border-rose-500/40",
  APPROVED: "bg-emerald-500/10 text-emerald-300 border-emerald-500/40",
  REJECTED: "bg-rose-500/10 text-rose-300 border-rose-500/40",
  SUPERSEDED: "bg-zinc-600/10 text-zinc-500 border-zinc-700",
  SENT: "bg-sky-500/10 text-sky-300 border-sky-500/40",
};

/** Step 6: latest draft + status for a lead (read-only, inside the lead drawer). */
export function LeadDraftsPanel({ leadId }: { leadId: string }) {
  const [drafts, setDrafts] = useState<LeadDraftSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const result = await getLeadDrafts(leadId).catch(() => [] as LeadDraftSummary[]);
      if (cancelled) return;
      setDrafts(result);
      setIsLoading(false);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  const latest = drafts[0];

  return (
    <div className="border-t border-zinc-800 pt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
          AI Draft ({drafts.length})
        </span>
        {isLoading && <span className="text-[10px] text-zinc-500 animate-pulse">Loading drafts…</span>}
      </div>

      {!latest ? (
        <p className="text-[11px] text-zinc-600 italic">No AI drafts for this lead yet.</p>
      ) : (
        <div className="space-y-2">
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/80 p-2.5 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  STATUS_TONE[latest.status] ?? STATUS_TONE.DRAFT
                }`}
              >
                {latest.status}
              </span>
              <span className="text-[10px] text-zinc-500">
                {new Date(latest.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-zinc-200 text-xs">{latest.body}</p>
            <div className="text-[10px] text-zinc-500">
              {latest.wordCount} words · {latest.promptVersion}
            </div>
          </div>

          {drafts.length > 1 && (
            <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
              {drafts.slice(1, 6).map((draft) => (
                <div
                  key={draft.id}
                  className="flex items-center justify-between rounded-md border border-zinc-800/60 bg-zinc-900/50 px-2 py-1 text-[10px]"
                >
                  <span className={STATUS_TONE[draft.status] ?? STATUS_TONE.DRAFT}>{draft.status}</span>
                  <span className="truncate text-zinc-500 ml-2">{draft.body.slice(0, 60)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
