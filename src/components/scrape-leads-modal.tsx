"use client";

import { useState, useEffect } from "react";
import {
  scrapeProfiles,
  discoverLeads,
  getScraperBudget,
  type ScraperBudgetInfo,
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
import { planInstagramQueries } from "@/lib/services/discovery/instagram-all-in-one-query";

type ScrapeMode = "discover" | "profiles";

const COUNTRY_CITIES: Record<string, string[]> = {
  canada: ["Toronto, ON", "Vancouver, BC", "Montreal, QC", "Calgary, AB", "Ottawa, ON"],
  "united states": ["New York, NY", "Los Angeles, CA", "Chicago, IL", "Houston, TX", "Miami, FL"],
  usa: ["New York, NY", "Los Angeles, CA", "Chicago, IL", "Houston, TX", "Miami, FL"],
  us: ["New York, NY", "Los Angeles, CA", "Chicago, IL", "Houston, TX", "Miami, FL"],
  "united kingdom": ["London, UK", "Manchester, UK", "Birmingham, UK", "Leeds, UK", "Glasgow, UK"],
  uk: ["London, UK", "Manchester, UK", "Birmingham, UK", "Leeds, UK", "Glasgow, UK"],
  australia: ["Sydney, Australia", "Melbourne, Australia", "Brisbane, Australia", "Perth, Australia"],
  germany: ["Berlin, Germany", "Munich, Germany", "Frankfurt, Germany", "Hamburg, Germany"],
  france: ["Paris, France", "Lyon, France", "Marseille, France", "Toulouse, France"],
  pakistan: ["Karachi, Pakistan", "Lahore, Pakistan", "Islamabad, Pakistan", "Rawalpindi, Pakistan"],
  uae: ["Dubai, UAE", "Abu Dhabi, UAE", "Sharjah, UAE"],
};

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

function parseLimitInput(value: string, maxCap: number = MAX_MAX_LEADS): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed < MIN_MAX_LEADS || parsed > maxCap) {
    return null;
  }
  return parsed;
}

