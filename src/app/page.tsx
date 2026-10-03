"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getCampaigns, deleteCampaign, type CampaignSummary } from "@/lib/api/campaigns";
import { getDashboardOverview, type DashboardOverview } from "@/lib/api/analytics";
import { ApiClientError } from "@/lib/api/client";
import { Navbar } from "@/components/navbar";
import { CreateCampaignModal } from "@/components/create-campaign-modal";
import { ConfirmModal } from "@/components/confirm-modal";

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // Deletion state
  const [deletingCampaign, setDeletingCampaign] = useState<CampaignSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchCampaigns = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [campaignsData, overviewData] = await Promise.all([
        getCampaigns(),
        getDashboardOverview().catch(() => null),
      ]);
      setCampaigns(campaignsData);
      if (overviewData) setOverview(overviewData);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.push("/login?redirect=/");
        return;
      }
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to load campaigns. Please ensure the backend is reachable.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    let ignore = false;
    Promise.resolve().then(async () => {
      if (ignore) return;
      setIsLoading(true);
      setError(null);
      try {
        const [campaignsData, overviewData] = await Promise.all([
          getCampaigns(),
          getDashboardOverview().catch(() => null),
        ]);
        if (!ignore) {
          setCampaigns(campaignsData);
          if (overviewData) setOverview(overviewData);
        }
      } catch (err) {
        if (!ignore) {
          if (err instanceof ApiClientError && err.status === 401) {
            router.push("/login?redirect=/");
            return;
          }
          setError(
            err instanceof ApiClientError
              ? err.message
              : "Failed to load campaigns. Please ensure the backend is reachable.",
          );
        }
      } finally {
        if (!ignore) setIsLoading(false);
      }
    });

    return () => {
      ignore = true;
    };
  }, [router]);

  const handleDeleteCampaign = async () => {
    if (!deletingCampaign) return;
    setIsDeleting(true);
    try {
      await deleteCampaign(deletingCampaign.id);
      setDeletingCampaign(null);
      await fetchCampaigns();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to delete campaign.",
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const getStatusBadge = (status: CampaignSummary["status"]) => {
    switch (status) {
      case "RUNNING":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-400 border border-amber-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-ping" />
            RUNNING
          </span>
        );
      case "COMPLETED":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400 border border-emerald-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            COMPLETED
          </span>
        );
      case "FAILED":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-400 border border-rose-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
            FAILED
          </span>
        );
      case "DRAFT":
      default:
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-300 border border-zinc-700">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
            DRAFT
          </span>
        );
    }
  };

  const totalLeads = campaigns.reduce((acc, c) => acc + (c.leadCount || 0), 0);
  const activeRuns = campaigns.filter((c) => c.status === "RUNNING").length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <Navbar onNewCampaign={() => setIsCreateModalOpen(true)} />

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Top Header & Stats */}
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between border-b border-zinc-800/80 pb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Campaigns Dashboard
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              Manage Instagram outreach campaigns, scraped leads, and profile datasets.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsCreateModalOpen(true)}
              id="header-create-campaign-btn"
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-500"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span>Create Campaign</span>
            </button>
          </div>
        </div>

        {/* Metrics Grid */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-xs">
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Total Campaigns</div>
            <div className="mt-2 text-3xl font-extrabold text-white">{overview?.stats.totalCampaigns ?? campaigns.length}</div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-xs">
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Total Leads Gathered</div>
            <div className="mt-2 text-3xl font-extrabold text-rose-400">{(overview?.stats.totalLeads ?? totalLeads).toLocaleString()}</div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-xs">
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Total Messages</div>
            <div className="mt-2 text-3xl font-extrabold text-emerald-400">{overview?.stats.totalMessages ?? 0}</div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-xs">
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Active Scraping Jobs</div>
            <div className="mt-2 text-3xl font-extrabold text-amber-400">{overview?.stats.activeRuns ?? activeRuns}</div>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mt-6 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 flex items-center justify-between text-sm text-rose-300">
            <div className="flex items-center gap-3">
              <svg className="h-5 w-5 text-rose-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <span>{error}</span>
            </div>
            <button
              onClick={fetchCampaigns}
              className="rounded-lg bg-rose-500/20 px-3 py-1 text-xs font-medium text-rose-200 hover:bg-rose-500/30"
            >
              Retry
            </button>
          </div>
        )}

        {/* Main Campaigns List Content */}
        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-zinc-200">Active & Saved Campaigns</h2>
            <button
              onClick={fetchCampaigns}
              disabled={isLoading}
              className="text-xs text-zinc-400 hover:text-zinc-200 transition flex items-center gap-1.5"
            >
              <svg
                className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              <span>Refresh</span>
            </button>
          </div>

          {isLoading ? (
            /* Loading Skeleton */
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-44 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 animate-pulse">
                  <div className="flex justify-between items-start">
                    <div className="h-5 w-36 rounded bg-zinc-800" />
                    <div className="h-5 w-16 rounded-full bg-zinc-800" />
                  </div>
                  <div className="mt-4 h-4 w-48 rounded bg-zinc-800/60" />
                  <div className="mt-8 flex justify-between">
                    <div className="h-4 w-20 rounded bg-zinc-800" />
                    <div className="h-4 w-24 rounded bg-zinc-800" />
                  </div>
                </div>
              ))}
            </div>
          ) : campaigns.length === 0 ? (
            /* Empty State */
            <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30 p-12 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-900 text-zinc-400 border border-zinc-800 shadow-inner">
                <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                  />
                </svg>
              </div>
              <h3 className="mt-4 text-base font-semibold text-zinc-100">No campaigns yet</h3>
              <p className="mt-1 text-sm text-zinc-400 max-w-sm mx-auto">
                Create your first campaign to scrape Instagram profiles, categorize accounts, and build your lead list.
              </p>
              <button
                onClick={() => setIsCreateModalOpen(true)}
                id="empty-create-btn"
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-rose-500"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <span>Create Campaign</span>
              </button>
            </div>
          ) : (
            /* Populated Campaign Grid */
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {campaigns.map((campaign) => (
                <div
                  key={campaign.id}
                  className="group relative flex flex-col justify-between rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 transition hover:border-zinc-700 hover:bg-zinc-900/90 shadow-sm"
                >
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <Link
                        href={`/campaigns/${campaign.id}`}
                        className="text-base font-bold text-zinc-100 group-hover:text-rose-400 transition truncate"
                      >
                        {campaign.name}
                      </Link>
                      {getStatusBadge(campaign.status)}
                    </div>

                    <p className="mt-2 text-xs text-zinc-400 line-clamp-2 min-h-[32px]">
                      {campaign.description || "No description provided."}
                    </p>

                    {/* Step 14 Intent & Discovery Configuration */}
                    <div className="mt-3 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 text-xs space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-zinc-500 font-medium shrink-0">Intent:</span>
                        <span className="text-zinc-200 text-right truncate" title={campaign.intent || undefined}>
                          {campaign.intent?.trim() ? campaign.intent : "Not specified"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-zinc-500 font-medium shrink-0">Location:</span>
                        <span className="text-zinc-200 text-right truncate">
                          {campaign.location?.trim() ? campaign.location : "Not specified"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-zinc-500 font-medium shrink-0">Category:</span>
                        <span className="text-zinc-200 text-right truncate">
                          {campaign.category?.trim() ? campaign.category : "Not specified"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-zinc-500 font-medium shrink-0">Lead Limit:</span>
                        <span className="font-semibold text-rose-400">
                          {campaign.leadLimit != null ? campaign.leadLimit : "Not specified"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 border-t border-zinc-800/80 pt-4">
                    <div className="flex items-center justify-between text-xs text-zinc-400">
                      <div className="flex items-center gap-4">
                        <div>
                          <span className="font-bold text-zinc-200">{campaign.leadCount || 0}</span> leads
                        </div>
                        <div>
                          <span className="font-bold text-zinc-200">{campaign.scrapeJobCount || 0}</span> scrapes
                        </div>
                      </div>

                      <span className="text-[11px] text-zinc-500">
                        {new Date(campaign.createdAt).toLocaleDateString()}
                      </span>
                    </div>

                    <div className="mt-4 flex items-center justify-between gap-2">
                      <Link
                        href={`/campaigns/${campaign.id}`}
                        className="flex-1 text-center rounded-lg bg-zinc-800/80 py-2 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700 hover:text-white"
                      >
                        Open Campaign &rarr;
                      </Link>
                      <button
                        type="button"
                        onClick={() => setDeletingCampaign(campaign)}
                        className="rounded-lg p-2 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-400 transition"
                        title="Delete Campaign"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Real Activity & Scrape Operations Grid */}
        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Recent System Activity */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Recent System Activity</h3>
                <p className="text-xs text-zinc-500">Live operational events derived from real database records</p>
              </div>
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-mono text-zinc-400">
                {overview?.recentActivity.length ?? 0} events
              </span>
            </div>

            {overview && overview.recentActivity.length > 0 ? (
              <div className="space-y-3">
                {overview.recentActivity.map((activity) => (
                  <div
                    key={activity.id}
                    className="flex items-start gap-3 rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-3"
                  >
                    <div className="mt-0.5">
                      {activity.type === "SCRAPE_COMPLETED" ? (
                        <div className="h-6 w-6 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold">✓</div>
                      ) : activity.type === "SCRAPE_FAILED" || activity.type === "MESSAGE_FAILED" ? (
                        <div className="h-6 w-6 rounded-full bg-rose-500/10 text-rose-400 flex items-center justify-center text-xs font-bold">✕</div>
                      ) : activity.type === "MESSAGE_SENT" ? (
                        <div className="h-6 w-6 rounded-full bg-blue-500/10 text-blue-400 flex items-center justify-center text-xs font-bold">✈</div>
                      ) : (
                        <div className="h-6 w-6 rounded-full bg-zinc-800 text-zinc-300 flex items-center justify-center text-xs font-bold">★</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-zinc-200 truncate">{activity.title}</span>
                        <span className="text-[10px] text-zinc-500 shrink-0 ml-2">
                          {new Date(activity.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-0.5">{activity.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-zinc-500">
                No recent activity recorded yet.
              </div>
            )}
          </div>

          {/* Recent Scrape Jobs Across Campaigns */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Recent Scrape Jobs</h3>
                <p className="text-xs text-zinc-500">Recent Apify profile extraction runs across all campaigns</p>
              </div>
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-mono text-zinc-400">
                {overview?.recentScrapeJobs.length ?? 0} jobs
              </span>
            </div>

            {overview && overview.recentScrapeJobs.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-800 text-zinc-400">
                    <tr>
                      <th className="pb-2 font-semibold">Campaign</th>
                      <th className="pb-2 font-semibold">Provider</th>
                      <th className="pb-2 font-semibold">Status</th>
                      <th className="pb-2 text-right font-semibold">Processed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {overview.recentScrapeJobs.map((job) => (
                      <tr key={job.id} className="hover:bg-zinc-800/20">
                        <td className="py-2.5 font-medium text-zinc-200 max-w-[140px] truncate">
                          <Link href={`/campaigns/${job.campaignId}`} className="hover:text-rose-400 transition">
                            {job.campaignName}
                          </Link>
                        </td>
                        <td className="py-2.5 font-mono uppercase text-zinc-400 text-[11px]">{job.provider}</td>
                        <td className="py-2.5">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${
                            job.status === "COMPLETED"
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : job.status === "FAILED"
                              ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                              : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          }`}>
                            {job.status}
                          </span>
                        </td>
                        <td className="py-2.5 text-right font-medium text-zinc-300">{job.processedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-zinc-500">
                No scrape jobs executed yet.
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Create Campaign Modal */}
      <CreateCampaignModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreated={fetchCampaigns}
      />

      {/* Delete Campaign Confirmation Modal */}
      <ConfirmModal
        isOpen={deletingCampaign !== null}
        title="Delete Campaign"
        message={`Are you sure you want to delete "${deletingCampaign?.name}"? All leads and scrape jobs in this campaign will be permanently deleted.`}
        confirmLabel="Delete Campaign"
        isDangerous={true}
        isLoading={isDeleting}
        onConfirm={handleDeleteCampaign}
        onCancel={() => setDeletingCampaign(null)}
      />
    </div>
  );
}
