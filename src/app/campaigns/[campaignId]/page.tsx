"use client";

import { useEffect, useState, useCallback, useRef, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { deleteCampaign, getCampaign, updateCampaign, type CampaignDetail } from "@/lib/api/campaigns";
import { listCompanyProfiles, type CompanyProfilesListItem } from "@/lib/api/company-profile";
import { getCampaignLeads, type Lead, type PaginatedLeads } from "@/lib/api/leads";
import { getCampaignScrapeJobs, type ScrapeJobItem } from "@/lib/api/scraper";
import { ApiClientError } from "@/lib/api/client";
import { Navbar } from "@/components/navbar";
import { ScrapeLeadsModal } from "@/components/scrape-leads-modal";
import { LeadDetailDrawer } from "@/components/lead-detail-drawer";
import { ConfirmModal } from "@/components/confirm-modal";
import { CampaignTemplatesTab } from "@/components/campaign-templates-tab";
import { CampaignAiCard } from "@/components/campaign-ai-card";
import { CampaignApprovalCard } from "@/components/campaign-approval-card";
import { CampaignExecutionTab } from "@/components/campaign-execution-tab";
import { CampaignAnalyticsTab } from "@/components/campaign-analytics-tab";
import { CampaignReviewQueueTab } from "@/components/campaign-review-queue-tab";
import { LeadAvatar } from "@/components/lead-avatar";
import { SocialPlatformIcon, getLeadLinkClassification } from "@/components/social-platform-icon";
import { BulkMessageModal } from "@/components/bulk-message-modal";
import { BulkJobProgressPanel } from "@/components/bulk-job-progress-panel";
import { CampaignExecutionControlPanel } from "@/components/campaign-execution-control-panel";
import { getCampaignAnalytics, type CampaignAnalytics } from "@/lib/api/analytics";
import { isTerminalBulkJobStatus } from "@/lib/polling/job-polling";

export default function CampaignDetailPage() {
  const params = useParams();
  const router = useRouter();
  const campaignId = params.campaignId as string;

  const [, startTransition] = useTransition();

  // Campaign State
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [overviewStats, setOverviewStats] = useState<CampaignAnalytics | null>(null);
  const [isCampaignLoading, setIsCampaignLoading] = useState(true);
  const [campaignError, setCampaignError] = useState<string | null>(null);

  // Leads State
  const [leadsData, setLeadsData] = useState<PaginatedLeads | null>(null);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [isLeadsLoading, setIsLeadsLoading] = useState(false);
  const [leadsError, setLeadsError] = useState<string | null>(null);

  // Profile change state
  const [isChangingProfile, setIsChangingProfile] = useState(false);
  const [availableProfiles, setAvailableProfiles] = useState<CompanyProfilesListItem[]>([]);
  const [selectedChangeProfileId, setSelectedChangeProfileId] = useState("");
  const [isSavingProfileChange, setIsSavingProfileChange] = useState(false);

  const handleOpenChangeProfile = async () => {
    setIsChangingProfile(true);
    try {
      const res = await listCompanyProfiles();
      setAvailableProfiles(res.profiles);
      setSelectedChangeProfileId(campaign?.companyProfileId || (res.profiles[0]?.profile.id ?? ""));
    } catch {
      // ignore
    }
  };

  const handleSaveProfileChange = async () => {
    if (!selectedChangeProfileId || !campaign) return;
    setIsSavingProfileChange(true);
    try {
      await updateCampaign(campaign.id, { companyProfileId: selectedChangeProfileId });
      const updatedCamp = await getCampaign(campaign.id);
      setCampaign(updatedCamp);
      setIsChangingProfile(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to change company profile");
    } finally {
      setIsSavingProfileChange(false);
    }
  };
  const [activeTab, setActiveTab] = useState<"leads" | "history" | "templates" | "execution" | "analytics" | "review">("leads");
  const [isScrapeModalOpen, setIsScrapeModalOpen] = useState(false);
  const [showDeleteCampaignModal, setShowDeleteCampaignModal] = useState(false);
  const [isDeletingCampaign, setIsDeletingCampaign] = useState(false);
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);
  const [drawerInitialTab, setDrawerInitialTab] = useState<"profile" | "message">("profile");

  // Scrape Jobs State
  const [scrapeJobs, setScrapeJobs] = useState<ScrapeJobItem[]>([]);
  const [isJobsLoading, setIsJobsLoading] = useState(false);

  // Lead Selection & Bulk Messaging
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [bulkSelectionMode, setBulkSelectionMode] = useState<"selected" | "allEligible">("selected");
  const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
  const [activeBulkJobId, setActiveBulkJobId] = useState<string | null>(null);

  const selectedLeadIdSet = new Set(selectedLeadIds);
  const selectedLeads = (leadsData?.items ?? []).filter((l) => selectedLeadIdSet.has(l.id));

  const selectAllVisibleLeads = () => {
    if (!leadsData) return;
    setBulkSelectionMode("selected");
    setSelectedLeadIds(
      leadsData.items
        .filter(
          (l) =>
            l.status !== "DO_NOT_CONTACT" &&
            (l as { leadStatus?: string }).leadStatus !== "DO_NOT_CONTACT",
        )
        .map((l) => l.id),
    );
  };

  const selectAllCampaignLeads = () => {
    setBulkSelectionMode("allEligible");
    setSelectedLeadIds([]);
  };

  const clearLeadSelection = () => {
    setBulkSelectionMode("selected");
    setSelectedLeadIds([]);
  };

  const toggleLeadSelection = (leadId: string) => {
    const targetLead = leadsData?.items.find((l) => l.id === leadId);
    if (
      targetLead &&
      (targetLead.status === "DO_NOT_CONTACT" ||
        (targetLead as { leadStatus?: string }).leadStatus === "DO_NOT_CONTACT")
    ) {
      return; // DO_NOT_CONTACT leads are unselectable for bulk send
    }
    setBulkSelectionMode("selected");
    setSelectedLeadIds((prev) =>
      prev.includes(leadId) ? prev.filter((id) => id !== leadId) : [...prev, leadId],
    );
  };

  // Leads Filter & Pagination State (initialized from URL if present)
  const [page, setPage] = useState(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search).get("page");
      if (p && /^\d+$/.test(p) && Number.parseInt(p, 10) >= 1) {
        return Number.parseInt(p, 10);
      }
    }
    return 1;
  });

  const [limit, setLimit] = useState(() => {
    if (typeof window !== "undefined") {
      const l = new URLSearchParams(window.location.search).get("limit");
      if (l && /^\d+$/.test(l)) {
        const parsedL = Number.parseInt(l, 10);
        if ([10, 25, 50, 100].includes(parsedL)) {
          return parsedL;
        }
      }
    }
    return 25;
  });

  const [searchInput, setSearchInput] = useState(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("search") ?? "";
    }
    return "";
  });

  const [searchQuery, setSearchQuery] = useState(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("search") ?? "";
    }
    return "";
  });

  const [categoryFilter, setCategoryFilter] = useState(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("category") ?? "";
    }
    return "";
  });

  const [verifiedFilter, setVerifiedFilter] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const v = new URLSearchParams(window.location.search).get("verified");
      if (v === "true" || v === "verified") return "verified";
      if (v === "false" || v === "unverified") return "unverified";
    }
    return "all";
  });

  const [businessFilter, setBusinessFilter] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const b =
        new URLSearchParams(window.location.search).get("business") ??
        new URLSearchParams(window.location.search).get("isBusinessAccount");
      if (b === "true" || b === "business") return "business";
      if (b === "false" || b === "personal") return "personal";
    }
    return "all";
  });

  const [statusFilter, setStatusFilter] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const st = new URLSearchParams(window.location.search).get("status");
      if (st && ["NEW", "CONTACTED", "SENDING", "FAILED"].includes(st.toUpperCase())) {
        return st.toUpperCase();
      }
    }
    return "all";
  });

  const [channelFilter, setChannelFilter] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const ch = new URLSearchParams(window.location.search).get("channel");
      if (ch && ["has_email", "has_phone", "instagram_only"].includes(ch.toLowerCase())) {
        return ch.toLowerCase();
      }
    }
    return "all";
  });

  // Synchronize state with URL query parameters without reloading
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (limit !== 25) params.set("limit", String(limit));
    if (searchQuery) params.set("search", searchQuery);
    if (categoryFilter) params.set("category", categoryFilter);
    if (verifiedFilter !== "all") params.set("verified", verifiedFilter);
    if (businessFilter !== "all") params.set("business", businessFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (channelFilter !== "all") params.set("channel", channelFilter);

    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", newUrl);
  }, [page, limit, searchQuery, categoryFilter, verifiedFilter, businessFilter, statusFilter, channelFilter]);

  // Fetch campaign info
  const fetchCampaignInfo = useCallback(async (showLoading = false) => {
    if (!campaignId) return;
    if (showLoading) setIsCampaignLoading(true);
    setCampaignError(null);
    try {
      const [campaignRes, statsRes] = await Promise.all([
        getCampaign(campaignId),
        getCampaignAnalytics(campaignId).catch(() => null),
      ]);
      setCampaign(campaignRes);
      if (statsRes) setOverviewStats(statsRes);
    } catch (err) {
      setCampaignError(
        err instanceof ApiClientError ? err.message : "Failed to load campaign.",
      );
    } finally {
      if (showLoading) setIsCampaignLoading(false);
    }
  }, [campaignId]);

  // Fetch leads with active filters
  const fetchLeads = useCallback(async () => {
    if (!campaignId) return;
    setIsLeadsLoading(true);
    setLeadsError(null);
    try {
      const isVerified =
        verifiedFilter === "verified"
          ? true
          : verifiedFilter === "unverified"
          ? false
          : undefined;

      const isBusiness =
        businessFilter === "business"
          ? true
          : businessFilter === "personal"
          ? false
          : undefined;

      const status = statusFilter !== "all" ? statusFilter : undefined;

      const data = await getCampaignLeads(campaignId, {
        page,
        limit,
        search: searchQuery || undefined,
        category: categoryFilter || undefined,
        isVerified,
        isBusiness,
        status,
        channel: channelFilter !== "all" ? channelFilter : undefined,
        excludeDuplicates: !showDuplicates,
      });
      setLeadsData(data);
    } catch (err) {
      setLeadsError(
        err instanceof ApiClientError ? err.message : "Failed to load leads.",
      );
    } finally {
      setIsLeadsLoading(false);
    }
  }, [campaignId, page, limit, searchQuery, categoryFilter, verifiedFilter, businessFilter, statusFilter, channelFilter, showDuplicates]);

  // Fetch scrape jobs
  const fetchJobs = useCallback(async () => {
    if (!campaignId) return;
    setIsJobsLoading(true);
    try {
      const data = await getCampaignScrapeJobs(campaignId);
      setScrapeJobs(data);
    } catch {
      // Ignored or handled gracefully
    } finally {
      setIsJobsLoading(false);
    }
  }, [campaignId]);

  // Refresh campaign data exactly once when a bulk job reaches a terminal
  // state. Stable identity so it never re-triggers the panel's polling effect.
  const bulkTerminalRefreshedRef = useRef(false);
  const handleBulkJobStatusChange = useCallback(
    (status: string) => {
      if (!isTerminalBulkJobStatus(status)) return;
      if (bulkTerminalRefreshedRef.current) return;
      bulkTerminalRefreshedRef.current = true;
      fetchLeads();
      fetchCampaignInfo();
    },
    [fetchLeads, fetchCampaignInfo],
  );

  // A new job starts a new one-shot terminal refresh.
  useEffect(() => {
    bulkTerminalRefreshedRef.current = false;
  }, [activeBulkJobId]);

  const handleBulkJobClose = useCallback(() => {
    setActiveBulkJobId(null);
  }, []);

  // Initial load
  useEffect(() => {
    let ignore = false;
    Promise.resolve().then(() => {
      if (ignore) return;
      fetchCampaignInfo(true);
      fetchJobs();
    });
    return () => {
      ignore = true;
    };
  }, [fetchCampaignInfo, fetchJobs]);

  useEffect(() => {
    let ignore = false;
    Promise.resolve().then(() => {
      if (ignore) return;
      fetchLeads();
    });
    return () => {
      ignore = true;
    };
  }, [fetchLeads]);

  // Selection is scoped to the visible page/filter set.
  useEffect(() => {
    let ignore = false;
    Promise.resolve().then(() => {
      if (!ignore) setSelectedLeadIds([]);
    });
    return () => {
      ignore = true;
    };
  }, [page, searchQuery, categoryFilter, verifiedFilter, businessFilter, statusFilter]);

  // Debounced search handler
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(searchInput);
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const handleFilterChange = () => {
    setPage(1);
  };

  const resetFilters = () => {
    setSearchInput("");
    setSearchQuery("");
    setCategoryFilter("");
    setVerifiedFilter("all");
    setBusinessFilter("all");
    setStatusFilter("all");
    setChannelFilter("all");
    setPage(1);
  };

  const [analyticsRefreshTrigger, setAnalyticsRefreshTrigger] = useState(0);

  // Stable handler for the execution engine panel (avoids re-subscribing its
  // polling effect on every parent render).
  const handleExecutionStateChange = useCallback(() => {
    fetchCampaignInfo();
    fetchLeads();
    fetchJobs();
    setAnalyticsRefreshTrigger((prev) => prev + 1);
  }, [fetchCampaignInfo, fetchLeads, fetchJobs]);

  const handleScrapeCompleted = () => {
    setPage(1);
    fetchCampaignInfo();
    fetchLeads();
    fetchJobs();
    setAnalyticsRefreshTrigger((prev) => prev + 1);
  };

  const handleDeleteCampaign = async () => {
    if (!campaignId) return;
    setIsDeletingCampaign(true);
    try {
      await deleteCampaign(campaignId);
      setShowDeleteCampaignModal(false);
      startTransition(() => {
        router.push("/");
      });
    } catch (err) {
      setCampaignError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to delete campaign.",
      );
    } finally {
      setIsDeletingCampaign(false);
    }
  };

  const formatNumber = (num: number | null) => {
    if (num === null || num === undefined) return "—";
    if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
    if (num >= 1000) return (num / 1000).toFixed(1) + "K";
    return num.toLocaleString();
  };

  const getStatusBadge = (status: string) => {
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
      case "PARTIAL":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 px-2.5 py-0.5 text-xs font-medium text-cyan-400 border border-cyan-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
            PARTIAL
          </span>
        );
      case "PAUSED":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-2.5 py-0.5 text-xs font-medium text-yellow-400 border border-yellow-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
            PAUSED
          </span>
        );
      case "FAILED":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-400 border border-rose-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
            FAILED
          </span>
        );
      case "CANCELLED":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-500/10 px-2.5 py-0.5 text-xs font-medium text-zinc-400 border border-zinc-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
            CANCELLED
          </span>
        );
      case "READY":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-400 border border-blue-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
            READY
          </span>
        );
      case "PENDING":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-400 border border-blue-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
            PENDING
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

  if (isCampaignLoading && !campaign) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
        <Navbar />
        <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8 animate-pulse">
          <div className="h-6 w-32 rounded bg-zinc-800" />
          <div className="mt-4 h-8 w-64 rounded bg-zinc-800" />
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5" />
            ))}
          </div>
        </main>
      </div>
    );
  }

  if (campaignError || !campaign) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
        <Navbar />
        <main className="flex-1 mx-auto w-full max-w-4xl px-4 py-16 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="mt-4 text-xl font-bold text-white">Campaign Not Found</h2>
          <p className="mt-2 text-sm text-zinc-400">
            {campaignError || "The campaign you requested does not exist or has been deleted."}
          </p>
          <div className="mt-6">
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700"
            >
              &larr; Back to Campaigns
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <Navbar />

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <Link href="/" className="hover:text-zinc-200 transition">
            Campaigns
          </Link>
          <span>/</span>
          <span className="text-zinc-200 font-medium truncate max-w-xs">{campaign.name}</span>
        </div>

        {/* Campaign Header */}
        <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-center md:justify-between border-b border-zinc-800/80 pb-6">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                {campaign.name}
              </h1>
              {getStatusBadge(campaign.status)}
            </div>
            <p className="mt-1 text-sm text-zinc-400 max-w-2xl">
              {campaign.description || "No description provided."}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowDeleteCampaignModal(true)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-zinc-300 hover:border-rose-900/50 hover:bg-rose-950/30 hover:text-rose-300 transition"
            >
              Delete Campaign
            </button>
            <button
              onClick={() => setIsScrapeModalOpen(true)}
              id="scrape-leads-btn"
              disabled={
                campaign.leadLimit != null &&
                (leadsData?.pagination.total ?? campaign.leadCount ?? 0) >= campaign.leadLimit
              }
              title={
                campaign.leadLimit != null &&
                (leadsData?.pagination.total ?? campaign.leadCount ?? 0) >= campaign.leadLimit
                  ? "Campaign has reached its configured lead limit"
                  : undefined
              }
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-rose-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-rose-500 hover:to-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <span>
                {campaign.leadLimit != null &&
                (leadsData?.pagination.total ?? campaign.leadCount ?? 0) >= campaign.leadLimit
                  ? "Lead Limit Reached"
                  : "Scrape Leads"}
              </span>
            </button>
          </div>
        </div>

        {/* Task 8 & 9 Authoritative Campaign Execution Control Bar */}
        <div className="mt-6">
          <CampaignExecutionControlPanel
            campaignId={campaign.id}
            initialStatus={campaign.status}
            onStateChange={handleExecutionStateChange}
          />
        </div>

        {/* Campaign Configuration Details (Step 14 Intent & Parameters) */}
        <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-sm">
          <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3 mb-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-500/10 text-rose-400">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">Campaign Details</h2>
                <p className="text-xs text-zinc-400">Target audience criteria & scrape discovery parameters</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-zinc-800/80 px-2.5 py-1 text-[11px] font-mono text-zinc-400 border border-zinc-700/60">
                Step 14 Intent
              </span>
              {campaign.leadLimit != null &&
              (leadsData?.pagination.total ?? campaign.leadCount ?? 0) >= campaign.leadLimit ? (
                <span
                  id="intent-card-capacity-reached"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 text-xs font-semibold text-amber-300"
                >
                  Lead Limit Reached
                </span>
              ) : (
                <button
                  type="button"
                  id="intent-card-discover-btn"
                  onClick={() => setIsScrapeModalOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600/20 border border-indigo-400/20 px-2.5 py-1 text-xs font-semibold text-indigo-300 hover:bg-indigo-600/30 transition"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span>Discover Leads</span>
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {/* Intent */}
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3.5 flex flex-col justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400">
                <span className="font-mono text-rose-400">├──</span>
                <span>Intent</span>
              </div>
              <div className="mt-2 text-sm font-medium text-zinc-100 break-words" title={campaign.intent || undefined}>
                {campaign.intent?.trim() ? (
                  campaign.intent
                ) : (
                  <span className="text-zinc-500 italic">Not specified</span>
                )}
              </div>
            </div>

            {/* Location */}
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3.5 flex flex-col justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400">
                <span className="font-mono text-indigo-400">├──</span>
                <span>Location</span>
              </div>
              <div className="mt-2 text-sm font-medium text-zinc-100 break-words">
                {campaign.location?.trim() ? (
                  campaign.location
                ) : (
                  <span className="text-zinc-500 italic">Not specified</span>
                )}
              </div>
            </div>

            {/* Category */}
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3.5 flex flex-col justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400">
                <span className="font-mono text-amber-400">├──</span>
                <span>Category</span>
              </div>
              <div className="mt-2 text-sm font-medium text-zinc-100 break-words">
                {campaign.category?.trim() ? (
                  campaign.category
                ) : (
                  <span className="text-zinc-500 italic">Not specified</span>
                )}
              </div>
            </div>

            {/* Lead Limit */}
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3.5 flex flex-col justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400">
                <span className="font-mono text-emerald-400">├──</span>
                <span>Lead Limit</span>
              </div>
              <div className="mt-2 text-sm font-bold text-rose-400">
                {campaign.leadLimit != null ? (
                  `${campaign.leadLimit} leads`
                ) : (
                  <span className="text-zinc-500 font-normal italic">Not specified</span>
                )}
              </div>
            </div>

            {/* Attached Company Profile */}
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3.5 flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs font-semibold text-zinc-400">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-purple-400">└──</span>
                  <span>Company Profile</span>
                </div>
                <button
                  type="button"
                  id="change-company-profile-btn"
                  onClick={handleOpenChangeProfile}
                  className="text-[10px] text-rose-400 hover:text-rose-300 font-medium underline transition"
                >
                  Change
                </button>
              </div>
              <div className="mt-2 text-sm font-semibold text-zinc-100 truncate" title={campaign.companyProfile?.name}>
                {campaign.companyProfile?.name || "Attached Profile"}
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
                <span>{campaign.companyProfile?.isDefault ? "Default" : "Custom"}</span>
                <Link href="/settings" className="hover:text-zinc-300 transition text-[10px]">
                  Edit in Settings →
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* Change Profile Modal */}
        {isChangingProfile && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
            <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl space-y-4">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                <h3 className="text-sm font-semibold text-zinc-100">Change Attached Company Profile</h3>
                <button
                  onClick={() => setIsChangingProfile(false)}
                  className="text-zinc-400 hover:text-zinc-200 text-sm"
                >
                  &times;
                </button>
              </div>
              <p className="text-xs text-zinc-400">
                Select which company context (services, brand tone, forbidden claims) this campaign and Gemini AI should use.
              </p>
              <div>
                <label className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                  Select Profile
                </label>
                <select
                  id="change-profile-select"
                  value={selectedChangeProfileId}
                  onChange={(e) => setSelectedChangeProfileId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-rose-500 focus:outline-none"
                >
                  {availableProfiles.map(({ profile, completeness }) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} — {completeness.complete ? "✓ Ready for AI" : `⚠ Incomplete (${completeness.missingFields.length} missing)`}
                      {profile.isDefault ? " [Default]" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsChangingProfile(false)}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  id="confirm-change-profile-btn"
                  onClick={handleSaveProfileChange}
                  disabled={isSavingProfileChange || !selectedChangeProfileId}
                  className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 transition disabled:opacity-50"
                >
                  {isSavingProfileChange ? "Updating..." : "Save Profile"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Stats Strip - Real DB Aggregates */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-9">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] text-zinc-500 uppercase font-semibold">Total Leads</div>
            <div className="mt-1 text-xl font-extrabold text-white">{overviewStats?.leads.total ?? campaign.leadCount ?? 0}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] text-zinc-500 uppercase font-semibold">Verified Leads</div>
            <div className="mt-1 text-xl font-extrabold text-emerald-400">{overviewStats?.leads.verified ?? 0}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] text-zinc-500 uppercase font-semibold">Business Leads</div>
            <div className="mt-1 text-xl font-extrabold text-indigo-400">{overviewStats?.leads.business ?? 0}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] text-zinc-500 uppercase font-semibold">Scrape Jobs</div>
            <div className="mt-1 text-xl font-extrabold text-white">{overviewStats?.scraping.jobs ?? campaign.scrapeJobCount ?? 0}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] text-zinc-500 uppercase font-semibold">Messages Sent</div>
            <div className="mt-1 text-xl font-extrabold text-emerald-400">{overviewStats?.messages.sent ?? 0}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] text-zinc-500 uppercase font-semibold">Messages Failed</div>
            <div className="mt-1 text-xl font-extrabold text-rose-400">{overviewStats?.messages.failed ?? 0}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] text-zinc-500 uppercase font-semibold">Pending Review</div>
            <div className="mt-1 text-xl font-extrabold text-amber-400">{overviewStats?.execution.pending ?? 0}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] text-zinc-500 uppercase font-semibold">Approved</div>
            <div className="mt-1 text-xl font-extrabold text-emerald-400">{overviewStats?.execution.approved ?? 0}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] text-zinc-500 uppercase font-semibold">Skipped</div>
            <div className="mt-1 text-xl font-extrabold text-zinc-400">{overviewStats?.execution.skipped ?? 0}</div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="mt-8 flex items-center gap-4 border-b border-zinc-800 overflow-x-auto">
          <button
            onClick={() => setActiveTab("leads")}
            id="tab-leads"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${
              activeTab === "leads"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Leads Directory ({leadsData?.pagination.total ?? campaign.leadCount ?? 0})
          </button>
          <button
            onClick={() => setActiveTab("analytics")}
            id="tab-analytics"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${
              activeTab === "analytics"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Analytics
          </button>
          <button
            onClick={() => setActiveTab("review")}
            id="tab-review"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${
              activeTab === "review"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Review Queue
          </button>
          <button
            onClick={() => setActiveTab("templates")}
            id="tab-templates"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${
              activeTab === "templates"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Message Templates
          </button>
          <button
            onClick={() => setActiveTab("execution")}
            id="tab-execution"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${
              activeTab === "execution"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Campaign Execution
          </button>
          <button
            onClick={() => setActiveTab("history")}
            id="tab-history"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${
              activeTab === "history"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Scrape History ({scrapeJobs.length})
          </button>
        </div>

        {/* Tab 1: Leads Directory */}
        {campaign && (
          <>
            <CampaignAiCard
              campaignId={campaign.id}
              companyProfileId={campaign.companyProfileId}
              companyProfileName={campaign.companyProfile?.name}
            />
            <CampaignApprovalCard
              campaignId={campaign.id}
              requireApproval={campaign.requireApproval}
              approvalMode={campaign.approvalMode}
              autoApproveMinScore={campaign.autoApproveMinScore}
              qualityMaxRegenerations={campaign.qualityMaxRegenerations}
              onUpdated={(updated) => {
                setCampaign((prev) => (prev ? { ...prev, ...updated } : prev));
              }}
            />
          </>
        )}

        {activeTab === "leads" && (
          <div className="mt-6 space-y-4">
            {/* Filter Toolbar */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
                {/* Search */}
                <div className="lg:col-span-2">
                  <label htmlFor="search-leads" className="block text-[11px] font-semibold uppercase text-zinc-400">Search</label>
                  <div className="relative mt-1">
                    <input
                      id="search-leads"
                      type="text"
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                      placeholder="Search username, name, or bio..."
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-rose-500 focus:outline-none"
                    />
                    {searchInput && (
                      <button
                        onClick={() => setSearchInput("")}
                        className="absolute right-2.5 top-2 text-zinc-500 hover:text-zinc-300"
                      >
                        &times;
                      </button>
                    )}
                  </div>
                </div>

                {/* Category Filter */}
                <div>
                  <label htmlFor="filter-category" className="block text-[11px] font-semibold uppercase text-zinc-400">Category</label>
                  <input
                    id="filter-category"
                    type="text"
                    value={categoryFilter}
                    onChange={(e) => {
                      setCategoryFilter(e.target.value);
                      handleFilterChange();
                    }}
                    placeholder="e.g. Fitness"
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-rose-500 focus:outline-none"
                  />
                </div>

                {/* Verified Filter */}
                <div>
                  <label htmlFor="filter-verified" className="block text-[11px] font-semibold uppercase text-zinc-400">Verified</label>
                  <select
                    id="filter-verified"
                    value={verifiedFilter}
                    onChange={(e) => {
                      setVerifiedFilter(e.target.value);
                      handleFilterChange();
                    }}
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                  >
                    <option value="all">All Accounts</option>
                    <option value="verified">Verified Only</option>
                    <option value="unverified">Non-Verified</option>
                  </select>
                </div>

                {/* Business Filter */}
                <div>
                  <label htmlFor="filter-business" className="block text-[11px] font-semibold uppercase text-zinc-400">Business</label>
                  <select
                    id="filter-business"
                    value={businessFilter}
                    onChange={(e) => {
                      setBusinessFilter(e.target.value);
                      handleFilterChange();
                    }}
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                  >
                    <option value="all">All Types</option>
                    <option value="business">Business Only</option>
                    <option value="personal">Personal Only</option>
                  </select>
                </div>

                {/* Status Filter */}
                <div>
                  <label htmlFor="filter-status" className="block text-[11px] font-semibold uppercase text-zinc-400">Status</label>
                  <select
                    id="filter-status"
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value);
                      handleFilterChange();
                    }}
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                  >
                    <option value="all">All Statuses</option>
                    <option value="NEW">New (Uncontacted)</option>
                    <option value="CONTACTED">Contacted</option>
                    <option value="SENDING">Sending</option>
                    <option value="FAILED">Failed</option>
                  </select>
                </div>

                {/* Channel Filter (Part E) */}
                <div>
                  <label htmlFor="filter-channel" className="block text-[11px] font-semibold uppercase text-zinc-400">Channel</label>
                  <select
                    id="filter-channel"
                    value={channelFilter}
                    onChange={(e) => {
                      setChannelFilter(e.target.value);
                      handleFilterChange();
                    }}
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                  >
                    <option value="all">All Channels</option>
                    <option value="has_email">Has Email</option>
                    <option value="has_phone">Has Phone</option>
                    <option value="instagram_only">Instagram Only</option>
                  </select>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <input
                  id="show-duplicates"
                  type="checkbox"
                  checked={showDuplicates}
                  onChange={(e) => {
                    setShowDuplicates(e.target.checked);
                    setPage(1);
                  }}
                  className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-950"
                />
                <label htmlFor="show-duplicates" className="text-[11px] text-zinc-400">
                  Show duplicates (duplicate-linked leads are hidden by default)
                </label>
              </div>

              {(searchQuery || categoryFilter || verifiedFilter !== "all" || businessFilter !== "all" || statusFilter !== "all" || channelFilter !== "all") && (
                <div className="flex items-center justify-between border-t border-zinc-800/80 pt-2 text-xs">
                  <span className="text-zinc-400">Active filters applied</span>
                  <button
                    onClick={resetFilters}
                    className="text-xs text-rose-400 hover:text-rose-300 transition"
                  >
                    Reset all filters
                  </button>
                </div>
              )}
            </div>

            {/* Error Message */}
            {leadsError && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                {leadsError}
              </div>
            )}

            {/* Active Bulk Job Progress Panel */}
            {activeBulkJobId && (
              <BulkJobProgressPanel
                jobId={activeBulkJobId}
                onClose={handleBulkJobClose}
                onJobStatusChange={handleBulkJobStatusChange}
              />
            )}

            {/* Selection Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  id="btn-select-all-visible"
                  onClick={selectAllVisibleLeads}
                  disabled={!leadsData || leadsData.items.length === 0}
                  className={`rounded-lg border px-3 py-1.5 font-medium transition disabled:opacity-40 ${
                    bulkSelectionMode === "selected" &&
                    selectedLeadIds.length > 0 &&
                    leadsData?.items.length === selectedLeadIds.length
                      ? "border-rose-500/60 bg-rose-500/20 text-rose-200"
                      : "border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                  }`}
                >
                  Select Visible ({leadsData?.items.length ?? 0})
                </button>
                <button
                  type="button"
                  id="btn-select-all-campaign"
                  onClick={selectAllCampaignLeads}
                  disabled={!campaign || (leadsData?.pagination.total ?? campaign.leadCount ?? 0) === 0}
                  className={`rounded-lg border px-3 py-1.5 font-medium transition disabled:opacity-40 ${
                    bulkSelectionMode === "allEligible"
                      ? "border-rose-500/60 bg-rose-500/20 text-rose-200"
                      : "border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                  }`}
                >
                  Select All in Campaign ({leadsData?.pagination.total ?? campaign.leadCount ?? 0})
                </button>
                <button
                  type="button"
                  id="btn-clear-selection"
                  onClick={clearLeadSelection}
                  disabled={selectedLeadIds.length === 0 && bulkSelectionMode !== "allEligible"}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
                >
                  Clear Selection
                </button>
              </div>

              <div className="flex items-center gap-3">
                <span className="text-zinc-400">
                  Target:{" "}
                  <strong className="text-zinc-100">
                    {bulkSelectionMode === "allEligible"
                      ? `All Eligible (${leadsData?.pagination.total ?? campaign.leadCount ?? 0})`
                      : `${selectedLeadIds.length} selected`}
                  </strong>
                </span>
                <button
                  type="button"
                  id="btn-open-bulk-messaging"
                  disabled={selectedLeadIds.length === 0 && bulkSelectionMode !== "allEligible"}
                  onClick={() => setIsBulkModalOpen(true)}
                  className="rounded-lg bg-rose-600 px-3.5 py-1.5 font-semibold text-white shadow-md shadow-rose-950/40 transition hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  <span>✉ Bulk Message</span>
                  {(selectedLeadIds.length > 0 || bulkSelectionMode === "allEligible") && (
                    <span className="rounded-full bg-rose-700/80 px-1.5 py-0.5 text-[10px]">
                      {bulkSelectionMode === "allEligible"
                        ? leadsData?.pagination.total ?? campaign.leadCount ?? 0
                        : selectedLeadIds.length}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Leads Table */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden shadow-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-800 bg-zinc-950/80 text-zinc-400 uppercase font-semibold">
                    <tr>
                      <th className="w-8 py-3 px-3">
                        <input
                          type="checkbox"
                          aria-label="Select all visible leads"
                          checked={
                            !!leadsData &&
                            leadsData.items.length > 0 &&
                            leadsData.items.every((l) =>
                              selectedLeadIdSet.has(l.id),
                            )
                          }
                          onChange={(e) => {
                            if (e.target.checked) {
                              selectAllVisibleLeads();
                            } else {
                              setSelectedLeadIds([]);
                            }
                          }}
                          className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-900 accent-rose-500"
                        />
                      </th>
                      <th className="py-3 px-4">Profile</th>
                      <th className="py-3 px-4">Followers</th>
                      <th className="py-3 px-4">Following</th>
                      <th className="py-3 px-4">Posts</th>
                      <th className="py-3 px-4">Category</th>
                      <th className="hidden py-3 px-4 lg:table-cell">Location</th>
                      <th className="hidden py-3 px-4 xl:table-cell">Bio</th>
                      <th className="hidden py-3 px-4 md:table-cell">Scraped</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                    {isLeadsLoading ? (
                      <tr>
                        <td colSpan={10} className="py-12 text-center text-zinc-500 animate-pulse">
                          Loading leads from PostgreSQL...
                        </td>
                      </tr>
                    ) : leadsData?.items.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-12 text-center">
                          {(() => {
                            const isDiscoveryRunning =
                              campaign.status === "RUNNING" ||
                              scrapeJobs.some((j) => j.status === "RUNNING");
                            const hasActiveFilters = Boolean(
                              searchQuery ||
                                categoryFilter ||
                                verifiedFilter !== "all" ||
                                businessFilter !== "all" ||
                                statusFilter !== "all",
                            );
                            const isLimitReached = Boolean(
                              campaign.leadLimit &&
                                (leadsData?.pagination.total ??
                                  campaign.leadCount ??
                                  0) >= campaign.leadLimit,
                            );

                            return (
                              <>
                                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-800 text-zinc-400 mb-3">
                                  {isDiscoveryRunning ? (
                                    <svg className="h-6 w-6 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                  ) : hasActiveFilters ? (
                                    <svg className="h-6 w-6 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                                    </svg>
                                  ) : isLimitReached ? (
                                    <svg className="h-6 w-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                    </svg>
                                  ) : (
                                    <svg className="h-6 w-6 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                                    </svg>
                                  )}
                                </div>
                                <p className="text-sm font-semibold text-zinc-200">
                                  {isDiscoveryRunning
                                    ? "Lead discovery is in progress."
                                    : hasActiveFilters
                                    ? "No leads match your current search or filters."
                                    : isLimitReached
                                    ? "Lead limit reached."
                                    : "No leads yet."}
                                </p>
                                <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto">
                                  {isDiscoveryRunning
                                    ? "Profiles are being discovered, enriched, and saved. Leads will appear here automatically."
                                    : hasActiveFilters
                                    ? "Try adjusting your search query or reset filters to see all leads."
                                    : isLimitReached
                                    ? `This campaign has reached its configured lead limit of ${campaign.leadLimit} leads.`
                                    : "Click 'Scrape Leads' to discover and import Instagram profiles into this campaign."}
                                </p>
                                {hasActiveFilters ? (
                                  <button
                                    type="button"
                                    onClick={resetFilters}
                                    className="mt-3.5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3.5 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 transition"
                                  >
                                    Reset all filters
                                  </button>
                                ) : !isDiscoveryRunning && !isLimitReached ? (
                                  <button
                                    type="button"
                                    id="empty-state-discover-btn"
                                    onClick={() => setIsScrapeModalOpen(true)}
                                    className="mt-3.5 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-rose-600 to-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:from-rose-500 hover:to-indigo-500"
                                  >
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                    </svg>
                                    <span>Discover Leads Now</span>
                                  </button>
                                ) : null}
                              </>
                            );
                          })()}
                        </td>
                      </tr>
                    ) : (
                      leadsData?.items.map((lead: Lead) => (
                        <tr
                          key={lead.id}
                          className="hover:bg-zinc-800/30 transition group"
                        >
                          {/* Selection */}
                          <td className="py-3 px-3">
                            <input
                              type="checkbox"
                              aria-label={`Select @${lead.username}`}
                              disabled={lead.status === "DO_NOT_CONTACT"}
                              checked={selectedLeadIdSet.has(lead.id)}
                              onChange={() => toggleLeadSelection(lead.id)}
                              className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-900 accent-rose-500 disabled:opacity-30 disabled:cursor-not-allowed"
                              title={lead.status === "DO_NOT_CONTACT" ? "Lead is in Do Not Contact list" : undefined}
                            />
                          </td>

                          {/* Profile & Name */}
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <LeadAvatar
                                profilePicUrlHD={lead.profilePicUrlHD}
                                profilePicUrl={lead.profilePicUrl}
                                profilePictureUrl={lead.profilePictureUrl}
                                username={lead.username}
                                size="md"
                              />

                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <button
                                    onClick={() => setActiveLeadId(lead.id)}
                                    className="font-semibold text-zinc-100 hover:text-rose-400 transition truncate text-left"
                                  >
                                    @{lead.username}
                                  </button>
                                  {lead.duplicateOfLeadId && (
                                    <span
                                      className="shrink-0 rounded bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-rose-400 border border-rose-500/20"
                                      title="Duplicate of another lead"
                                    >
                                      DUPLICATE
                                    </span>
                                  )}
                                  {!lead.duplicateOfLeadId && lead.possibleDuplicateOfLeadId && (
                                    <span
                                      className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-400 border border-amber-500/20"
                                      title={
                                        lead.possibleDuplicateReason
                                          ? `Possible duplicate (${lead.possibleDuplicateReason})`
                                          : "Possible duplicate"
                                      }
                                    >
                                      POSSIBLE DUP
                                    </span>
                                  )}
                                  {(lead.verified ?? lead.isVerified) && (
                                    <svg
                                      className="h-3.5 w-3.5 fill-sky-400 shrink-0"
                                      viewBox="0 0 24 24"
                                      aria-label="Verified"
                                    >
                                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                                    </svg>
                                  )}
                                  {(lead.isBusinessAccount ?? lead.isBusiness) && (
                                    <span className="shrink-0 rounded bg-purple-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-purple-400 border border-purple-500/20">
                                      BUSINESS
                                    </span>
                                  )}
                                  {lead.status === "DO_NOT_CONTACT" && (
                                    <span className="shrink-0 rounded bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-rose-400 border border-rose-500/20">
                                      DO NOT CONTACT
                                    </span>
                                  )}
                                </div>
                                {lead.fullName && (
                                  <div className="text-[11px] text-zinc-400 truncate">{lead.fullName}</div>
                                )}
                              </div>
                            </div>
                          </td>

                          {/* Followers */}
                          <td className="py-3 px-4 font-semibold text-zinc-200">
                            {formatNumber(lead.followersCount ?? lead.followers)}
                          </td>

                          {/* Following */}
                          <td className="py-3 px-4 text-zinc-400">
                            {formatNumber(lead.followsCount ?? lead.following)}
                          </td>

                          {/* Posts */}
                          <td className="py-3 px-4 text-zinc-400">
                            {formatNumber(lead.postsCount)}
                          </td>

                          {/* Category */}
                          <td className="py-3 px-4">
                            {lead.businessCategoryName || lead.category ? (
                              <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 font-medium">
                                {lead.businessCategoryName || lead.category}
                              </span>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </td>

                          {/* Location */}
                          <td className="hidden py-3 px-4 text-zinc-400 lg:table-cell">
                            {lead.location ? (
                              <span className="text-[11px]">{lead.location}</span>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </td>

                          {/* Bio */}
                          <td className="hidden py-3 px-4 xl:table-cell">
                            {lead.biography ? (
                              <span className="block max-w-[220px] truncate text-[11px] text-zinc-400" title={lead.biography}>
                                {lead.biography}
                              </span>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </td>

                          {/* Scraped At */}
                          <td className="hidden py-3 px-4 text-[11px] text-zinc-400 md:table-cell">
                            {lead.scrapedAt ? new Date(lead.scrapedAt).toLocaleDateString() : "—"}
                          </td>

                          {/* Actions */}
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <a
                                href={lead.profileUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="rounded p-1 text-zinc-400 hover:text-zinc-200 transition"
                                title="Open Instagram"
                              >
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </a>
                              {(() => {
                                const linkInfo = getLeadLinkClassification(lead);
                                return (
                                  <>
                                    {linkInfo.hasWebsite && (
                                      <a
                                        href={
                                          linkInfo.website!.startsWith("http")
                                            ? linkInfo.website!
                                            : `https://${linkInfo.website}`
                                        }
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="rounded p-1 text-zinc-400 transition hover:text-emerald-400"
                                        title="Open website"
                                      >
                                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                                        </svg>
                                      </a>
                                    )}
                                    {linkInfo.hasSocialLink && (
                                      <a
                                        href={
                                          linkInfo.socialLink!.startsWith("http")
                                            ? linkInfo.socialLink!
                                            : `https://${linkInfo.socialLink}`
                                        }
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="rounded p-1 text-zinc-400 transition hover:text-sky-400"
                                        title={`Open ${linkInfo.socialLabel}`}
                                      >
                                        <SocialPlatformIcon platform={linkInfo.socialPlatform || "social"} className="h-4 w-4" />
                                      </a>
                                    )}
                                  </>
                                );
                              })()}
                              {lead.status === "DO_NOT_CONTACT" ? (
                                <button
                                  type="button"
                                  id={`btn-message-${lead.id}`}
                                  onClick={() => {
                                    setDrawerInitialTab("profile");
                                    setActiveLeadId(lead.id);
                                  }}
                                  className="inline-flex items-center gap-1 rounded bg-zinc-800/80 px-2.5 py-1 text-xs font-semibold text-zinc-400 border border-zinc-700/60 hover:bg-zinc-800 hover:text-zinc-300 transition"
                                  title={`@${lead.username} is marked Do Not Contact`}
                                >
                                  <svg className="h-3.5 w-3.5 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                                  </svg>
                                  <span>DNC</span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  id={`btn-message-${lead.id}`}
                                  onClick={() => {
                                    setDrawerInitialTab("message");
                                    setActiveLeadId(lead.id);
                                  }}
                                  className="inline-flex items-center gap-1 rounded bg-rose-600/20 px-2.5 py-1 text-xs font-semibold text-rose-400 border border-rose-500/30 hover:bg-rose-600/30 hover:text-rose-300 transition"
                                  title={`Message @${lead.username}`}
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                                  </svg>
                                  <span>Message</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setDrawerInitialTab("profile");
                                  setActiveLeadId(lead.id);
                                }}
                                className="rounded bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-700 hover:text-white transition"
                              >
                                View
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Responsive Stacked Cards (visible on smaller screens / mobile) */}
              {!isLeadsLoading && leadsData && leadsData.items.length > 0 && (
                <div className="block md:hidden divide-y divide-zinc-800/80 border-t border-zinc-800 bg-zinc-950/40">
                  {leadsData.items.map((lead: Lead) => (
                    <div key={`card-${lead.id}`} className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            aria-label={`Select @${lead.username}`}
                            checked={selectedLeadIdSet.has(lead.id)}
                            onChange={() => toggleLeadSelection(lead.id)}
                            className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 accent-rose-500"
                          />
                          <LeadAvatar
                            profilePicUrlHD={lead.profilePicUrlHD}
                            profilePicUrl={lead.profilePicUrl}
                            profilePictureUrl={lead.profilePictureUrl}
                            username={lead.username}
                            size="md"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => setActiveLeadId(lead.id)}
                                className="font-semibold text-zinc-100 hover:text-rose-400 transition truncate text-left text-sm"
                              >
                                @{lead.username}
                              </button>
                              {(lead.verified ?? lead.isVerified) && (
                                <svg
                                  className="h-3.5 w-3.5 fill-sky-400 shrink-0"
                                  viewBox="0 0 24 24"
                                  aria-label="Verified"
                                >
                                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                                </svg>
                              )}
                            </div>
                            {lead.fullName && (
                              <p className="text-xs text-zinc-400 truncate">{lead.fullName}</p>
                            )}
                          </div>
                        </div>

                        {(lead.isBusinessAccount ?? lead.isBusiness) && (
                          <span className="shrink-0 rounded bg-purple-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-purple-400 border border-purple-500/20">
                            BUSINESS
                          </span>
                        )}
                      </div>

                      {/* Stats */}
                      <div className="grid grid-cols-3 gap-2 rounded-lg bg-zinc-900/60 p-2 text-center text-xs">
                        <div>
                          <span className="text-[10px] text-zinc-500 block">Followers</span>
                          <span className="font-bold text-zinc-200">{formatNumber(lead.followersCount ?? lead.followers)}</span>
                        </div>
                        <div className="border-x border-zinc-800">
                          <span className="text-[10px] text-zinc-500 block">Following</span>
                          <span className="font-bold text-zinc-200">{formatNumber(lead.followsCount ?? lead.following)}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-zinc-500 block">Posts</span>
                          <span className="font-bold text-zinc-200">{formatNumber(lead.postsCount)}</span>
                        </div>
                      </div>

                      {/* Bio */}
                      {lead.biography && (
                        <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">
                          {lead.biography}
                        </p>
                      )}

                      {/* Category & Location */}
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        {(lead.businessCategoryName || lead.category) && (
                          <span className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-300 font-medium">
                            {lead.businessCategoryName || lead.category}
                          </span>
                        )}
                        {lead.location && (
                          <span className="rounded bg-zinc-800/60 px-2 py-0.5 text-zinc-400">
                            📍 {lead.location}
                          </span>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60 text-xs">
                        <div className="flex items-center gap-2">
                          <a
                            href={lead.profileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-rose-400 hover:text-rose-300 font-medium"
                          >
                            <span>Instagram</span>
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                          </a>
                          {(() => {
                            const linkInfo = getLeadLinkClassification(lead);
                            return (
                              <>
                                {linkInfo.hasWebsite && (
                                  <a
                                    href={linkInfo.website!.startsWith("http") ? linkInfo.website! : `https://${linkInfo.website}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-zinc-400 hover:text-emerald-300 underline truncate max-w-[120px]"
                                  >
                                    Website
                                  </a>
                                )}
                                {linkInfo.hasSocialLink && (
                                  <a
                                    href={linkInfo.socialLink!.startsWith("http") ? linkInfo.socialLink! : `https://${linkInfo.socialLink}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-zinc-400 hover:text-sky-300 underline truncate max-w-[120px] inline-flex items-center gap-1"
                                  >
                                    <SocialPlatformIcon platform={linkInfo.socialPlatform || "social"} className="h-3 w-3 inline" />
                                    <span>{linkInfo.socialLabel}</span>
                                  </a>
                                )}
                              </>
                            );
                          })()}
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setDrawerInitialTab("message");
                              setActiveLeadId(lead.id);
                            }}
                            className="inline-flex items-center gap-1 rounded-lg bg-rose-600/20 px-2.5 py-1 text-xs font-semibold text-rose-400 border border-rose-500/30 hover:bg-rose-600/30 transition"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            <span>Message</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDrawerInitialTab("profile");
                              setActiveLeadId(lead.id);
                            }}
                            className="rounded-lg bg-zinc-800 px-3 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 transition"
                          >
                            View
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Pagination Controls */}
              {leadsData && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950/60 px-4 py-3 text-xs">
                  <div className="flex items-center gap-3 text-zinc-400">
                    <div>
                      Showing{" "}
                      <span className="font-semibold text-zinc-200">
                        {leadsData.pagination.total === 0
                          ? 0
                          : (page - 1) * limit + 1}
                      </span>
                      –
                      <span className="font-semibold text-zinc-200">
                        {Math.min(page * limit, leadsData.pagination.total)}
                      </span>{" "}
                      of{" "}
                      <span className="font-semibold text-zinc-200">
                        {leadsData.pagination.total}
                      </span>{" "}
                      leads
                    </div>

                    {/* Page Size Selector */}
                    <div className="flex items-center gap-1.5 pl-2 border-l border-zinc-800">
                      <label htmlFor="select-page-size" className="text-zinc-500">Per page:</label>
                      <select
                        id="select-page-size"
                        value={limit}
                        onChange={(e) => {
                          setLimit(Number.parseInt(e.target.value, 10));
                          setPage(1);
                        }}
                        className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-zinc-200 focus:border-rose-500 focus:outline-none"
                      >
                        <option value={10}>10</option>
                        <option value={25}>25</option>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      disabled={page <= 1 || isLeadsLoading}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                    >
                      &larr; Previous
                    </button>

                    {Array.from(
                      { length: Math.min(5, leadsData.pagination.totalPages) },
                      (_, i) => {
                        const totalP = leadsData.pagination.totalPages;
                        let pageNum: number;
                        if (totalP <= 5) {
                          pageNum = i + 1;
                        } else if (page <= 3) {
                          pageNum = i + 1;
                        } else if (page >= totalP - 2) {
                          pageNum = totalP - 4 + i;
                        } else {
                          pageNum = page - 2 + i;
                        }
                        return (
                          <button
                            key={`page-btn-${pageNum}`}
                            onClick={() => setPage(pageNum)}
                            disabled={isLeadsLoading}
                            className={`min-w-[28px] h-7 rounded px-2 text-xs font-medium transition ${
                              pageNum === page
                                ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                                : "border border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                            }`}
                          >
                            {pageNum}
                          </button>
                        );
                      },
                    )}

                    <button
                      disabled={
                        page >= leadsData.pagination.totalPages || isLeadsLoading
                      }
                      onClick={() => setPage((p) => p + 1)}
                      className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                    >
                      Next &rarr;
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Scrape History */}
        {activeTab === "history" && (
          <div className="mt-6">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden shadow-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-800 bg-zinc-950/80 text-zinc-400 uppercase font-semibold">
                    <tr>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Provider</th>
                      <th className="py-3 px-4">Input Count</th>
                      <th className="py-3 px-4">Processed</th>
                      <th className="py-3 px-4">Started</th>
                      <th className="py-3 px-4">Completed</th>
                      <th className="py-3 px-4">Details / Errors</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                    {isJobsLoading ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-zinc-500 animate-pulse">
                          Loading job history...
                        </td>
                      </tr>
                    ) : scrapeJobs.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-zinc-500">
                          No scrape jobs executed for this campaign yet.
                        </td>
                      </tr>
                    ) : (
                      scrapeJobs.map((job) => (
                        <tr key={job.id} className="hover:bg-zinc-800/30">
                          <td className="py-3 px-4">{getStatusBadge(job.status)}</td>
                          <td className="py-3 px-4 font-mono uppercase text-zinc-300">{job.provider}</td>
                          <td className="py-3 px-4 font-medium text-zinc-200">{job.inputCount}</td>
                          <td className="py-3 px-4 font-medium text-emerald-400">{job.processedCount}</td>
                          <td className="py-3 px-4 text-zinc-400">
                            {job.startedAt ? new Date(job.startedAt).toLocaleString() : "—"}
                          </td>
                          <td className="py-3 px-4 text-zinc-400">
                            {job.completedAt ? new Date(job.completedAt).toLocaleString() : "—"}
                          </td>
                          <td className="py-3 px-4">
                            {job.errorMessage ? (
                              <span className="text-rose-400 text-xs font-mono">{job.errorMessage}</span>
                            ) : (
                              <span className="text-emerald-400 text-xs font-medium">Completed without errors</span>
                            )}
                            {job.query && (
                              <div className="mt-1 text-[11px] text-zinc-400 space-y-0.5">
                                <div>
                                  <span className="text-zinc-300 font-medium">Intent:</span> {job.query}
                                  {job.location && <span className="ml-2"><span className="text-zinc-300 font-medium">Loc:</span> {job.location}</span>}
                                  {job.category && <span className="ml-2"><span className="text-zinc-300 font-medium">Cat:</span> {job.category}</span>}
                                  {job.requestedLimit !== undefined && job.requestedLimit !== null && (
                                    <span className="ml-2"><span className="text-zinc-300 font-medium">Limit:</span> {job.requestedLimit}</span>
                                  )}
                                </div>
                                <div className="text-[10px] text-zinc-500">
                                  <span>Discovered: {job.candidatesDiscovered ?? 0}</span> &bull;{" "}
                                  <span>Enriched: {job.candidatesEnriched ?? 0}</span> &bull;{" "}
                                  <span>Skipped: {job.candidatesSkipped ?? 0}</span>
                                </div>
                                {(job.discoveryActor || job.enrichmentActor) && (
                                  <div className="text-[10px] font-mono text-zinc-500 truncate" title={`${job.discoveryActor ?? ""} -> ${job.enrichmentActor ?? ""}`}>
                                    <span>Actors: {job.discoveryActor ?? "—"} &rarr; {job.enrichmentActor ?? "—"}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Tab: Review Queue (Step 6) */}
        {activeTab === "review" && (
          <div className="mt-6">
            <CampaignReviewQueueTab
              campaignId={campaign.id}
              onJobStarted={(jobId) => {
                if (!jobId) return;
                setActiveBulkJobId(jobId);
                setActiveTab("leads");
              }}
            />
          </div>
        )}

        {/* Tab: Analytics */}
        {activeTab === "analytics" && (
          <div className="mt-6">
            <CampaignAnalyticsTab campaignId={campaign.id} refreshTrigger={analyticsRefreshTrigger} />
          </div>
        )}

        {/* Tab 2: Message Templates */}
        {activeTab === "templates" && (
          <div className="mt-6">
            <CampaignTemplatesTab
              campaignId={campaign.id}
              campaignName={campaign.name}
            />
          </div>
        )}

        {/* Tab 3: Campaign Execution */}
        {activeTab === "execution" && (
          <div className="mt-6">
            <CampaignExecutionTab
              campaignId={campaign.id}
              campaignName={campaign.name}
              campaignExecutionMode={campaign.executionMode}
              selectedLeads={selectedLeads}
              onClearSelection={() => setSelectedLeadIds([])}
            />
          </div>
        )}
      </main>

      {/* Scrape Modal */}
      {isScrapeModalOpen && (
        <ScrapeLeadsModal
          key={`scrape-modal-${campaign.id}`}
          isOpen={isScrapeModalOpen}
          campaignId={campaign.id}
          onClose={() => setIsScrapeModalOpen(false)}
          onScrapeCompleted={handleScrapeCompleted}
          campaignIntent={campaign.intent}
          campaignLocation={campaign.location}
          campaignCategory={campaign.category}
          campaignLeadLimit={campaign.leadLimit}
          currentLeadCount={leadsData?.pagination.total ?? campaign.leadCount ?? 0}
        />
      )}

      {/* Bulk Message Modal */}
      {isBulkModalOpen && campaign && (
        <BulkMessageModal
          isOpen={isBulkModalOpen}
          onClose={() => setIsBulkModalOpen(false)}
          campaignId={campaign.id}
          selectedLeadIds={selectedLeadIds}
          selectionMode={bulkSelectionMode}
          totalCampaignLeads={leadsData?.pagination.total ?? campaign.leadCount ?? 0}
          filters={{
            search: searchQuery || undefined,
            category: categoryFilter || undefined,
            verified: verifiedFilter === "all" ? undefined : verifiedFilter === "verified",
            isBusinessAccount: businessFilter === "all" ? undefined : businessFilter === "business",
            status: statusFilter === "all" ? undefined : statusFilter,
          }}
          onJobStarted={(jobId) => {
            setActiveBulkJobId(jobId);
          }}
        />
      )}

      {/* Lead Detail Drawer */}
      <LeadDetailDrawer
        leadId={activeLeadId}
        initialTab={drawerInitialTab}
        onClose={() => setActiveLeadId(null)}
        onLeadUpdated={fetchLeads}
        onLeadDeleted={() => {
          fetchLeads();
          fetchCampaignInfo();
        }}
      />

      {/* Delete Campaign Confirmation */}
      <ConfirmModal
        isOpen={showDeleteCampaignModal}
        title="Delete Campaign"
        message={`Are you sure you want to delete "${campaign.name}"? This will permanently delete all associated leads and scrape logs.`}
        confirmLabel="Delete Campaign"
        isDangerous={true}
        isLoading={isDeletingCampaign}
        onConfirm={handleDeleteCampaign}
        onCancel={() => setShowDeleteCampaignModal(false)}
      />
    </div>
  );
}
