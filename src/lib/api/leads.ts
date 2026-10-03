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

/** Step 4: clear a "possible duplicate" flag (explicit user action). */
export async function clearLeadDuplicateFlag(
  leadId: string,
): Promise<{ cleared: boolean }> {
  return apiFetch<{ cleared: boolean }>(
    `/api/leads/${encodeURIComponent(leadId)}/clear-duplicate-flag`,
    { method: "POST" },
  );
}
