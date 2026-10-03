"use client";

import { useEffect, useState, useCallback } from "react";
import { ConfirmModal } from "./confirm-modal";

type DncItem = {
  id: string;
  channel: "INSTAGRAM" | "EMAIL" | "ALL";
  identifierType: "USERNAME" | "INSTAGRAM_ID" | "EMAIL" | "DOMAIN";
  identifierNormalized: string;
  reason: string | null;
  source: string;
  createdAt: string;
};

export function DoNotContactSettings() {
  const [items, setItems] = useState<DncItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Add form state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"single" | "bulk">("single");
  const [singleType, setSingleType] = useState<"USERNAME" | "EMAIL" | "DOMAIN" | "INSTAGRAM_ID">("USERNAME");
  const [singleValue, setSingleValue] = useState("");
  const [singleChannel, setSingleChannel] = useState<"ALL" | "INSTAGRAM" | "EMAIL">("ALL");
  const [singleReason, setSingleReason] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [bulkType, setBulkType] = useState<"USERNAME" | "EMAIL" | "DOMAIN">("USERNAME");
  const [bulkChannel, setBulkChannel] = useState<"ALL" | "INSTAGRAM" | "EMAIL">("ALL");
  const [bulkReason, setBulkReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Delete state
  const [entryToDelete, setEntryToDelete] = useState<DncItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshItems = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let ignore = false;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("page", page.toString());
        params.set("pageSize", "20");
        if (search.trim()) params.set("search", search.trim());
        if (channelFilter) params.set("channel", channelFilter);

        const res = await fetch(`/api/dnc?${params.toString()}`);
        if (!res.ok) {
          throw new Error("Failed to load Do Not Contact entries.");
        }
        const data = await res.json();
        if (!ignore) {
          setItems(data.items || []);
          setTotal(data.total || 0);
        }
      } catch (err) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Failed to load entries.");
        }
      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    }

    void load();
    return () => {
      ignore = true;
    };
  }, [page, search, channelFilter, refreshKey]);

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setSuccessMsg(null);

    try {
      let entries: Array<{
        identifierType: string;
        value: string;
        channel: string;
        reason?: string;
      }> = [];

      if (addMode === "single") {
        if (!singleValue.trim()) {
          throw new Error("Please enter an identifier value.");
        }
        entries.push({
          identifierType: singleType,
          value: singleValue.trim(),
          channel: singleChannel,
          reason: singleReason.trim() || undefined,
        });
      } else {
        const lines = bulkText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length === 0) {
          throw new Error("Please enter at least one entry (one per line).");
        }
        entries = lines.map((val) => ({
          identifierType: bulkType,
          value: val,
          channel: bulkChannel,
          reason: bulkReason.trim() || undefined,
        }));
      }

      const res = await fetch("/api/dnc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries, source: addMode === "bulk" ? "IMPORT" : "MANUAL" }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || "Failed to add entries.");
      }

      const data = await res.json();
      setSuccessMsg(
        `Added ${data.created} new entries (${data.alreadyExisted} already existed). Updated ${data.leadsUpdated} leads and cancelled ${data.pendingCancelled} pending items.`,
      );
      setSingleValue("");
      setSingleReason("");
      setBulkText("");
      setBulkReason("");
      setIsAddOpen(false);
      refreshItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add DNC entries.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!entryToDelete) return;
    setIsDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/dnc/${entryToDelete.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || "Failed to remove entry.");
      }
      const data = await res.json();
      setSuccessMsg(
        `Entry removed. Restored ${data.leadsRestored} lead(s) back to active status.`,
      );
      setEntryToDelete(null);
      refreshItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove entry.");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <svg className="h-5 w-5 text-rose-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
            Do Not Contact (DNC) Suppression List
          </h2>
          <p className="mt-1 text-xs text-zinc-400">
            Globally suppress outreach across all campaigns and channels for specified accounts, emails, or domains.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setIsAddOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-500"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Suppression
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      {successMsg && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300 flex items-center justify-between">
          <span>{successMsg}</span>
          <button type="button" onClick={() => setSuccessMsg(null)} className="text-zinc-400 hover:text-zinc-200">
            ✕
          </button>
        </div>
      )}

      {/* Search and Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-sm">
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search identifier or reason..."
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-1.5 pl-9 text-xs text-zinc-200 placeholder-zinc-500 focus:border-rose-500 focus:outline-none"
          />
          <svg
            className="absolute left-3 top-2 h-4 w-4 text-zinc-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={channelFilter}
            onChange={(e) => {
              setChannelFilter(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 focus:border-rose-500 focus:outline-none"
          >
            <option value="">All Channels</option>
            <option value="ALL">ALL (Cross-channel)</option>
            <option value="INSTAGRAM">INSTAGRAM</option>
            <option value="EMAIL">EMAIL</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="min-w-full divide-y divide-zinc-800 text-left text-xs text-zinc-300">
          <thead className="bg-zinc-950/80 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            <tr>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Identifier</th>
              <th className="px-4 py-3">Channel</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Added</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60 bg-zinc-900/40">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                  Loading suppression list...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                  No suppressed entries found.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="hover:bg-zinc-800/40 transition">
                  <td className="px-4 py-3 font-mono text-[11px]">
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-300 border border-zinc-700/60">
                      {item.identifierType}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-zinc-200">
                    {item.identifierType === "USERNAME" && "@"}
                    {item.identifierNormalized}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] font-semibold border ${
                        item.channel === "ALL"
                          ? "border-rose-500/30 bg-rose-500/10 text-rose-400"
                          : item.channel === "INSTAGRAM"
                          ? "border-purple-500/30 bg-purple-500/10 text-purple-400"
                          : "border-sky-500/30 bg-sky-500/10 text-sky-400"
                      }`}
                    >
                      {item.channel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-400 text-[11px]">{item.source}</td>
                  <td className="px-4 py-3 text-zinc-400 max-w-xs truncate">{item.reason || "—"}</td>
                  <td className="px-4 py-3 text-zinc-500 text-[11px]">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setEntryToDelete(item)}
                      className="text-rose-400 hover:text-rose-300 font-medium text-xs transition"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > 20 && (
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>Total: {total} entries</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="py-1">Page {page}</span>
            <button
              type="button"
              disabled={page * 20 >= total || isLoading}
              onClick={() => setPage((p) => p + 1)}
              className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Add Modal */}
      {isAddOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="text-base font-semibold text-zinc-100">Add to Do Not Contact</h3>
              <button
                type="button"
                onClick={() => setIsAddOpen(false)}
                className="text-zinc-400 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>

            <div className="flex rounded-lg border border-zinc-800 bg-zinc-950 p-1">
              <button
                type="button"
                onClick={() => setAddMode("single")}
                className={`flex-1 rounded py-1.5 text-xs font-semibold transition ${
                  addMode === "single" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Single Entry
              </button>
              <button
                type="button"
                onClick={() => setAddMode("bulk")}
                className={`flex-1 rounded py-1.5 text-xs font-semibold transition ${
                  addMode === "bulk" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Paste Multiple (Bulk)
              </button>
            </div>

            <form onSubmit={handleAddSubmit} className="space-y-4">
              {addMode === "single" ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                        Identifier Type
                      </label>
                      <select
                        value={singleType}
                        onChange={(e) => setSingleType(e.target.value as "USERNAME" | "EMAIL" | "DOMAIN" | "INSTAGRAM_ID")}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                      >
                        <option value="USERNAME">Username</option>
                        <option value="EMAIL">Email</option>
                        <option value="DOMAIN">Domain</option>
                        <option value="INSTAGRAM_ID">Instagram ID</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                        Channel
                      </label>
                      <select
                        value={singleChannel}
                        onChange={(e) => setSingleChannel(e.target.value as "ALL" | "INSTAGRAM" | "EMAIL")}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                      >
                        <option value="ALL">ALL (Cross-channel)</option>
                        <option value="INSTAGRAM">INSTAGRAM Only</option>
                        <option value="EMAIL">EMAIL Only</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                      Identifier Value
                    </label>
                    <input
                      type="text"
                      value={singleValue}
                      onChange={(e) => setSingleValue(e.target.value)}
                      placeholder={
                        singleType === "USERNAME"
                          ? "e.g. john_doe or @john_doe"
                          : singleType === "EMAIL"
                          ? "e.g. john@example.com"
                          : singleType === "DOMAIN"
                          ? "e.g. competitor.com"
                          : "e.g. 17841400000000"
                      }
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                      Reason (Optional)
                    </label>
                    <input
                      type="text"
                      value={singleReason}
                      onChange={(e) => setSingleReason(e.target.value)}
                      placeholder="e.g. Opt-out request or competitor domain"
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                        Type for all lines
                      </label>
                      <select
                        value={bulkType}
                        onChange={(e) => setBulkType(e.target.value as "USERNAME" | "EMAIL" | "DOMAIN")}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                      >
                        <option value="USERNAME">Usernames</option>
                        <option value="EMAIL">Emails</option>
                        <option value="DOMAIN">Domains</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                        Channel
                      </label>
                      <select
                        value={bulkChannel}
                        onChange={(e) => setBulkChannel(e.target.value as "ALL" | "INSTAGRAM" | "EMAIL")}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                      >
                        <option value="ALL">ALL (Cross-channel)</option>
                        <option value="INSTAGRAM">INSTAGRAM Only</option>
                        <option value="EMAIL">EMAIL Only</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                      Values (One per line, up to 1000)
                    </label>
                    <textarea
                      rows={6}
                      value={bulkText}
                      onChange={(e) => setBulkText(e.target.value)}
                      placeholder={`user1\n@user2\nuser3`}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2.5 font-mono text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                      Reason for all (Optional)
                    </label>
                    <input
                      type="text"
                      value={bulkReason}
                      onChange={(e) => setBulkReason(e.target.value)}
                      placeholder="e.g. Bulk opt-out import"
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                    />
                  </div>
                </>
              )}

              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsAddOpen(false)}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
                >
                  {isSubmitting ? "Adding..." : "Add to List"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      <ConfirmModal
        isOpen={Boolean(entryToDelete)}
        title="Remove from Do Not Contact"
        message={`Are you sure you want to remove ${entryToDelete?.identifierNormalized} from the suppression list? If no other suppression rules apply, matching leads will be restored to their prior outreach status.`}
        confirmLabel="Remove Entry"
        cancelLabel="Cancel"
        isDangerous={false}
        isLoading={isDeleting}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setEntryToDelete(null)}
      />
    </div>
  );
}
