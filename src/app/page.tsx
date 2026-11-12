"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getCampaigns, deleteCampaign, type CampaignSummary } from "@/lib/api/campaigns";
import { getDashboardOverview, type DashboardOverview } from "@/lib/api/analytics";
import { ApiClientError } from "@/lib/api/client";
import { Navbar } from "@/components/navbar";
import { CreateCampaignModal } from "@/components/create-campaign-modal";
import { EditCampaignModal } from "@/components/edit-campaign-modal";
import { ConfirmModal } from "@/components/confirm-modal";
import { Button, Card, CardTitle, CardDescription, Badge } from "@/components/ui";

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // Edit campaign state
  const [editingCampaign, setEditingCampaign] = useState<CampaignSummary | null>(null);

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
          <Badge variant="warning" dot className="animate-pulse">
            RUNNING
          </Badge>
        );
      case "COMPLETED":
        return (
          <Badge variant="success" dot>
            COMPLETED
          </Badge>
        );
      case "FAILED":
        return (
          <Badge variant="danger" dot>
            FAILED
          </Badge>
        );
      case "DRAFT":
      default:
        return (
          <Badge variant="neutral" dot>
            DRAFT
          </Badge>
        );
    }
  };

  const totalLeads = campaigns.reduce((acc, c) => acc + (c.leadCount || 0), 0);
  const activeRuns = campaigns.filter((c) => c.status === "RUNNING").length;

  return (
    <div className="min-h-screen bg-app text-primary flex flex-col transition-colors duration-150">
      <Navbar onNewCampaign={() => setIsCreateModalOpen(true)} />

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Top Header & Stats */}
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between border-b border-subtle pb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-primary sm:text-3xl">
              Campaigns Dashboard
            </h1>
            <p className="mt-1 text-sm text-muted">
              Manage Instagram outreach campaigns, scraped leads, and profile datasets.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              id="header-create-campaign-btn"
              onClick={() => setIsCreateModalOpen(true)}
              className="gap-2"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span>Create Campaign</span>
            </Button>
          </div>
        </div>

        {/* Metrics Grid */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">Total Campaigns</span>
              <span className="p-2 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </span>
            </div>
            <div className="mt-2 text-3xl font-extrabold tracking-tight text-primary">
              {overview?.stats.totalCampaigns ?? campaigns.length}
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">Total Leads Gathered</span>
              <span className="p-2 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </span>
            </div>
            <div className="mt-2 text-3xl font-extrabold tracking-tight text-indigo-600 dark:text-indigo-400">
              {(overview?.stats.totalLeads ?? totalLeads).toLocaleString()}
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">Total Messages</span>
              <span className="p-2 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </span>
            </div>
            <div className="mt-2 text-3xl font-extrabold tracking-tight text-emerald-600 dark:text-emerald-400">
              {overview?.stats.totalMessages ?? 0}
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">Active Scraping Jobs</span>
              <span className="p-2 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </span>
            </div>
            <div className="mt-2 text-3xl font-extrabold tracking-tight text-amber-600 dark:text-amber-400">
              {overview?.stats.activeRuns ?? activeRuns}
            </div>
          </Card>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mt-6 rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 flex items-center justify-between text-sm text-rose-700 dark:text-rose-300">
            <div className="flex items-center gap-3">
              <svg className="h-5 w-5 text-rose-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
              className="rounded-lg bg-rose-500/20 px-3 py-1 text-xs font-medium text-rose-700 dark:text-rose-200 hover:bg-rose-500/30 transition cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        {/* Main Campaigns List Content */}
        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-primary">Active & Saved Campaigns</h2>
            <button
              onClick={fetchCampaigns}
              disabled={isLoading}
              className="text-xs text-muted hover:text-primary transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
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
                <Card key={i} className="h-44 p-5 animate-pulse">
                  <div className="flex justify-between items-start">
                    <div className="h-5 w-36 rounded bg-subtle" />
                    <div className="h-5 w-16 rounded-full bg-subtle" />
                  </div>
                  <div className="mt-4 h-4 w-48 rounded bg-subtle" />
                  <div className="mt-8 flex justify-between">
                    <div className="h-4 w-20 rounded bg-subtle" />
                    <div className="h-4 w-24 rounded bg-subtle" />
                  </div>
                </Card>
              ))}
            </div>
          ) : campaigns.length === 0 ? (
            /* Empty State */
            <div className="rounded-2xl border border-dashed border-subtle bg-surface p-12 text-center shadow-card">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-subtle text-muted border border-subtle shadow-inner">
                <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                  />
                </svg>
              </div>
              <h3 className="mt-4 text-base font-semibold text-primary">No campaigns yet</h3>
              <p className="mt-1 text-sm text-muted max-w-sm mx-auto">
                Create your first campaign to scrape Instagram profiles, categorize accounts, and build your lead list.
              </p>
              <Button
                id="empty-create-btn"
                onClick={() => setIsCreateModalOpen(true)}
                className="mt-5 gap-2"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span>Create Campaign</span>
              </Button>
            </div>
          ) : (
            /* Populated Campaign Grid */
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {campaigns.map((campaign) => (
                <Card
                  key={campaign.id}
                  hoverable
                  className="group relative flex flex-col justify-between p-5"
                >
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <Link
                        href={`/campaigns/${campaign.id}`}
                        className="text-base font-bold text-primary group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition truncate"
                      >
                        {campaign.name}
                      </Link>
                      {getStatusBadge(campaign.status)}
                    </div>

                    <p className="mt-2 text-xs text-muted line-clamp-2 min-h-[32px]">
                      {campaign.description || "No description provided."}
                    </p>

                    {/* Intent & Discovery Configuration */}
                    <div className="mt-3 rounded-xl border border-subtle bg-subtle p-3 text-xs space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-muted font-medium shrink-0">Intent:</span>
                        <span className="text-primary text-right truncate font-medium" title={campaign.intent || undefined}>
                          {campaign.intent?.trim() ? campaign.intent : "Not specified"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted font-medium shrink-0">Location:</span>
                        <span className="text-primary text-right truncate font-medium">
                          {campaign.location?.trim() ? campaign.location : "Not specified"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted font-medium shrink-0">Category:</span>
                        <span className="text-primary text-right truncate font-medium">
                          {campaign.category?.trim() ? campaign.category : "Not specified"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted font-medium shrink-0">Lead Limit:</span>
                        <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                          {campaign.leadLimit != null ? campaign.leadLimit : "Not specified"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 border-t border-subtle pt-4">
                    <div className="flex items-center justify-between text-xs text-muted">
                      <div className="flex items-center gap-4">
                        <div>
                          <span className="font-bold text-primary">{campaign.leadCount || 0}</span> leads
                        </div>
                        <div>
                          <span className="font-bold text-primary">{campaign.scrapeJobCount || 0}</span> scrapes
                        </div>
                      </div>

                      <span className="text-[11px] text-muted">
                        {new Date(campaign.createdAt).toLocaleDateString()}
                      </span>
                    </div>

                    <div className="mt-4 flex items-center justify-between gap-2">
                      <Link
                        href={`/campaigns/${campaign.id}`}
                        className="flex-1 text-center rounded-lg bg-subtle hover:bg-surface-hover border border-subtle py-2 text-xs font-medium text-secondary hover:text-primary transition shadow-card"
                      >
                        Open Campaign &rarr;
                      </Link>
                      <button
                        type="button"
                        id={`edit-campaign-${campaign.id}`}
                        onClick={() => setEditingCampaign(campaign)}
                        className="rounded-lg p-2 text-muted hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400 transition cursor-pointer"
                        title="Edit Campaign"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeletingCampaign(campaign)}
                        className="rounded-lg p-2 text-muted hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 transition cursor-pointer"
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
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Real Activity & Scrape Operations Grid */}
        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Recent System Activity */}
          <Card className="p-5">
            <div className="flex items-center justify-between border-b border-subtle pb-3 mb-4">
              <div>
                <CardTitle className="text-sm">Recent System Activity</CardTitle>
                <CardDescription>Live operational events derived from real database records</CardDescription>
              </div>
              <Badge variant="neutral">
                {overview?.recentActivity.length ?? 0} events
              </Badge>
            </div>

            {overview && overview.recentActivity.length > 0 ? (
              <div className="space-y-3">
                {overview.recentActivity.map((activity) => (
                  <div
                    key={activity.id}
                    className="flex items-start gap-3 rounded-xl border border-subtle bg-subtle p-3"
                  >
                    <div className="mt-0.5">
                      {activity.type === "SCRAPE_COMPLETED" ? (
                        <div className="h-6 w-6 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-xs font-bold">✓</div>
                      ) : activity.type === "SCRAPE_FAILED" || activity.type === "MESSAGE_FAILED" ? (
                        <div className="h-6 w-6 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400 flex items-center justify-center text-xs font-bold">✕</div>
                      ) : activity.type === "MESSAGE_SENT" ? (
                        <div className="h-6 w-6 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400 flex items-center justify-center text-xs font-bold">✈</div>
                      ) : (
                        <div className="h-6 w-6 rounded-full bg-slate-500/15 text-slate-600 dark:text-slate-300 flex items-center justify-center text-xs font-bold">★</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-primary truncate">{activity.title}</span>
                        <span className="text-[10px] text-muted shrink-0 ml-2">
                          {new Date(activity.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <p className="text-xs text-muted mt-0.5">{activity.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-muted">
                No recent activity recorded yet.
              </div>
            )}
          </Card>

          {/* Recent Scrape Jobs Across Campaigns */}
          <Card className="p-5">
            <div className="flex items-center justify-between border-b border-subtle pb-3 mb-4">
              <div>
                <CardTitle className="text-sm">Recent Scrape Jobs</CardTitle>
                <CardDescription>Recent Apify profile extraction runs across all campaigns</CardDescription>
              </div>
              <Badge variant="neutral">
                {overview?.recentScrapeJobs.length ?? 0} jobs
              </Badge>
            </div>

            {overview && overview.recentScrapeJobs.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-subtle text-muted">
                    <tr>
                      <th className="pb-2 font-semibold">Campaign</th>
                      <th className="pb-2 font-semibold">Provider</th>
                      <th className="pb-2 font-semibold">Status</th>
                      <th className="pb-2 text-right font-semibold">Processed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-subtle">
                    {overview.recentScrapeJobs.map((job) => (
                      <tr key={job.id} className="hover:bg-surface-hover transition-colors">
                        <td className="py-2.5 font-medium text-primary max-w-[140px] truncate">
                          <Link href={`/campaigns/${job.campaignId}`} className="hover:text-indigo-600 dark:hover:text-indigo-400 transition">
                            {job.campaignName}
                          </Link>
                        </td>
                        <td className="py-2.5 font-mono uppercase text-muted text-[11px]">{job.provider}</td>
                        <td className="py-2.5">
                          {job.status === "COMPLETED" ? (
                            <Badge variant="success" dot>{job.status}</Badge>
                          ) : job.status === "FAILED" ? (
                            <Badge variant="danger" dot>{job.status}</Badge>
                          ) : (
                            <Badge variant="warning" dot>{job.status}</Badge>
                          )}
                        </td>
                        <td className="py-2.5 text-right font-semibold text-primary">{job.processedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-muted">
                No scrape jobs executed yet.
              </div>
            )}
          </Card>
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

      {/* Edit Campaign Modal */}
      {editingCampaign && (
        <EditCampaignModal
          isOpen={editingCampaign !== null}
          campaign={editingCampaign}
          onClose={() => setEditingCampaign(null)}
          onUpdated={() => {
            fetchCampaigns();
            setEditingCampaign(null);
          }}
        />
      )}
    </div>
  );
}
