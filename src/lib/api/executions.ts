import { apiFetch } from "./client";

export type ExecutionMode = "MANUAL" | "REVIEW_REQUIRED";

export type CampaignStatus =
  | "DRAFT"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

export type CampaignExecutionStatus =
  | "PREVIEW"
  | "DRAFT"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

export type CampaignExecutionPhase =
  | "DISCOVERY"
  | "ENRICHMENT"
  | "READY"
  | "MESSAGING"
  | "FINALIZING";

export type ExecutionItemStatus =
  | "PENDING"
  | "APPROVED"
  | "SENDING"
  | "SKIPPED"
  | "SENT"
  | "FAILED";

export type CampaignExecutionStatusResponse = {
  campaignId: string;
  executionId: string | null;
  campaignStatus: CampaignStatus;
  executionStatus: CampaignExecutionStatus | null;
  currentPhase: CampaignExecutionPhase | null;
  totalLeads: number;
  eligibleLeads: number;
  overallProgress: number;
  leadCapacity: {
    leadLimit: number | null;
    currentLeads: number;
    remainingCapacity: number | null;
  };
  discoveryDetails: {
    query: string | null;
    location: string | null;
    category: string | null;
    targetLimit: number;
    candidatesFound: number;
    enriched: number;
    saved: number;
    skipped: number;
    discoverySkipped: boolean;
    skippedReason: string | null;
  } | null;
  discoveryProgress: {
    candidatesDiscovered: number;
    candidatesEnriched: number;
    candidatesSkipped: number;
    persisted: number;
  } | null;
  messagingProgress: {
    total: number;
    sent: number;
    failed: number;
    skipped: number;
    unknown: number;
    queued: number;
    processing: number;
    progress: number;
  } | null;
  sent: number;
  failed: number;
  skipped: number;
  unknown: number;
  queued: number;
  timestamps: {
    startedAt: string | null;
    pausedAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    updatedAt: string | null;
    elapsedSeconds: number | null;
  };
  safeError: {
    errorCode: string | null;
    errorMessage: string | null;
  } | null;
  estimatedCompletion?: {
    estimatedCompletionDate: string | null;
    healthySendersCount: number;
    dailyCapacity: number;
    daysRemaining: number | null;
    workingHoursWindow: string;
    sendWindow?: {
      enabled: boolean;
      start: string | null;
      end: string | null;
      days: number[] | null;
      timezone: string | null;
    };
  } | null;
};

export async function fetchCampaignExecutionStatus(
  campaignId: string,
): Promise<CampaignExecutionStatusResponse> {
  return apiFetch<CampaignExecutionStatusResponse>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/execution`,
  );
}

export async function startCampaignExecution(
  campaignId: string,
  options?: { templateId?: string; rerun?: boolean },
): Promise<{ execution: CampaignExecutionStatusResponse; isNew: boolean }> {
  return apiFetch<{ execution: CampaignExecutionStatusResponse; isNew: boolean }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/execute`,
    {
      method: "POST",
      body: options ? JSON.stringify(options) : undefined,
    },
  );
}

export async function pauseCampaignExecution(
  campaignId: string,
): Promise<{ executionId: string; status: CampaignExecutionStatus; pausedAt: string }> {
  return apiFetch<{ executionId: string; status: CampaignExecutionStatus; pausedAt: string }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/pause`,
    {
      method: "POST",
    },
  );
}

export async function resumeCampaignExecution(
  campaignId: string,
): Promise<{ executionId: string; status: CampaignExecutionStatus }> {
  return apiFetch<{ executionId: string; status: CampaignExecutionStatus }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/resume`,
    {
      method: "POST",
    },
  );
}

