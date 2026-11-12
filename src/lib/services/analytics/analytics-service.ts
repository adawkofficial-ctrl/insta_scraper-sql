import { getPrismaClient } from "@/lib/db/prisma";
import {
  MessageStatus,
  ExecutionItemStatus,
  BulkMessageItemStatus,
  BulkMessageJobStatus,
  CampaignExecutionStatus,
  CampaignExecutionPhase,
} from "@/generated/prisma/enums";
import { NotFoundError } from "@/lib/errors";
import { classifyMessagingError } from "../messaging/error-classifier";

export type CampaignAnalyticsResponse = {
  campaign: {
    id: string;
    name: string;
    status: string;
    executionMode: string;
    createdAt: Date;
    updatedAt: Date;
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
      startedAt: Date | null;
      completedAt: Date | null;
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
    suppressedCount: number;
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
    unknown: number;
    pending: number;
  };
  execution: {
    id: string | null;
    status: string;
    phase: string | null;
    overallProgress: number;
    startedAt: Date | null;
    completedAt: Date | null;
    pausedAt: Date | null;
    cancelledAt: Date | null;
    durationSeconds: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    total: number;
    totalItems: number;
    processedItems: number;
    successfulItems: number;
    failedItems: number;
    pending: number;
    approved: number;
    skipped: number;
    suppressedCount: number;
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

export type CampaignMessagesResponse = {
  items: Array<{
    id: string;
    campaignId: string;
    leadId: string;
    provider: string;
    status: string;
    messageText: string;
    errorCode: string | null;
    errorMessage: string | null;
    sentAt: Date | null;
    createdAt: Date;
    lead: {
      username: string | null;
      fullName: string | null;
      profileUrl: string | null;
    };
    attempts: Array<{
      id: string;
      attemptNumber: number;
      status: string;
      errorCode: string | null;
      errorMessage: string | null;
      startedAt: Date;
      completedAt: Date | null;
    }>;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export type DashboardOverviewResponse = {
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
    createdAt: Date;
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
    createdAt: Date;
  }>;
  recentActivity: Array<{
    id: string;
    type: string;
    title: string;
    description: string;
    timestamp: Date;
    campaignId?: string;
  }>;
};

export async function getCampaignAnalytics(
  campaignId: string,
  userId?: string,
): Promise<CampaignAnalyticsResponse> {
  const prisma = getPrismaClient();

  // Validate campaign exists and belongs to user
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: {
      id: true,
      name: true,
      status: true,
      executionMode: true,
      leadLimit: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${campaignId}" was not found.`,
    );
  }

  const now = new Date();

  // Parallel database queries
  const [
    totalLeads,
    verifiedLeads,
    businessLeads,
    leadsWithExternalUrl,
    leadsWithProfilePic,
    leadsWithBio,
    categoryGroups,
    scrapeJobs,
    bulkItemsGroup,
    singleMessagesGroup,
    bulkJobsCount,
    activeBulkJobsCount,
    completedBulkJobsCount,
    latestExecution,
    failedAttempts,
    executionGroups,
  ] = await Promise.all([
    // Lead totals
    prisma.lead.count({ where: { campaignId } }),
    prisma.lead.count({
      where: {
        campaignId,
        OR: [{ isVerified: true }, { verified: true }],
      },
    }),
    prisma.lead.count({
      where: {
        campaignId,
        OR: [{ isBusiness: true }, { isBusinessAccount: true }],
      },
    }),
    prisma.lead.count({
      where: {
        campaignId,
        externalUrl: { not: null },
      },
    }),
    prisma.lead.count({
      where: {
        campaignId,
        OR: [
          { profilePictureUrl: { not: null } },
          { profilePicUrl: { not: null } },
          { profilePicUrlHD: { not: null } },
        ],
      },
    }),
    prisma.lead.count({
      where: {
        campaignId,
        biography: { not: null },
      },
    }),
    // Categories distribution
    prisma.lead.groupBy({
      by: ["category"],
      where: {
        campaignId,
        category: { not: null },
      },
      _count: { id: true },
      orderBy: {
        _count: { id: "desc" },
      },
      take: 8,
    }),
    // Scrape jobs
    prisma.scrapeJob.findMany({
      where: { campaignId },
      orderBy: { createdAt: "desc" },
    }),
    // Bulk message items breakdown
    prisma.bulkMessageItem.groupBy({
      by: ["status"],
      where: { job: { campaignId } },
      _count: { id: true },
    }),
    // Single message items breakdown
    prisma.message.groupBy({
      by: ["status"],
      where: { campaignId },
      _count: { id: true },
    }),
    // Bulk message jobs counts
    prisma.bulkMessageJob.count({ where: { campaignId } }),
    prisma.bulkMessageJob.count({
      where: {
        campaignId,
        status: { in: [BulkMessageJobStatus.RUNNING, BulkMessageJobStatus.QUEUED] },
      },
    }),
    prisma.bulkMessageJob.count({
      where: {
        campaignId,
        status: BulkMessageJobStatus.COMPLETED,
      },
    }),
    // Latest CampaignExecution
    prisma.campaignExecution.findFirst({
      where: { campaignId },
      orderBy: { createdAt: "desc" },
    }),
    // Failure error codes for taxonomy
    prisma.messageAttempt.findMany({
      where: {
        campaignId,
        status: { in: [MessageStatus.FAILED, MessageStatus.UNKNOWN] },
        errorCode: { not: null },
      },
      select: { errorCode: true },
      take: 200,
    }),
    // Legacy Execution Items breakdown
    prisma.campaignExecutionItem.groupBy({
      by: ["status"],
      where: { execution: { campaignId } },
      _count: { id: true },
    }),
  ]);

  // Lead calculations
  const nonBusinessLeads = Math.max(0, totalLeads - businessLeads);
  const verifiedPercentage = totalLeads > 0 ? Math.round((verifiedLeads / totalLeads) * 100) : 0;
  const businessPercentage = totalLeads > 0 ? Math.round((businessLeads / totalLeads) * 100) : 0;

  // Categories distribution formatting
  const categories = categoryGroups
    .filter((g) => g.category && g.category.trim().length > 0)
    .map((g) => ({
      category: g.category as string,
      count: g._count.id,
      percentage: totalLeads > 0 ? Math.round((g._count.id / totalLeads) * 100) : 0,
    }));

  // Lead capacity
  const leadLimitVal = campaign.leadLimit ?? null;
  const remainingCapacity = leadLimitVal != null ? Math.max(0, leadLimitVal - totalLeads) : 0;
  const isAtCapacity = leadLimitVal != null && totalLeads >= leadLimitVal;

  // Discovery metrics from ScrapeJob
  const totalScrapeJobs = scrapeJobs.length;
  const completedScrapeJobs = scrapeJobs.filter((j) => j.status === "COMPLETED").length;
  const failedScrapeJobs = scrapeJobs.filter((j) => j.status === "FAILED").length;
  const candidatesDiscovered = scrapeJobs.reduce((acc, j) => acc + (j.candidatesDiscovered ?? 0), 0);
  const candidatesEnriched = scrapeJobs.reduce((acc, j) => acc + (j.candidatesEnriched ?? 0), 0);
  const candidatesSkipped = scrapeJobs.reduce((acc, j) => acc + (j.candidatesSkipped ?? 0), 0);
  const leadsSaved = scrapeJobs.reduce((acc, j) => acc + (j.processedCount ?? 0), 0);

  const enrichmentRate =
    candidatesDiscovered > 0 ? Math.min(100, Math.round((candidatesEnriched / candidatesDiscovered) * 100)) : 0;
  const saveRate =
    candidatesEnriched > 0 ? Math.min(100, Math.round((leadsSaved / candidatesEnriched) * 100)) : 0;

  let discoveryDurationSeconds: number | null = null;
  const scrapeDurations = scrapeJobs
    .filter((j) => j.startedAt)
    .map((j) => {
      const end = j.completedAt ?? now;
      return Math.max(0, Math.floor((end.getTime() - j.startedAt!.getTime()) / 1000));
    });
  if (scrapeDurations.length > 0) {
    discoveryDurationSeconds = scrapeDurations.reduce((acc, d) => acc + d, 0);
  }

  const recentJobs = scrapeJobs.slice(0, 5).map((job) => {
    let durationSec: number | null = null;
    if (job.startedAt) {
      const end = job.completedAt ?? (job.status === "RUNNING" ? now : job.startedAt);
      durationSec = Math.max(0, Math.floor((end.getTime() - job.startedAt.getTime()) / 1000));
    }
    return {
      id: job.id,
      query: job.query,
      location: job.location,
      category: job.category,
      requestedLimit: job.requestedLimit,
      candidatesDiscovered: job.candidatesDiscovered ?? 0,
      candidatesEnriched: job.candidatesEnriched ?? 0,
      candidatesSkipped: job.candidatesSkipped ?? 0,
      processedCount: job.processedCount,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      durationSeconds: durationSec,
      status: job.status,
      errorMessage: job.errorMessage,
    };
  });

  // Messaging metrics from BulkMessageItem
  const countByBulkStatus = (st: BulkMessageItemStatus): number =>
    bulkItemsGroup.find((row) => row.status === st)?._count.id ?? 0;

  const bulkSent = countByBulkStatus(BulkMessageItemStatus.SENT);
  const bulkFailed = countByBulkStatus(BulkMessageItemStatus.FAILED);
  const bulkUnknown = countByBulkStatus(BulkMessageItemStatus.UNKNOWN);
  const bulkSkipped = countByBulkStatus(BulkMessageItemStatus.SKIPPED);
  const bulkQueued = countByBulkStatus(BulkMessageItemStatus.QUEUED);
  const bulkProcessing = countByBulkStatus(BulkMessageItemStatus.PROCESSING);
  const bulkCancelled = countByBulkStatus(BulkMessageItemStatus.CANCELLED);

  const totalBulkTargeted =
    bulkSent + bulkFailed + bulkUnknown + bulkSkipped + bulkQueued + bulkProcessing + bulkCancelled;

  const bulkAttempted = bulkSent + bulkFailed + bulkUnknown;
  const sentRate = bulkAttempted > 0 ? Math.min(100, Math.round((bulkSent / bulkAttempted) * 100)) : 0;

  // Single messages breakdown
  const countBySingleStatus = (st: MessageStatus): number =>
    singleMessagesGroup.find((row) => row.status === st)?._count.id ?? 0;

  const singleSent = countBySingleStatus(MessageStatus.SENT);
  const singleFailed = countBySingleStatus(MessageStatus.FAILED);
  const singleUnknown = countBySingleStatus(MessageStatus.UNKNOWN);
  const singleDraft = countBySingleStatus(MessageStatus.DRAFT);
  const singleSending = countBySingleStatus(MessageStatus.SENDING);
  const singleTotal = singleSent + singleFailed + singleUnknown + singleDraft + singleSending;

  // Eligible leads: leads that have not received a confirmed message
  const confirmedSentLeadsCount = bulkSent + singleSent;
  const eligibleLeads = Math.max(0, totalLeads - confirmedSentLeadsCount);

  // Authoritative Execution state
  let overallProgress = 0;
  let executionDurationSeconds: number | null = null;

  if (latestExecution) {
    if (
      campaign.status === "COMPLETED" ||
      latestExecution.status === CampaignExecutionStatus.COMPLETED
    ) {
      overallProgress = 100;
    } else if (latestExecution.totalItems > 0) {
      overallProgress = Math.min(
        100,
        Math.round((latestExecution.processedItems / latestExecution.totalItems) * 100),
      );
    } else if (totalBulkTargeted > 0) {
      overallProgress = Math.min(
        100,
        Math.round(((bulkSent + bulkFailed + bulkUnknown + bulkSkipped) / totalBulkTargeted) * 100),
      );
    } else if (latestExecution.phase === CampaignExecutionPhase.FINALIZING) {
      overallProgress = 95;
    } else if (latestExecution.phase === CampaignExecutionPhase.READY) {
      overallProgress = totalLeads > 0 ? 50 : 25;
    } else if (
      latestExecution.phase === CampaignExecutionPhase.ENRICHMENT ||
      latestExecution.phase === CampaignExecutionPhase.DISCOVERY
    ) {
      const targetLimit = campaign.leadLimit ?? 50;
      overallProgress = targetLimit > 0 ? Math.min(50, Math.round((candidatesEnriched / targetLimit) * 50)) : 20;
    }

    if (latestExecution.startedAt) {
      const end =
        latestExecution.completedAt ??
        latestExecution.cancelledAt ??
        latestExecution.pausedAt ??
        (latestExecution.status === CampaignExecutionStatus.RUNNING ? now : latestExecution.startedAt);
      executionDurationSeconds = Math.max(
        0,
        Math.floor((end.getTime() - latestExecution.startedAt.getTime()) / 1000),
      );
    }
  }

  // Failure categories taxonomy
  const failureCategoryCounts: Record<string, number> = {};
  let totalFailures = 0;
  for (const attempt of failedAttempts) {
    if (attempt.errorCode) {
      if (attempt.errorCode === "DNC_SUPPRESSED" || attempt.errorCode === "SUPPRESSED_DNC") {
        continue; // DNC suppression is not counted as delivery failure
      }
      totalFailures++;
      const classified = classifyMessagingError(attempt.errorCode);
      const key = classified.code;
      failureCategoryCounts[key] = (failureCategoryCounts[key] || 0) + 1;
    }
  }

  const failureCategories = Object.entries(failureCategoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => {
      const sample = classifyMessagingError(category);
      return {
        category,
        count,
        label: sample.userFacingMessage || category,
      };
    });

  // Durations
  const campaignDurationSeconds = Math.max(
    0,
    Math.floor((now.getTime() - campaign.createdAt.getTime()) / 1000),
  );

  // Legacy execution item counts for backward compatibility
  let execPending = 0;
  let execApproved = 0;
  let execSkipped = 0;
  let execSuppressed = 0;
  let execSent = 0;
  let execFailed = 0;
  let execTotal = 0;

  for (const eg of executionGroups) {
    execTotal += eg._count.id;
    if (eg.status === ExecutionItemStatus.PENDING) {
      execPending += eg._count.id;
    } else if (eg.status === ExecutionItemStatus.APPROVED) {
      execApproved += eg._count.id;
    } else if (eg.status === ExecutionItemStatus.SKIPPED) {
      execSkipped += eg._count.id;
    } else if (eg.status === ExecutionItemStatus.SUPPRESSED_DNC) {
      execSuppressed += eg._count.id;
    } else if (eg.status === ExecutionItemStatus.SENT) {
      execSent += eg._count.id;
    } else if (eg.status === ExecutionItemStatus.FAILED) {
      execFailed += eg._count.id;
    }
  }

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      executionMode: campaign.executionMode,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
    },
    summary: {
      totalLeads,
      totalMessages: totalBulkTargeted + singleTotal,
      messagesSent: bulkSent + singleSent,
      messagesFailed: bulkFailed + singleFailed,
      messagesUnknown: bulkUnknown + singleUnknown,
      messagesRemaining: bulkQueued + bulkProcessing,
      executionStatus: latestExecution?.status || campaign.status,
    },
    leads: {
      total: totalLeads,
      verified: verifiedLeads,
      business: businessLeads,
      nonBusiness: nonBusinessLeads,
      withExternalUrl: leadsWithExternalUrl,
      withProfilePic: leadsWithProfilePic,
      withBio: leadsWithBio,
      eligible: eligibleLeads,
      verifiedPercentage,
      businessPercentage,
    },
    leadLimit: {
      limit: leadLimitVal,
      current: totalLeads,
      remainingCapacity,
      isAtCapacity,
    },
    categories,
    discovery: {
      totalJobs: totalScrapeJobs,
      completedJobs: completedScrapeJobs,
      failedJobs: failedScrapeJobs,
      candidatesDiscovered,
      candidatesEnriched,
      candidatesSkipped,
      leadsSaved,
      enrichmentRate,
      saveRate,
      recentJobs,
    },
    scraping: {
      jobs: totalScrapeJobs,
      processed: leadsSaved,
      failed: failedScrapeJobs,
    },
    messaging: {
      totalTargeted: totalBulkTargeted,
      queued: bulkQueued,
      processing: bulkProcessing,
      sent: bulkSent,
      failed: bulkFailed,
      skipped: bulkSkipped,
      unknown: bulkUnknown,
      cancelled: bulkCancelled,
      suppressedCount: countByBulkStatus(BulkMessageItemStatus.SUPPRESSED_DNC),
      sentRate,
      singleMessages: {
        total: singleTotal,
        sent: singleSent,
        failed: singleFailed,
        unknown: singleUnknown,
        draft: singleDraft,
      },
      bulkJobs: {
        totalJobs: bulkJobsCount,
        activeJobs: activeBulkJobsCount,
        completedJobs: completedBulkJobsCount,
      },
    },
    messages: {
      total: totalBulkTargeted + singleTotal,
      sent: bulkSent + singleSent,
      failed: bulkFailed + singleFailed,
      unknown: bulkUnknown + singleUnknown,
      pending: bulkQueued + bulkProcessing + singleSending,
    },
    execution: {
      id: latestExecution?.id ?? null,
      status: latestExecution?.status ?? campaign.status,
      phase: latestExecution?.phase ?? null,
      overallProgress,
      startedAt: latestExecution?.startedAt ?? null,
      completedAt: latestExecution?.completedAt ?? null,
      pausedAt: latestExecution?.pausedAt ?? null,
      cancelledAt: latestExecution?.cancelledAt ?? null,
      durationSeconds: executionDurationSeconds,
      errorCode: latestExecution?.errorCode ?? null,
      errorMessage: latestExecution?.errorMessage ?? null,
      total: latestExecution ? latestExecution.totalItems : execTotal,
      totalItems: latestExecution ? latestExecution.totalItems : execTotal,
      processedItems: latestExecution?.processedItems ?? (bulkSent + bulkFailed + bulkUnknown + bulkSkipped),
      successfulItems: latestExecution?.successfulItems ?? (bulkSent + singleSent),
      failedItems: latestExecution?.failedItems ?? (bulkFailed + singleFailed),
      pending: execPending,
      approved: execApproved,
      skipped: execSkipped,
      suppressedCount: execSuppressed,
      sent: latestExecution?.successfulItems ?? execSent,
      failed: latestExecution?.failedItems ?? execFailed,
    },
    failures: {
      totalFailures,
      categories: failureCategories,
    },
    durations: {
      campaignDurationSeconds,
      discoveryDurationSeconds,
      messagingDurationSeconds: executionDurationSeconds,
      totalExecutionDurationSeconds: executionDurationSeconds,
    },
    emptyStates: {
      hasLeads: totalLeads > 0,
      hasDiscovery: totalScrapeJobs > 0,
      hasMessaging: totalBulkTargeted > 0 || singleTotal > 0,
      hasExecution: latestExecution !== null,
    },
  };
}

