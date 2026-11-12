import { apiFetch } from "./client";

export type CampaignAnalytics = {
  campaign: {
    id: string;
    name: string;
    status: string;
    executionMode: string;
    createdAt?: string;
    updatedAt?: string;
  };
  summary: {
    totalLeads: number;
    totalMessages: number;
    messagesSent: number;
    messagesFailed: number;
    messagesUnknown: number;
    messagesRemaining: number;
    executionStatus: string;
  };
  leads: {
    total: number;
    verified: number;
    business: number;
    nonBusiness: number;
    withExternalUrl: number;
    withProfilePic: number;
    withBio: number;
    eligible: number;
    verifiedPercentage: number;
    businessPercentage: number;
  };
  leadLimit: {
    limit: number | null;
    current: number;
    remainingCapacity: number;
    isAtCapacity: boolean;
  };
  categories: Array<{
    category: string;
    count: number;
    percentage: number;
  }>;
  discovery: {
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    candidatesDiscovered: number;
    candidatesEnriched: number;
    candidatesSkipped: number;
    leadsSaved: number;
    enrichmentRate: number;
    saveRate: number;
    recentJobs: Array<{
      id: string;
      query: string | null;
      location: string | null;
      category: string | null;
      requestedLimit: number | null;
      candidatesDiscovered: number;
      candidatesEnriched: number;
      candidatesSkipped: number;
      processedCount: number;
      startedAt: string | null;
      completedAt: string | null;
      durationSeconds: number | null;
      status: string;
      errorMessage: string | null;
    }>;
  };
  scraping: {
    jobs: number;
    processed: number;
    failed: number;
  };
  messaging: {
    totalTargeted: number;
    queued: number;
    processing: number;
    sent: number;
    failed: number;
    skipped: number;
    unknown: number;
    cancelled: number;
    sentRate: number;
    singleMessages: {
      total: number;
      sent: number;
      failed: number;
      unknown: number;
      draft: number;
    };
    bulkJobs: {
      totalJobs: number;
      activeJobs: number;
      completedJobs: number;
    };
  };
  messages: {
    total: number;
    sent: number;
    failed: number;
    unknown?: number;
    pending: number;
  };
  execution: {
    id?: string | null;
    status: string;
    phase?: string | null;
    overallProgress: number;
    startedAt?: string | null;
    completedAt?: string | null;
    pausedAt?: string | null;
    cancelledAt?: string | null;
    durationSeconds?: number | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    total: number;
    totalItems?: number;
    processedItems?: number;
    successfulItems?: number;
    failedItems?: number;
    pending: number;
    approved: number;
    skipped: number;
    sent: number;
    failed: number;
  };
  failures: {
    totalFailures: number;
    categories: Array<{
      category: string;
      count: number;
      label: string;
    }>;
  };
  durations: {
    campaignDurationSeconds: number;
    discoveryDurationSeconds: number | null;
    messagingDurationSeconds: number | null;
    totalExecutionDurationSeconds: number | null;
  };
  emptyStates: {
    hasLeads: boolean;
    hasDiscovery: boolean;
    hasMessaging: boolean;
    hasExecution: boolean;
  };
};

export type CampaignMessageItem = {
  id: string;
  campaignId: string;
  leadId: string;
  provider: string;
  status: "DRAFT" | "SENDING" | "SENT" | "FAILED" | "UNKNOWN";
  messageText: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  attempts?: Array<{
    id: string;
    attemptNumber: number;
    status: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  }>;
  lead: {
    username: string;
    fullName: string | null;
    profileUrl: string;
  };
};

export type CampaignMessagesResult = {
  items: CampaignMessageItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export type DashboardOverview = {
  stats: {
    totalCampaigns: number;
    totalLeads: number;
    totalMessages: number;
    activeRuns: number;
  };
  recentCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    createdAt: string;
    leadCount: number;
    scrapeJobCount: number;
  }>;
  recentScrapeJobs: Array<{
    id: string;
    campaignId: string | null;
    campaignName: string | null;
    status: string;
    provider: string;
    inputCount: number;
    processedCount: number;
    errorMessage: string | null;
    createdAt: string;
  }>;
  recentActivity: Array<{
    id: string;
    type:
      | "CAMPAIGN_CREATED"
      | "SCRAPE_COMPLETED"
      | "SCRAPE_FAILED"
      | "MESSAGE_SENT"
      | "MESSAGE_FAILED"
      | "EXECUTION_CREATED";
    title: string;
    description: string;
    timestamp: string;
    campaignId?: string;
  }>;
};