function computeDiscoveryCostEstimate(
  intent: string,
  parsedLimit: number | null,
  budget: ScraperBudgetInfo | null,
) {
  const plannedKeywordsCount = 1;
  const plannedCitiesCount = Math.min(2, budget?.gmapsMaxCities ?? 1);
  const totalSearches = plannedKeywordsCount * plannedCitiesCount;
  const maxPlaces = budget?.gmapsMaxTotalPlaces ?? 15;
  const totalPlaces = Math.min(maxPlaces, totalSearches * 15);

  const mapsRunCost = budget?.costs?.mapsRun ?? 0.007;
  const placeScrapedUnit =
    budget?.mapsRollingCostPerPlaceUsd ?? budget?.costs?.placeScraped ?? 0.003;
  const placesCost = Number((totalPlaces * placeScrapedUnit).toFixed(4));

  const contactsUnit = budget?.costs?.contactsPerPlace ?? 0.002;
  const contactsCost = budget?.contactsEnrichmentEnabled ? Number((totalPlaces * contactsUnit).toFixed(4)) : 0;

  const estimatedCandidates = Math.min(totalPlaces, Math.max(1, Math.round(totalPlaces * 0.4)));
  const profileUnit = budget?.costs?.profileEnrichment ?? 0.0023;
  const profileCost = Number((estimatedCandidates * profileUnit).toFixed(4));

  const limit = Math.min(parsedLimit ?? 10, estimatedCandidates);
  const geminiUnit = budget?.costs?.gemini ?? 0.001;
  const geminiCost = Number((limit * geminiUnit).toFixed(4));

  const totalCost = Number((mapsRunCost + placesCost + contactsCost + profileCost + geminiCost).toFixed(3));
  const maxJobUsd = budget?.discoveryMaxJobUsd ?? Number.POSITIVE_INFINITY;
  const isOverCeiling = Number.isFinite(maxJobUsd) && totalCost > maxJobUsd;

  return {
    plannedKeywordsCount,
    plannedCitiesCount,
    totalSearches,
    totalPlaces,
    mapsRunCost,
    placesCost,
    contactsCost,
    estimatedCandidates,
    profileCost,
    geminiCost,
    totalCost,
    maxJobUsd,
    isOverCeiling,
  };
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
  const [budget, setBudget] = useState<ScraperBudgetInfo | null>(null);
  const [confirmRealRun, setConfirmRealRun] = useState(false);
  const [confirmCountryPlan, setConfirmCountryPlan] = useState(false);

  // Advanced criteria state
  const [showAdvancedCriteria, setShowAdvancedCriteria] = useState(false);
  const [minFollowers, setMinFollowers] = useState("100");
  const [maxFollowers, setMaxFollowers] = useState("500000");
  const [minPosts, setMinPosts] = useState("3");
  const [strictMode, setStrictMode] = useState(false);

  useEffect(() => {
    if (isOpen) {
      getScraperBudget()
        .then((b) => {
          setBudget(b);
          setConfirmRealRun(false);
          if (b.activeProviders?.discoveryProvider === "instagram_all_in_one") {
            setMinFollowers((prev) => (prev === "100" ? "300" : prev));
            setMaxFollowers((prev) => (prev === "500000" ? "20000" : prev));
            setMinPosts((prev) => (prev === "3" ? "20" : prev));
          }
        })
        .catch((err) => console.warn("Failed to load scraper budget:", err));
    }
  }, [isOpen]);

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
    const maxAllowedLimit = budget?.maxLeadsCap ?? MAX_MAX_LEADS;
    if (parsedLimit === null || parsedLimit < MIN_MAX_LEADS || parsedLimit > maxAllowedLimit) {
      setError(
        `Lead Limit must be an integer between ${MIN_MAX_LEADS} and ${maxAllowedLimit}${budget?.discoveryStage === "pilot_small" ? " (pilot cap: 10)" : ""}.`,
      );
      return;
    }

    // Pre-run cost estimate calculation
    const estimate = computeDiscoveryCostEstimate(trimmedIntent, parsedLimit, budget);
    let estimateTotal = estimate.totalCost;
    let estimateIsOverCeiling = estimate.isOverCeiling;
    if (budget?.activeProviders?.discoveryProvider === "instagram_all_in_one") {
      const plan = planInstagramQueries({
        query: trimmedIntent,
        category,
        location: trimmedLocation,
        maxQueries: budget?.igMaxQueriesPerJob ?? 6,
        searchLimit: budget?.igSearchLimit ?? 10,
      });
      const unit = budget?.igScraperCostPerResultUsd ?? 0.0027;
      const searchLimit = budget?.igSearchLimit ?? 10;
      const detailsCount = Math.min(parsedLimit, plan.queries.length * searchLimit);
      estimateTotal = Number(
        (plan.queries.length * searchLimit * unit + detailsCount * unit).toFixed(4),
      );
      estimateIsOverCeiling = estimateTotal > estimate.maxJobUsd;
    }
    if (estimateIsOverCeiling) {
      setError(
        `Estimated cost ($${estimateTotal.toFixed(2)}) exceeds DISCOVERY_MAX_JOB_USD ceiling ($${estimate.maxJobUsd.toFixed(2)}). Discovery blocked to protect your budget.`,
      );
      return;
    }

    if (!budget?.isDryRun && budget?.remainingBudgetUsd !== null && budget?.remainingBudgetUsd !== undefined && budget.remainingBudgetUsd <= 0) {
      setError(
        `BUDGET_BLOCKED: Monthly Apify budget is exhausted ($0.00 left of $${budget.monthlyBudgetUsd?.toFixed(2) ?? "0.00"}, spend this month: $${budget.monthlySpendUsd?.toFixed(2) ?? "0.00"}). Real runs are blocked.`,
      );
      return;
    }

    const normalizedLoc = trimmedLocation.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const recommendedCities = COUNTRY_CITIES[normalizedLoc];
    const isCountryLoc = Boolean(recommendedCities && recommendedCities.length > 0);
    if (isCountryLoc && !confirmCountryPlan) {
      setError(`Location "${trimmedLocation}" is a whole country. Please review and confirm the multi-city search plan below before proceeding.`);
      return;
    }

    if (!budget?.isDryRun && !confirmRealRun) {
      setError("Please check 'I understand this is a real paid run' before proceeding.");
      return;
    }

    if (!budget?.isDryRun && estimate.totalCost > 0.25) {
      const budgetLeftStr = !budget ? "..." : budget.remainingBudgetUsd === null ? "unlimited" : `$${budget.remainingBudgetUsd.toFixed(2)}`;
      const proceed = window.confirm(
        `Estimated real spend (~$${estimate.totalCost.toFixed(2)}) exceeds $0.25.\n\nPlanned: ${estimate.totalSearches} search(es) x ${estimate.plannedCitiesCount} city, up to ${estimate.totalPlaces} places.\nBudget left this month: ${budgetLeftStr}\n\nDo you want to proceed with this real discovery run?`
      );
      if (!proceed) {
        return;
      }
    }

    resetResults();
    setIsSubmitting(true);

    const parsedMinFollowers = minFollowers.trim() ? Number.parseInt(minFollowers.trim(), 10) : null;
    const parsedMaxFollowers = maxFollowers.trim() ? Number.parseInt(maxFollowers.trim(), 10) : null;
    const parsedMinPosts = minPosts.trim() ? Number.parseInt(minPosts.trim(), 10) : null;

    const criteria = {
      minFollowers: Number.isFinite(parsedMinFollowers) ? parsedMinFollowers : 100,
      maxFollowers: Number.isFinite(parsedMaxFollowers) ? parsedMaxFollowers : 500000,
      minPosts: Number.isFinite(parsedMinPosts) ? parsedMinPosts : 3,
      strictMode,
      excludePrivate: true,
    };

    try {
      const result = await discoverLeads(
        campaignId,
        {
          query: trimmedIntent,
          location: trimmedLocation,
          category: trimmedCategory,
          maxLeads: parsedLimit,
          criteria,
        },
        (event) => setProgress(event),
      );
      setDiscoverResult(result);
      getScraperBudget().then(setBudget).catch(() => undefined);
      onScrapeCompleted();
    } catch (err) {
      if (
        (err instanceof ApiClientError && err.code === "EXPENSIVE_ZERO_LEADS_CONFIRMATION_REQUIRED") ||
        (err instanceof Error && err.message.includes("EXPENSIVE_ZERO_LEADS_CONFIRMATION_REQUIRED"))
      ) {
        const confirmed = window.confirm(
          "The previous discovery job for this campaign cost > $0.30 and produced 0 leads. Are you sure you want to retry another discovery job?",
        );
        if (confirmed) {
          setIsSubmitting(true);
          setError(null);
          try {
            const retryResult = await discoverLeads(
              campaignId,
              {
                query: trimmedIntent,
                location: trimmedLocation,
                category: trimmedCategory,
                maxLeads: parsedLimit,
                criteria,
                confirmHighCostRetry: true,
              },
              (event) => setProgress(event),
            );
            setDiscoverResult(retryResult);
            getScraperBudget().then(setBudget).catch(() => undefined);
            onScrapeCompleted();
            return;
          } catch (retryErr) {
            if (retryErr instanceof ApiClientError) {
              setError(`[${retryErr.code}] ${retryErr.message}`);
            } else if (retryErr instanceof Error) {
              setError(retryErr.message);
            } else {
              setError("Discovery failed. Please check server logs or Apify credentials.");
            }
          } finally {
            setIsSubmitting(false);
          }
          return;
        }
      }
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

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text === "string") {
        const lines = text
          .split(/[\r\n]+/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, MAX_PROFILE_BATCH);
        setInputText(lines.join("\n"));
      }
    };
    reader.readAsText(file);
    e.target.value = "";
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

    // Pre-run cost estimate confirmation for specific profile scrape
    const estCount = Math.min(20, profiles.length || 1);
    const estimatedCost = Number((0.005 + estCount * 0.0023).toFixed(3));
    if (estimatedCost > 0.25) {
      const proceed = window.confirm(
        `Estimated cost (~$${estimatedCost.toFixed(2)}) exceeds $0.25.\n\nDo you want to proceed with importing ${profiles.length} profiles?`
      );
      if (!proceed) return;
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
            {budget?.isDryRun && (
              <div className="mb-3 rounded-lg border border-red-500/50 bg-red-950/70 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-red-200 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                DRY RUN - fake data, no Apify cost
              </div>
            )}
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
            {(budget?.isDryRun || discoverResult.meta.isDryRun) && (
              <div className="mb-3 rounded-lg border border-red-500/50 bg-red-950/70 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-red-200 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-red-500" />
                DRY RUN - fake data, no Apify cost
              </div>
            )}
            <div className="flex items-center gap-2 font-semibold">
              {discoverResult.meta.persisted > 0 || (discoverResult.meta.usageSummary as { contactOnlyCount?: number })?.contactOnlyCount ? (
                <>
                  <svg className="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>
                    {(discoverResult.meta.usageSummary as { summaryHeadline?: string })?.summaryHeadline ||
                      (discoverResult.meta.notice?.startsWith("IG-ready:")
                        ? discoverResult.meta.notice
                        : `Discovery Finished: ${discoverResult.meta.persisted} Leads Added!`)}
                  </span>
                </>
              ) : (
                <>
                  <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span>
                    {(discoverResult.meta.usageSummary as { summaryHeadline?: string })?.summaryHeadline ||
                      "Discovery Finished (0 Leads Added)"}
                  </span>
                </>
              )}
            </div>
            {discoverResult.meta.notice && !discoverResult.meta.notice.startsWith("IG-ready:") && (
              <p className="mt-1 text-xs text-amber-200/90">{discoverResult.meta.notice}</p>
            )}
            {/* Skip Table */}
            {Array.isArray((discoverResult.meta.usageSummary as { skipTable?: Array<{ reason: string; count: number; examples: string[] }> })?.skipTable) &&
              ((discoverResult.meta.usageSummary as { skipTable: Array<{ reason: string; count: number; examples: string[] }> }).skipTable.length > 0) && (
                <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/60 p-2 text-xs font-mono">
                  <div className="text-[10px] uppercase font-bold text-zinc-400 mb-1">Skip / Rejection Summary</div>
                  <table className="w-full text-left text-[11px]">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-500">
                        <th className="py-1">Reason</th>
                        <th className="py-1 text-right">Count</th>
                        <th className="py-1 pl-3">Examples</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(discoverResult.meta.usageSummary as { skipTable: Array<{ reason: string; count: number; examples: string[] }> }).skipTable.map((row) => (
                        <tr key={row.reason} className="border-b border-zinc-900 text-zinc-300">
                          <td className="py-1 font-semibold text-amber-400">{row.reason}</td>
                          <td className="py-1 text-right">{row.count}</td>
                          <td className="py-1 pl-3 text-zinc-400 truncate max-w-[200px]" title={row.examples.join(", ")}>
                            {row.examples.join(", ") || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            <p className="mt-1 text-[11px] text-zinc-400 font-mono">
              Provider: {discoverResult.meta.discoveryActor} &bull; Enrichment:{" "}
              {discoverResult.meta.enrichmentActor} &bull; Cost per saved lead:{" "}
              {discoverResult.meta.persisted > 0
                ? `$${((discoverResult.meta.apifyCostUsd ?? 0) / discoverResult.meta.persisted).toFixed(4)}`
                : "n/a"}
            </p>
            {discoverResult.meta.usageSummary?.resultsConsumed && (
              <p className="mt-1 text-[11px] text-zinc-400 font-mono">
                Results consumed — search: {discoverResult.meta.usageSummary.resultsConsumed.search} &bull; details:{" "}
                {discoverResult.meta.usageSummary.resultsConsumed.details} &bull; stop:{" "}
                {discoverResult.meta.usageSummary.stopReason ?? "completed"}
              </p>
            )}
            {discoverResult.meta.usageSummary?.conversionFunnel && (
              <p className="mt-1 text-[11px] text-zinc-400 font-mono">
                Funnel — found: {discoverResult.meta.usageSummary.conversionFunnel.found} &bull; after rules:{" "}
                {discoverResult.meta.usageSummary.conversionFunnel.afterFreeRules} &bull; after pre-gate:{" "}
                {discoverResult.meta.usageSummary.conversionFunnel.afterGeminiPreGate} &bull; detailed:{" "}
                {discoverResult.meta.usageSummary.conversionFunnel.detailed} &bull; saved:{" "}
                {discoverResult.meta.usageSummary.conversionFunnel.saved}
              </p>
            )}
            {(discoverResult.meta.usageSummary?.perQueryStats?.length ?? 0) > 0 && (
              <div className="mt-2 border-t border-zinc-800/80 pt-2 font-mono text-[11px] text-zinc-400">
                <div className="text-[10px] uppercase text-zinc-500">Per-query performance</div>
                {discoverResult.meta.usageSummary!.perQueryStats!.map((stat) => (
                  <div key={stat.query}>
                    {stat.query}: {stat.accepted}/{stat.results} accepted &bull; wrong-location{" "}
                    {stat.rejectedWrongLocation} &bull; non-business {stat.rejectedNonBusiness} &bull; private{" "}
                    {stat.rejectedPrivate} &bull; duplicate {stat.rejectedDuplicate} &bull; $
                    {stat.costUsd.toFixed(4)} &bull; cost/accepted $
                    {(stat.costPerAcceptedLeadUsd ?? 0).toFixed(4)}
                  </div>
                ))}
              </div>
            )}
            {discoverResult.meta.usageSummary?.mapsCost && (
              <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-2.5 font-mono text-[11px] text-zinc-300 space-y-1">
                <div className="text-[10px] uppercase text-emerald-300/80">Maps cost &amp; yield</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
                  <span>Places: {discoverResult.meta.usageSummary.mapsCost.placesReturned ?? 0}</span>
                  <span>
                    Paid: {discoverResult.meta.usageSummary.mapsCost.paidPlaces ?? 0} &bull; duplicates:{" "}
                    {discoverResult.meta.usageSummary.mapsCost.duplicatePlaces ?? 0} &bull; new:{" "}
                    {discoverResult.meta.usageSummary.mapsCost.newPlaces ?? 0}
                  </span>
                  <span>
                    Cost/new place: $
                    {(discoverResult.meta.usageSummary.mapsCost.costPerNewPlaceUsd ?? 0).toFixed(4)}
                  </span>
                  <span>
                    Contact-only saved: {discoverResult.meta.usageSummary.mapsCost.contactOnlySaved ?? 0}
                  </span>
                  <span>
                    Cost/place: $
                    {(discoverResult.meta.usageSummary.mapsCost.costPerPlaceUsd ?? 0).toFixed(4)}
                  </span>
                  <span>
                    Cost/IG-ready:{" "}
                    {discoverResult.meta.usageSummary.mapsCost.costPerIgReadyLeadUsd === null
                      ? "n/a"
                      : `$${(discoverResult.meta.usageSummary.mapsCost.costPerIgReadyLeadUsd ?? 0).toFixed(4)}`}
                  </span>
                  <span>
                    Cost/contactable:{" "}
                    {discoverResult.meta.usageSummary.mapsCost.costPerContactableLeadUsd === null
                      ? "n/a"
                      : `$${(discoverResult.meta.usageSummary.mapsCost.costPerContactableLeadUsd ?? 0).toFixed(4)}`}
                  </span>
                  <span>
                    Wasted: ${(discoverResult.meta.usageSummary.mapsCost.wastedSpendUsd ?? 0).toFixed(4)}
                  </span>
                  <span>
                    Coverage skipped: {discoverResult.meta.usageSummary.mapsCost.coverageSkipped ?? 0}
                  </span>
                  <span>
                    Cached outcomes: {discoverResult.meta.usageSummary.mapsCost.outcomeCacheSkipped ?? 0}
                  </span>
                  <span>
                    Overlap: {((discoverResult.meta.usageSummary.mapsCost.placeOverlapRatio ?? 0) * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
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
              <div className="bg-zinc-950/50 p-2 rounded-lg border border-zinc-800/60">
                <div className="text-zinc-500 text-[10px] uppercase">Apify cost</div>
                <div className="text-sm font-bold text-emerald-400">
                  ${(discoverResult.meta.apifyCostUsd ?? 0).toFixed(2)}
                </div>
              </div>
              <div className="bg-zinc-950/50 p-2 rounded-lg border border-zinc-800/60">
                <div className="text-zinc-500 text-[10px] uppercase">Budget left this month</div>
                <div className="text-sm font-bold text-indigo-300">
                  {(() => {
                    const rem = discoverResult.meta.remainingBudgetUsd ?? budget?.remainingBudgetUsd;
                    if (rem === null || rem === undefined) return "Unlimited";
                    return `$${rem.toFixed(2)}`;
                  })()}
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
            {/* Dry Run Form Banner */}
            {budget?.isDryRun && (
              <div id="dry-run-form-banner" className="rounded-xl border border-red-500/50 bg-red-950/60 p-3.5 text-red-200 flex items-center gap-3">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-600 text-white font-black text-xs">
                  !
                </div>
                <div>
                  <div className="font-bold text-red-100 uppercase tracking-wide text-xs">
                    DRY RUN - fake data, no Apify cost
                  </div>
                  <div className="text-[11px] text-red-300/80">
                    Apify dry-run mode is enabled. Fake places are used; zero network calls or paid API charges.
                  </div>
                </div>
              </div>
            )}

            {/* Active providers (informational) */}
            {budget?.activeProviders && (
              <div id="active-provider-banner" className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-[11px] text-zinc-400 space-y-1">
                <div>
                  Discovery provider:{" "}
                  <strong className="text-zinc-200">{budget.activeProviders.discoveryProvider}</strong>{" "}
                  <span className="text-zinc-500">({budget.activeProviders.discoveryActor})</span>
                </div>
                <div>
                  Enrichment provider:{" "}
                  <strong className="text-zinc-200">{budget.activeProviders.enrichmentProvider}</strong>{" "}
                  <span className="text-zinc-500">({budget.activeProviders.enrichmentActor})</span>
                </div>
                <div className="text-zinc-500">
                  Disabled actors: {[
                    budget.activeProviders.mapsActorDisabled ? "Google Maps" : null,
                    budget.activeProviders.profileActorDisabled ? "instagram-profile-scraper" : null,
                  ].filter(Boolean).join(", ") || "none"}
                </div>
              </div>
            )}

            {/* Instagram all-in-one pre-run plan */}
            {(() => {
              if (budget?.activeProviders?.discoveryProvider !== "instagram_all_in_one") return null;
              const parsedLimit = parseLimitInput(discoverLimitInput, budget?.maxLeadsCap ?? MAX_MAX_LEADS);
              const searchLimit = budget?.igSearchLimit ?? 10;
              const plan = planInstagramQueries({
                query: intent,
                category,
                location,
                maxQueries: budget?.igMaxQueriesPerJob ?? 6,
                searchLimit,
              });
              const unit = budget?.igScraperCostPerResultUsd ?? 0.0027;
              const expectedDetails = Math.min(plan.queries.length * searchLimit, parsedLimit ?? 10);
              const searchCost = plan.queries.length * searchLimit * unit;
              const detailsCost = expectedDetails * unit;
              const geminiCost = expectedDetails * 0.00015;
              const totalCost = searchCost + detailsCost + geminiCost;
              const maxJobUsd = budget?.discoveryMaxJobUsd ?? Number.POSITIVE_INFINITY;

              if (plan.blocked) {
                return (
                  <div id="ig-query-plan" className="rounded-xl border border-amber-500/40 bg-amber-950/30 p-3.5 text-xs text-amber-200 space-y-1">
                    <div className="font-semibold">Choose specific cities for Instagram-only discovery</div>
                    <p className="text-amber-300/80">{plan.blockedReason}</p>
                    {plan.recommendedCities.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {plan.recommendedCities.slice(0, 6).map((city) => (
                          <button
                            key={city}
                            type="button"
                            onClick={() => setLocation(city)}
                            className="rounded-md border border-amber-600/50 bg-amber-900/40 px-2 py-1 text-[11px] font-semibold text-amber-100"
                          >
                            + {city}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div id="ig-query-plan" className="rounded-xl border border-indigo-500/40 bg-indigo-950/30 p-3.5 text-xs space-y-2">
                  <div className="font-semibold text-indigo-200">
                    Instagram search plan ({plan.queries.length}/{plan.maxQueries} queries, {searchLimit} results each)
                  </div>
                  <ul className="list-disc pl-4 text-[11px] text-zinc-300 space-y-0.5">
                    {plan.queries.map((query) => (
                      <li key={query}>{query}</li>
                    ))}
                  </ul>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-indigo-500/20 pt-2 font-mono text-[11px]">
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">Search</div>
                      <div className="text-zinc-200">${searchCost.toFixed(4)}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">Details (est.)</div>
                      <div className="text-zinc-200">${detailsCost.toFixed(4)}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">Gemini pre-gate</div>
                      <div className="text-zinc-200">${geminiCost.toFixed(4)}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">Est. total</div>
                      <div className={totalCost > maxJobUsd ? "text-amber-300" : "text-emerald-400"}>
                        {budget?.isDryRun ? "$0.00 (dry run)" : `$${totalCost.toFixed(3)}`}
                      </div>
                    </div>
                  </div>
                  {totalCost > maxJobUsd && (
                    <p className="text-[11px] text-amber-300">
                      Estimated total exceeds DISCOVERY_MAX_JOB_USD (${maxJobUsd.toFixed(2)}); the job will stop early.
                    </p>
                  )}
                </div>
              );
            })()}

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
                  onChange={(e) => {
                    setLocation(e.target.value);
                    setConfirmCountryPlan(false);
                  }}
                  placeholder="e.g. Rawalpindi or Toronto, Vancouver"
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
                  Lead Limit (1–{budget?.maxLeadsCap ?? MAX_MAX_LEADS}) <span className="text-rose-400">*</span>
                </label>
                <input
                  id="discover-limit"
                  type="number"
                  min={MIN_MAX_LEADS}
                  max={budget?.maxLeadsCap ?? MAX_MAX_LEADS}
                  step={1}
                  required
                  disabled={isSubmitting || isLimitReached}
                  value={discoverLimitInput}
                  onChange={(e) => setDiscoverLimitInput(e.target.value)}
                  className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  Allowed range: 1–{budget?.maxLeadsCap ?? MAX_MAX_LEADS} leads {budget?.discoveryStage === "pilot_small" && "(pilot cap: 10)"}
                </p>
              </div>
            </div>

            {/* Whole-Country Pre-Run Plan */}
            {(() => {
              const normalizedLoc = location.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
              const recommendedCities = COUNTRY_CITIES[normalizedLoc];
              if (!recommendedCities || recommendedCities.length === 0) return null;

              const parsedLimit = parseLimitInput(discoverLimitInput, budget?.maxLeadsCap ?? MAX_MAX_LEADS);
              const costEstimate = computeDiscoveryCostEstimate(intent, parsedLimit, budget);
              const maxCities = budget?.gmapsMaxCities ?? 5;
              const plannedCities = recommendedCities.slice(0, Math.max(1, maxCities));
              const keywordsCount = costEstimate.plannedKeywordsCount || 1;

              return (
                <div id="country-pre-run-plan" className="rounded-xl border border-indigo-500/40 bg-indigo-950/30 p-3.5 text-xs space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-indigo-200 flex items-center gap-2">
                      <span>Multi-City Country Plan: {location.trim().toUpperCase()}</span>
                    </div>
                    <span className="rounded bg-indigo-500/20 px-2 py-0.5 text-[10px] font-bold text-indigo-300 uppercase">
                      Country Detected
                    </span>
                  </div>

                  <div>
                    <div className="text-[11px] text-zinc-400">
                      Recommended major cities (click to customize city list):
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {recommendedCities.map((city) => (
                        <button
                          key={city}
                          type="button"
                          onClick={() => {
                            if (COUNTRY_CITIES[normalizedLoc]) {
                              setLocation(city);
                            } else {
                              setLocation((prev) => (prev ? `${prev}, ${city}` : city));
                            }
                            setConfirmCountryPlan(false);
                          }}
                          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:border-indigo-500 hover:text-white transition"
                          title={`Set city to ${city}`}
                        >
                          + {city}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          setLocation(recommendedCities.join(", "));
                          setConfirmCountryPlan(false);
                        }}
                        className="rounded-md border border-indigo-600/50 bg-indigo-900/40 px-2 py-1 text-[11px] font-semibold text-indigo-200 hover:bg-indigo-900/80 transition"
                      >
                        Use All ({recommendedCities.length} cities)
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-indigo-500/20 pt-2.5 font-mono text-[11px]">
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">Cities to search</div>
                      <div className="font-bold text-zinc-200 truncate" title={plannedCities.join(", ")}>
                        {plannedCities.length} ({plannedCities[0]}...)
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">Keywords / city</div>
                      <div className="font-bold text-zinc-200">{keywordsCount}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">Max places</div>
                      <div className="font-bold text-zinc-200">{costEstimate.totalPlaces}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">Est. USD</div>
                      <div className="font-bold text-emerald-400">
                        {budget?.isDryRun ? "$0.00 (Dry Run)" : `$${costEstimate.totalCost.toFixed(2)}`}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
                    <label className="flex items-start gap-2.5 cursor-pointer text-amber-200">
                      <input
                        type="checkbox"
                        id="confirm-country-plan-checkbox"
                        checked={confirmCountryPlan}
                        onChange={(e) => setConfirmCountryPlan(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-amber-600 bg-zinc-900 text-amber-500 focus:ring-amber-400"
                      />
                      <div>
                        <span className="font-semibold text-amber-100">
                          Confirm Multi-City Country Search
                        </span>
                        <p className="mt-0.5 text-[11px] text-amber-300/80">
                          I confirm searching across {location.trim()} ({plannedCities.join(", ")}).
                        </p>
                      </div>
                    </label>
                  </div>
                </div>
              );
            })()}

            {/* Collapsible Advanced Criteria */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
              <button
                type="button"
                id="toggle-advanced-criteria-btn"
                onClick={() => setShowAdvancedCriteria(!showAdvancedCriteria)}
                className="flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-medium text-zinc-300 hover:text-white transition cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <svg
                    className={`h-4 w-4 text-zinc-400 transition-transform ${showAdvancedCriteria ? "rotate-90" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="font-semibold">Advanced criteria</span>
                </div>
                <span className="text-[11px] text-zinc-500">
                  {strictMode ? "Strict mode (reject low posts)" : "Default: 100-500k followers, 3+ posts"}
                </span>
              </button>

              {showAdvancedCriteria && (
                <div className="border-t border-zinc-800/80 p-3.5 space-y-3.5 bg-zinc-900/30">
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    Instagram profile data decides whether a lead is kept. In standard mode, accounts with fewer than {minPosts || 3} posts are flagged as &ldquo;low_activity&rdquo;; strict mode rejects them. Accounts outside follower bounds or private accounts are filtered out before AI analytics.
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                      <label htmlFor="crit-min-followers" className="block text-[11px] font-semibold text-zinc-300">
                        Min Followers
                      </label>
                      <input
                        id="crit-min-followers"
                        type="number"
                        min={0}
                        value={minFollowers}
                        onChange={(e) => setMinFollowers(e.target.value)}
                        placeholder="100"
                        className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label htmlFor="crit-max-followers" className="block text-[11px] font-semibold text-zinc-300">
                        Max Followers
                      </label>
                      <input
                        id="crit-max-followers"
                        type="number"
                        min={0}
                        value={maxFollowers}
                        onChange={(e) => setMaxFollowers(e.target.value)}
                        placeholder="500000"
                        className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label htmlFor="crit-min-posts" className="block text-[11px] font-semibold text-zinc-300">
                        Min Posts
                      </label>
                      <input
                        id="crit-min-posts"
                        type="number"
                        min={0}
                        value={minPosts}
                        onChange={(e) => setMinPosts(e.target.value)}
                        placeholder="3"
                        className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <label htmlFor="crit-strict-mode" className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300">
                      <input
                        id="crit-strict-mode"
                        type="checkbox"
                        checked={strictMode}
                        onChange={(e) => setStrictMode(e.target.checked)}
                        className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 accent-indigo-500"
                      />
                      <span>Strict mode (reject accounts with fewer than {minPosts || 3} posts)</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            {/* Provider Cost Warning Banner */}
            {(budget?.discoveryProvider === "instagram_places" ||
              budget?.discoveryProvider === "hybrid" ||
              budget?.discoveryProvider === "instagram_search") && (
              <div
                id="ig-places-cost-warning"
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300"
              >
                <div className="flex items-center gap-2 font-semibold text-amber-200">
                  <svg className="h-4 w-4 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span>
                    Cost Notice: Provider &ldquo;{budget.discoveryProvider}&rdquo; active
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-amber-200/80">
                  {budget.discoveryProvider === "instagram_places"
                    ? "Instagram Places discovery is experimental, low yield (~$0.0027/item). google_maps is recommended for zero-cost Instagram extraction."
                    : budget.discoveryProvider === "hybrid"
                      ? "Hybrid discovery runs Google Maps first and tops up remaining quota with Instagram Places (~$0.0027/item)."
                      : "Instagram Search discovery burns credits faster than Google Maps. google_maps is recommended."}
                </p>
              </div>
            )}

            {/* Pre-run estimate banner */}
            {(() => {
              const parsedLimit = parseLimitInput(discoverLimitInput, budget?.maxLeadsCap ?? MAX_MAX_LEADS);
              const costEstimate = computeDiscoveryCostEstimate(intent, parsedLimit, budget);
              const isIgMode = budget?.activeProviders?.discoveryProvider === "instagram_all_in_one";
              const igPlan = isIgMode
                ? planInstagramQueries({
                    query: intent,
                    category,
                    location,
                    maxQueries: budget?.igMaxQueriesPerJob ?? 6,
                    searchLimit: budget?.igSearchLimit ?? 10,
                  })
                : null;
              const igUnit = budget?.igScraperCostPerResultUsd ?? 0.0027;
              const igQueryCount = igPlan?.queries.length ?? 0;
              const igSearchLimit = budget?.igSearchLimit ?? 10;
              const igDetailsCount = Math.min(
                parsedLimit ?? 10,
                igQueryCount * igSearchLimit,
              );
              const igSearchCost = Number((igQueryCount * igSearchLimit * igUnit).toFixed(4));
              const igDetailsCost = Number((igDetailsCount * igUnit).toFixed(4));
              const igGeminiCost = Number(
                (igDetailsCount * (budget?.costs?.gemini ?? 0.001)).toFixed(4),
              );
              const igTotalCost = Number(
                (igSearchCost + igDetailsCost + igGeminiCost).toFixed(4),
              );
              const displayTotal = isIgMode ? igTotalCost : costEstimate.totalCost;
              const isOverCeiling = isIgMode
                ? Number.isFinite(costEstimate.maxJobUsd) &&
                  igTotalCost > costEstimate.maxJobUsd
                : costEstimate.isOverCeiling;
              const isRealRun = budget && !budget.isDryRun;
              const isBudgetExhausted = Boolean(
                isRealRun &&
                budget?.remainingBudgetUsd !== null &&
                budget?.remainingBudgetUsd !== undefined &&
                budget.remainingBudgetUsd <= 0
              );

              return (
                <>
                  <div
                    className={`rounded-xl border p-3.5 text-xs ${
                      isOverCeiling || isBudgetExhausted
                        ? "border-rose-500/40 bg-rose-950/20"
                        : "border-indigo-500/20 bg-indigo-950/20"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-indigo-300">Cost Guard Pre-Run Estimate</span>
                      {budget?.isDryRun ? (
                        <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300 uppercase tracking-wide">
                          DRY RUN ($0.00)
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 uppercase tracking-wide">
                          REAL PAID RUN (~${displayTotal.toFixed(3)})
                        </span>
                      )}
                    </div>

                    <div className="mt-2.5 grid grid-cols-2 sm:grid-cols-3 gap-2 border-t border-indigo-500/20 pt-2 font-mono text-[11px] text-zinc-300">
                      {isIgMode ? (
                        <>
                          <div>
                            <span className="text-zinc-500">Search ({igQueryCount}q x {igSearchLimit}):</span> $
                            {igSearchCost.toFixed(3)}
                          </div>
                          <div>
                            <span className="text-zinc-500">Details (~{igDetailsCount}x):</span> $
                            {igDetailsCost.toFixed(3)}
                          </div>
                          <div>
                            <span className="text-zinc-500">Gemini (~{igDetailsCount}x):</span> $
                            {igGeminiCost.toFixed(3)}
                          </div>
                          <div className="font-bold text-indigo-200">
                            <span className="text-zinc-500">Total Est:</span> ${displayTotal.toFixed(3)}
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <span className="text-zinc-500">Maps Run:</span> ${costEstimate.mapsRunCost.toFixed(3)}
                          </div>
                          <div>
                            <span className="text-zinc-500">Places ({costEstimate.totalPlaces}x):</span> ${costEstimate.placesCost.toFixed(3)}
                          </div>
                          {budget?.contactsEnrichmentEnabled ? (
                            <div>
                              <span className="text-zinc-500">Contacts ({costEstimate.totalPlaces}x):</span> ${costEstimate.contactsCost.toFixed(3)}
                            </div>
                          ) : (
                            <div>
                              <span className="text-zinc-500">Contacts:</span> <span className="text-zinc-500">disabled</span>
                            </div>
                          )}
                          <div>
                            <span className="text-zinc-500">Profiles (~{costEstimate.estimatedCandidates}x):</span> ${costEstimate.profileCost.toFixed(3)}
                          </div>
                          <div>
                            <span className="text-zinc-500">Gemini (~{Math.min(parsedLimit ?? 10, costEstimate.estimatedCandidates)}x):</span> ${costEstimate.geminiCost.toFixed(3)}
                          </div>
                          <div className="font-bold text-indigo-200">
                            <span className="text-zinc-500">Total Est:</span> ${displayTotal.toFixed(3)}
                          </div>
                        </>
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[11px] text-zinc-400 border-t border-zinc-800/80 pt-2">
                      <span>
                        Ceiling:{" "}
                        <strong className="text-zinc-200">
                          {Number.isFinite(costEstimate.maxJobUsd)
                            ? `$${costEstimate.maxJobUsd.toFixed(2)}`
                            : "disabled"}
                        </strong>
                      </span>
                      <span>
                        Budget left:{" "}
                        <strong className="text-zinc-200">
                          {!budget
                            ? "..."
                            : budget.remainingBudgetUsd === null
                              ? "unlimited"
                              : `$${budget.remainingBudgetUsd.toFixed(2)}`}
                        </strong>
                      </span>
                    </div>

                    {isOverCeiling && (
                      <div className="mt-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300 font-medium">
                        Estimated cost (${displayTotal.toFixed(2)}) exceeds DISCOVERY_MAX_JOB_USD ceiling (${costEstimate.maxJobUsd.toFixed(2)}). Discovery is blocked.
                      </div>
                    )}

                    {isBudgetExhausted && (
                      <div className="mt-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300 font-medium">
                        <strong>BUDGET_BLOCKED:</strong> Monthly Apify budget is exhausted ($0.00 left of ${budget?.monthlyBudgetUsd?.toFixed(2) ?? "0.00"}, spend this month: ${budget?.monthlySpendUsd?.toFixed(2) ?? "0.00"}). Real runs are blocked.
                      </div>
                    )}
                    {(budget?.keywordSuggestions?.length ?? 0) > 0 && (
                      <div className="mt-2 text-[11px] text-emerald-300/90">
                        Best past keywords:{" "}
                        {budget!.keywordSuggestions!.map((s) => `${s.keyword} (${(s.yield * 100).toFixed(0)}% IG)`).join(" • ")}
                      </div>
                    )}
                  </div>

                  {/* Real run confirmation checkbox */}
                  {isRealRun && !isBudgetExhausted && (
                    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                      <label className="flex items-start gap-2.5 cursor-pointer text-amber-200">
                        <input
                          type="checkbox"
                          id="confirm-real-run-checkbox"
                          checked={confirmRealRun}
                          onChange={(e) => setConfirmRealRun(e.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-amber-600 bg-zinc-900 text-amber-500 focus:ring-amber-400"
                        />
                        <div>
                          <span className="font-semibold text-amber-100">I understand this is a real paid run</span>
                          <p className="mt-0.5 text-[11px] text-amber-300/80">
                            Estimated spend: ~${displayTotal.toFixed(3)} USD. Live{" "}
                            {isIgMode ? "apify/instagram-scraper" : "Apify and Google Maps provider"} credits will be consumed.
                          </p>
                        </div>
                      </label>
                    </div>
                  )}

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
                      disabled={isSubmitting || isLimitReached || isOverCeiling || isBudgetExhausted || (Boolean(isRealRun) && !confirmRealRun)}
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
                      ) : isBudgetExhausted ? (
                        <span>Budget Blocked</span>
                      ) : isOverCeiling ? (
                        <span>Over Budget Ceiling</span>
                      ) : isRealRun && !confirmRealRun ? (
                        <span>Confirm Real Run Above</span>
                      ) : (
                        <span>Start Discovery</span>
                      )}
                    </button>
                  </div>
                </>
              );
            })()}
          </form>
        )}

        {/* Specific profiles form */}
        {mode === "profiles" && (
          <form onSubmit={handleScrapeProfiles} className="mt-5 space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="scrape-profiles" className="block text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Profiles or Usernames <span className="text-zinc-500">(1 per line or CSV up to {MAX_PROFILE_BATCH})</span>
                </label>
                <label className="cursor-pointer text-xs font-semibold text-indigo-400 hover:text-indigo-300">
                  <span>Upload CSV</span>
                  <input
                    type="file"
                    accept=".csv,.txt"
                    disabled={isSubmitting}
                    onChange={handleCsvUpload}
                    className="hidden"
                  />
                </label>
              </div>
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
                Up to {MAX_PROFILE_BATCH} profiles per request. Usernames, direct Instagram links, or CSV upload supported.
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

            {/* Pre-run estimate banner */}
            <div className="rounded-xl border border-indigo-500/20 bg-indigo-950/20 p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-indigo-300">Cost Guard Pre-Run Estimate</span>
                {budget?.isDryRun && (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                    DRY RUN ($0.00)
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-zinc-300 font-mono text-[11px]">
                {(() => {
                  const profiles = normalizeProfiles(inputText);
                  const estCount = Math.min(20, profiles.length || 1);
                  const estCost = (0.005 + estCount * 0.0023).toFixed(3);
                  const budgetLeftStr = !budget
                    ? "..."
                    : budget.remainingBudgetUsd === null
                      ? "not set"
                      : `$${budget.remainingBudgetUsd.toFixed(2)}`;
                  return `Planned: ${profiles.length} profiles to import (max 20 survivor enrichments). Est. cost: ~$${estCost}. Budget left this month: ${budgetLeftStr}`;
                })()}
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
