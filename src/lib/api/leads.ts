import { apiFetch } from "./client";

export type LeadRelatedProfile = {
  username: string;
  fullName: string | null;
  profilePictureUrl: string | null;
  isVerified: boolean | null;
  isPrivate: boolean | null;
};

export type LeadLatestPost = {
  id: string | null;
  shortCode: string | null;
  url: string | null;
  type: string | null;
  caption: string | null;
  likesCount: number | null;
  commentsCount: number | null;
  displayUrl: string | null;
  timestamp: string | null;
};

export type Lead = {
  id: string;
  campaignId: string;
  username: string;
  profileUrl: string;
  status?: string | null;
  leadStatus?: string | null;
  instagramId: string | null;
  fullName: string | null;
  biography: string | null;
  followers: number | null;
  following: number | null;
  followersCount?: number | null;
  followsCount?: number | null;
  postsCount: number | null;
  profilePictureUrl: string | null;
  profilePicUrl?: string | null;
  profilePicUrlHD?: string | null;
  isVerified: boolean | null;
  verified?: boolean | null;
  isBusiness: boolean | null;
  isBusinessAccount?: boolean | null;
  category: string | null;
  businessCategoryName?: string | null;
  externalUrl: string | null;
  location: string | null;
  email?: string | null;
  emailNormalized?: string | null;
  phone?: string | null;
  phoneNormalized?: string | null;
  website?: string | null;
  websiteDomain?: string | null;
  socialLink?: string | null;
  socialPlatform?: string | null;
  contactSource?: string | null;
  availableChannels?: string[];
  relatedProfiles: LeadRelatedProfile[] | null;
  latestPosts: LeadLatestPost[] | null;
  rawProfileData?: Record<string, unknown> | null;
  leadScore?: number | null;
  handleSource?: string | null;
  handleConfidence?: string | null;
  aiScore?: number | null;
  aiAnalysis?: Record<string, unknown> | null;
  source: string;
  scrapedAt: string | null;
  createdAt: string;
  updatedAt: string;
  campaign?: {
    id: string;
    name: string;
    status: string;
  };
  /** Step 4 dedup fields (additive). */
  duplicateOfLeadId?: string | null;
  possibleDuplicateOfLeadId?: string | null;
  possibleDuplicateReason?: string | null;
  dedupMatchedBy?: string | null;
  duplicateOf?: { id: string; username: string } | null;
  possibleDuplicateOf?: { id: string; username: string } | null;
  _count?: { sightings: number };

  /** Quality Score & Chain Detection */
  qualityScore?: number | null;
  qualityTier?: string | null;
  scoreBreakdown?: unknown | null;
  scoreFlags?: string[];
  isChain?: boolean;
  isClaimed?: boolean | null;
  lastPostAt?: string | null;
  scoreVersion?: number;

  /** Attribution & Cost Tracking */
  scrapeJobId?: string | null;
  discoveryKeyword?: string | null;
  discoveryCity?: string | null;
  acquisitionCostUsd?: number | null;
  acquisitionCostBreakdown?: unknown | null;
  messageVariant?: string | null;
  isDryRun?: boolean;
  isGroup?: boolean;
  groupKey?: string | null;
  lastHandleEnrichmentAt?: string | null;
  followUpMessages?: FollowUpMessageItem[];
};