export async function getCampaignAnalytics(
  campaignId: string,
): Promise<CampaignAnalytics> {
  return apiFetch<CampaignAnalytics>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/analytics`,
  );
}

export async function getCampaignMessages(
  campaignId: string,
  params?: {
    page?: number;
    limit?: number;
    status?: string;
  },
): Promise<CampaignMessagesResult> {
  const query = new URLSearchParams();
  if (params?.page) query.set("page", String(params.page));
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.status) query.set("status", params.status);

  const qs = query.toString();
  return apiFetch<CampaignMessagesResult>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/messages${qs ? `?${qs}` : ""}`,
  );
}

export async function getDashboardOverview(): Promise<DashboardOverview> {
  return apiFetch<DashboardOverview>("/api/dashboard/overview");
}

export function getCampaignAnalyticsExportUrl(
  campaignId: string,
  format: "csv" | "json" = "csv",
): string {
  return `/api/campaigns/${encodeURIComponent(campaignId)}/analytics/export?format=${format}`;
}

export type OutcomeSegmentRow = {
  segmentKey: string;
  leads: number;
  sent: number;
  replies: number;
  positiveReplies: number;
  meetings: number;
  won: number;
  replyRate: number;
  positiveRate: number;
  totalCostUsd: number;
  costPerPositiveReply: number | null;
  lowConfidence: boolean;
};

export type OutcomeAnalyticsResponse = {
  campaignId: string;
  funnel: {
    places: number;
    contactable: number;
    savedLeads: number;
    sent: number;
    replied: number;
    positive: number;
    meeting: number;
    won: number;
    conversions: {
      placesToContactable: number;
      contactableToSaved: number;
      savedToSent: number;
      sentToReplied: number;
      repliedToPositive: number;
      positiveToMeeting: number;
      meetingToWon: number;
      overallSentToWon: number;
    };
  };
  cost: {
    totalDiscoverySpend: number;
    senderMonthlyFeeAllocated: number;
    totalSpend: number;
    costPerSavedLead: number;
    costPerSent: number;
    costPerReply: number;
    costPerPositiveReply: number;
    costPerMeeting: number;
    costPerWon: number;
  };
  segments: {
    byKeyword: Array<{
      segmentKey: string;
      leads: number;
      sent: number;
      replies: number;
      positiveReplies: number;
      meetings: number;
      won: number;
      replyRate: number;
      positiveRate: number;
      totalCostUsd: number;
      costPerPositiveReply: number | null;
      lowConfidence: boolean;
    }>;
    byCity: Array<{
      segmentKey: string;
      leads: number;
      sent: number;
      replies: number;
      positiveReplies: number;
      meetings: number;
      won: number;
      replyRate: number;
      positiveRate: number;
      totalCostUsd: number;
      costPerPositiveReply: number | null;
      lowConfidence: boolean;
    }>;
    byTier: Array<{
      segmentKey: string;
      leads: number;
      sent: number;
      replies: number;
      positiveReplies: number;
      meetings: number;
      won: number;
      replyRate: number;
      positiveRate: number;
      totalCostUsd: number;
      costPerPositiveReply: number | null;
      lowConfidence: boolean;
    }>;
    byHandleSource: Array<{
      segmentKey: string;
      leads: number;
      sent: number;
      replies: number;
      positiveReplies: number;
      meetings: number;
      won: number;
      replyRate: number;
      positiveRate: number;
      totalCostUsd: number;
      costPerPositiveReply: number | null;
      lowConfidence: boolean;
    }>;
    byChainType: Array<{
      segmentKey: string;
      leads: number;
      sent: number;
      replies: number;
      positiveReplies: number;
      meetings: number;
      won: number;
      replyRate: number;
      positiveRate: number;
      totalCostUsd: number;
      costPerPositiveReply: number | null;
      lowConfidence: boolean;
    }>;
    byChannel: Array<{
      segmentKey: string;
      leads: number;
      sent: number;
      replies: number;
      positiveReplies: number;
      meetings: number;
      won: number;
      replyRate: number;
      positiveRate: number;
      totalCostUsd: number;
      costPerPositiveReply: number | null;
      lowConfidence: boolean;
    }>;
    byFollowerBand: Array<{
      segmentKey: string;
      leads: number;
      sent: number;
      replies: number;
      positiveReplies: number;
      meetings: number;
      won: number;
      replyRate: number;
      positiveRate: number;
      totalCostUsd: number;
      costPerPositiveReply: number | null;
      lowConfidence: boolean;
    }>;
    byVariant: Array<{
      segmentKey: string;
      leads: number;
      sent: number;
      replies: number;
      positiveReplies: number;
      meetings: number;
      won: number;
      replyRate: number;
      positiveRate: number;
      totalCostUsd: number;
      costPerPositiveReply: number | null;
      lowConfidence: boolean;
    }>;
  };
  dataQuality: {
    totalLeads: number;
    unknownFieldsCount: number;
    unknownFieldsRate: number;
    duplicateSightingsCount: number;
    duplicateRate: number;
    totalPlacesScraped: number;
    rejectedPlacesCount: number;
    enrichmentWasteRate: number;
  };
  variants: Array<{
    variant: string;
    sent: number;
    replies: number;
    positiveReplies: number;
    replyRate: number;
    positiveRate: number;
    lowConfidence: boolean;
    significanceVsControl?: {
      zScore: number;
      pValueEstimate: number;
      significance: string;
      label: string;
    };
  }>;
};