export async function getCampaignMessages(
  campaignId: string,
  searchParams?: URLSearchParams,
  userId?: string,
): Promise<CampaignMessagesResponse> {
  const prisma = getPrismaClient();

  // Validate campaign exists and belongs to user
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: { id: true },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${campaignId}" was not found.`,
    );
  }

  const rawPage = parseInt(searchParams?.get("page") || "1", 10);
  const rawLimit = parseInt(searchParams?.get("limit") || "25", 10);

  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 100
      ? rawLimit
      : 25;

  const statusFilter = searchParams?.get("status");
  const where: { campaignId: string; status?: MessageStatus } = { campaignId };

  if (statusFilter && Object.values(MessageStatus).includes(statusFilter as MessageStatus)) {
    where.status = statusFilter as MessageStatus;
  }

  const [total, items] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        campaignId: true,
        leadId: true,
        provider: true,
        status: true,
        messageText: true,
        errorCode: true,
        errorMessage: true,
        sentAt: true,
        createdAt: true,
        lead: {
          select: {
            username: true,
            fullName: true,
            profileUrl: true,
          },
        },
        attempts: {
          orderBy: { attemptNumber: "desc" },
          select: {
            id: true,
            attemptNumber: true,
            status: true,
            errorCode: true,
            errorMessage: true,
            startedAt: true,
            completedAt: true,
          },
        },
      },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}

