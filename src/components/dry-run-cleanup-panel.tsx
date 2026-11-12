"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api/client";

interface DryRunCounts {
  dryLeads: number;
  dryScrapeJobs: number;
  drySightings: number;
}

interface CleanupApiResponse {
  success: boolean;
  counts?: DryRunCounts;
  result?: {
    deletedLeads: number;
    deletedScrapeJobs: number;
    deletedSightings: number;
  };
  backupReminder?: string;
  message?: string;
  error?: string;
}

export function DryRunCleanupPanel() {
  const [counts, setCounts] = useState<DryRunCounts | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchCounts = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetch<CleanupApiResponse>("/api/admin/dry-run/cleanup");
      if (res.counts) {
        setCounts(res.counts);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch dry-run counts");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    apiFetch<CleanupApiResponse>("/api/admin/dry-run/cleanup")
      .then((res) => {
        if (active && res.counts) {
          setCounts(res.counts);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to fetch dry-run counts");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const handleCleanup = async () => {
    if (!confirmed) {
      setError("Please check the confirmation box to proceed.");
      return;
    }

    setIsDeleting(true);
    setError(null);
    setMessage(null);

    try {
      const res = await apiFetch<CleanupApiResponse>("/api/admin/dry-run/cleanup", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });

      if (res.success && res.result) {
        setMessage(
          `Cleanup successful! Deleted ${res.result.deletedLeads} leads, ${res.result.deletedScrapeJobs} scrape jobs, and ${res.result.deletedSightings} sightings.`
        );
        setConfirmed(false);
        await fetchCounts();
      } else {
        setError(res.error || "Failed to delete dry-run data");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cleanup failed");
    } finally {
      setIsDeleting(false);
    }
  };

  const totalDryRows = counts ? counts.dryLeads + counts.dryScrapeJobs + counts.drySightings : 0;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800/80 pb-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <span>Dry-Run & Mock Data Cleanup</span>
            <span className="rounded bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-400 border border-amber-500/20">
              Admin Tool
            </span>
          </h2>
          <p className="mt-1 text-xs text-zinc-400">
            Permanently remove test leads, dry-run scrape jobs, and mock candidates. Real leads (isDryRun = false) are never touched.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchCounts}
          disabled={isLoading || isDeleting}
          className="self-start sm:self-auto rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition disabled:opacity-50"
        >
          {isLoading ? "Refreshing..." : "Refresh Counts"}
        </button>
      </div>

      {/* Backup Reminder Banner */}
      <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200">
        <div className="flex items-center gap-2 font-semibold text-amber-100">
          <svg className="h-4 w-4 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>REMINDER: Make sure you have a database backup (e.g. pg_dump) before proceeding.</span>
        </div>
        <p className="mt-1 text-[11px] text-amber-300/80">
          Cleanup permanently removes isolated test data. It cannot be recovered once executed.
        </p>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300 font-medium">
          {error}
        </div>
      )}

      {message && (
        <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300 font-medium">
          {message}
        </div>
      )}

      {/* Counts Display */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">Dry-Run Leads</div>
          <div className="mt-1 text-2xl font-bold text-zinc-100">
            {counts !== null ? counts.dryLeads : "—"}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">sample_*, .example, 555 phones</div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">Dry Scrape Jobs</div>
          <div className="mt-1 text-2xl font-bold text-zinc-100">
            {counts !== null ? counts.dryScrapeJobs : "—"}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">mock / dry_run provider jobs</div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">Cached Sightings</div>
          <div className="mt-1 text-2xl font-bold text-zinc-100">
            {counts !== null ? counts.drySightings : "—"}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">sightings tied to dry-run leads</div>
        </div>
      </div>

      {/* Action footer */}
      <div className="mt-6 border-t border-zinc-800/80 pt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        {totalDryRows > 0 ? (
          <>
            <label className="flex items-center gap-2.5 text-xs text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                id="confirm-dry-run-cleanup"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-rose-500 focus:ring-rose-500"
              />
              <span>
                I confirm I want to permanently delete {totalDryRows} dry-run record{totalDryRows === 1 ? "" : "s"}
              </span>
            </label>

            <button
              type="button"
              id="btn-execute-dry-run-cleanup"
              disabled={!confirmed || isDeleting}
              onClick={handleCleanup}
              className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white shadow hover:bg-rose-500 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isDeleting ? "Deleting..." : "Delete All Dry-Run Data"}
            </button>
          </>
        ) : (
          <div className="text-xs text-zinc-400">
            No dry-run records detected. The database is clean.
          </div>
        )}
      </div>
    </div>
  );
}

