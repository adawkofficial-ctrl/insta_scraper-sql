"use client";

import { useEffect, useState, useCallback } from "react";
import {
  getCampaignAnalytics,
  getCampaignMessages,
  getCampaignAnalyticsExportUrl,
  type CampaignAnalytics,
  type CampaignMessagesResult,
} from "@/lib/api/analytics";
import { ApiClientError } from "@/lib/api/client";

type CampaignAnalyticsTabProps = {
  campaignId: string;
  refreshTrigger?: number;
};

export function CampaignAnalyticsTab({
  campaignId,
  refreshTrigger,
}: CampaignAnalyticsTabProps) {
  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  // Message Activity State
  const [messagesResult, setMessagesResult] = useState<CampaignMessagesResult | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [messageStatusFilter, setMessageStatusFilter] = useState<string>("");
  const [messagesPage, setMessagesPage] = useState(1);

  const fetchAnalytics = useCallback(async () => {
    setIsLoadingAnalytics(true);
    setAnalyticsError(null);
    try {
      const data = await getCampaignAnalytics(campaignId);
      setAnalytics(data);
    } catch (err) {
      setAnalyticsError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to load campaign analytics.",
      );
    } finally {
      setIsLoadingAnalytics(false);
    }
  }, [campaignId]);

  const fetchMessages = useCallback(async () => {
    setIsLoadingMessages(true);
    try {
      const data = await getCampaignMessages(campaignId, {
        page: messagesPage,
        limit: 15,
        status: messageStatusFilter || undefined,
      });
      setMessagesResult(data);
    } catch {
      // Handled gracefully
    } finally {
      setIsLoadingMessages(false);
    }
  }, [campaignId, messagesPage, messageStatusFilter]);

  useEffect(() => {
    let isMounted = true;
    Promise.resolve().then(() => {
      if (isMounted) {
        fetchAnalytics();
      }
    });
    return () => {
      isMounted = false;
    };
  }, [fetchAnalytics, refreshTrigger]);

  useEffect(() => {
    let isMounted = true;
    Promise.resolve().then(() => {
      if (isMounted) {
        fetchMessages();
      }
    });
    return () => {
      isMounted = false;
    };
  }, [fetchMessages]);

  const formatDuration = (seconds: number | null | undefined): string => {
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

  const getMessageBadge = (status: string) => {
    switch (status) {
      case "SENT":
        return (
          <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
            SENT
          </span>
        );
      case "UNKNOWN":
        return (
          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20">
            UNKNOWN
          </span>
        );
      case "SENDING":
        return (
          <span className="rounded bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-400 border border-blue-500/20">
            SENDING
          </span>
        );
      case "FAILED":
      default:
        return (
          <span className="rounded bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-400 border border-rose-500/20">
            FAILED
          </span>
        );
    }
  };

  if (isLoadingAnalytics && !analytics) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-24 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="h-64 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5" />
          <div className="h-64 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5" />
        </div>
      </div>
    );
  }

  if (analyticsError && !analytics) {
    return (
      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-center">
        <p className="text-sm text-rose-300">{analyticsError}</p>
        <button
          type="button"
          onClick={fetchAnalytics}
          className="mt-3 rounded-xl bg-zinc-800 px-4 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (!analytics) return null;

  const leadCap = analytics.leadLimit;
  const messaging = analytics.messaging;
  const discovery = analytics.discovery;
  const summary = analytics.summary;

  return (
    <div className="space-y-6" id="campaign-analytics-dashboard">
      {/* 1. Header with Export Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-bold text-white">Campaign Analytics & Reporting</h2>
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-mono text-zinc-300 border border-zinc-700">
              {summary.executionStatus}
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Strictly derived from persisted PostgreSQL records. Zero client-only counters or duplicated counts.
          </p>
        </div>

        {/* Export Buttons */}
        <div className="flex items-center gap-2">
          <a
            id="btn-export-csv"
            href={getCampaignAnalyticsExportUrl(campaignId, "csv")}
            download
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition"
          >
            <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span>Export CSV</span>
          </a>
          <a
            id="btn-export-json"
            href={getCampaignAnalyticsExportUrl(campaignId, "json")}
            download
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition"
          >
            <svg className="h-3.5 w-3.5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span>Export JSON</span>
          </a>
          <button
            type="button"
            onClick={fetchAnalytics}
            aria-label="Refresh analytics"
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/80 p-1.5 text-zinc-300 hover:bg-zinc-700 transition"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* 2. KPI Summary Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 text-center">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Total Leads</span>
          <div className="text-xl font-extrabold text-white font-mono">{summary.totalLeads}</div>
          <span className="text-[10px] text-zinc-400 block">{analytics.leads.eligible} eligible</span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Messages Sent</span>
          <div className="text-xl font-extrabold text-emerald-400 font-mono">{summary.messagesSent}</div>
          <span className="text-[10px] text-emerald-500/80 block">{messaging.sentRate}% success rate</span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Failed / Unknown</span>
          <div className="text-xl font-extrabold text-rose-400 font-mono">
            {summary.messagesFailed + summary.messagesUnknown}
          </div>
          <span className="text-[10px] text-zinc-400 block">
            {summary.messagesFailed} failed &bull; {summary.messagesUnknown} unknown
          </span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Remaining in Queue</span>
          <div className="text-xl font-extrabold text-amber-400 font-mono">{summary.messagesRemaining}</div>
          <span className="text-[10px] text-zinc-400 block">{messaging.processing} processing</span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Lead Capacity</span>
          <div className="text-xl font-extrabold text-zinc-200 font-mono">
            {leadCap.remainingCapacity}
          </div>
          <span className="text-[10px] text-zinc-400 block">
            {leadCap.limit != null ? `of ${leadCap.limit} limit` : "Unrestricted"}
          </span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Execution Progress</span>
          <div className="text-xl font-extrabold text-indigo-400 font-mono">
            {analytics.execution.overallProgress}%
          </div>
          <span className="text-[10px] text-zinc-400 block">{analytics.execution.status}</span>
        </div>
      </div>

      {/* 3. Lead Profile Demographics & Characteristics */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-zinc-100">Lead Demographics & Profile Attributes</h3>
            <p className="text-xs text-zinc-400 mt-0.5">Distribution of lead characteristics saved in this campaign</p>
          </div>
          {leadCap.isAtCapacity && (
            <span className="rounded-md bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-xs font-semibold text-amber-300">
              Capacity Limit Reached
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-center">
          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
            <span className="text-[10px] font-semibold text-zinc-500 block uppercase">Verified</span>
            <span className="text-base font-bold text-sky-400 font-mono">{analytics.leads.verified}</span>
            <span className="text-[10px] text-zinc-400 block">{analytics.leads.verifiedPercentage}%</span>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
            <span className="text-[10px] font-semibold text-zinc-500 block uppercase">Business</span>
            <span className="text-base font-bold text-purple-400 font-mono">{analytics.leads.business}</span>
            <span className="text-[10px] text-zinc-400 block">{analytics.leads.businessPercentage}%</span>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
            <span className="text-[10px] font-semibold text-zinc-500 block uppercase">Non-Business</span>
            <span className="text-base font-bold text-zinc-300 font-mono">{analytics.leads.nonBusiness}</span>
            <span className="text-[10px] text-zinc-400 block">Personal profiles</span>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
            <span className="text-[10px] font-semibold text-zinc-500 block uppercase">Has Website</span>
            <span className="text-base font-bold text-emerald-400 font-mono">{analytics.leads.withExternalUrl}</span>
            <span className="text-[10px] text-zinc-400 block">With external URL</span>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
            <span className="text-[10px] font-semibold text-zinc-500 block uppercase">Has Avatar</span>
            <span className="text-base font-bold text-indigo-400 font-mono">{analytics.leads.withProfilePic}</span>
            <span className="text-[10px] text-zinc-400 block">Profile picture present</span>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
            <span className="text-[10px] font-semibold text-zinc-500 block uppercase">Has Bio</span>
            <span className="text-base font-bold text-amber-400 font-mono">{analytics.leads.withBio}</span>
            <span className="text-[10px] text-zinc-400 block">Biography text populated</span>
          </div>
        </div>

        {/* Categories Bar */}
        {analytics.categories.length > 0 && (
          <div className="pt-2">
            <span className="text-xs font-semibold text-zinc-400 block mb-2">Top Niches & Categories:</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {analytics.categories.map((cat) => (
                <div key={cat.category} className="rounded-lg bg-zinc-950/80 border border-zinc-800/80 p-2 flex items-center justify-between text-xs">
                  <span className="text-zinc-200 truncate max-w-[150px]">{cat.category}</span>
                  <span className="font-mono text-zinc-400 font-medium">{cat.count} ({cat.percentage}%)</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 4. Discovery & Conversion Funnel */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-zinc-100">Discovery & Enrichment Performance</h3>
            <p className="text-xs text-zinc-400 mt-0.5">Scraping metrics, enrichment rate, and save conversion</p>
          </div>
          <span className="text-xs text-zinc-400 font-mono">
            {discovery.totalJobs} total jobs executed
          </span>
        </div>

        {!analytics.emptyStates.hasDiscovery ? (
          <div className="p-8 text-center text-xs text-zinc-500 italic">
            No discovery activity yet. Execute a scrape job or start the campaign to discover leads.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3">
                <span className="text-[10px] font-bold uppercase text-indigo-400">1. Discovered</span>
                <div className="mt-1 text-lg font-bold text-white font-mono">{discovery.candidatesDiscovered}</div>
                <span className="text-[10px] text-zinc-500">Raw candidate profiles</span>
              </div>

              <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-3">
                <span className="text-[10px] font-bold uppercase text-purple-400">2. Enriched</span>
                <div className="mt-1 text-lg font-bold text-white font-mono">{discovery.candidatesEnriched}</div>
                <span className="text-[10px] text-purple-400 font-medium">{discovery.enrichmentRate}% conversion</span>
              </div>

              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                <span className="text-[10px] font-bold uppercase text-emerald-400">3. Saved Leads</span>
                <div className="mt-1 text-lg font-bold text-white font-mono">{discovery.leadsSaved}</div>
                <span className="text-[10px] text-emerald-400 font-medium">{discovery.saveRate}% save rate</span>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                <span className="text-[10px] font-bold uppercase text-zinc-400">Skipped</span>
                <div className="mt-1 text-lg font-bold text-zinc-300 font-mono">{discovery.candidatesSkipped}</div>
                <span className="text-[10px] text-zinc-500">Unmatched / duplicate</span>
              </div>
            </div>

            {/* Recent Scrape Jobs Table */}
            {discovery.recentJobs.length > 0 && (
              <div className="overflow-x-auto pt-2">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-800 bg-zinc-950/60 text-zinc-400 uppercase font-semibold text-[10px]">
                    <tr>
                      <th className="py-2 px-3">Status</th>
                      <th className="py-2 px-3">Query / Intent</th>
                      <th className="py-2 px-3">Discovered</th>
                      <th className="py-2 px-3">Enriched</th>
                      <th className="py-2 px-3">Saved</th>
                      <th className="py-2 px-3">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                    {discovery.recentJobs.map((job) => (
                      <tr key={job.id} className="hover:bg-zinc-800/30 font-mono text-[11px]">
                        <td className="py-2 px-3">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            job.status === "COMPLETED" ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"
                          }`}>
                            {job.status}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-sans text-zinc-200">{job.query || "Direct scrape"}</td>
                        <td className="py-2 px-3">{job.candidatesDiscovered}</td>
                        <td className="py-2 px-3">{job.candidatesEnriched}</td>
                        <td className="py-2 px-3 text-emerald-400">{job.processedCount}</td>
                        <td className="py-2 px-3 text-zinc-400">{formatDuration(job.durationSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* 5. Messaging Activity Breakdown */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-zinc-100">Messaging Delivery & Queue Status</h3>
            <p className="text-xs text-zinc-400 mt-0.5">Authoritative dispatch outcomes from messaging queue</p>

          </div>
          <span className="text-xs font-mono text-zinc-400">
            {messaging.sentRate}% Delivery Success Rate
          </span>
        </div>

        {!analytics.emptyStates.hasMessaging ? (
          <div className="p-8 text-center text-xs text-zinc-500 italic">
            No messaging activity yet. Messages will be tracked here once queue dispatch begins.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 text-center">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
              <span className="text-[10px] font-bold uppercase text-emerald-400">Sent</span>
              <div className="mt-1 text-lg font-bold text-emerald-300 font-mono">{messaging.sent}</div>
              <span className="text-[10px] text-zinc-400">Confirmed</span>
            </div>

            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
              <span className="text-[10px] font-bold uppercase text-rose-400">Failed</span>
              <div className="mt-1 text-lg font-bold text-rose-300 font-mono">{messaging.failed}</div>
              <span className="text-[10px] text-zinc-400">Rejected</span>
            </div>

            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
              <span className="text-[10px] font-bold uppercase text-amber-400">Unknown</span>
              <div className="mt-1 text-lg font-bold text-amber-300 font-mono">{messaging.unknown}</div>
              <span className="text-[10px] text-zinc-400">Unconfirmed</span>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
              <span className="text-[10px] font-bold uppercase text-zinc-400">Skipped</span>
              <div className="mt-1 text-lg font-bold text-zinc-300 font-mono">{messaging.skipped}</div>
              <span className="text-[10px] text-zinc-500">Ineligible</span>
            </div>

            <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-3">
              <span className="text-[10px] font-bold uppercase text-blue-400">Processing</span>
              <div className="mt-1 text-lg font-bold text-blue-300 font-mono">{messaging.processing}</div>
              <span className="text-[10px] text-zinc-400">In flight</span>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
              <span className="text-[10px] font-bold uppercase text-zinc-400">Queued</span>
              <div className="mt-1 text-lg font-bold text-zinc-300 font-mono">{messaging.queued}</div>
              <span className="text-[10px] text-zinc-500">Pending</span>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
              <span className="text-[10px] font-bold uppercase text-zinc-400">Cancelled</span>
              <div className="mt-1 text-lg font-bold text-zinc-300 font-mono">{messaging.cancelled}</div>
              <span className="text-[10px] text-zinc-500">Halted</span>
            </div>
          </div>
        )}
      </div>

      {/* 6. Failure Taxonomy Breakdown */}
      {analytics.failures.categories.length > 0 && (
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-5 space-y-3">
          <div className="flex items-center justify-between border-b border-rose-500/20 pb-2.5">
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h3 className="text-sm font-bold text-rose-300">Failure & Platform Challenge Taxonomy</h3>
            </div>
            <span className="text-xs text-rose-400 font-mono">
              {analytics.failures.totalFailures} logged error events
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-1">
            {analytics.failures.categories.map((fc) => (
              <div key={fc.category} className="rounded-xl border border-rose-500/20 bg-zinc-950/70 p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-rose-400">[{fc.category}]</span>
                  <span className="font-mono text-xs text-rose-300 font-extrabold">{fc.count}</span>
                </div>
                <p className="text-[11px] text-zinc-400">{fc.label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 7. Timing & Durations Strip */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-6 text-zinc-400 font-mono">
            <span>Campaign Age: <strong className="text-zinc-200">{formatDuration(analytics.durations.campaignDurationSeconds)}</strong></span>
            <span>Discovery: <strong className="text-zinc-200">{formatDuration(analytics.durations.discoveryDurationSeconds)}</strong></span>
            <span>Execution: <strong className="text-zinc-200">{formatDuration(analytics.durations.totalExecutionDurationSeconds)}</strong></span>
          </div>
          <div className="text-[11px] text-zinc-500">
            Timestamps are persisted in PostgreSQL. Browser clocks do not affect calculations.
          </div>
        </div>
      </div>

      {/* 8. Message Outreach Audit Log (with Filter & Pagination) */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-zinc-100">Outreach Message Activity Log</h3>
            <p className="text-xs text-zinc-400 mt-0.5">Audit trail of individual direct message dispatches</p>
          </div>

          {/* Status Filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="select-msg-status" className="text-xs text-zinc-400">Filter:</label>
            <select
              id="select-msg-status"
              value={messageStatusFilter}
              onChange={(e) => {
                setMessageStatusFilter(e.target.value);
                setMessagesPage(1);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
            >
              <option value="">All Statuses</option>
              <option value="SENT">Sent</option>
              <option value="FAILED">Failed</option>
              <option value="UNKNOWN">Unknown</option>
              <option value="SENDING">Sending</option>
            </select>
          </div>
        </div>

        {isLoadingMessages ? (
          <div className="p-8 text-center text-xs text-zinc-500 animate-pulse">
            Loading message audit records...
          </div>
        ) : !messagesResult || messagesResult.items.length === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-500 italic">
            No message audit records match this criteria.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-800 bg-zinc-950/60 text-zinc-400 uppercase font-semibold text-[10px]">
                <tr>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Recipient</th>
                  <th className="py-2.5 px-3">Content Preview</th>
                  <th className="py-2.5 px-3">Sent At / Error</th>
                  <th className="py-2.5 px-3">Attempts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {messagesResult.items.map((m) => (
                  <tr key={m.id} className="hover:bg-zinc-800/30">
                    <td className="py-2.5 px-3">{getMessageBadge(m.status)}</td>
                    <td className="py-2.5 px-3 font-semibold text-zinc-100">
                      @{m.lead.username}
                    </td>
                    <td className="py-2.5 px-3 text-zinc-400 max-w-[280px] truncate" title={m.messageText}>
                      {m.messageText}
                    </td>
                    <td className="py-2.5 px-3">
                      {m.status === "SENT" ? (
                        <span className="text-zinc-400 text-[11px] font-mono">
                          {m.sentAt ? new Date(m.sentAt).toLocaleTimeString() : "—"}
                        </span>
                      ) : (
                        <span className="text-rose-400 text-[11px] font-mono">
                          {m.errorMessage || "—"}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-zinc-400 text-[11px]">
                      {m.attempts ? `${m.attempts.length} attempts` : "1 attempt"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {messagesResult.pagination.totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-zinc-800 pt-3 text-xs text-zinc-400">
                <span>
                  Page {messagesResult.pagination.page} of {messagesResult.pagination.totalPages}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    disabled={messagesPage <= 1}
                    onClick={() => setMessagesPage((p) => Math.max(1, p - 1))}
                    className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 disabled:opacity-40"
                  >
                    &larr; Prev
                  </button>
                  <button
                    disabled={messagesPage >= messagesResult.pagination.totalPages}
                    onClick={() => setMessagesPage((p) => p + 1)}
                    className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 disabled:opacity-40"
                  >
                    Next &rarr;
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
