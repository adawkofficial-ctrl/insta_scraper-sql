"use client";

import { useEffect, useState, useCallback } from "react";
import {
  getCampaignAnalytics,
  getCampaignMessages,
  getCampaignAnalyticsExportUrl,
  getCampaignOutcomeAnalytics,
  getCampaignRecommendations,
  applyCampaignRecommendation,
  type CampaignAnalytics,
  type CampaignMessagesResult,
  type OutcomeAnalyticsResponse,
  type OutcomeSegmentRow,
  type CampaignRecommendationItem,
} from "@/lib/api/analytics";
import { updateCampaign } from "@/lib/api/campaigns";
import { ApiClientError } from "@/lib/api/client";

type CampaignAnalyticsTabProps = {
  campaignId: string;
  refreshTrigger?: number;
};

type SegmentTab =
  | "keyword"
  | "city"
  | "tier"
  | "handleSource"
  | "chainType"
  | "channel"
  | "followerBand"
  | "variant";

export function CampaignAnalyticsTab({
  campaignId,
  refreshTrigger,
}: CampaignAnalyticsTabProps) {
  // Legacy Overview Analytics
  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  // Outcome & Funnel Analytics
  const [outcomeData, setOutcomeData] = useState<OutcomeAnalyticsResponse | null>(null);
  const [isLoadingOutcome, setIsLoadingOutcome] = useState(true);

  // Recommendations & Auto-Optimize
  const [recommendations, setRecommendations] = useState<CampaignRecommendationItem[]>([]);
  const [autoOptimize, setAutoOptimize] = useState(false);
  const [applyingRecId, setApplyingRecId] = useState<string | null>(null);
  const [recFeedback, setRecFeedback] = useState<string | null>(null);

  // Segment Table Filter
  const [activeSegmentTab, setActiveSegmentTab] = useState<SegmentTab>("keyword");

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

  const fetchOutcomeAnalytics = useCallback(async () => {
    setIsLoadingOutcome(true);
    try {
      const [outcomes, recsRes] = await Promise.all([
        getCampaignOutcomeAnalytics(campaignId),
        getCampaignRecommendations(campaignId),
      ]);
      setOutcomeData(outcomes);
      setRecommendations(recsRes.recommendations);
      setAutoOptimize(recsRes.autoOptimize);
    } catch {
      // Graceful fallback: legacy stats will still show
    } finally {
      setIsLoadingOutcome(false);
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
        fetchOutcomeAnalytics();
      }
    });
    return () => {
      isMounted = false;
    };
  }, [fetchAnalytics, fetchOutcomeAnalytics, refreshTrigger]);

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

  const handleApplyRecommendation = async (recId: string) => {
    setApplyingRecId(recId);
    setRecFeedback(null);
    try {
      const res = await applyCampaignRecommendation(campaignId, recId);
      setRecFeedback(`Applied successfully! Updated: ${res.updatedFields.join(", ")}`);
      await fetchOutcomeAnalytics();
    } catch (err) {
      setRecFeedback(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setApplyingRecId(null);
    }
  };

  const handleToggleAutoOptimize = async () => {
    const nextVal = !autoOptimize;
    setAutoOptimize(nextVal);
    try {
      await updateCampaign(campaignId, { autoOptimize: nextVal });
    } catch {
      setAutoOptimize(!nextVal);
    }
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

  if ((isLoadingAnalytics || isLoadingOutcome) && !analytics && !outcomeData) {
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

  const funnel = outcomeData?.funnel;
  const cost = outcomeData?.cost;
  const segments = outcomeData?.segments;
  const dataQuality = outcomeData?.dataQuality;
  const variants = outcomeData?.variants || [];

  // Active segment data
  let activeSegmentRows: OutcomeSegmentRow[] = [];
  if (segments) {
    switch (activeSegmentTab) {
      case "keyword":
        activeSegmentRows = segments.byKeyword;
        break;
      case "city":
        activeSegmentRows = segments.byCity;
        break;
      case "tier":
        activeSegmentRows = segments.byTier;
        break;
      case "handleSource":
        activeSegmentRows = segments.byHandleSource;
        break;
      case "chainType":
        activeSegmentRows = segments.byChainType;
        break;
      case "channel":
        activeSegmentRows = segments.byChannel;
        break;
      case "followerBand":
        activeSegmentRows = segments.byFollowerBand;
        break;
      case "variant":
        activeSegmentRows = segments.byVariant;
        break;
    }
  }

  return (
    <div className="space-y-6" id="campaign-analytics-dashboard">
      {/* 1. Header with Export Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-bold text-white">Campaign Outcomes & Economics</h2>
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
              Outcome Optimized
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Real outcomes, conversion rates, honest cost-per-reply accounting, and statistical confidence.
          </p>
        </div>

        {/* Export & Actions */}
        <div className="flex items-center gap-2">
          <a
            id="btn-export-csv"
            href={getCampaignAnalyticsExportUrl(campaignId, "csv")}
            download
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition"
          >
            <span>Export CSV</span>
          </a>
          <button
            type="button"
            onClick={() => {
              fetchAnalytics();
              fetchOutcomeAnalytics();
            }}
            aria-label="Refresh analytics"
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/80 p-1.5 text-zinc-300 hover:bg-zinc-700 transition"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* 2. Top Economics & Outcome KPI Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 text-center">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Cost / Pos. Reply</span>
          <div className="text-xl font-extrabold text-emerald-400 font-mono">
            {cost ? (cost.costPerPositiveReply > 0 ? `$${cost.costPerPositiveReply}` : "—") : "—"}
          </div>
          <span className="text-[10px] text-zinc-400 block">
            {cost ? `$${cost.costPerReply || 0} / reply` : "—"}
          </span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Positive Reply Rate</span>
          <div className="text-xl font-extrabold text-emerald-400 font-mono">
            {funnel ? `${funnel.conversions.sentToReplied > 0 ? funnel.conversions.repliedToPositive : 0}%` : "—"}
          </div>
          <span className="text-[10px] text-zinc-400 block">
            {funnel ? `${funnel.positive} positive replies` : "—"}
          </span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Reply Rate</span>
          <div className="text-xl font-extrabold text-indigo-400 font-mono">
            {funnel ? `${funnel.conversions.sentToReplied}%` : "—"}
          </div>
          <span className="text-[10px] text-zinc-400 block">
            {funnel ? `${funnel.replied} of ${funnel.sent} sent` : "—"}
          </span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Meetings Booked</span>
          <div className="text-xl font-extrabold text-amber-400 font-mono">
            {funnel ? funnel.meeting : 0}
          </div>
          <span className="text-[10px] text-zinc-400 block">
            {cost && cost.costPerMeeting > 0 ? `$${cost.costPerMeeting} / meeting` : "Primary Goal"}
          </span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Deals Won</span>
          <div className="text-xl font-extrabold text-cyan-400 font-mono">
            {funnel ? funnel.won : 0}
          </div>
          <span className="text-[10px] text-zinc-400 block">
            {cost && cost.costPerWon > 0 ? `$${cost.costPerWon} / won` : "Closed deals"}
          </span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Total Spend</span>
          <div className="text-xl font-extrabold text-zinc-200 font-mono">
            {cost ? `$${cost.totalSpend}` : "—"}
          </div>
          <span className="text-[10px] text-zinc-400 block">
            {cost ? `$${cost.costPerSavedLead} / lead` : "Honest spend"}
          </span>
        </div>
      </div>

      {/* 3. Conversion Funnel Card */}
      {funnel && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
            <div>
              <h3 className="text-sm font-bold text-white">Full-Funnel Conversion Flow</h3>
              <p className="text-xs text-zinc-400">
                Tracking every prospect from initial place discovery through replies, meetings, and closed deals.
              </p>
            </div>
            <span className="text-xs font-mono text-emerald-400">
              {funnel.conversions.overallSentToWon}% Sent-to-Won
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8 text-center pt-2">
            {[
              { label: "Places", count: funnel.places, stepConv: "100%" },
              { label: "Contactable", count: funnel.contactable, stepConv: `${funnel.conversions.placesToContactable}%` },
              { label: "Saved Leads", count: funnel.savedLeads, stepConv: `${funnel.conversions.contactableToSaved}%` },
              { label: "Sent", count: funnel.sent, stepConv: `${funnel.conversions.savedToSent}%` },
              { label: "Replied", count: funnel.replied, stepConv: `${funnel.conversions.sentToReplied}%` },
              { label: "Positive", count: funnel.positive, stepConv: `${funnel.conversions.repliedToPositive}%` },
              { label: "Meeting", count: funnel.meeting, stepConv: `${funnel.conversions.positiveToMeeting}%` },
              { label: "Won", count: funnel.won, stepConv: `${funnel.conversions.meetingToWon}%` },
            ].map((step, idx) => (
              <div key={step.label} className="relative rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3">
                <span className="text-[10px] font-bold uppercase text-zinc-400 block">{step.label}</span>
                <span className="text-lg font-extrabold text-white font-mono block mt-0.5">{step.count}</span>
                <span className="text-[10px] font-mono text-zinc-400 block mt-1">
                  {idx === 0 ? "Initial" : `${step.stepConv} step`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. Recommendations & Feedback Loop */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white">Data-Driven Discovery Recommendations</h3>
              <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-400 border border-indigo-500/20">
                Feedback Loop
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Only segments with n &ge; 30 are promoted. Suggestions require 1-click confirmation before modifying settings.
            </p>
          </div>

          {/* Auto-optimize opt-in toggle */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-300">Auto-Optimize Query Priority:</span>
            <button
              type="button"
              onClick={handleToggleAutoOptimize}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                autoOptimize ? "bg-emerald-600" : "bg-zinc-700"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  autoOptimize ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>

        {recFeedback && (
          <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-2.5 text-xs text-emerald-300">
            {recFeedback}
          </div>
        )}

        {recommendations.length === 0 ? (
          <div className="p-4 text-center text-xs text-zinc-400 italic">
            No active recommendations yet. Gathering statistical confidence (minimum n=30 per segment).
          </div>
        ) : (
          <div className="space-y-3">
            {recommendations.map((rec) => (
              <div
                key={rec.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-zinc-800/90 bg-zinc-950/50 p-3.5 hover:border-zinc-700 transition"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                        rec.type === "SCALE_SEGMENT"
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                          : rec.type === "STOP_SEGMENT"
                          ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                          : "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
                      }`}
                    >
                      {rec.type.replace("_", " ")}
                    </span>
                    <span className="text-xs font-bold text-zinc-100">{rec.title}</span>
                  </div>
                  <p className="text-xs text-zinc-400">{rec.rationale}</p>
                  <span className="text-[10px] text-zinc-400 block font-mono">{rec.impact}</span>
                </div>

                <button
                  type="button"
                  disabled={applyingRecId === rec.id}
                  onClick={() => handleApplyRecommendation(rec.id)}
                  className="shrink-0 rounded-lg border border-indigo-500/40 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-200 px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50"
                >
                  {applyingRecId === rec.id ? "Applying..." : "1-Click Apply"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 5. Statistical Segment Breakdown Table */}
      {segments && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
            <div>
              <h3 className="text-sm font-bold text-white">Segment Attribution & Reply Economics</h3>
              <p className="text-xs text-zinc-400">
                Segment performance with sample size (n) and statistical confidence markers.
              </p>
            </div>

            {/* Segment Selector Tabs */}
            <div className="flex items-center gap-1 overflow-x-auto text-xs">
              {[
                { id: "keyword", label: "Keyword" },
                { id: "city", label: "City" },
                { id: "tier", label: "Quality Tier" },
                { id: "handleSource", label: "Handle Source" },
                { id: "chainType", label: "Chain vs Ind." },
                { id: "channel", label: "Channel" },
                { id: "followerBand", label: "Followers" },
                { id: "variant", label: "Variant" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSegmentTab(tab.id as SegmentTab)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                    activeSegmentTab === tab.id
                      ? "bg-zinc-800 text-white font-semibold border border-zinc-700"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {activeSegmentRows.length === 0 ? (
            <div className="p-8 text-center text-xs text-zinc-400 italic">
              No segment data recorded for this category yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-zinc-800 bg-zinc-950/60 text-zinc-400 uppercase font-semibold text-[10px]">
                  <tr>
                    <th className="py-2.5 px-3">Segment</th>
                    <th className="py-2.5 px-3">Leads</th>
                    <th className="py-2.5 px-3">Sent (n)</th>
                    <th className="py-2.5 px-3">Replies</th>
                    <th className="py-2.5 px-3">Positive Replies</th>
                    <th className="py-2.5 px-3">Positive %</th>
                    <th className="py-2.5 px-3">Cost / Pos.</th>
                    <th className="py-2.5 px-3">Confidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                  {activeSegmentRows.map((row) => (
                    <tr key={row.segmentKey} className="hover:bg-zinc-800/30">
                      <td className="py-2.5 px-3 font-semibold text-zinc-100">{row.segmentKey}</td>
                      <td className="py-2.5 px-3 font-mono text-zinc-400">{row.leads}</td>
                      <td className="py-2.5 px-3 font-mono font-bold text-white">{row.sent}</td>
                      <td className="py-2.5 px-3 font-mono text-zinc-300">{row.replies}</td>
                      <td className="py-2.5 px-3 font-mono text-emerald-400 font-bold">{row.positiveReplies}</td>
                      <td className="py-2.5 px-3 font-mono text-emerald-400">{row.positiveRate}%</td>
                      <td className="py-2.5 px-3 font-mono text-zinc-300">
                        {row.costPerPositiveReply ? `$${row.costPerPositiveReply}` : "—"}
                      </td>
                      <td className="py-2.5 px-3">
                        {row.lowConfidence ? (
                          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20">
                            Low Confidence (n &lt; 30)
                          </span>
                        ) : (
                          <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
                            High Confidence (n &ge; 30)
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 6. A/B Testing & Data Quality Dual Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* A/B Testing Card */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4">
          <div className="border-b border-zinc-800 pb-3">
            <h3 className="text-sm font-bold text-white">Message A/B Testing (Statistical Significance)</h3>
            <p className="text-xs text-zinc-400">
              Two-proportion z-test comparing variants against control. Requires min n=30 per variant.
            </p>
          </div>

          {variants.length === 0 ? (
            <div className="p-4 text-center text-xs text-zinc-400 italic">
              No variant sends recorded yet. Variants are stickily assigned per lead.
            </div>
          ) : (
            <div className="space-y-3">
              {variants.map((v) => (
                <div key={v.variant} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white">Variant {v.variant}</span>
                    <span className="text-xs font-mono font-bold text-emerald-400">{v.positiveRate}% Pos. Rate</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>
                      {v.positiveReplies} positive / {v.sent} sent (n={v.sent})
                    </span>
                    {v.significanceVsControl && (
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                          v.significanceVsControl.significance === "high" ||
                          v.significanceVsControl.significance === "medium"
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {v.significanceVsControl.label}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Data Quality & Waste Panel */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4">
          <div className="border-b border-zinc-800 pb-3">
            <h3 className="text-sm font-bold text-white">Data Quality & Waste Accounting</h3>
            <p className="text-xs text-zinc-400">
              Monitoring data completeness and enrichment waste so no budget is lost.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
              <span className="text-[10px] uppercase font-bold text-zinc-400 block">Unknown Fields</span>
              <span className="text-lg font-extrabold text-amber-400 font-mono block mt-1">
                {dataQuality ? `${dataQuality.unknownFieldsRate}%` : "0%"}
              </span>
              <span className="text-[10px] text-zinc-400 block mt-0.5">
                {dataQuality ? `${dataQuality.unknownFieldsCount} leads` : "0 leads"}
              </span>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
              <span className="text-[10px] uppercase font-bold text-zinc-400 block">Duplicate Rate</span>
              <span className="text-lg font-extrabold text-indigo-400 font-mono block mt-1">
                {dataQuality ? `${dataQuality.duplicateRate}%` : "0%"}
              </span>
              <span className="text-[10px] text-zinc-400 block mt-0.5">
                {dataQuality ? `${dataQuality.duplicateSightingsCount} duplicates` : "0"}
              </span>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
              <span className="text-[10px] uppercase font-bold text-zinc-400 block">Enrichment Waste</span>
              <span className="text-lg font-extrabold text-rose-400 font-mono block mt-1">
                {dataQuality ? `${dataQuality.enrichmentWasteRate}%` : "0%"}
              </span>
              <span className="text-[10px] text-zinc-400 block mt-0.5">
                {dataQuality ? `${dataQuality.rejectedPlacesCount} rejected` : "0"}
              </span>
            </div>
          </div>
          <p className="text-[11px] text-zinc-400 italic">
            Note: Rejected places’ costs are fully rolled into the acquisition cost of surviving leads with zero leakage.
          </p>
        </div>
      </div>

      {/* 7. Message Audit Activity Log */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-white">Outbound Message Audit Records</h3>
            <p className="text-xs text-zinc-400">
              Paginated audit of dispatched outbound messages, attempts, and error codes.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="select-msg-filter" className="text-xs text-zinc-400">Filter:</label>
            <select
              id="select-msg-filter"
              value={messageStatusFilter}
              onChange={(e) => {
                setMessageStatusFilter(e.target.value);
                setMessagesPage(1);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 focus:outline-none"
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
          <div className="p-8 text-center text-xs text-zinc-400 animate-pulse">
            Loading message audit records...
          </div>
        ) : !messagesResult || messagesResult.items.length === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-400 italic">
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
