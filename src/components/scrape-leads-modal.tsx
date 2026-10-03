"use client";

import { useState } from "react";
import {
  scrapeProfiles,
  discoverLeads,
  type ScrapeProfilesResponse,
  type DiscoverLeadsResponse,
  type DiscoveryProgress,
  type DiscoverySkipCounts,
  DEFAULT_MAX_LEADS,
  MIN_MAX_LEADS,
  MAX_MAX_LEADS,
  MAX_PROFILE_BATCH,
} from "@/lib/api/scraper";
import { ApiClientError } from "@/lib/api/client";

type ScrapeMode = "discover" | "profiles";

function formatSkipCounts(skipCounts?: DiscoverySkipCounts): string | null {
  if (!skipCounts) return null;
  const parts = Object.entries(skipCounts)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([reason, count]) => `${reason}=${count}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

type ScrapeLeadsModalProps = {
  isOpen: boolean;
  campaignId: string;
  onClose: () => void;
  onScrapeCompleted: () => void;
  campaignIntent?: string | null;
  campaignLocation?: string | null;
  campaignCategory?: string | null;
  campaignLeadLimit?: number | null;
  currentLeadCount?: number;
};

function parseLimitInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed < MIN_MAX_LEADS || parsed > MAX_MAX_LEADS) {
    return null;
  }
  return parsed;
}

export function ScrapeLeadsModal({
  isOpen,
  campaignId,
  onClose,
  onScrapeCompleted,
  campaignIntent = null,
  campaignLocation = null,
  campaignCategory = null,
  campaignLeadLimit = null,
  currentLeadCount = 0,
}: ScrapeLeadsModalProps) {
  const [mode, setMode] = useState<ScrapeMode>("discover");

  // Discover mode
  const [intent, setIntent] = useState(campaignIntent ?? "");
  const [location, setLocation] = useState(campaignLocation ?? "");
  const [category, setCategory] = useState(campaignCategory ?? "");
  const [discoverLimitInput, setDiscoverLimitInput] = useState(
    String(campaignLeadLimit ?? DEFAULT_MAX_LEADS),
  );
  const [progress, setProgress] = useState<DiscoveryProgress | null>(null);
  const [discoverResult, setDiscoverResult] =
    useState<DiscoverLeadsResponse | null>(null);

  // Capacity calculations
  const currentLeads = currentLeadCount;
  const parsedInputLimit = parseLimitInput(discoverLimitInput);
  const configuredLimit = campaignLeadLimit ?? (parsedInputLimit ?? DEFAULT_MAX_LEADS);
  const effectiveLimit = configuredLimit;
  const remainingCapacity = Math.max(0, effectiveLimit - currentLeads);
  const isLimitReached =
    campaignLeadLimit !== null &&
    campaignLeadLimit !== undefined &&
    currentLeads >= campaignLeadLimit;

  // Specific profiles mode
  const [inputText, setInputText] = useState("");
  const [maxLeadsInput, setMaxLeadsInput] = useState(String(DEFAULT_MAX_LEADS));
  const [successResult, setSuccessResult] =
    useState<ScrapeProfilesResponse | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const normalizeProfiles = (raw: string): string[] => {
    return raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };

  const resetResults = () => {
    setError(null);
    setProgress(null);
    setDiscoverResult(null);
    setSuccessResult(null);
  };

  const handleDiscover = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isLimitReached) {
      setError(
        `Campaign has already reached its configured lead limit (${campaignLeadLimit}). Increase the lead limit to discover more leads.`,
      );
      return;
    }

    const trimmedIntent = intent.trim();
    const trimmedLocation = location.trim();
    const trimmedCategory = category.trim();
    const parsedLimit = parseLimitInput(discoverLimitInput);

    if (!trimmedIntent) {
      setError("Intent / Search Query is required (e.g. \"fitness gyms and fitness businesses\").");
      return;
    }
    if (!trimmedLocation) {
      setError("Location is required (e.g. \"Rawalpindi\").");
      return;
    }
    if (!trimmedCategory) {
      setError("Category is required (e.g. \"Fitness\").");
      return;
    }
    if (parsedLimit === null || parsedLimit < MIN_MAX_LEADS || parsedLimit > MAX_MAX_LEADS) {
      setError(
        `Lead Limit must be an integer between ${MIN_MAX_LEADS} and ${MAX_MAX_LEADS}.`,
      );
      return;
    }

    resetResults();
    setIsSubmitting(true);

    try {
      const result = await discoverLeads(
        campaignId,
        {
          query: trimmedIntent,
          location: trimmedLocation,
          category: trimmedCategory,
          maxLeads: parsedLimit,
        },
        (event) => setProgress(event),
      );
      setDiscoverResult(result);
      onScrapeCompleted();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(`[${err.code}] ${err.message}`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Discovery failed. Please check server logs or Apify credentials.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleScrapeProfiles = async (e: React.FormEvent) => {
    e.preventDefault();
    const profiles = normalizeProfiles(inputText);
    const parsedMaxLeads = parseLimitInput(maxLeadsInput);

    if (parsedMaxLeads === null) {
      setError(
        `Maximum Leads must be a whole number between ${MIN_MAX_LEADS} and ${MAX_MAX_LEADS}.`,
      );
      return;
    }

    if (profiles.length === 0) {
      setError("Please enter at least one Instagram username or profile URL.");
      return;
    }

    if (profiles.length > MAX_PROFILE_BATCH) {
      setError(`Maximum ${MAX_PROFILE_BATCH} profiles allowed per scrape batch.`);
      return;
    }

    resetResults();
    setIsSubmitting(true);

    try {
      const response = await scrapeProfiles(campaignId, profiles, parsedMaxLeads);
      setSuccessResult(response);
      setInputText("");
      onScrapeCompleted();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(`[${err.code}] ${err.message}`);
      } else {
        setError("Scraper execution failed. Please check server logs or Apify credentials.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (isSubmitting) return;
    resetResults();
    setMode("discover");
    onClose();
  };

  const switchMode = (next: ScrapeMode) => {
    if (isSubmitting) return;
    resetResults();
    setMode(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-xs transition-opacity"
        onClick={handleClose}
      />

      <div className="relative max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl shadow-black/80">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">Find Instagram Leads</h2>
              <p className="text-xs text-zinc-400">
                Discover by campaign intent or import specific profiles
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Mode tabs */}
        <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl border border-zinc-800 bg-zinc-950 p-1">
          <button
            type="button"
            id="discover-tab-btn"
            onClick={() => switchMode("discover")}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
              mode === "discover"
                ? "bg-indigo-600 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Discover Leads
          </button>
          <button
            type="button"
            id="profiles-tab-btn"
            onClick={() => switchMode("profiles")}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
              mode === "profiles"
                ? "bg-indigo-600 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Specific Profiles
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400">
            <div className="font-semibold">Scrape Error</div>
            <div className="mt-0.5 text-xs text-rose-300/90">{error}</div>
          </div>
        )}

        {/* Discover progress */}
        {mode === "discover" && isSubmitting && (
          <div id="discovery-progress-banner" className="mt-4 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 text-sm text-indigo-200">
            <div className="flex items-center gap-2.5 font-semibold text-indigo-300">
              <svg className="h-4 w-4 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>{progress?.message ?? "Discovering Instagram profiles..."}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs border-t border-indigo-500/20 pt-2.5 font-mono text-indigo-200/90">
              <div>
                <span className="text-zinc-400">Candidates found:</span>{" "}
                <strong className="text-white">{progress?.candidatesDiscovered ?? 0}</strong>
              </div>
              <div>
                <span className="text-zinc-400">Profiles enriched:</span>{" "}
                <strong className="text-white">{progress?.candidatesEnriched ?? 0}</strong>
              </div>
              <div>
                <span className="text-zinc-400">Leads added:</span>{" "}
                <strong className="text-emerald-400 font-bold">{progress?.persisted ?? 0}</strong>
              </div>
              <div>
                <span className="text-zinc-400">Skipped:</span>{" "}
                <strong className="text-zinc-300">
                  {progress?.skipped ?? (
                    progress?.candidatesDiscovered !== undefined && progress?.persisted !== undefined
                      ? Math.max(0, progress.candidatesDiscovered - progress.persisted)
                      : 0
                  )}
                </strong>
              </div>
              <div className="sm:col-span-2">
                <span className="text-zinc-400">Remaining capacity:</span>{" "}
                <strong className="text-indigo-300 font-semibold">
                  {progress?.remainingCapacity ?? remainingCapacity}
                </strong>
              </div>
            </div>
            {formatSkipCounts(progress?.skipCounts) && (
              <p className="mt-2 border-t border-indigo-500/20 pt-2 font-mono text-[11px] text-indigo-200/70">
                Skipped: {formatSkipCounts(progress?.skipCounts)}
              </p>
            )}
          </div>
        )}

        {/* Discover result */}
        {mode === "discover" && discoverResult && (
          <div id="discovery-result-banner" className={`mt-4 rounded-xl border p-4 text-sm ${
            discoverResult.meta.persisted > 0
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-amber-500/30 bg-amber-500/10 text-amber-300"
          }`}>
            <div className="flex items-center gap-2 font-semibold">
              {discoverResult.meta.persisted > 0 ? (
                <>
                  <svg className="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>Discovery Finished: {discoverResult.meta.persisted} Leads Added!</span>
                </>
              ) : (
                <>
                  <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span>Discovery Finished (0 Leads Added)</span>
                </>
              )}
            </div>
            {discoverResult.meta.notice && (
              <p className="mt-1 text-xs text-amber-200/90">{discoverResult.meta.notice}</p>
            )}
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs border-t border-zinc-800/80 pt-2.5 font-mono">
              <div className="bg-zinc-950/50 p-2 rounded-lg border border-zinc-800/60">
                <div className="text-zinc-500 text-[10px] uppercase">Requested limit</div>
                <div className="text-sm font-bold text-zinc-100">{discoverResult.meta.requestedLimit}</div>
              </div>
              <div className="bg-zinc-950/50 p-2 rounded-lg border border-zinc-800/60">
                <div className="text-zinc-500 text-[10px] uppercase">Existing leads</div>
                <div className="text-sm font-bold text-zinc-100">{discoverResult.meta.existingLeads ?? currentLeads}</div>
              </div>
              <div className="bg-zinc-950/50 p-2 rounded-lg border border-zinc-800/60">
                <div className="text-zinc-500 text-[10px] uppercase">Candidates found</div>
                <div className="text-sm font-bold text-zinc-100">{discoverResult.meta.candidatesDiscovered}</div>
              </div>
              <div className="bg-zinc-950/50 p-2 rounded-lg border border-zinc-800/60">
                <div className="text-zinc-500 text-[10px] uppercase">Profiles enriched</div>
                <div className="text-sm font-bold text-zinc-100">{discoverResult.meta.candidatesEnriched}</div>
              </div>
              <div className="bg-zinc-950/50 p-2 rounded-lg border border-zinc-800/60">
                <div className="text-zinc-500 text-[10px] uppercase">New leads saved</div>
                <div className="text-sm font-bold text-emerald-400">{discoverResult.meta.persisted}</div>
              </div>
              <div className="bg-zinc-950/50 p-2 rounded-lg border border-zinc-800/60">
                <div className="text-zinc-500 text-[10px] uppercase">Remaining capacity</div>
                <div className="text-sm font-bold text-indigo-300">
                  {discoverResult.meta.remainingCapacity ??
                    Math.max(
                      0,
                      (discoverResult.meta.requestedLimit ?? configuredLimit) -
                        ((discoverResult.meta.existingLeads ?? currentLeads) +
                          discoverResult.meta.persisted),
                    )}
                </div>
              </div>
            </div>
            {formatSkipCounts(discoverResult.meta.skipCounts) && (
              <p className="mt-2 border-t border-zinc-800/80 pt-2 font-mono text-[11px] text-zinc-400">
                Skipped: {formatSkipCounts(discoverResult.meta.skipCounts)}
              </p>
            )}
          </div>
        )}

        {/* Specific profiles result */}
        {mode === "profiles" && successResult && successResult.meta.notice ? (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-sm text-amber-300">
            <div className="font-semibold">Scrape finished with no results</div>
            <div className="mt-1 text-xs text-amber-200/90">{successResult.meta.notice}</div>
            <div className="mt-1.5 text-xs text-amber-200/70">
              Provider: {successResult.meta.provider.toUpperCase()} &bull; Job status:{" "}
              {successResult.meta.status} &bull; Persisted: {successResult.meta.processedCount}
            </div>
          </div>
        ) : mode === "profiles" && successResult ? (
          <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-sm text-emerald-300">
            <div className="flex items-center gap-2 font-semibold">
              <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span>Scrape Job Finished Successfully!</span>
            </div>
            <div className="mt-1.5 space-y-0.5 text-xs text-emerald-200/80">
              <p>
                Persisted {successResult.meta.processedCount} of{" "}
                {successResult.meta.inputCount} requested profiles.
              </p>
              <p>
                Provider: {successResult.meta.provider.toUpperCase()} &bull; Status:{" "}
                {successResult.meta.status}
              </p>
            </div>
          </div>
        ) : null}

        {/* Discover form */}
        {mode === "discover" && (
          <form onSubmit={handleDiscover} className="mt-5 space-y-4">
            {/* Lead Limit Context Banner */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-xs space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-zinc-400">
                <div>
                  Configured limit:{" "}
                  <strong className="text-zinc-200">{campaignLeadLimit ?? "Not set"}</strong>
                </div>
                <div>
                  Current leads:{" "}
                  <strong className="text-zinc-200">{currentLeads}</strong>
                </div>
                <div>
                  Remaining capacity:{" "}
                  <strong className={remainingCapacity > 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>
                    {remainingCapacity}
                  </strong>
                </div>
              </div>
              {isLimitReached && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 font-medium">
                  Campaign has reached its configured lead limit of {campaignLeadLimit}. Discovery cannot add more leads until the limit is increased.
                </div>
              )}
            </div>

            <div>
              <label htmlFor="discover-intent" className="block text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Intent / Search Query <span className="text-rose-400">*</span>
              </label>
              <textarea
                id="discover-intent"
                rows={3}
                required
                disabled={isSubmitting || isLimitReached}
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="e.g. fitness gyms and fitness businesses"
                className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              />
              <p className="mt-1.5 text-xs text-zinc-500">
                Describe the target audience / business niche you want to discover.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="discover-location" className="block text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Location <span className="text-rose-400">*</span>
                </label>
                <input
                  id="discover-location"
                  type="text"
                  required
                  disabled={isSubmitting || isLimitReached}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Rawalpindi"
                  className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                />
              </div>

              <div>
                <label htmlFor="discover-category" className="block text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Category <span className="text-rose-400">*</span>
                </label>
                <input
                  id="discover-category"
                  type="text"
                  required
                  disabled={isSubmitting || isLimitReached}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. Fitness"
                  className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                />
              </div>

              <div>
                <label htmlFor="discover-limit" className="block text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Lead Limit (1–100) <span className="text-rose-400">*</span>
                </label>
                <input
                  id="discover-limit"
                  type="number"
                  min={MIN_MAX_LEADS}
                  max={MAX_MAX_LEADS}
                  step={1}
                  required
                  disabled={isSubmitting || isLimitReached}
                  value={discoverLimitInput}
                  onChange={(e) => setDiscoverLimitInput(e.target.value)}
                  className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  Allowed range: 1–100 leads
                </p>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleClose}
                className="rounded-lg border border-zinc-700 bg-zinc-800/80 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-white disabled:opacity-50"
              >
                {discoverResult ? "Done" : "Cancel"}
              </button>
              <button
                type="submit"
                id="start-discovery-btn"
                disabled={isSubmitting || isLimitReached}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-rose-600 to-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:from-rose-500 hover:to-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <svg className="h-4 w-4 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>Discovering...</span>
                  </>
                ) : isLimitReached ? (
                  <span>Limit Reached</span>
                ) : (
                  <span>Start Discovery</span>
                )}
              </button>
            </div>
          </form>
        )}

        {/* Specific profiles form */}
        {mode === "profiles" && (
          <form onSubmit={handleScrapeProfiles} className="mt-5 space-y-4">
            <div>
              <label htmlFor="scrape-profiles" className="block text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Profiles or Usernames <span className="text-zinc-500">(1 per line or comma-separated)</span>
              </label>
              <textarea
                id="scrape-profiles"
                rows={4}
                required
                disabled={isSubmitting}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="e.g.&#10;cristiano&#10;https://www.instagram.com/therock/&#10;natgeo"
                className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              />
              <p className="mt-1.5 text-xs text-zinc-500">
                Up to {MAX_PROFILE_BATCH} profiles per request. Usernames or direct Instagram profile links are supported.
              </p>
            </div>

            <div>
              <label htmlFor="scrape-max-leads" className="block text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Maximum Leads
              </label>
              <input
                id="scrape-max-leads"
                type="number"
                min={MIN_MAX_LEADS}
                max={MAX_MAX_LEADS}
                step={1}
                required
                disabled={isSubmitting}
                value={maxLeadsInput}
                onChange={(e) => setMaxLeadsInput(e.target.value)}
                className="mt-1.5 block w-32 rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              />
              <p className="mt-1.5 text-xs text-zinc-500">
                Maximum number of profiles to import into this campaign.
              </p>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleClose}
                className="rounded-lg border border-zinc-700 bg-zinc-800/80 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-white disabled:opacity-50"
              >
                {successResult ? "Done" : "Cancel"}
              </button>
              <button
                type="submit"
                id="start-scrape-btn"
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-rose-600 to-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:from-rose-500 hover:to-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <svg className="h-4 w-4 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>Scraping via Apify...</span>
                  </>
                ) : (
                  <span>Start Scraping</span>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