export async function getDashboardOverview(userId?: string): Promise<DashboardOverviewResponse> {
  const prisma = getPrismaClient();

  const campaignFilter = userId ? { userId } : {};
  const nestedCampaignFilter = userId ? { campaign: { userId } } : {};

  const [
    totalCampaigns,
    totalLeads,
    totalMessages,
    activeRuns,
    recentCampaignsRaw,
    recentScrapeJobsRaw,
    recentMessagesRaw,
    recentExecutionsRaw,
  ] = await Promise.all([
    prisma.campaign.count({ where: campaignFilter }),
    prisma.lead.count({ where: nestedCampaignFilter }),
    prisma.message.count({ where: nestedCampaignFilter }),
    prisma.campaign.count({ where: { status: "RUNNING", ...campaignFilter } }),
    prisma.campaign.findMany({
      where: campaignFilter,
      take: 6,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        _count: {
          select: {
            leads: true,
            scrapeJobs: true,
          },
        },
      },
    }),
    prisma.scrapeJob.findMany({
      where: nestedCampaignFilter,
      take: 6,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        campaignId: true,
        status: true,
        provider: true,
        inputCount: true,
        processedCount: true,
        errorMessage: true,
        createdAt: true,
        campaign: {
          select: {
            name: true,
          },
        },
      },
    }),
    prisma.message.findMany({
      where: nestedCampaignFilter,
      take: 8,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        campaignId: true,
        status: true,
        sentAt: true,
        createdAt: true,
        campaign: { select: { name: true } },
        lead: { select: { username: true } },
      },
    }),
    prisma.campaignExecution.findMany({
      where: nestedCampaignFilter,
      take: 5,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        campaignId: true,
        status: true,
        totalItems: true,
        createdAt: true,
        campaign: { select: { name: true } },
      },
    }),
  ]);

  // Construct derived activity stream from actual database records
  const activityList: DashboardOverviewResponse["recentActivity"] = [];

  for (const c of recentCampaignsRaw) {
    activityList.push({
      id: `camp-${c.id}`,
      type: "CAMPAIGN_CREATED",
      title: "Campaign Created",
      description: `Campaign "${c.name}" was created.`,
      timestamp: c.createdAt,
      campaignId: c.id,
    });
  }

  for (const job of recentScrapeJobsRaw) {
    const isSuccess = job.status === "COMPLETED";
    activityList.push({
      id: `job-${job.id}`,
      type: isSuccess ? "SCRAPE_COMPLETED" : "SCRAPE_FAILED",
      title: isSuccess ? "Scrape Job Completed" : "Scrape Job Failed",
      description: isSuccess
        ? `Scraped ${job.processedCount} lead(s) for ${job.campaign?.name || "campaign"}.`
        : `Scrape job failed for ${job.campaign?.name || "campaign"}: ${job.errorMessage || "Unknown error"}.`,
      timestamp: job.createdAt,
      campaignId: job.campaignId || undefined,
    });
  }

  for (const msg of recentMessagesRaw) {
    const isSent = msg.status === "SENT";
    activityList.push({
      id: `msg-${msg.id}`,
      type: isSent ? "MESSAGE_SENT" : "MESSAGE_FAILED",
      title: isSent ? "Test Message Sent" : "Message Dispatch Failed",
      description: isSent
        ? `Dispatched test message to @${msg.lead.username} in "${msg.campaign.name}".`
        : `Message attempt to @${msg.lead.username} was marked ${msg.status}.`,
      timestamp: msg.createdAt,
      campaignId: msg.campaignId,
    });
  }

  for (const exec of recentExecutionsRaw) {
    activityList.push({
      id: `exec-${exec.id}`,
      type: "EXECUTION_CREATED",
      title: "Execution Plan Generated",
      description: `Execution preview created with ${exec.totalItems} planned item(s) in "${exec.campaign.name}".`,
      timestamp: exec.createdAt,
      campaignId: exec.campaignId,
    });
  }

  // Sort unified activity newest first and take top 10
  activityList.sort(
    (a: { timestamp: Date }, b: { timestamp: Date }) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const recentActivity = activityList.slice(0, 10);

  return {
    stats: {
      totalCampaigns,
      totalLeads,
      totalMessages,
      activeRuns,
    },
    recentCampaigns: recentCampaignsRaw.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      createdAt: c.createdAt,
      leadCount: c._count.leads,
      scrapeJobCount: c._count.scrapeJobs,
    })),
    recentScrapeJobs: recentScrapeJobsRaw.map((j) => ({
      id: j.id,
      campaignId: j.campaignId,
      campaignName: j.campaign?.name || null,
      status: j.status,
      provider: j.provider,
      inputCount: j.inputCount,
      processedCount: j.processedCount,
      errorMessage: j.errorMessage,
      createdAt: j.createdAt,
    })),
    recentActivity,
  };
}
