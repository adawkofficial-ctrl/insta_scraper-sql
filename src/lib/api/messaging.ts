import { apiFetch } from "./client";

export type MessagingStatusResponse = {
  provider: string;
  authenticated: boolean;
  status: "READY" | "AUTH_REQUIRED" | "ERROR";
  message?: string;
};

export type MessageHistoryItem = {
  id: string;
  provider: string;
  direction?: "INBOUND" | "OUTBOUND";
  status: "DRAFT" | "SENDING" | "SENT" | "FAILED" | "UNKNOWN";
  messageText: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  intent?: string | null;
  interestLevel?: "high" | "medium" | "low" | string | null;
  requiresHuman?: boolean;
  classifiedAt?: string | null;
  replyDrafts?: Array<{
    id: string;
    body: string;
    status: string;
    qualityScore?: number | null;
    qualityPassed?: boolean | null;
    kind?: string;
  }>;
};

export type SendTestMessageResponse = {
  success: boolean;
  messageId: string;
  status: "SENT" | "FAILED";
  error?: {
    code: string;
    message: string;
  };
};

export type SendSingleMessageResponse = {
  success: boolean;
  messageId: string;
  leadId: string;
  status?: "SENT" | "FAILED" | "UNKNOWN";
  sentAt?: string;
  errorCode?: string;
  error?: string;
};

export async function getMessagingStatus(): Promise<MessagingStatusResponse> {
  return apiFetch<MessagingStatusResponse>("/api/messaging/status");
}

export async function sendSingleMessage(
  leadId: string,
  message: string,
  campaignId?: string,
  senderAccountId?: string,
): Promise<SendSingleMessageResponse> {

  return apiFetch<SendSingleMessageResponse>("/api/messages/send", {
    method: "POST",
    body: JSON.stringify({ leadId, message, campaignId, senderAccountId }),
  });
}

export async function sendTestMessage(
  leadId: string,
  message: string,
): Promise<SendTestMessageResponse> {
  return apiFetch<SendTestMessageResponse>("/api/messages/test", {
    method: "POST",
    body: JSON.stringify({ leadId, message }),
  });
}

export async function getLeadMessages(
  leadId: string,
): Promise<MessageHistoryItem[]> {
  return apiFetch<MessageHistoryItem[]>(
    `/api/leads/${encodeURIComponent(leadId)}/messages`,
  );
}

export async function classifyMessage(messageId: string): Promise<{
  ok: boolean;
  classification: unknown;
  leadStatus: unknown;
  draft: unknown;
}> {
  return apiFetch(`/api/messages/${encodeURIComponent(messageId)}/classify`, {
    method: "POST",
  });
}

export type BulkMessageJobStatus =
  | "DRAFT"
  | "QUEUED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

export type BulkMessageItemStatus =
  | "QUEUED"
  | "PROCESSING"
  | "SENT"
  | "FAILED"
  | "SKIPPED"
  | "CANCELLED"
  | "UNKNOWN";

export type BulkPreviewRequest = {
  templateId: string;
  leadIds?: string[];
  selection?: "selected" | "allEligible";
  senderAccountId?: string;
  filters?: Record<string, unknown>;
};

export type BulkSkipReason = {
  leadId: string;
  username: string;
  reason: string;
};

export type BulkPreviewSample = {
  leadId: string;
  username: string;
  fullName: string | null;
  renderedMessage: string;
};

/**
 * Actual response shape of POST /api/campaigns/:campaignId/message-jobs/preview
 * (see bulk-messaging-service.previewBulkMessageJob). Field names are
 * `totalSelected` / `eligibleCount` / `skippedCount` — NOT total/eligible/skipped.
 */
export type BulkPreviewResponse = {
  campaignId: string;
  templateId: string;
  templateName: string;
  totalSelected: number;
  eligibleCount: number;
  skippedCount: number;
  skippedReasons: BulkSkipReason[];
  samples: BulkPreviewSample[];
};

export type BulkJobCreateRequest = {
  templateId: string;
  leadIds?: string[];
  selection?: "selected" | "allEligible";
  senderAccountId?: string;
  filters?: Record<string, unknown>;
};

