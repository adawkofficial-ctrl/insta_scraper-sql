"use client";

import { useEffect, useState, useCallback, useRef, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { deleteCampaign, getCampaign, updateCampaign, type CampaignDetail } from "@/lib/api/campaigns";
import { listCompanyProfiles, type CompanyProfilesListItem } from "@/lib/api/company-profile";
import { getCampaignLeads, getCampaignLeadsExportUrl, enrichLeads, enrichLeadHandle, findLeadContacts, deleteLead, deleteLeadsBulk, deleteDryRunLeadsApi, type Lead, type PaginatedLeads } from "@/lib/api/leads";
import { getCampaignScrapeJobs, type ScrapeJobItem } from "@/lib/api/scraper";

function isLeadDryRun(lead: { isDryRun?: boolean | null; source?: string | null; username?: string | null; website?: string | null; phone?: string | null }): boolean {
  if (!lead) return false;
  if (lead.isDryRun === true) return true;
  if (lead.source === "dry_run" || lead.source === "sample") return true;
  if (typeof lead.username === "string" && (lead.username.startsWith("sample_") || lead.username.startsWith("sample-"))) return true;
  if (typeof lead.website === "string" && (lead.website.includes("example.com") || lead.website.includes(".example"))) return true;
  if (typeof lead.phone === "string" && (lead.phone.includes("555-01") || lead.phone.includes("55501"))) return true;
  return false;
}
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
import { CampaignEmailTab } from "@/components/campaign-email-tab";
import { LeadAvatar } from "@/components/lead-avatar";
import { SocialPlatformIcon, getLeadLinkClassification } from "@/components/social-platform-icon";
import { BulkMessageModal } from "@/components/bulk-message-modal";
import { BulkJobProgressPanel } from "@/components/bulk-job-progress-panel";
import { CampaignExecutionControlPanel } from "@/components/campaign-execution-control-panel";
import { EditCampaignModal } from "@/components/edit-campaign-modal";
import { CsvUploadModal } from "@/components/csv-upload-modal";
import { getCampaignAnalytics, type CampaignAnalytics } from "@/lib/api/analytics";
import { isTerminalBulkJobStatus } from "@/lib/polling/job-polling";
import { useSendingStatus } from "@/components/sending-banner";

export default function CampaignDetailPage() {
  const params = useParams();
  const router = useRouter();
  const campaignId = params.campaignId as string;

  const [, startTransition] = useTransition();
  const { sendingEnabled } = useSendingStatus();

  // Campaign State
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
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
  const [activeTab, setActiveTab] = useState<"leads" | "history" | "templates" | "execution" | "analytics" | "review" | "email">("leads");
  const [isScrapeModalOpen, setIsScrapeModalOpen] = useState(false);
  const [isCsvUploadModalOpen, setIsCsvUploadModalOpen] = useState(false);
  const [isExportingCsv, setIsExportingCsv] = useState(false);
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

  // Lead Deletion State
  const [isDeletingLeads, setIsDeletingLeads] = useState(false);
  const [leadPendingDelete, setLeadPendingDelete] = useState<Lead | null>(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<{ type: "success" | "error" | "info"; message: string } | null>(null);

  // Dry-run Filter & Admin Action State
  const [hideDryRun, setHideDryRun] = useState(false);
  const [showDeleteDryRunConfirm, setShowDeleteDryRunConfirm] = useState(false);
  const [isDeletingDryRunLeads, setIsDeletingDryRunLeads] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

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

  const [enrichmentFilter, setEnrichmentFilter] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const e = new URLSearchParams(window.location.search).get("enrichment");
      if (e && ["all", "enriched", "not_enriched"].includes(e.toLowerCase())) {
        return e.toLowerCase();
      }
    }
    return "all";
  });

  const [isBulkEnriching, setIsBulkEnriching] = useState(false);
  const [enrichingLeadId, setEnrichingLeadId] = useState<string | null>(null);
  const [enrichNotice, setEnrichNotice] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  const [isBulkFindingContacts, setIsBulkFindingContacts] = useState(false);
  const [findingContactsLeadId, setFindingContactsLeadId] = useState<string | null>(null);
  const [contactsNotice, setContactsNotice] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

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
    if (enrichmentFilter !== "all") params.set("enrichment", enrichmentFilter);

    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", newUrl);
  }, [page, limit, searchQuery, categoryFilter, verifiedFilter, businessFilter, statusFilter, channelFilter, enrichmentFilter]);

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
        enrichmentStatus: enrichmentFilter !== "all" ? (enrichmentFilter as "enriched" | "not_enriched") : undefined,
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
  }, [campaignId, page, limit, searchQuery, categoryFilter, verifiedFilter, businessFilter, statusFilter, channelFilter, enrichmentFilter, showDuplicates]);

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
    setEnrichmentFilter("all");
    setPage(1);
  };

  const handleBulkEnrich = async () => {
    if (selectedLeadIds.length === 0) return;
    if (selectedLeadIds.length > 20) {
      alert("Cannot enrich more than 20 leads per click to protect your budget.");
      return;
    }
    setIsBulkEnriching(true);
    setEnrichNotice(null);
    try {
      const res = await enrichLeads(selectedLeadIds);
      const cachedText = res.cachedCount > 0 ? ` (${res.cachedCount} from 30-day cache, $0.00)` : "";
      setEnrichNotice({
        type: "success",
        message: `Enriched ${res.enrichedCount} profile(s)${cachedText}. Real Apify cost: $${res.apifyCostUsd.toFixed(4)}. Remaining budget: $${res.remainingBudgetUsd.toFixed(2)}.`,
      });
      fetchLeads();
      fetchCampaignInfo();
    } catch (err) {
      setEnrichNotice({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to enrich selected profiles.",
      });
    } finally {
      setIsBulkEnriching(false);
    }
  };

  const handleEnrichHandleSingle = async (leadId: string) => {
    setEnrichingLeadId(leadId);
    setEnrichNotice(null);
    try {
      const res = await enrichLeadHandle(leadId);
      setEnrichNotice({
        type: res.outcome === "found" ? "success" : "info",
        message: res.message,
      });
      fetchLeads();
      fetchCampaignInfo();
    } catch (err) {
      setEnrichNotice({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to run handle waterfall.",
      });
    } finally {
      setEnrichingLeadId(null);
    }
  };

  const handleEnrichSingle = async (leadId: string) => {
    const targetLead = leadsData?.items.find((l) => l.id === leadId);
    if (targetLead && (!targetLead.username || targetLead.username.trim() === "")) {
      return handleEnrichHandleSingle(leadId);
    }

    setEnrichingLeadId(leadId);
    setEnrichNotice(null);
    try {
      const res = await enrichLeads([leadId]);
      const cachedText = res.cachedCount > 0 ? " (from 30-day cache, $0.00)" : "";
      setEnrichNotice({
        type: "success",
        message: `Profile enriched successfully${cachedText}! Real Apify cost: $${res.apifyCostUsd.toFixed(4)}. Remaining budget: $${res.remainingBudgetUsd.toFixed(2)}.`,
      });
      fetchLeads();
      fetchCampaignInfo();
    } catch (err) {
      setEnrichNotice({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to enrich profile.",
      });
    } finally {
      setEnrichingLeadId(null);
    }
  };

  const handleBulkFindContacts = async () => {
    if (selectedLeadIds.length === 0) return;
    setIsBulkFindingContacts(true);
    setContactsNotice(null);
    try {
      const res = await findLeadContacts(selectedLeadIds);
      setContactsNotice({
        type: "success",
        message: `Extracted contacts for ${res.count} lead(s).`,
      });
      fetchLeads();
    } catch (err) {
      setContactsNotice({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to extract contacts.",
      });
    } finally {
      setIsBulkFindingContacts(false);
    }
  };

  const handleFindContactsSingle = async (leadId: string) => {
    setFindingContactsLeadId(leadId);
    setContactsNotice(null);
    try {
      const res = await findLeadContacts([leadId]);
      const leadItem = res.leads[0];
      const count =
        (leadItem?.contacts?.emails?.length ?? 0) +
        (leadItem?.contacts?.phones?.length ?? 0) +
        (leadItem?.contacts?.whatsapps?.length ?? 0);
      setContactsNotice({
        type: "success",
        message: `Contacts extraction completed: found ${count} contact detail(s).`,
      });
      fetchLeads();
    } catch (err) {
      setContactsNotice({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to extract contacts.",
      });
    } finally {
      setFindingContactsLeadId(null);
    }
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

  const handleConfirmSingleDelete = async () => {
    if (!leadPendingDelete) return;
    setIsDeletingLeads(true);
    setDeleteNotice(null);
    try {
      await deleteLead(leadPendingDelete.id);
      setSelectedLeadIds((prev) => prev.filter((id) => id !== leadPendingDelete.id));
      setDeleteNotice({
        type: "success",
        message: `Lead @${leadPendingDelete.username} was permanently deleted.`,
      });
      setLeadPendingDelete(null);
      fetchLeads();
      fetchCampaignInfo();
    } catch (err) {
      setDeleteNotice({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to delete lead.",
      });
    } finally {
      setIsDeletingLeads(false);
    }
  };

  const handleConfirmBulkDelete = async () => {
    if (selectedLeadIds.length === 0) return;
    setIsDeletingLeads(true);
    setDeleteNotice(null);
    try {
      const res = await deleteLeadsBulk(campaignId, selectedLeadIds);
      const count = res.deletedCount;
      setSelectedLeadIds([]);
      setBulkSelectionMode("selected");
      setShowBulkDeleteConfirm(false);
      setDeleteNotice({
        type: "success",
        message: `Successfully deleted ${count} lead${count === 1 ? "" : "s"}.`,
      });
      fetchLeads();
      fetchCampaignInfo();
    } catch (err) {
      setDeleteNotice({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to delete selected leads.",
      });
    } finally {
      setIsDeletingLeads(false);
    }
  };

  const handleConfirmDeleteDryRun = async () => {
    setIsDeletingDryRunLeads(true);
    setDeleteNotice(null);
    try {
      const res = await deleteDryRunLeadsApi(campaignId);
      setShowDeleteDryRunConfirm(false);
      setDeleteNotice({
        type: "success",
        message: `Successfully deleted ${res.deletedCount} dry-run / sample lead${res.deletedCount === 1 ? "" : "s"}.`,
      });
      fetchLeads();
      fetchCampaignInfo();
    } catch (err) {
      setDeleteNotice({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to delete dry-run leads.",
      });
    } finally {
      setIsDeletingDryRunLeads(false);
    }
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

  const handleExportCsv = async (leadIdsOnly?: boolean) => {
    if (!campaignId) return;
    setIsExportingCsv(true);
    try {
      const idsToExport =
        leadIdsOnly && selectedLeadIds.length > 0 ? selectedLeadIds : undefined;
      const exportUrl = getCampaignLeadsExportUrl(campaignId, {
        leadIds: idsToExport,
      });
      const res = await fetch(exportUrl);
      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        throw new Error(
          errJson?.error || `Export failed with status ${res.status}`,
        );
      }
      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      const sanitizedName = (campaign?.name || "campaign")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
      link.download = `${sanitizedName || "campaign"}-leads.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to export CSV");
    } finally {
      setIsExportingCsv(false);
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
              type="button"
              id="edit-campaign-btn"
              onClick={() => setIsEditModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800 hover:text-white transition shadow-xs"
            >
              <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
              </svg>
              <span>Edit Campaign</span>
            </button>
            <button
              onClick={() => setShowDeleteCampaignModal(true)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-zinc-300 hover:border-rose-900/50 hover:bg-rose-950/30 hover:text-rose-300 transition"
            >
              Delete Campaign
            </button>
            <button
              onClick={() => setIsCsvUploadModalOpen(true)}
              id="upload-csv-leads-header-btn"
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800 hover:text-white transition shadow-xs"
            >
              <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              <span>Upload CSV</span>
            </button>
            <button
              type="button"
              onClick={() => handleExportCsv(false)}
              disabled={isExportingCsv || !campaign || (leadsData?.pagination.total ?? campaign.leadCount ?? 0) === 0}
              id="export-csv-leads-header-btn"
              title={(leadsData?.pagination.total ?? campaign.leadCount ?? 0) === 0 ? "No leads to export" : "Export campaign leads to CSV"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800 hover:text-white transition shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              <span>{isExportingCsv ? "Exporting..." : "Export CSV"}</span>
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
              <button
                type="button"
                id="intent-card-edit-btn"
                onClick={() => setIsEditModalOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-800/80 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:border-zinc-600 hover:bg-zinc-700/80 hover:text-white transition"
              >
                <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                </svg>
                <span>Edit</span>
              </button>
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

          {/* Follow-up Campaign Summary & Settings */}
          {campaign.followUpEnabled ? (
            <div className="mt-4 pt-3.5 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-emerald-400" />
                <span className="font-semibold text-zinc-200">Scheduled Follow-ups Active:</span>
                <span className="text-zinc-400">
                  {campaign.followUpCount ?? 1} follow-up{(campaign.followUpCount ?? 1) > 1 ? "s" : ""} (after {campaign.followUpDelayDays?.join(", ") ?? "3, 5"} days)
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 rounded-lg border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-300">
                  <span className="font-medium">Scheduled:</span>
                  <span className="font-bold">{campaign.followUpSummary?.scheduled ?? 0}</span>
                </div>
                <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300">
                  <span className="font-medium">Sent:</span>
                  <span className="font-bold">{campaign.followUpSummary?.sent ?? 0}</span>
                </div>
                <div className="flex items-center gap-1.5 rounded-lg border border-purple-500/20 bg-purple-500/10 px-2.5 py-1 text-[11px] text-purple-300">
                  <span className="font-medium">Cancelled:</span>
                  <span className="font-bold">{campaign.followUpSummary?.cancelled ?? 0}</span>
                </div>
                <div className="flex items-center gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1 text-[11px] text-indigo-300">
                  <span className="font-medium">Replies after Follow-up:</span>
                  <span className="font-bold">{campaign.followUpSummary?.repliesAfterFollowUp ?? 0}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4 pt-3.5 border-t border-zinc-800/80 flex items-center justify-between text-xs text-zinc-500">
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-zinc-600" />
                <span>Follow-ups: Disabled</span>
              </div>
              <button
                type="button"
                onClick={() => setIsEditModalOpen(true)}
                className="text-zinc-400 hover:text-zinc-300 underline text-[11px]"
              >
                Enable in Edit Campaign
              </button>
            </div>
          )}
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
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${activeTab === "leads"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
          >
            Leads Directory ({leadsData?.pagination.total ?? campaign.leadCount ?? 0})
          </button>
          <button
            onClick={() => setActiveTab("analytics")}
            id="tab-analytics"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${activeTab === "analytics"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
          >
            Analytics
          </button>
          <button
            onClick={() => setActiveTab("review")}
            id="tab-review"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${activeTab === "review"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
          >
            Review Queue
          </button>
          <button
            onClick={() => setActiveTab("templates")}
            id="tab-templates"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${activeTab === "templates"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
          >
            Message Templates
          </button>
          <button
            onClick={() => setActiveTab("execution")}
            id="tab-execution"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${activeTab === "execution"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
          >
            Campaign Execution
          </button>
          <button
            onClick={() => setActiveTab("email")}
            id="tab-email"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${activeTab === "email"
                ? "border-rose-500 text-rose-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
          >
            Email
          </button>
          <button
            onClick={() => setActiveTab("history")}
            id="tab-history"
            className={`pb-3 text-sm font-semibold transition border-b-2 whitespace-nowrap ${activeTab === "history"
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
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

                {/* Enrichment Filter */}
                <div>
                  <label htmlFor="filter-enrichment" className="block text-[11px] font-semibold uppercase text-zinc-400">Enrichment</label>
                  <select
                    id="filter-enrichment"
                    value={enrichmentFilter}
                    onChange={(e) => {
                      setEnrichmentFilter(e.target.value);
                      handleFilterChange();
                    }}
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                  >
                    <option value="all">All Profiles</option>
                    <option value="enriched">Enriched Only</option>
                    <option value="not_enriched">Not Enriched</option>
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

              <div className="mt-3 flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
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

                <div className="flex items-center gap-2">
                  <input
                    id="hide-dry-run"
                    type="checkbox"
                    checked={hideDryRun}
                    onChange={(e) => setHideDryRun(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-950 accent-amber-500"
                  />
                  <label htmlFor="hide-dry-run" className="text-[11px] text-zinc-300 font-medium">
                    Hide dry-run / sample leads
                  </label>
                </div>
              </div>

              {(searchQuery || categoryFilter || verifiedFilter !== "all" || businessFilter !== "all" || statusFilter !== "all" || channelFilter !== "all" || enrichmentFilter !== "all") && (
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
                  className={`rounded-lg border px-3 py-1.5 font-medium transition disabled:opacity-40 ${bulkSelectionMode === "selected" &&
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
                  className={`rounded-lg border px-3 py-1.5 font-medium transition disabled:opacity-40 ${bulkSelectionMode === "allEligible"
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
                <button
                  type="button"
                  id="btn-upload-csv-toolbar"
                  onClick={() => setIsCsvUploadModalOpen(true)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-white flex items-center gap-1.5"
                >
                  <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <span>Upload CSV</span>
                </button>
                <button
                  type="button"
                  id="btn-export-csv-toolbar"
                  onClick={() =>
                    handleExportCsv(
                      selectedLeadIds.length > 0 &&
                        bulkSelectionMode !== "allEligible",
                    )
                  }
                  disabled={
                    isExportingCsv ||
                    !campaign ||
                    (leadsData?.pagination.total ?? campaign.leadCount ?? 0) === 0
                  }
                  title={
                    (leadsData?.pagination.total ?? campaign.leadCount ?? 0) === 0
                      ? "No leads to export"
                      : selectedLeadIds.length > 0 &&
                        bulkSelectionMode !== "allEligible"
                      ? `Export ${selectedLeadIds.length} selected leads to CSV`
                      : "Export all campaign leads to CSV"
                  }
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-white flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  <span>
                    {isExportingCsv
                      ? "Exporting..."
                      : selectedLeadIds.length > 0 &&
                        bulkSelectionMode !== "allEligible"
                      ? `Export Selected (${selectedLeadIds.length})`
                      : "Export CSV"}
                  </span>
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
                  disabled={!sendingEnabled || (selectedLeadIds.length === 0 && bulkSelectionMode !== "allEligible")}
                  title={!sendingEnabled ? "Sending is disabled (SENDING_DISABLED)" : undefined}
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

                {selectedLeadIds.length > 0 && (
                  <button
                    type="button"
                    id="btn-enrich-selected"
                    disabled={selectedLeadIds.length > 20 || isBulkEnriching}
                    onClick={handleBulkEnrich}
                    className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-1.5 font-semibold text-amber-200 shadow-md transition hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                    title={
                      selectedLeadIds.length > 20
                        ? "Max 20 leads per enrichment batch"
                        : `Enrich ${selectedLeadIds.length} profiles (Est. ~$${(selectedLeadIds.length * 0.0026).toFixed(4)})`
                    }
                  >
                    {isBulkEnriching ? (
                      <>
                        <svg className="h-3.5 w-3.5 animate-spin text-amber-400" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>Enriching...</span>
                      </>
                    ) : (
                      <>
                        <span>⚡ Enrich Selected ({selectedLeadIds.length})</span>
                        <span className="text-[10px] text-amber-400/80 font-normal">
                          {selectedLeadIds.length > 20 ? "(Max 20)" : `~$${(selectedLeadIds.length * 0.0026).toFixed(4)}`}
                        </span>
                      </>
                    )}
                  </button>
                )}

                {selectedLeadIds.length > 0 && (
                  <button
                    type="button"
                    id="btn-find-contacts-selected"
                    disabled={isBulkFindingContacts}
                    onClick={handleBulkFindContacts}
                    className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-1.5 font-semibold text-emerald-200 shadow-md transition hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                    title={`Find contacts for ${selectedLeadIds.length} lead(s) (Free Stage 3 extractor)`}
                  >
                    {isBulkFindingContacts ? (
                      <>
                        <svg className="h-3.5 w-3.5 animate-spin text-emerald-400" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>Finding Contacts...</span>
                      </>
                    ) : (
                      <>
                        <span>🔍 Find Contacts ({selectedLeadIds.length})</span>
                        <span className="text-[10px] text-emerald-400/80 font-normal">(Free)</span>
                      </>
                    )}
                  </button>
                )}
                {selectedLeadIds.length > 0 && (
                  <button
                    type="button"
                    id="btn-delete-selected-leads"
                    disabled={isDeletingLeads}
                    onClick={() => setShowBulkDeleteConfirm(true)}
                    className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-1.5 font-semibold text-rose-300 shadow-md transition hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                    title={`Delete ${selectedLeadIds.length} selected lead(s)`}
                  >
                    {isDeletingLeads ? (
                      <>
                        <svg className="h-3.5 w-3.5 animate-spin text-rose-400" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>Deleting...</span>
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        <span>Delete Selected ({selectedLeadIds.length})</span>
                      </>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  id="btn-delete-dry-run-leads"
                  disabled={isDeletingDryRunLeads}
                  onClick={() => setShowDeleteDryRunConfirm(true)}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 font-semibold text-amber-300 shadow-md transition hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  title="Delete all dry-run and sample leads in this campaign"
                >
                  {isDeletingDryRunLeads ? (
                    <>
                      <svg className="h-3.5 w-3.5 animate-spin text-amber-400" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      <span>Deleting Dry-Run...</span>
                    </>
                  ) : (
                    <>
                      <svg className="h-4 w-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      <span>Delete Dry-Run Leads</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Enrich Notice Banner */}
            {enrichNotice && (
              <div
                className={`rounded-lg border p-3 text-xs flex items-center justify-between ${enrichNotice.type === "success"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                  }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">{enrichNotice.type === "success" ? "✓" : "⚠"}</span>
                  <span>{enrichNotice.message}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setEnrichNotice(null)}
                  className="hover:opacity-75 ml-2 font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Contacts Notice Banner */}
            {contactsNotice && (
              <div
                className={`rounded-lg border p-3 text-xs flex items-center justify-between ${contactsNotice.type === "success"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                  }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">{contactsNotice.type === "success" ? "✓" : "⚠"}</span>
                  <span>{contactsNotice.message}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setContactsNotice(null)}
                  className="hover:opacity-75 ml-2 font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Delete Notice Banner */}
            {deleteNotice && (
              <div
                className={`rounded-lg border p-3 text-xs flex items-center justify-between ${deleteNotice.type === "success"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                  }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">{deleteNotice.type === "success" ? "✓" : "⚠"}</span>
                  <span>{deleteNotice.message}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setDeleteNotice(null)}
                  className="hover:opacity-75 ml-2 font-bold"
                >
                  ✕
                </button>
              </div>
            )}

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
                      <th className="py-3 px-4">Score</th>
                      <th className="hidden py-3 px-4 lg:table-cell">City / Location</th>
                      <th className="hidden py-3 px-4 md:table-cell">Contact &amp; Socials</th>
                      <th className="hidden py-3 px-4 xl:table-cell">Bio</th>
                      <th className="hidden py-3 px-4 lg:table-cell">Scraped</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                    {isLeadsLoading ? (
                      <tr>
                        <td colSpan={12} className="py-12 text-center text-zinc-500 animate-pulse">
                          Loading leads from PostgreSQL...
                        </td>
                      </tr>
                    ) : leadsData?.items.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="py-12 text-center">
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
                    ) : (leadsData?.items ?? []).filter((l) => !hideDryRun || !isLeadDryRun(l)).length === 0 ? (
                      <tr>
                        <td colSpan={12} className="py-12 text-center text-zinc-500">
                          {hideDryRun ? "All visible leads are dry-run/sample leads. Uncheck 'Hide dry-run / sample leads' to view them." : "No leads found."}
                        </td>
                      </tr>
                    ) : (
                      (leadsData?.items ?? [])
                        .filter((lead) => !hideDryRun || !isLeadDryRun(lead))
                        .map((lead: Lead) => (
                        <tr
                          key={lead.id}
                          className="hover:bg-zinc-800/30 transition group"
                        >
                          {/* Selection */}
                          <td className="py-3 px-3">
                            <input
                              type="checkbox"
                              aria-label={`Select @${lead.username}`}
                              checked={selectedLeadIdSet.has(lead.id)}
                              onChange={() => toggleLeadSelection(lead.id)}
                              className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-900 accent-rose-500 disabled:opacity-30 disabled:cursor-not-allowed"
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
                                  {lead.username ? (
                                    <button
                                      onClick={() => setActiveLeadId(lead.id)}
                                      className="font-semibold text-zinc-100 hover:text-rose-400 transition truncate text-left"
                                    >
                                      @{lead.username}
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => setActiveLeadId(lead.id)}
                                      className="font-semibold text-zinc-100 hover:text-rose-400 transition truncate text-left inline-flex items-center gap-1.5"
                                    >
                                      <span>{lead.fullName || "Unnamed Lead"}</span>
                                      <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-semibold text-zinc-400 border border-zinc-700">
                                        No Instagram
                                      </span>
                                    </button>
                                  )}
                                  {lead.email && (
                                    <span
                                      className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-sky-300 border border-sky-500/20"
                                      title={lead.email}
                                    >
                                      Email
                                    </span>
                                  )}
                                  {isLeadDryRun(lead) ? (
                                    <span
                                      className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-400 border border-amber-500/20"
                                      title="Dry-run / sample lead (messaging blocked)"
                                    >
                                      Mode: DRY-RUN
                                    </span>
                                  ) : (
                                    <span
                                      className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400 border border-emerald-500/20"
                                      title="Real discovered lead"
                                    >
                                      Mode: REAL
                                    </span>
                                  )}
                                  {lead.isGroup && (
                                    <span
                                      className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-sky-300 border border-sky-500/20"
                                      title={`Multi-location group${lead.groupKey ? ` (${lead.groupKey})` : ""}`}
                                    >
                                      GROUP
                                    </span>
                                  )}
                                  {lead.scoreFlags?.includes("NAME_WEBSITE_MISMATCH") && (
                                    <span
                                      className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300 border border-amber-500/20"
                                      title="Business name does not match website domain"
                                    >
                                      NAME/SITE MISMATCH
                                    </span>
                                  )}
                                  {lead.handleSource && (
                                    <span
                                      className="shrink-0 rounded bg-indigo-500/10 px-1.5 py-0.5 text-[9px] font-medium text-indigo-300 border border-indigo-500/20"
                                      title={`Handle source: ${lead.handleSource}${lead.handleConfidence ? ` (${lead.handleConfidence})` : ""}`}
                                    >
                                      {lead.handleSource}
                                      {lead.handleConfidence ? ` · ${lead.handleConfidence}` : ""}
                                    </span>
                                  )}
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
                                </div>
                                {lead.fullName && lead.username && (
                                  <div className="text-[11px] text-zinc-400 truncate">{lead.fullName}</div>
                                )}
                                {!lead.username && (
                                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                    <span className="text-[10px] text-zinc-500">Channels:</span>
                                    {lead.email && <span className="text-[9px] rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 px-1 font-medium truncate max-w-[140px]" title={lead.email}>{lead.email}</span>}
                                    {lead.phone && <span className="text-[9px] rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 px-1 font-medium">{lead.phone}</span>}
                                    {lead.website && <span className="text-[9px] rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 px-1 font-medium truncate max-w-[120px]" title={lead.website}>{lead.website.replace(/^https?:\/\//, "")}</span>}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>

                          {/* Followers */}
                          <td className="py-3 px-4">
                            {(() => {
                              if (!lead.username) {
                                return (
                                  <div className="flex items-center gap-1.5">
                                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400 border border-zinc-700 whitespace-nowrap">
                                      No handle
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => handleEnrichHandleSingle(lead.id)}
                                      disabled={enrichingLeadId === lead.id}
                                      className="rounded bg-sky-600/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300 border border-sky-500/30 hover:bg-sky-600/30 transition disabled:opacity-50"
                                      title="Discover Instagram handle from website (homepage, /contact, link hubs)"
                                    >
                                      {enrichingLeadId === lead.id ? "..." : "⚡ Find IG"}
                                    </button>
                                  </div>
                                );
                              }
                              const isNotEnriched =
                                (lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" ||
                                (!lead.followersCount && !lead.followers && !lead.biography);
                              if (isNotEnriched) {
                                return (
                                  <div className="flex items-center gap-1.5">
                                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20 whitespace-nowrap">
                                      Not enriched
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => handleEnrichSingle(lead.id)}
                                      disabled={enrichingLeadId === lead.id}
                                      className="rounded bg-rose-600/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300 border border-rose-500/30 hover:bg-rose-600/30 transition disabled:opacity-50"
                                      title="Enrich Profile (Est. ~$0.0026)"
                                    >
                                      {enrichingLeadId === lead.id ? "..." : "Enrich"}
                                    </button>
                                  </div>
                                );
                              }
                              return (
                                <span className="font-semibold text-zinc-200">
                                  {formatNumber(lead.followersCount ?? lead.followers)}
                                </span>
                              );
                            })()}
                          </td>

                          {/* Following */}
                          <td className="py-3 px-4 text-zinc-400">
                            {(() => {
                              const isNotEnriched =
                                (lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" ||
                                (!lead.followersCount && !lead.followers && !lead.biography);
                              return isNotEnriched ? "—" : formatNumber(lead.followsCount ?? lead.following);
                            })()}
                          </td>

                          {/* Posts */}
                          <td className="py-3 px-4 text-zinc-400">
                            {(() => {
                              const isNotEnriched =
                                (lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" ||
                                (!lead.followersCount && !lead.followers && !lead.biography);
                              return isNotEnriched ? "—" : formatNumber(lead.postsCount);
                            })()}
                          </td>

                          {/* Category */}
                          <td className="py-3 px-4">
                            {lead.businessCategoryName || lead.category || (lead.rawProfileData as { mapsCategory?: string } | undefined)?.mapsCategory ? (
                              <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 font-medium">
                                {lead.businessCategoryName || lead.category || (lead.rawProfileData as { mapsCategory?: string } | undefined)?.mapsCategory}
                              </span>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </td>

                          {/* Score */}
                          <td className="py-3 px-4">
                            {(() => {
                              if (typeof lead.qualityScore === "number") {
                                const tier =
                                  lead.qualityTier ||
                                  (lead.qualityScore >= 75
                                    ? "A"
                                    : lead.qualityScore >= 55
                                      ? "B"
                                      : lead.qualityScore >= 35
                                        ? "C"
                                        : "D");
                                const tierStyles: Record<string, string> = {
                                  A: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
                                  B: "bg-sky-500/10 text-sky-400 border-sky-500/25",
                                  C: "bg-amber-500/10 text-amber-400 border-amber-500/25",
                                  D: "bg-rose-500/10 text-rose-400 border-rose-500/25",
                                };
                                const badgeStyle = tierStyles[tier] ?? "bg-zinc-800 text-zinc-300 border-zinc-700";
                                const flagsList =
                                  Array.isArray(lead.scoreFlags) && lead.scoreFlags.length > 0
                                    ? lead.scoreFlags.join(", ")
                                    : "None";
                                let breakdownTooltip = "";
                                if (Array.isArray(lead.scoreBreakdown)) {
                                  breakdownTooltip =
                                    "\n\nBreakdown:\n" +
                                    (lead.scoreBreakdown as Array<{ displayName: string; points: number; maxPoints: number; skipped: boolean }>)
                                      .map((b) => `• ${b.displayName}: ${b.skipped ? "Omitted (no IG)" : `${b.points}/${b.maxPoints} pts`}`)
                                      .join("\n");
                                }
                                const tooltip = `Lead Quality Score: ${lead.qualityScore}/100 (Tier ${tier})\nFlags: ${flagsList}${lead.isChain ? "\n• Flagged as multi-location chain" : ""}${!lead.username ? "\n• Tier capped at B (no IG handle for Instagram DM)" : ""}${breakdownTooltip}`;

                                return (
                                  <div className="flex flex-col gap-1 items-start">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span
                                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold border ${badgeStyle} cursor-help`}
                                        title={tooltip}
                                      >
                                        <span>Tier {tier}</span>
                                        <span className="opacity-60">•</span>
                                        <span>{lead.qualityScore}</span>
                                      </span>
                                      {lead.isChain && (
                                        <span
                                          className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-red-400 border border-red-500/20"
                                          title="Corporate chain / franchise detected"
                                        >
                                          CHAIN
                                        </span>
                                      )}
                                    </div>
                                    {Array.isArray(lead.scoreFlags) && lead.scoreFlags.length > 0 && (
                                      <span className="text-[10px] text-zinc-500 truncate max-w-[120px]" title={flagsList}>
                                        {lead.scoreFlags[0].replace(/_/g, " ")}
                                        {lead.scoreFlags.length > 1 ? ` +${lead.scoreFlags.length - 1}` : ""}
                                      </span>
                                    )}
                                  </div>
                                );
                              }

                              const scoreVal =
                                lead.leadScore ??
                                lead.aiScore ??
                                (lead.rawProfileData as { aiAnalysis?: { score?: number } } | undefined)?.aiAnalysis?.score;
                              if (typeof scoreVal === "number") {
                                const badgeColor =
                                  scoreVal >= 80
                                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                    : scoreVal >= 70
                                      ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                                      : "bg-amber-500/10 text-amber-400 border-amber-500/20";
                                return (
                                  <span
                                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold border ${badgeColor}`}
                                    title={`AI Relevance Score: ${scoreVal}/100`}
                                  >
                                    <span>★</span>
                                    <span>{scoreVal}</span>
                                  </span>
                                );
                              }
                              return <span className="text-zinc-600">—</span>;
                            })()}
                          </td>

                          {/* City / Location */}
                          <td className="hidden py-3 px-4 text-zinc-400 lg:table-cell">
                            {lead.location || (lead.rawProfileData as { city?: string; address?: string } | undefined)?.city || (lead.rawProfileData as { address?: string } | undefined)?.address ? (
                              <span className="text-[11px] truncate max-w-[140px] block" title={lead.location || (lead.rawProfileData as { address?: string } | undefined)?.address}>
                                {lead.location || (lead.rawProfileData as { city?: string; address?: string } | undefined)?.city || (lead.rawProfileData as { address?: string } | undefined)?.address}
                              </span>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </td>

                          {/* Contact & Socials */}
                          <td className="hidden py-3 px-4 md:table-cell">
                            {(() => {
                              const contactsData = (lead.rawProfileData as { contacts?: { whatsapps?: Array<{ url: string; phone?: string }> } } | undefined)?.contacts;
                              const whatsapps = contactsData?.whatsapps ?? [];
                              const hasEmail = Boolean(lead.email);
                              const hasPhone = Boolean(lead.phone || (lead.rawProfileData as { phone?: string } | undefined)?.phone);
                              const hasWebsite = Boolean(lead.website || (lead.rawProfileData as { website?: string } | undefined)?.website);
                              const hasWhatsapp = whatsapps.length > 0;
                              const socials = (lead.rawProfileData as { socialLinks?: Record<string, string | null> } | undefined)?.socialLinks;
                              const socialEntries = socials ? Object.entries(socials).filter((entry) => Boolean(entry[1])) : [];
                              const hasAnySocial = socialEntries.length > 0 || Boolean(lead.socialLink);

                              if (!hasEmail && !hasPhone && !hasWebsite && !hasWhatsapp && !hasAnySocial) {
                                return (
                                  <button
                                    type="button"
                                    onClick={() => handleFindContactsSingle(lead.id)}
                                    disabled={findingContactsLeadId === lead.id}
                                    className="rounded bg-emerald-600/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 border border-emerald-500/20 hover:bg-emerald-600/20 transition disabled:opacity-50"
                                    title="Extract contacts from bio and website"
                                  >
                                    {findingContactsLeadId === lead.id ? "Searching..." : "🔍 Find contacts"}
                                  </button>
                                );
                              }

                              return (
                                <div className="flex flex-col gap-1 text-[11px]">
                                  {hasEmail && (
                                    <a
                                      href={`mailto:${lead.email}`}
                                      className="text-zinc-300 hover:text-emerald-400 inline-flex items-center gap-1 truncate max-w-[130px]"
                                      title={lead.email ?? ""}
                                    >
                                      <span className="text-xs">✉️</span>
                                      <span className="truncate">{lead.email}</span>
                                    </a>
                                  )}
                                  {hasPhone && (
                                    <a
                                      href={`tel:${lead.phoneNormalized || lead.phone || (lead.rawProfileData as { phone?: string } | undefined)?.phone}`}
                                      className="text-zinc-300 hover:text-emerald-400 inline-flex items-center gap-1 truncate max-w-[130px]"
                                      title={lead.phone || (lead.rawProfileData as { phone?: string } | undefined)?.phone}
                                    >
                                      <span className="text-xs">📞</span>
                                      <span className="truncate">{lead.phone || (lead.rawProfileData as { phone?: string } | undefined)?.phone}</span>
                                    </a>
                                  )}
                                  {hasWhatsapp && (
                                    <a
                                      href={whatsapps[0].url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1 truncate max-w-[130px]"
                                      title={whatsapps[0].url}
                                    >
                                      <span className="text-xs">💬</span>
                                      <span className="truncate">{whatsapps[0].phone ? `WA: ${whatsapps[0].phone}` : "WhatsApp"}</span>
                                    </a>
                                  )}
                                  {hasWebsite && (
                                    <a
                                      href={(() => {
                                        const w = lead.website || (lead.rawProfileData as { website?: string } | undefined)?.website || "";
                                        return w.startsWith("http") ? w : `https://${w}`;
                                      })()}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-zinc-400 hover:text-sky-400 inline-flex items-center gap-1 truncate max-w-[130px]"
                                      title={lead.website || (lead.rawProfileData as { website?: string } | undefined)?.website}
                                    >
                                      <span className="text-xs">🌐</span>
                                      <span className="truncate">{(lead.website || (lead.rawProfileData as { website?: string } | undefined)?.website || "").replace(/^https?:\/\/(www\.)?/, "")}</span>
                                    </a>
                                  )}
                                  {hasAnySocial && (
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                      {socialEntries.map(([platform, url]) => (
                                        <a
                                          key={platform}
                                          href={url!.startsWith("http") ? url! : `https://${url}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-zinc-400 hover:text-rose-400 transition"
                                          title={`Open ${platform}`}
                                        >
                                          <SocialPlatformIcon platform={platform} className="h-3.5 w-3.5" />
                                        </a>
                                      ))}
                                      {lead.socialLink && !socialEntries.some(([p]) => p.toLowerCase() === (lead.socialPlatform || "").toLowerCase()) && (
                                        <a
                                          href={lead.socialLink.startsWith("http") ? lead.socialLink : `https://${lead.socialLink}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-zinc-400 hover:text-sky-400 transition"
                                          title={`Open ${lead.socialPlatform || "social"}`}
                                        >
                                          <SocialPlatformIcon platform={lead.socialPlatform || "social"} className="h-3.5 w-3.5" />
                                        </a>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </td>

                          {/* Bio */}
                          <td className="hidden py-3 px-4 xl:table-cell">
                            {(() => {
                              const isNotEnriched =
                                (lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" ||
                                (!lead.followersCount && !lead.followers && !lead.biography);
                              if (isNotEnriched) {
                                return <span className="text-zinc-500 italic text-[11px]">Not enriched</span>;
                              }
                              return lead.biography ? (
                                <span className="block max-w-[220px] truncate text-[11px] text-zinc-400" title={lead.biography}>
                                  {lead.biography}
                                </span>
                              ) : (
                                <span className="text-zinc-600">—</span>
                              );
                            })()}
                          </td>

                          {/* Scraped At */}
                          <td className="hidden py-3 px-4 text-[11px] text-zinc-400 lg:table-cell">
                            {lead.scrapedAt ? new Date(lead.scrapedAt).toLocaleDateString() : "—"}
                          </td>

                          {/* Actions */}
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {(() => {
                                const isNotEnriched =
                                  (lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" ||
                                  (!lead.followersCount && !lead.followers && !lead.biography);
                                if (isNotEnriched) {
                                  return (
                                    <button
                                      type="button"
                                      onClick={() => handleEnrichSingle(lead.id)}
                                      disabled={enrichingLeadId === lead.id}
                                      className="rounded bg-rose-600/20 px-2 py-1 text-xs font-semibold text-rose-300 border border-rose-500/30 hover:bg-rose-600/30 transition disabled:opacity-50"
                                      title="Enrich Profile (Est. ~$0.0026)"
                                    >
                                      {enrichingLeadId === lead.id ? "..." : "⚡ Enrich"}
                                    </button>
                                  );
                                }
                                return null;
                              })()}
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
                              {lead.username ? (
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
                              ) : (
                                <span
                                  className="inline-flex items-center gap-1 rounded bg-zinc-800/60 px-2.5 py-1 text-xs font-medium text-zinc-500 border border-zinc-700/50 cursor-not-allowed"
                                  title="Instagram DM unavailable: Lead has no Instagram handle"
                                >
                                  No IG DM
                                </span>
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
                              <button
                                type="button"
                                id={`btn-delete-lead-${lead.id}`}
                                onClick={() => setLeadPendingDelete(lead)}
                                className="rounded p-1.5 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition"
                                title={`Delete @${lead.username}`}
                                aria-label={`Delete @${lead.username}`}
                              >
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
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
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {lead.username ? (
                                <button
                                  onClick={() => setActiveLeadId(lead.id)}
                                  className="font-semibold text-zinc-100 hover:text-rose-400 transition truncate text-left text-sm"
                                >
                                  @{lead.username}
                                </button>
                              ) : (
                                <button
                                  onClick={() => setActiveLeadId(lead.id)}
                                  className="font-semibold text-zinc-100 hover:text-rose-400 transition truncate text-left text-sm inline-flex items-center gap-1.5"
                                >
                                  <span>{lead.fullName || "Unnamed Lead"}</span>
                                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-semibold text-zinc-400 border border-zinc-700">
                                    No Instagram
                                  </span>
                                </button>
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
                              {isLeadDryRun(lead) ? (
                                <span
                                  className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-400 border border-amber-500/20"
                                  title="Dry-run / sample lead (messaging blocked)"
                                >
                                  Mode: DRY-RUN
                                </span>
                              ) : (
                                <span
                                  className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400 border border-emerald-500/20"
                                  title="Real discovered lead"
                                >
                                  Mode: REAL
                                </span>
                              )}
                              {lead.isGroup && (
                                <span
                                  className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-sky-300 border border-sky-500/20"
                                  title={`Multi-location group${lead.groupKey ? ` (${lead.groupKey})` : ""}`}
                                >
                                  GROUP
                                </span>
                              )}
                              {lead.scoreFlags?.includes("NAME_WEBSITE_MISMATCH") && (
                                <span
                                  className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300 border border-amber-500/20"
                                  title="Business name does not match website domain"
                                >
                                  NAME/SITE MISMATCH
                                </span>
                              )}
                            </div>
                            {lead.fullName && (
                              <p className="text-xs text-zinc-400 truncate">{lead.fullName}</p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap justify-end">
                          {typeof lead.qualityScore === "number" && (
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold border ${lead.qualityTier === "A" || lead.qualityScore >= 75
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                                  : lead.qualityTier === "B" || lead.qualityScore >= 55
                                    ? "bg-sky-500/10 text-sky-400 border-sky-500/25"
                                    : lead.qualityTier === "C" || lead.qualityScore >= 35
                                      ? "bg-amber-500/10 text-amber-400 border-amber-500/25"
                                      : "bg-rose-500/10 text-rose-400 border-rose-500/25"
                                }`}
                            >
                              Tier {lead.qualityTier ?? (lead.qualityScore >= 75 ? "A" : lead.qualityScore >= 55 ? "B" : "C")} • {lead.qualityScore}
                            </span>
                          )}
                          {lead.isChain && (
                            <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-red-400 border border-red-500/20">
                              CHAIN
                            </span>
                          )}
                          {(lead.isBusinessAccount ?? lead.isBusiness) && (
                            <span className="shrink-0 rounded bg-purple-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-purple-400 border border-purple-500/20">
                              BUSINESS
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Stats */}
                      {(() => {
                        const isNotEnriched =
                          (lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" ||
                          (!lead.followersCount && !lead.followers && !lead.biography);
                        if (isNotEnriched) {
                          return (
                            <div className="flex items-center justify-between rounded-lg bg-zinc-900/60 p-2.5 text-xs border border-zinc-800">
                              <div className="flex items-center gap-1.5">
                                <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20">
                                  Not enriched
                                </span>
                                <span className="text-zinc-500 text-[11px]">Followers &amp; bio lazy</span>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleEnrichSingle(lead.id)}
                                disabled={enrichingLeadId === lead.id}
                                className="rounded bg-rose-600/20 px-2.5 py-1 text-xs font-semibold text-rose-300 border border-rose-500/30 hover:bg-rose-600/30 transition disabled:opacity-50"
                                title="Enrich Profile (Est. ~$0.0026)"
                              >
                                {enrichingLeadId === lead.id ? "..." : "⚡ Enrich (~$0.0026)"}
                              </button>
                            </div>
                          );
                        }
                        return (
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
                        );
                      })()}

                      {/* Bio */}
                      {lead.biography ? (
                        <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">
                          {lead.biography}
                        </p>
                      ) : (
                        (lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" && (
                          <p className="text-xs text-zinc-500 italic">Bio not enriched yet</p>
                        )
                      )}

                      {/* Category & Location & Phone */}
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        {(lead.businessCategoryName || lead.category || (lead.rawProfileData as { mapsCategory?: string } | undefined)?.mapsCategory) && (
                          <span className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-300 font-medium">
                            {lead.businessCategoryName || lead.category || (lead.rawProfileData as { mapsCategory?: string } | undefined)?.mapsCategory}
                          </span>
                        )}
                        {(lead.location || (lead.rawProfileData as { city?: string } | undefined)?.city) && (
                          <span className="rounded bg-zinc-800/60 px-2 py-0.5 text-zinc-400">
                            📍 {lead.location || (lead.rawProfileData as { city?: string } | undefined)?.city}
                          </span>
                        )}
                        {(lead.phone || (lead.rawProfileData as { phone?: string } | undefined)?.phone) && (
                          <a
                            href={`tel:${lead.phoneNormalized || lead.phone || (lead.rawProfileData as { phone?: string } | undefined)?.phone}`}
                            className="rounded bg-zinc-800/60 px-2 py-0.5 text-zinc-300 hover:text-emerald-400"
                          >
                            📞 {lead.phone || (lead.rawProfileData as { phone?: string } | undefined)?.phone}
                          </a>
                        )}
                      </div>

                      {/* Other Social Links on Mobile */}
                      {(() => {
                        const socials = (lead.rawProfileData as { socialLinks?: Record<string, string | null> } | undefined)?.socialLinks;
                        const entries = socials ? Object.entries(socials).filter((entry) => Boolean(entry[1])) : [];
                        if (entries.length === 0) return null;
                        return (
                          <div className="flex items-center gap-2 pt-0.5">
                            <span className="text-[10px] text-zinc-500 uppercase font-semibold">Socials:</span>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {entries.map(([platform, url]) => (
                                <a
                                  key={platform}
                                  href={url!.startsWith("http") ? url! : `https://${url}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-zinc-400 hover:text-rose-400"
                                  title={platform}
                                >
                                  <SocialPlatformIcon platform={platform} className="h-3.5 w-3.5" />
                                </a>
                              ))}
                            </div>
                          </div>
                        );
                      })()}

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
                          {(() => {
                            if (!lead.username) {
                              return (
                                <button
                                  type="button"
                                  onClick={() => handleEnrichHandleSingle(lead.id)}
                                  disabled={enrichingLeadId === lead.id}
                                  className="rounded bg-sky-600/20 px-2 py-1 text-xs font-semibold text-sky-300 border border-sky-500/30 hover:bg-sky-600/30 transition disabled:opacity-50"
                                >
                                  {enrichingLeadId === lead.id ? "..." : "⚡ Find IG"}
                                </button>
                              );
                            }
                            const isNotEnriched =
                              (lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" ||
                              (!lead.followersCount && !lead.followers && !lead.biography);
                            if (isNotEnriched) {
                              return (
                                <button
                                  type="button"
                                  onClick={() => handleEnrichSingle(lead.id)}
                                  disabled={enrichingLeadId === lead.id}
                                  className="rounded bg-rose-600/20 px-2 py-1 text-xs font-semibold text-rose-300 border border-rose-500/30 hover:bg-rose-600/30 transition disabled:opacity-50"
                                >
                                  {enrichingLeadId === lead.id ? "..." : "Enrich"}
                                </button>
                              );
                            }
                            return null;
                          })()}
                          {lead.username ? (
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
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 rounded-lg bg-zinc-800/60 px-2 py-1 text-xs font-medium text-zinc-500 border border-zinc-700/50 cursor-not-allowed"
                              title="Instagram DM unavailable: Lead has no Instagram handle"
                            >
                              No IG DM
                            </span>
                          )}
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
                          <button
                            type="button"
                            onClick={() => setLeadPendingDelete(lead)}
                            className="rounded-lg p-1.5 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition"
                            title={`Delete @${lead.username}`}
                            aria-label={`Delete @${lead.username}`}
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
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
                            className={`min-w-[28px] h-7 rounded px-2 text-xs font-medium transition ${pageNum === page
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
                      scrapeJobs.map((job) => {
                        const runIds: string[] = Array.isArray(job.usage?.runIds) ? (job.usage.runIds as string[]) : [];
                        const hasRealRunId = runIds.length > 0 && runIds.some(
                          (id) => typeof id === "string" && id.trim().length > 0 && !id.startsWith("dry_run_") && id !== "unknown"
                        );

                        // Refuse to label REAL if runs = 0 or no real Apify run ID exists (or if run ID is dry_run_* or unknown)
                        const isDry = Boolean(
                          job.isDryRun === true ||
                          job.usage?.isDryRun ||
                          job.provider?.toLowerCase().includes("dry") ||
                          job.provider?.toLowerCase().includes("mock") ||
                          !hasRealRunId ||
                          (job.costUsd === 0 && job.status === "COMPLETED" && (job.usage?.placesFetched ?? 0) === 0)
                        );

                        return (
                          <tr key={job.id} className="hover:bg-zinc-800/30">
                            <td className="py-3 px-4">{getStatusBadge(job.status)}</td>
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-mono uppercase text-zinc-300">{job.provider}</span>
                                {isDry ? (
                                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-400 border border-amber-500/20">
                                    Mode: DRY-RUN
                                  </span>
                                ) : (
                                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400 border border-emerald-500/20">
                                    Mode: REAL
                                  </span>
                                )}
                              </div>
                            </td>
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

                              <div className="mt-2 flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}
                                  className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold text-indigo-300 hover:bg-zinc-700 transition"
                                >
                                  {expandedJobId === job.id ? "Hide Summary ▲" : "Job Summary ▼"}
                                </button>
                                {job.costUsd !== null && job.costUsd !== undefined && (
                                  <span className="text-[10px] text-zinc-400 font-mono">
                                    Spend: <strong className="text-zinc-200">${Number(job.costUsd).toFixed(3)}</strong>
                                  </span>
                                )}
                                {job.stopReason && (
                                  <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[9px] font-mono text-zinc-400">
                                    {job.stopReason}
                                  </span>
                                )}
                              </div>

                              {expandedJobId === job.id && (
                                <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 text-xs space-y-2.5 font-mono">
                                  <div className="flex flex-wrap items-center justify-between text-zinc-300 pb-2 border-b border-zinc-800">
                                    <div className="flex items-center gap-2">
                                      <span className="font-semibold text-indigo-300">Funnel &amp; Spend Summary</span>
                                      {isDry ? (
                                        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-400 border border-amber-500/20">
                                          Mode: DRY-RUN
                                        </span>
                                      ) : (
                                        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400 border border-emerald-500/20">
                                          Mode: REAL
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-[11px] text-zinc-400">
                                      Stop: <strong className="text-zinc-200">{job.stopReason || "COMPLETED"}</strong>
                                    </span>
                                  </div>

                                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 text-[11px]">
                                    <div className="bg-zinc-900/60 p-2 rounded border border-zinc-800/80">
                                      <div className="text-zinc-500 uppercase text-[9px]">Places Fetched</div>
                                      <div className="text-sm font-bold text-zinc-100">{job.usage?.placesFetched ?? job.candidatesDiscovered ?? 0}</div>
                                    </div>
                                    <div className="bg-zinc-900/60 p-2 rounded border border-zinc-800/80">
                                      <div className="text-zinc-500 uppercase text-[9px]">Contactable (IG)</div>
                                      <div className="text-sm font-bold text-sky-400">{job.usage?.contactableWithIg ?? job.candidatesEnriched ?? 0}</div>
                                    </div>
                                    <div className="bg-zinc-900/60 p-2 rounded border border-zinc-800/80">
                                      <div className="text-zinc-500 uppercase text-[9px]">Handle Yield</div>
                                      <div className="text-sm font-bold text-indigo-400">
                                        {job.usage?.handleYieldPct !== undefined
                                          ? `${job.usage.handleYieldPct}%`
                                          : (job.usage?.placesFetched ?? 0) > 0
                                            ? `${Math.round(((job.usage?.contactableWithIg ?? 0) / (job.usage?.placesFetched ?? 1)) * 100)}%`
                                            : "0%"}
                                      </div>
                                    </div>
                                    <div className="bg-zinc-900/60 p-2 rounded border border-zinc-800/80">
                                      <div className="text-zinc-500 uppercase text-[9px]">Without IG (Contactable)</div>
                                      <div className="text-sm font-bold text-zinc-300">{String((job.usage as Record<string, unknown> | null)?.noIgButContactableCount ?? (job.usage as Record<string, unknown> | null)?.contactableWithoutIg ?? 0)}</div>
                                    </div>
                                    <div className="bg-zinc-900/60 p-2 rounded border border-zinc-800/80">
                                      <div className="text-zinc-500 uppercase text-[9px]">Name Mismatch</div>
                                      <div className="text-sm font-bold text-amber-400">{String((job.usage as Record<string, unknown> | null)?.nameMismatchCount ?? 0)}</div>
                                    </div>
                                    <div className="bg-zinc-900/60 p-2 rounded border border-zinc-800/80">
                                      <div className="text-zinc-500 uppercase text-[9px]">Group Members</div>
                                      <div className="text-sm font-bold text-teal-400">{String((job.usage as Record<string, unknown> | null)?.groupDedupedCount ?? 0)}</div>
                                    </div>
                                    <div className="bg-zinc-900/60 p-2 rounded border border-zinc-800/80">
                                      <div className="text-zinc-500 uppercase text-[9px]">Leads Saved</div>
                                      <div className="text-sm font-bold text-emerald-400">{job.processedCount}</div>
                                    </div>
                                  </div>

                                  {/* Dropped Reasons */}
                                  <div className="pt-1">
                                    <div className="text-[10px] text-zinc-500 uppercase font-semibold">Dropped Reasons</div>
                                    <div className="flex flex-wrap gap-2 mt-1 text-[11px] text-zinc-400">
                                      <span>Closed: <strong className="text-zinc-200">{job.usage?.droppedByReason?.closed ?? 0}</strong></span>
                                      <span>•</span>
                                      <span>Wrong city: <strong className="text-zinc-200">{job.usage?.droppedByReason?.wrong_city ?? 0}</strong></span>
                                      <span>•</span>
                                      <span>Chain: <strong className="text-zinc-200">{job.usage?.droppedByReason?.chain ?? 0}</strong></span>
                                      <span>•</span>
                                      <span>Negative kw: <strong className="text-zinc-200">{job.usage?.droppedByReason?.negative_keyword ?? 0}</strong></span>
                                      <span>•</span>
                                      <span>No contact: <strong className="text-zinc-200">{job.usage?.droppedByReason?.no_contact ?? 0}</strong></span>
                                    </div>
                                  </div>

                                  {/* Tier Counts */}
                                  <div className="pt-1 border-t border-zinc-800/80">
                                    <div className="text-[10px] text-zinc-500 uppercase font-semibold">Lead Quality Tiers</div>
                                    <div className="flex flex-wrap gap-3 mt-1 text-[11px]">
                                      <span className="text-emerald-400">Tier A: <strong>{job.usage?.tierCounts?.A ?? 0}</strong></span>
                                      <span className="text-sky-400">Tier B: <strong>{job.usage?.tierCounts?.B ?? 0}</strong></span>
                                      <span className="text-amber-400">Tier C: <strong>{job.usage?.tierCounts?.C ?? 0}</strong></span>
                                      <span className="text-rose-400">Tier D: <strong>{job.usage?.tierCounts?.D ?? 0}</strong></span>
                                    </div>
                                  </div>

                                  {/* Spend By Stage */}
                                  <div className="pt-1 border-t border-zinc-800/80">
                                    <div className="text-[10px] text-zinc-500 uppercase font-semibold">Spend By Stage</div>
                                    <div className="flex flex-wrap gap-3 mt-1 text-[11px] text-zinc-400">
                                      <span>Maps: <strong className="text-zinc-200">${((job.usage?.spendByStage?.maps ?? (job.costBreakdown as { maps?: number })?.maps ?? 0)).toFixed(4)}</strong></span>
                                      <span>Profiles: <strong className="text-zinc-200">${((job.usage?.spendByStage?.profiles ?? (job.costBreakdown as { profiles?: number })?.profiles ?? 0)).toFixed(4)}</strong></span>
                                      <span>Gemini: <strong className="text-zinc-200">${((job.usage?.spendByStage?.gemini ?? (job.costBreakdown as { gemini?: number })?.gemini ?? 0)).toFixed(4)}</strong></span>
                                      <span className="text-indigo-300 font-bold">Total: ${Number(job.costUsd ?? 0).toFixed(4)} USD</span>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })
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

        {/* Email channel */}
        {activeTab === "email" && campaign && (
          <div className="mt-6">
            <CampaignEmailTab campaignId={campaign.id} />
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

      {/* Delete Single Lead Confirmation */}
      <ConfirmModal
        isOpen={Boolean(leadPendingDelete)}
        title="Delete Lead"
        message={
          leadPendingDelete
            ? `Are you sure you want to delete @${leadPendingDelete.username}? All associated outreach history, status logs, and messages will be permanently removed.`
            : ""
        }
        confirmLabel="Delete Lead"
        isDangerous={true}
        isLoading={isDeletingLeads}
        onConfirm={handleConfirmSingleDelete}
        onCancel={() => setLeadPendingDelete(null)}
      />

      {/* Delete Selected Leads Confirmation */}
      <ConfirmModal
        isOpen={showBulkDeleteConfirm}
        title="Delete Selected Leads"
        message={`Are you sure you want to permanently delete ${selectedLeadIds.length} selected lead${selectedLeadIds.length === 1 ? "" : "s"} from "${campaign?.name || "this campaign"}"? This action cannot be undone.`}
        confirmLabel={`Delete ${selectedLeadIds.length} Lead${selectedLeadIds.length === 1 ? "" : "s"}`}
        isDangerous={true}
        isLoading={isDeletingLeads}
        onConfirm={handleConfirmBulkDelete}
        onCancel={() => setShowBulkDeleteConfirm(false)}
      />

      {/* Delete Dry-Run Leads Confirmation */}
      <ConfirmModal
        isOpen={showDeleteDryRunConfirm}
        title="Delete Dry-Run / Sample Leads"
        message={`Are you sure you want to permanently delete all dry-run and sample leads in "${campaign?.name || "this campaign"}"? Real leads will be preserved. Make sure you have a database backup (e.g. pg_dump) before proceeding.`}
        confirmLabel="Delete Dry-Run Leads"
        isDangerous={true}
        isLoading={isDeletingDryRunLeads}
        onConfirm={handleConfirmDeleteDryRun}
        onCancel={() => setShowDeleteDryRunConfirm(false)}
      />


      {/* Edit Campaign Modal */}
      {isEditModalOpen && campaign && (
        <EditCampaignModal
          isOpen={isEditModalOpen}
          campaign={campaign}
          onClose={() => setIsEditModalOpen(false)}
          onUpdated={(updated) => {
            setCampaign((prev) => (prev ? { ...prev, ...updated } : null));
            fetchCampaignInfo();
          }}
        />
      )}

      {/* CSV Lead Upload Modal */}
      {isCsvUploadModalOpen && campaign && (
        <CsvUploadModal
          isOpen={isCsvUploadModalOpen}
          campaignId={campaign.id}
          campaignName={campaign.name}
          onClose={() => setIsCsvUploadModalOpen(false)}
          onSuccess={() => {
            fetchLeads();
            fetchCampaignInfo();
          }}
        />
      )}
    </div>
  );
}