export type FollowUpMessageItem = {
  id: string;
  campaignId: string;
  leadId: string;
  step: number;
  status: "SCHEDULED" | "SENT" | "CANCELLED_REPLIED" | "CANCELLED_DNC" | "CANCELLED_MANUAL" | "NEEDS_EDIT" | "FAILED" | "SKIPPED";
  templateText: string;
  renderedBody?: string | null;
  dueAt: string;
  sentAt?: string | null;
  retryAt?: string | null;
  cancelReason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GetLeadsParams = {
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
  verified?: boolean;
  isVerified?: boolean;
  isBusinessAccount?: boolean;
  isBusiness?: boolean;
  status?: string;
  channel?: string;
  /** Step 4: hide duplicate-linked leads. */
  excludeDuplicates?: boolean;
  /** Filter by enrichment status */
  enrichmentStatus?: "all" | "enriched" | "not_enriched";
  /** Quality score filter & sorting */
  tier?: string;
  qualityTier?: string;
  flags?: string;
  isChain?: boolean;
  sort?: string;
  order?: "asc" | "desc";
};

export type PaginatedLeads = {
  items: Lead[];
  leads?: Lead[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
};

export type UpdateLeadInput = {
  fullName?: string | null;
  category?: string | null;
  biography?: string | null;
  externalUrl?: string | null;
};

export async function getCampaignLeads(
  campaignId: string,
  params: GetLeadsParams = {},
): Promise<PaginatedLeads> {
  const query = new URLSearchParams();

  if (params.page !== undefined) query.set("page", String(params.page));
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.search && params.search.trim()) query.set("search", params.search.trim());
  if (params.category && params.category.trim()) query.set("category", params.category.trim());
  const verifiedVal = params.verified ?? params.isVerified;
  if (verifiedVal !== undefined) query.set("verified", String(verifiedVal));
  const businessVal = params.isBusinessAccount ?? params.isBusiness;
  if (businessVal !== undefined) query.set("isBusinessAccount", String(businessVal));
  if (params.status && params.status.trim()) query.set("status", params.status.trim());
  if (params.channel && params.channel.trim()) query.set("channel", params.channel.trim());
  if (params.excludeDuplicates) query.set("excludeDuplicates", "true");
  if (params.enrichmentStatus && params.enrichmentStatus !== "all") {
    query.set("enrichmentStatus", params.enrichmentStatus);
  }
  const tierVal = params.tier ?? params.qualityTier;
  if (tierVal && tierVal.trim()) query.set("tier", tierVal.trim());
  if (params.flags && params.flags.trim()) query.set("flags", params.flags.trim());
  if (params.isChain !== undefined) query.set("isChain", String(params.isChain));
  if (params.sort && params.sort.trim()) query.set("sort", params.sort.trim());
  if (params.order) query.set("order", params.order);

  const qs = query.toString();
  const url = `/api/campaigns/${encodeURIComponent(campaignId)}/leads${qs ? `?${qs}` : ""}`;

  return apiFetch<PaginatedLeads>(url);
}

export async function getLead(leadId: string): Promise<Lead> {
  return apiFetch<Lead>(`/api/leads/${encodeURIComponent(leadId)}`);
}

export async function updateLead(
  leadId: string,
  input: UpdateLeadInput,
): Promise<Lead> {
  return apiFetch<Lead>(`/api/leads/${encodeURIComponent(leadId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteLead(
  leadId: string,
): Promise<{ id: string; deleted: boolean }> {
  return apiFetch<{ id: string; deleted: boolean }>(
    `/api/leads/${encodeURIComponent(leadId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function deleteLeadsBulk(
  campaignId: string,
  leadIds: string[],
): Promise<{ deletedCount: number; deletedIds: string[] }> {
  return apiFetch<{ deletedCount: number; deletedIds: string[] }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/leads`,
    {
      method: "DELETE",
      body: JSON.stringify({ leadIds }),
    },
  );
}


/** Step 4: clear a "possible duplicate" flag (explicit user action). */
export async function clearLeadDuplicateFlag(
  leadId: string,
): Promise<{ cleared: boolean }> {
  return apiFetch<{ cleared: boolean }>(
    `/api/leads/${encodeURIComponent(leadId)}/clear-duplicate-flag`,
    { method: "POST" },
  );
}

export type EnrichLeadsResponse = {
  success: boolean;
  totalRequested: number;
  enrichedCount: number;
  cachedCount: number;
  apifyCostUsd: number;
  remainingBudgetUsd: number;
  leads: Array<{
    id: string;
    username: string;
    followersCount: number | null;
    biography: string | null;
    enrichmentStatus: "ENRICHED" | "NOT_ENRICHED";
    negativeKeywordMatched?: string | null;
    criteriaPassed?: boolean;
    criteriaReasons?: string[];
  }>;
};

export async function enrichLeads(leadIds: string[]): Promise<EnrichLeadsResponse> {
  return apiFetch<EnrichLeadsResponse>("/api/leads/enrich", {
    method: "POST",
    body: JSON.stringify({ leadIds }),
  });
}

export type EnrichLeadHandleResponse = {
  success: boolean;
  outcome: "found" | "not_found" | "cooldown" | "no_website";
  handle: string | null;
  handleSource: string | null;
  handleConfidence: string | null;
  message: string;
  criteriaPassed?: boolean;
  criteriaReasons?: string[];
};

export async function enrichLeadHandle(leadId: string): Promise<EnrichLeadHandleResponse> {
  return apiFetch<EnrichLeadHandleResponse>(`/api/leads/${leadId}/enrich-handle`, {
    method: "POST",
  });
}

export type LeadContactItem = {
  value: string;
  source: "bio" | "website" | "maps";
};

export type LeadPhoneItem = {
  value: string;
  normalized: string;
  source: "bio" | "website" | "maps";
};

export type LeadWhatsappItem = {
  url: string;
  phone?: string;
  source: "bio" | "website" | "maps";
};

export type LeadContactsInfo = {
  emails: LeadContactItem[];
  phones: LeadPhoneItem[];
  whatsapps: LeadWhatsappItem[];
  socialLinks: {
    facebook?: string | null;
    tiktok?: string | null;
    linkedin?: string | null;
    youtube?: string | null;
  };
  extractedAt: string;
};

export type FindLeadContactsResponse = {
  success: boolean;
  count: number;
  leads: Array<{
    id: string;
    phone: string | null;
    phoneNormalized: string | null;
    email: string | null;
    website: string | null;
    contacts: LeadContactsInfo;
  }>;
};

export async function findLeadContacts(leadIds: string[]): Promise<FindLeadContactsResponse> {
  return apiFetch<FindLeadContactsResponse>("/api/leads/contacts", {
    method: "POST",
    body: JSON.stringify({ leadIds }),
  });
}

export type CsvPreviewResponse = {
  success: boolean;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  headers: string[];
  columnMapping: Record<string, string>;
  errors: Array<{ row: number; reason: string; snippet: string }>;
  previewRows: Array<Record<string, string>>;
};

export type CsvUploadResponse = {
  success: boolean;
  campaignId: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createdCount: number;
  updatedCount: number;
  skippedDuplicates: number;
  errors: Array<{ row: number; reason: string; snippet: string }>;
  sampleLeads: Array<{ id: string; username: string; fullName: string | null; status: string }>;
};

export async function previewLeadsCsv(
  campaignId: string,
  fileOrText: File | string,
): Promise<CsvPreviewResponse> {
  if (typeof fileOrText === "string") {
    return apiFetch<CsvPreviewResponse>(`/api/campaigns/${campaignId}/leads/upload/preview`, {
      method: "POST",
      body: JSON.stringify({ csvText: fileOrText }),
    });
  }

  const formData = new FormData();
  formData.append("file", fileOrText);
  return apiFetch<CsvPreviewResponse>(`/api/campaigns/${campaignId}/leads/upload/preview`, {
    method: "POST",
    body: formData,
  });
}

export async function uploadLeadsCsv(
  campaignId: string,
  fileOrText: File | string,
  options?: { skipExisting?: boolean },
): Promise<CsvUploadResponse> {
  if (typeof fileOrText === "string") {
    return apiFetch<CsvUploadResponse>(`/api/campaigns/${campaignId}/leads/upload`, {
      method: "POST",
      body: JSON.stringify({ csvText: fileOrText, options }),
    });
  }

  const formData = new FormData();
  formData.append("file", fileOrText);
  if (options?.skipExisting) {
    formData.append("skipExisting", "true");
  }
  return apiFetch<CsvUploadResponse>(`/api/campaigns/${campaignId}/leads/upload`, {
    method: "POST",
    body: formData,
  });
}
export async function recordLeadOutcomeEvent(
  leadId: string,
  eventType: "MEETING_BOOKED" | "WON" | "POSITIVE_REPLY" | "NEGATIVE_REPLY" | "UNSUBSCRIBE_OR_DNC",
  options?: { channel?: string; notes?: string }
): Promise<{ success: boolean; event: unknown; leadStatus: string }> {
  return apiFetch<{ success: boolean; event: unknown; leadStatus: string }>(`/api/leads/${leadId}/events`, {
    method: "POST",
    body: JSON.stringify({
      eventType,
      channel: options?.channel,
      notes: options?.notes,
    }),
  });
}

export async function deleteDryRunLeadsApi(
  campaignId: string,
): Promise<{ deletedCount: number }> {
  return apiFetch<{ deletedCount: number }>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/leads/dry-run`,
    {
      method: "DELETE",
    },
  );
}

export function getCampaignLeadsExportUrl(
  campaignId: string,
  options?: {
    leadIds?: string[];
    format?: "csv" | "json";
  },
): string {
  const params = new URLSearchParams();
  if (options?.format) {
    params.set("format", options.format);
  }
  if (options?.leadIds && options.leadIds.length > 0) {
    params.set("leadIds", options.leadIds.join(","));
  }
  const queryString = params.toString();
  return `/api/campaigns/${encodeURIComponent(campaignId)}/leads/export${queryString ? `?${queryString}` : ""}`;
}