/**
 * Actual response shape of POST /api/campaigns/:campaignId/message-jobs.
 * The server returns the created job plus a `summary` with the same
 * totalSelected/eligibleCount/skippedCount counters.
 */
export type BulkJobCreateResponse = {
  job: {
    id: string;
    campaignId: string;
    templateId: string | null;
    senderAccountId: string | null;
    status: BulkMessageJobStatus;
    total: number;
    queued: number;
    processing: number;
    sent: number;
    failed: number;
    skipped: number;
    cancelled: number;
    unknown: number;
    progress: number;
    errorMessage: string | null;
    startedAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    createdAt: string;
  };
  summary: {
    totalSelected: number;
    eligibleCount: number;
    skippedCount: number;
  };
};

export type BulkJobItemRecord = {
  id: string;
  leadId: string;
  username: string;
  renderedMessage: string;
  status: BulkMessageItemStatus;
  attempts: number;
  startedAt?: string | null;
  completedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type BulkJobStatusResponse = {
  id: string;
  campaignId: string;
  templateId: string | null;
  status: BulkMessageJobStatus;
  total: number;
  queued: number;
  processing: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
  unknown?: number;
  progress: number;
  errorSummary?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  items?: BulkJobItemRecord[];
};

export async function previewBulkMessages(
  campaignId: string,
  data: BulkPreviewRequest
): Promise<BulkPreviewResponse> {
  return apiFetch<BulkPreviewResponse>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/message-jobs/preview`,
    {
      method: "POST",
      body: JSON.stringify(data),
    }
  );
}

export async function createBulkMessageJob(
  campaignId: string,
  data: BulkJobCreateRequest
): Promise<BulkJobCreateResponse> {
  return apiFetch<BulkJobCreateResponse>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/message-jobs`,
    {
      method: "POST",
      body: JSON.stringify(data),
    }
  );
}

export async function getBulkJobStatus(
  jobId: string
): Promise<BulkJobStatusResponse> {
  return apiFetch<BulkJobStatusResponse>(
    `/api/message-jobs/${encodeURIComponent(jobId)}`
  );
}

export async function startBulkJob(
  jobId: string
): Promise<BulkJobStatusResponse> {
  return apiFetch<BulkJobStatusResponse>(
    `/api/message-jobs/${encodeURIComponent(jobId)}/start`,
    {
      method: "POST",
    }
  );
}

export async function pauseBulkJob(
  jobId: string
): Promise<BulkJobStatusResponse> {
  return apiFetch<BulkJobStatusResponse>(
    `/api/message-jobs/${encodeURIComponent(jobId)}/pause`,
    {
      method: "POST",
    }
  );
}

export async function resumeBulkJob(
  jobId: string
): Promise<BulkJobStatusResponse> {
  return apiFetch<BulkJobStatusResponse>(
    `/api/message-jobs/${encodeURIComponent(jobId)}/resume`,
    {
      method: "POST",
    }
  );
}

export async function cancelBulkJob(
  jobId: string
): Promise<BulkJobStatusResponse> {
  return apiFetch<BulkJobStatusResponse>(
    `/api/message-jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
    }
  );
}

export async function retryBulkJobItem(
  jobId: string,
  itemId: string
): Promise<BulkJobStatusResponse> {
  return apiFetch<BulkJobStatusResponse>(
    `/api/message-jobs/${encodeURIComponent(jobId)}/items/${encodeURIComponent(itemId)}/retry`,
    {
      method: "POST",
    }
  );
}

export async function recoverStaleBulkJob(
  jobId: string
): Promise<{ recovery: { recoveredCount: number; details: Array<{ id: string; resolution: string }> }; job: BulkJobStatusResponse }> {
  return apiFetch<{ recovery: { recoveredCount: number; details: Array<{ id: string; resolution: string }> }; job: BulkJobStatusResponse }>(
    `/api/message-jobs/${encodeURIComponent(jobId)}/recover-stale`,
    {
      method: "POST",
    }
  );
}