export async function getCampaignOutcomeAnalytics(
  campaignId: string,
  params?: {
    startDate?: string;
    endDate?: string;
    channel?: string;
  },
): Promise<OutcomeAnalyticsResponse> {
  const query = new URLSearchParams();
  if (params?.startDate) query.set("startDate", params.startDate);
  if (params?.endDate) query.set("endDate", params.endDate);
  if (params?.channel) query.set("channel", params.channel);

  const qs = query.toString();
  return apiFetch<OutcomeAnalyticsResponse>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/analytics/outcomes${qs ? `?${qs}` : ""}`,
  );
}

export type CampaignRecommendationItem = {
  id: string;
  type: "SCALE_SEGMENT" | "STOP_SEGMENT" | "ADJUST_SCORE_THRESHOLD";
  title: string;
  rationale: string;
  impact: string;
  segmentType: "keyword" | "city" | "tier";
  segmentValue: string;
  positiveRate?: number;
  costPerPositiveReply?: number | null;
  sampleSize: number;
  actionPayload: {
    customPositiveKeywords?: string[];
    customNegativeKeywords?: string[];
    minLeadScore?: number;
    preferredCities?: string[];
  };
};

export async function getCampaignRecommendations(
  campaignId: string,
): Promise<{
  campaignId: string;
  autoOptimize: boolean;
  explorationBudgetShare: number;
  recommendations: CampaignRecommendationItem[];
}> {
  return apiFetch(
    `/api/campaigns/${encodeURIComponent(campaignId)}/analytics/recommendations`,
  );
}

export async function applyCampaignRecommendation(
  campaignId: string,
  recommendationId: string,
): Promise<{
  success: boolean;
  appliedRecommendationId: string;
  updatedFields: string[];
}> {
  return apiFetch(
    `/api/campaigns/${encodeURIComponent(campaignId)}/analytics/recommendations/apply`,
    {
      method: "POST",
      body: JSON.stringify({ recommendationId }),
    },
  );
}

export async function recordLeadOutcomeEvent(
  leadId: string,
  input: {
    eventType: "MEETING_BOOKED" | "WON" | "POSITIVE_REPLY" | "NEGATIVE_REPLY" | "UNSUBSCRIBE_OR_DNC";
    notes?: string;
    channel?: string;
  },
): Promise<{
  event: { id: string; eventType: string; createdAt: string };
  leadStatus: string;
}> {
  return apiFetch(`/api/leads/${encodeURIComponent(leadId)}/events`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

