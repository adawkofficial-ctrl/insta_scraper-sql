import { apiFetch } from "./client";

export type DraftStatus =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "BLOCKED"
  | "APPROVED"
  | "REJECTED"
  | "SUPERSEDED"
  | "SENT";

export type QualityCheckView = {
  id: string;
  severity: "BLOCKER" | "WARNING";
  passed: boolean;
  detail: string;
  data?: Record<string, unknown>;
};

export type QualityResultView = {
  passed: boolean;
  score: number;
  qualityVersion: string;
  blockers: QualityCheckView[];
  warnings: QualityCheckView[];
  checks: QualityCheckView[];
};

export type ReviewQueueItem = {
  id: string;
  leadId: string;
  campaignId: string;
  body: string;
  generatedBody: string;
  status: DraftStatus;
  kind?: "OUTREACH" | "REPLY";
  replyToMessageId?: string | null;
  promptVersion: string;
  model: string;
  wordCount: number;
  personalizationPointsUsed: unknown;
  qualityVersion: string | null;
  qualityScore: number | null;
  qualityPassed: boolean | null;
  qualityResult: QualityResultView | null;
  qualityCheckedAt: string | null;
  regenerationCount: number;
  editDistance: number | null;
  warningOverrides: unknown;
  approvedAt: string | null;
  approvedByType: string | null;
  rejectedAt: string | null;
  rejectReasonCode: string | null;
  rejectNotes: string | null;
  createdAt: string;
  updatedAt: string;
  lead: {
    id: string;
    username: string;
    fullName: string | null;
    followersCount: number | null;
    profilePictureUrl: string | null;
    status: string;
    leadScore: number | null;
    aiStatus: string;
  };
  reviews?: Array<{
    id: string;
    action: string;
    actorType: string;
    reasonCode: string | null;
    notes: string | null;
    createdAt: string;
  }>;
};

export type ReviewQueueResponse = {
  items: ReviewQueueItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

export type QualityStatsResponse = {
  total: number;
  counts: Record<string, number>;
  approvalRate: number;
  rejectionRate: number;
  editRate: number;
  averageEditDistance: number;
  blockedRate: number;
  averageQualityScore: number;
  topRejectReasons: Array<{ reasonCode: string; count: number }>;
  topFailedRules: Array<{ ruleId: string; count: number }>;
  byPromptVersion: Array<{ promptVersion: string; count: number; averageScore: number; approvalRate: number }>;
  byQualityVersion: Array<{ qualityVersion: string; count: number; averageScore: number }>;
};

export async function listReviewQueue(
  campaignId: string,
  params?: { status?: string; kind?: "OUTREACH" | "REPLY"; minScore?: number; sort?: "score" | "created"; page?: number; pageSize?: number },
): Promise<ReviewQueueResponse> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.kind) query.set("kind", params.kind);
  if (typeof params?.minScore === "number") query.set("minScore", String(params.minScore));
  if (params?.sort) query.set("sort", params.sort);
  if (params?.page) query.set("page", String(params.page));
  if (params?.pageSize) query.set("pageSize", String(params.pageSize));
  const suffix = query.toString();
  return apiFetch<ReviewQueueResponse>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/review-queue${suffix ? `?${suffix}` : ""}`,
  );
}

export async function getDraft(draftId: string): Promise<{ draft: ReviewQueueItem }> {
  return apiFetch<{ draft: ReviewQueueItem }>(`/api/drafts/${encodeURIComponent(draftId)}`);
}

export async function approveDraft(
  draftId: string,
  overrideWarnings: string[] = [],
): Promise<unknown> {
  return apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/approve`, {
    method: "POST",
    body: JSON.stringify({ overrideWarnings }),
  });
}

export async function rejectDraft(
  draftId: string,
  input: { reasonCode: string; notes?: string; regenerate?: boolean },
): Promise<unknown> {
  return apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/reject`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function editDraft(draftId: string, body: string): Promise<unknown> {
  return apiFetch(`/api/drafts/${encodeURIComponent(draftId)}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

export async function regenerateDraft(draftId: string): Promise<unknown> {
  return apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/regenerate`, { method: "POST" });
}

export async function recheckDraft(draftId: string): Promise<unknown> {
  return apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/recheck`, { method: "POST" });
}

export async function revokeDraftApproval(draftId: string): Promise<unknown> {
  return apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/revoke`, { method: "POST" });
}

export async function bulkApproveDrafts(
  campaignId: string,
  draftIds: string[],
): Promise<{ results: Array<{ draftId: string; ok: boolean; code?: string }>; approvedCount: number }> {
  return apiFetch(`/api/campaigns/${encodeURIComponent(campaignId)}/drafts/bulk-approve`, {
    method: "POST",
    body: JSON.stringify({ draftIds }),
  });
}

export async function sendApprovedDrafts(
  campaignId: string,
  input: { senderAccountId?: string; limit?: number; draftIds?: string[] },
): Promise<{ job: { id: string }; summary: { totalSelected: number; eligibleCount: number; skippedCount: number; skippedReasons: Array<{ draftId: string; leadId: string; reason: string }> } }> {
  return apiFetch(`/api/campaigns/${encodeURIComponent(campaignId)}/send-approved`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type LeadDraftSummary = {
  id: string;
  body: string;
  status: string;
  promptVersion: string;
  model: string;
  wordCount: number;
  personalizationPointsUsed: unknown;
  generationMeta: unknown;
  createdAt: string;
};

export async function getLeadDrafts(leadId: string): Promise<LeadDraftSummary[]> {
  const data = await apiFetch<{ drafts: LeadDraftSummary[] }>(
    `/api/leads/${encodeURIComponent(leadId)}/drafts`,
  );
  return data.drafts;
}

export async function getQualityStats(campaignId: string): Promise<QualityStatsResponse> {
  return apiFetch<QualityStatsResponse>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/quality-stats`,
  );
}

export async function sendReplyDraft(
  draftId: string,
): Promise<{ success: boolean; messageId?: string; status: string; error?: string }> {
  return apiFetch<{ success: boolean; messageId?: string; status: string; error?: string }>(
    `/api/drafts/${encodeURIComponent(draftId)}/send-reply`,
    { method: "POST" },
  );
}

