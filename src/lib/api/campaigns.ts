import { apiFetch } from "./client";

export type CampaignStatus = "DRAFT" | "RUNNING" | "COMPLETED" | "FAILED";

export type ExecutionMode = "MANUAL" | "REVIEW_REQUIRED";

export type ApprovalMode = "MANUAL" | "AUTO_ELIGIBLE";

export type CampaignSummary = {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  executionMode?: ExecutionMode;
  messageApprovalRequired?: boolean;
  requireApproval: boolean;
  approvalMode: ApprovalMode;
  autoApproveMinScore: number;
  qualityMaxRegenerations: number;
  scheduledAt?: string | null;
  intent?: string | null;
  location?: string | null;
  category?: string | null;
  leadLimit?: number | null;
  followUpEnabled?: boolean;
  followUpCount?: number;
  followUpDelayDays?: number[];
  followUpTemplates?: string[];
  followUpSummary?: {
    scheduled: number;
    sent: number;
    cancelled: number;
    repliesAfterFollowUp: number;
    total: number;
  };
  companyProfileId?: string;
  companyProfile?: {
    id: string;
    name: string;
    description?: string | null;
    isDefault?: boolean;
    brandTone?: string | null;
    messageLanguage?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  leadCount: number;
  scrapeJobCount: number;
};

export type ScrapeJobUsage = {
  placesFetched?: number;
  contactableWithIg?: number;
  contactableWithoutIg?: number;
  droppedByReason?: {
    closed?: number;
    wrong_city?: number;
    chain?: number;
    negative_keyword?: number;
    no_contact?: number;
    [key: string]: number | undefined;
  };
  tierCounts?: {
    A?: number;
    B?: number;
    C?: number;
    D?: number;
    [key: string]: number | undefined;
  };
  spendByStage?: {
    maps?: number;
    profiles?: number;
    gemini?: number;
    [key: string]: number | undefined;
  };
  [key: string]: unknown;
};

export type ScrapeJobItem = {
  id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_WARNINGS" | "FAILED" | "CANCELLED" | "PAUSED" | "READY" | "DRAFT";
  provider: string;
  inputCount: number;
  processedCount: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  query?: string | null;
  location?: string | null;
  category?: string | null;
  discoveryActor?: string | null;
  enrichmentActor?: string | null;
  requestedLimit?: number | null;
  candidatesDiscovered?: number | null;
  candidatesEnriched?: number | null;
  candidatesSkipped?: number | null;
  isDryRun?: boolean | null;
  usage?: ScrapeJobUsage | null;
  stopReason?: string | null;
  costUsd?: number | string | null;
  costBreakdown?: Record<string, unknown> | null;
};

export type CampaignDetail = CampaignSummary & {
  recentScrapeJobs: ScrapeJobItem[];
};

export type CreateCampaignInput = {
  name: string;
  description?: string | null;
  executionMode?: ExecutionMode;
  messageApprovalRequired?: boolean;
  requireApproval?: boolean;
  approvalMode?: ApprovalMode;
  autoApproveMinScore?: number;
  qualityMaxRegenerations?: number;
  scheduledAt?: string | null;
  intent?: string | null;
  location?: string | null;
  category?: string | null;
  leadLimit?: number | null;
  followUpEnabled?: boolean;
  followUpCount?: number;
  followUpDelayDays?: number[];
  followUpTemplates?: string[];
  followUpSummary?: {
    scheduled: number;
    sent: number;
    cancelled: number;
    repliesAfterFollowUp: number;
    total: number;
  };
  companyProfileId?: string;
  companyProfile?: Record<string, unknown>;
};

export type UpdateCampaignInput = {
  name?: string;
  description?: string | null;
  status?: CampaignStatus;
  executionMode?: ExecutionMode;
  messageApprovalRequired?: boolean;
  requireApproval?: boolean;
  approvalMode?: ApprovalMode;
  autoApproveMinScore?: number;
  qualityMaxRegenerations?: number;
  scheduledAt?: string | null;
  intent?: string | null;
  location?: string | null;
  category?: string | null;
  leadLimit?: number | null;
  followUpEnabled?: boolean;
  followUpCount?: number;
  followUpDelayDays?: number[];
  followUpTemplates?: string[];
  requireNameInFirstMessage?: boolean;
  allowNeutralGreeting?: boolean;
  followUpAllowSenderSwitch?: boolean;
  reContactCooldownDays?: number | null;
  followUpSummary?: {
    scheduled: number;
    sent: number;
    cancelled: number;
    repliesAfterFollowUp: number;
    total: number;
  };
  companyProfileId?: string;
  autoOptimize?: boolean;
  explorationBudgetShare?: number;
};

export type AutoApprovalEligibility = {
  eligible: boolean;
  unmet: string[];
  metrics: {
    enabled: boolean;
    reviewed: number;
    minReviewed: number;
    approvalRate: number;
    minApprovalRate: number;
    editRate: number;
    maxEditRate: number;
  };
};

export async function getCampaigns(): Promise<CampaignSummary[]> {
  return apiFetch<CampaignSummary[]>("/api/campaigns");
}

export async function createCampaign(
  input: CreateCampaignInput,
): Promise<CampaignSummary> {
  return apiFetch<CampaignSummary>("/api/campaigns", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getCampaign(campaignId: string): Promise<CampaignDetail> {
  return apiFetch<CampaignDetail>(`/api/campaigns/${encodeURIComponent(campaignId)}`);
}

export async function updateCampaign(
  campaignId: string,
  input: UpdateCampaignInput,
): Promise<CampaignSummary> {
  return apiFetch<CampaignSummary>(`/api/campaigns/${encodeURIComponent(campaignId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function getCampaignApprovalEligibility(
  campaignId: string,
): Promise<AutoApprovalEligibility> {
  return apiFetch<AutoApprovalEligibility>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/approval-eligibility`,
  );
}

export async function deleteCampaign(
  campaignId: string,
): Promise<{ id: string; name?: string; deleted: boolean }> {
  return apiFetch<{ id: string; name?: string; deleted: boolean }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}`,
    {
      method: "DELETE",
    },
  );
}