export async function cancelCampaignExecution(
  campaignId: string,
): Promise<{ executionId: string; status: CampaignExecutionStatus; cancelledAt: string }> {
  return apiFetch<{ executionId: string; status: CampaignExecutionStatus; cancelledAt: string }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/cancel`,
    {
      method: "POST",
    },
  );
}

// ---------------------------------------------------------------------------
// Legacy helpers
// ---------------------------------------------------------------------------

export type ExecutionPreviewItem = {
  id: string;
  leadId: string;
  username: string | null;
  messagePreview: string;
  status: ExecutionItemStatus;
};

export type ExecutionPreviewResponse = {
  campaignId: string;
  executionId: string;
  status: CampaignExecutionStatus;
  mode: ExecutionMode;
  totalEligibleLeads: number;
  planned: number;
  skipped: number;
  items: ExecutionPreviewItem[];
};

export type ExecutionDetailItem = {
  id: string;
  executionId: string;
  leadId: string;
  status: ExecutionItemStatus;
  messageText: string;
  errorMessage: string | null;
  processedAt: string | null;
  createdAt: string;
  lead: {
    id: string;
    username: string | null;
    fullName: string | null;
    profileUrl: string | null;
    category: string | null;
    followers: number | null;
  };
};

export type ExecutionDetailResponse = {
  id: string;
  campaignId: string;
  campaignName: string;
  status: CampaignExecutionStatus;
  executionMode: ExecutionMode;
  totalItems: number;
  processedItems: number;
  successfulItems: number;
  failedItems: number;
  pendingItems: number;
  approvedItems: number;
  skippedItems: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: ExecutionDetailItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export async function createCampaignExecution(
  campaignId: string,
  options?: {
    templateId?: string;
    executionMode?: ExecutionMode;
    leadIds?: string[];
  },
): Promise<ExecutionPreviewResponse> {
  return apiFetch<ExecutionPreviewResponse>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/execute`,
    {
      method: "POST",
      body: options ? JSON.stringify(options) : undefined,
    },
  );
}

export async function getCampaignExecution(
  executionId: string,
  params?: {
    page?: number;
    limit?: number;
    status?: string;
  },
): Promise<ExecutionDetailResponse> {
  const query = new URLSearchParams();
  if (params?.page) query.set("page", String(params.page));
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.status) query.set("status", params.status);

  const qs = query.toString();
  return apiFetch<ExecutionDetailResponse>(
    `/api/campaign-executions/${encodeURIComponent(executionId)}${qs ? `?${qs}` : ""}`,
  );
}

export async function approveExecutionItem(
  executionId: string,
  itemId: string,
  messageText?: string,
): Promise<ExecutionDetailItem> {
  return apiFetch<ExecutionDetailItem>(
    `/api/campaign-executions/${encodeURIComponent(executionId)}/items/${encodeURIComponent(itemId)}/approve`,
    {
      method: "POST",
      body: messageText ? JSON.stringify({ messageText }) : undefined,
    },
  );
}

export async function skipExecutionItem(
  executionId: string,
  itemId: string,
): Promise<ExecutionDetailItem> {
  return apiFetch<ExecutionDetailItem>(
    `/api/campaign-executions/${encodeURIComponent(executionId)}/items/${encodeURIComponent(itemId)}/skip`,
    {
      method: "POST",
    },
  );
}

export type DispatchExecutionResponse = {
  executionId: string;
  campaignId: string;
  status: CampaignExecutionStatus;
  provider: string;
  providerStatus: string;
  providerAuthenticated: boolean;
  attempted: number;
  sent: number;
  failed: number;
  remainingApproved: number;
  errorMessage: string | null;
  items: Array<{
    id: string;
    leadId: string;
    username: string;
    status: ExecutionItemStatus;
    errorMessage: string | null;
  }>;
};

export async function dispatchCampaignExecution(
  executionId: string,
): Promise<DispatchExecutionResponse> {
  return apiFetch<DispatchExecutionResponse>(
    `/api/campaign-executions/${encodeURIComponent(executionId)}/dispatch`,
    {
      method: "POST",
    },
  );
}
