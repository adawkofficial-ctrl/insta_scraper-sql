import "server-only";

import type { LeadProfile, SkippedScrapeProfile } from "@/lib/types";
import { getPrismaClient } from "@/lib/db/prisma";
import {
  CampaignStatus,
  ScrapeJobStatus,
  ExecutionMode,
  ApprovalMode,
} from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import {
  ScrapeInputError,
  normalizeInstagramUsername,
  parseLeadLimit,
  scrapeInstagramProfiles,
  MAX_PROFILE_BATCH_SIZE,
} from "../scraper";
import {
  applyClassifiedProfiles,
  classifyProfiles,
  emptyDedupStats,
  type DedupStats,
} from "../dedup";
import { getAutoApprovalEligibility } from "../drafts";
import {
  createCompanyProfile,
  getDefaultCompanyProfileRecord,
} from "../company-profile";

export const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_CAMPAIGN_NAME_LENGTH = 200;
const MAX_CAMPAIGN_DESC_LENGTH = 2000;
const MAX_ERROR_MESSAGE_LENGTH = 1000;

export type CampaignSummary = {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  executionMode: ExecutionMode;
  messageApprovalRequired: boolean;
  scheduledAt: Date | null;
  intent: string | null;
  location: string | null;
  category: string | null;
  leadLimit: number | null;
  companyProfileId: string;
  companyProfile?: {
    id: string;
    name: string;
    description: string;
    isDefault: boolean;
  } | null;
  requireApproval: boolean;
  approvalMode: ApprovalMode;
  autoApproveMinScore: number;
  qualityMaxRegenerations: number;
  createdAt: Date;
  updatedAt: Date;
  leadCount: number;
  scrapeJobCount: number;
};

export type CampaignDetail = CampaignSummary & {
  recentScrapeJobs: {
    id: string;
    campaignId: string | null;
    status: ScrapeJobStatus;
    provider: string;
    inputCount: number;
    processedCount: number;
    errorMessage: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    query: string | null;
    location: string | null;
    category: string | null;
    discoveryActor: string | null;
    enrichmentActor: string | null;
    requestedLimit: number | null;
    candidatesDiscovered: number | null;
    candidatesEnriched: number | null;
    candidatesSkipped: number | null;
  }[];
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
};

export type CampaignScrapeInput = {
  campaignId: string;
  campaignName?: string | null;
  usernames: string[];
  maxLeads: number;
};

export type CampaignScrapeResult = {
  campaignId: string;
  scrapeJobId: string;
  provider: string;
  status: "COMPLETED";
  inputCount: number;
  processedCount: number;
  notice: string | null;
  profiles: LeadProfile[];
};

function logScrape(message: string): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  console.log(message);
}

export function parseCampaignLeadLimit(value: unknown, fieldName = "leadLimit"): number {
  if (value === undefined || value === null) {
    throw new BadRequestError(
      "INVALID_LEAD_LIMIT",
      `"${fieldName}" is required and must be an integer between 1 and 100.`,
    );
  }

  let numValue: number;
  if (typeof value === "number") {
    numValue = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new BadRequestError(
        "INVALID_LEAD_LIMIT",
        `"${fieldName}" must be an integer between 1 and 100.`,
      );
    }
    numValue = Number.parseInt(trimmed, 10);
  } else {
    throw new BadRequestError(
      "INVALID_LEAD_LIMIT",
      `"${fieldName}" must be an integer between 1 and 100.`,
    );
  }

  if (!Number.isInteger(numValue) || Number.isNaN(numValue)) {
    throw new BadRequestError(
      "INVALID_LEAD_LIMIT",
      `"${fieldName}" must be an integer between 1 and 100.`,
    );
  }

  if (numValue < 1 || numValue > 100) {
    throw new BadRequestError(
      "LEAD_LIMIT_OUT_OF_RANGE",
      `"${fieldName}" must be between 1 and 100.`,
    );
  }

  return numValue;
}

export async function createCampaign(
  input: unknown,
  userId: string,
): Promise<{
  id: string;
  userId: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  executionMode: ExecutionMode;
  messageApprovalRequired: boolean;
  scheduledAt: Date | null;
  intent: string | null;
  location: string | null;
  category: string | null;
  leadLimit: number | null;
  companyProfileId: string;
  companyProfile?: {
    id: string;
    name: string;
    description: string;
    isDefault: boolean;
  } | null;
  requireApproval: boolean;
  approvalMode: ApprovalMode;
  autoApproveMinScore: number;
  qualityMaxRegenerations: number;
  createdAt: Date;
  updatedAt: Date;
}> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }

  const record = input as Record<string, unknown>;

  if (record.name === undefined || record.name === null) {
    throw new BadRequestError("MISSING_NAME", '"name" is required.');
  }

  if (typeof record.name !== "string") {
    throw new BadRequestError("INVALID_NAME", '"name" must be a string.');
  }

  const name = record.name.trim();
  if (name.length === 0) {
    throw new BadRequestError("EMPTY_NAME", '"name" cannot be empty.');
  }

  if (name.length > MAX_CAMPAIGN_NAME_LENGTH) {
    throw new BadRequestError(
      "NAME_TOO_LONG",
      `"name" cannot exceed ${MAX_CAMPAIGN_NAME_LENGTH} characters.`,
    );
  }

  let description: string | null = null;
  if (record.description !== undefined && record.description !== null) {
    if (typeof record.description !== "string") {
      throw new BadRequestError(
        "INVALID_DESCRIPTION",
        '"description" must be a string.',
      );
    }
    const trimmedDesc = record.description.trim();
    if (trimmedDesc.length > MAX_CAMPAIGN_DESC_LENGTH) {
      throw new BadRequestError(
        "DESCRIPTION_TOO_LONG",
        `"description" cannot exceed ${MAX_CAMPAIGN_DESC_LENGTH} characters.`,
      );
    }
    description = trimmedDesc.length > 0 ? trimmedDesc : null;
  }

  let executionMode: ExecutionMode = ExecutionMode.MANUAL;
  if (record.executionMode !== undefined && record.executionMode !== null) {
    if (
      record.executionMode !== ExecutionMode.MANUAL &&
      record.executionMode !== ExecutionMode.REVIEW_REQUIRED
    ) {
      throw new BadRequestError(
        "INVALID_EXECUTION_MODE",
        `Invalid executionMode "${String(record.executionMode)}". Allowed: MANUAL, REVIEW_REQUIRED.`,
      );
    }
    executionMode = record.executionMode as ExecutionMode;
  }

  let messageApprovalRequired = true;
  if (record.messageApprovalRequired !== undefined) {
    if (typeof record.messageApprovalRequired !== "boolean") {
      throw new BadRequestError(
        "INVALID_APPROVAL_REQUIRED",
        '"messageApprovalRequired" must be a boolean.',
      );
    }
    messageApprovalRequired = record.messageApprovalRequired;
  }

  let requireApproval = true;
  if (record.requireApproval !== undefined) {
    if (typeof record.requireApproval !== "boolean") {
      throw new BadRequestError(
        "INVALID_REQUIRE_APPROVAL",
        '"requireApproval" must be a boolean.',
      );
    }
    requireApproval = record.requireApproval;
  }

  let approvalMode: ApprovalMode = ApprovalMode.MANUAL;
  if (record.approvalMode !== undefined && record.approvalMode !== null) {
    if (
      record.approvalMode !== ApprovalMode.MANUAL &&
      record.approvalMode !== ApprovalMode.AUTO_ELIGIBLE
    ) {
      throw new BadRequestError(
        "INVALID_APPROVAL_MODE",
        `Invalid approvalMode "${String(record.approvalMode)}". Allowed: MANUAL, AUTO_ELIGIBLE.`,
      );
    }
    approvalMode = record.approvalMode as ApprovalMode;
  }

  let autoApproveMinScore = 80;
  if (record.autoApproveMinScore !== undefined && record.autoApproveMinScore !== null) {
    const value = record.autoApproveMinScore;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new BadRequestError(
        "INVALID_AUTO_APPROVE_MIN_SCORE",
        '"autoApproveMinScore" must be an integer between 0 and 100.',
      );
    }
    autoApproveMinScore = value;
  }

  let qualityMaxRegenerations = 2;
  if (record.qualityMaxRegenerations !== undefined && record.qualityMaxRegenerations !== null) {
    const value = record.qualityMaxRegenerations;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
      throw new BadRequestError(
        "INVALID_QUALITY_MAX_REGENERATIONS",
        '"qualityMaxRegenerations" must be an integer between 0 and 5.',
      );
    }
    qualityMaxRegenerations = value;
  }

  let scheduledAt: Date | null = null;
  if (record.scheduledAt !== undefined && record.scheduledAt !== null) {
    const parsedDate = new Date(record.scheduledAt as string);
    if (Number.isNaN(parsedDate.getTime())) {
      throw new BadRequestError("INVALID_SCHEDULED_AT", 'Invalid date format for "scheduledAt".');
    }
    scheduledAt = parsedDate;
  }

  let intent: string | null = null;
  if (record.intent !== undefined && record.intent !== null) {
    if (typeof record.intent !== "string") {
      throw new BadRequestError("INVALID_INTENT", '"intent" must be a string.');
    }
    const trimmedIntent = record.intent.trim();
    if (trimmedIntent.length > 500) {
      throw new BadRequestError("INTENT_TOO_LONG", '"intent" cannot exceed 500 characters.');
    }
    intent = trimmedIntent.length > 0 ? trimmedIntent : null;
  }

  let location: string | null = null;
  if (record.location !== undefined && record.location !== null) {
    if (typeof record.location !== "string") {
      throw new BadRequestError("INVALID_LOCATION", '"location" must be a string.');
    }
    const trimmedLocation = record.location.trim();
    if (trimmedLocation.length > 200) {
      throw new BadRequestError("LOCATION_TOO_LONG", '"location" cannot exceed 200 characters.');
    }
    location = trimmedLocation.length > 0 ? trimmedLocation : null;
  }

  let category: string | null = null;
  if (record.category !== undefined && record.category !== null) {
    if (typeof record.category !== "string") {
      throw new BadRequestError("INVALID_CATEGORY", '"category" must be a string.');
    }
    const trimmedCategory = record.category.trim();
    if (trimmedCategory.length > 200) {
      throw new BadRequestError("CATEGORY_TOO_LONG", '"category" cannot exceed 200 characters.');
    }
    category = trimmedCategory.length > 0 ? trimmedCategory : null;
  }

  let leadLimit: number | null = null;
  if (record.leadLimit !== undefined && record.leadLimit !== null) {
    leadLimit = parseCampaignLeadLimit(record.leadLimit, "leadLimit");
  }

  const prisma = getPrismaClient();

  let companyProfileId: string;
  if (record.companyProfileId !== undefined && record.companyProfileId !== null) {
    if (typeof record.companyProfileId !== "string" || record.companyProfileId.trim().length === 0) {
      throw new BadRequestError("INVALID_COMPANY_PROFILE", '"companyProfileId" must be a non-empty string.');
    }
    const profileId = record.companyProfileId.trim();
    const profile = await prisma.companyProfile.findFirst({
      where: { id: profileId, userId },
    });
    if (!profile) {
      throw new BadRequestError("PROFILE_NOT_FOUND", `Company profile "${profileId}" not found for this user.`);
    }
    companyProfileId = profile.id;
  } else if (record.companyProfile !== undefined && record.companyProfile !== null) {
    const created = await createCompanyProfile(userId, record.companyProfile);
    companyProfileId = created.id;
  } else {
    const def = await getDefaultCompanyProfileRecord(userId);
    if (def) {
      companyProfileId = def.id;
    } else {
      const created = await createCompanyProfile(userId, { name: "Default Profile", isDefault: true });
      companyProfileId = created.id;
    }
  }

  const campaign = await prisma.campaign.create({
    data: {
      userId,
      name,
      description,
      status: CampaignStatus.DRAFT,
      executionMode,
      messageApprovalRequired,
      requireApproval,
      approvalMode,
      autoApproveMinScore,
      qualityMaxRegenerations,
      scheduledAt,
      intent,
      location,
      category,
      leadLimit,
      companyProfileId,
    },
    select: {
      id: true,
      userId: true,
      name: true,
      description: true,
      status: true,
      executionMode: true,
      messageApprovalRequired: true,
      requireApproval: true,
      approvalMode: true,
      autoApproveMinScore: true,
      qualityMaxRegenerations: true,
      scheduledAt: true,
      intent: true,
      location: true,
      category: true,
      leadLimit: true,
      companyProfileId: true,
      companyProfile: {
        select: {
          id: true,
          name: true,
          description: true,
          isDefault: true,
        },
      },
      createdAt: true,
      updatedAt: true,
    },
  });

  return campaign;
}

export async function listCampaigns(userId?: string): Promise<CampaignSummary[]> {
  const prisma = getPrismaClient();

  const campaigns = await prisma.campaign.findMany({
    where: userId ? { userId } : {},
    take: 100,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userId: true,
      name: true,
      description: true,
      status: true,
      executionMode: true,
      messageApprovalRequired: true,
      requireApproval: true,
      approvalMode: true,
      autoApproveMinScore: true,
      qualityMaxRegenerations: true,
      scheduledAt: true,
      intent: true,
      location: true,
      category: true,
      leadLimit: true,
      companyProfileId: true,
      companyProfile: {
        select: {
          id: true,
          name: true,
          description: true,
          isDefault: true,
        },
      },
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          leads: true,
          scrapeJobs: true,
        },
      },
    },
  });

  return campaigns.map((campaign) => ({
    id: campaign.id,
    userId: campaign.userId,
    name: campaign.name,
    description: campaign.description,
    status: campaign.status,
    executionMode: campaign.executionMode,
    messageApprovalRequired: campaign.messageApprovalRequired,
    requireApproval: campaign.requireApproval,
    approvalMode: campaign.approvalMode,
    autoApproveMinScore: campaign.autoApproveMinScore,
    qualityMaxRegenerations: campaign.qualityMaxRegenerations,
    scheduledAt: campaign.scheduledAt,
    intent: campaign.intent,
    location: campaign.location,
    category: campaign.category,
    leadLimit: campaign.leadLimit,
    companyProfileId: campaign.companyProfileId,
    companyProfile: campaign.companyProfile,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    leadCount: campaign._count.leads,
    scrapeJobCount: campaign._count.scrapeJobs,
  }));
}

export async function getCampaignById(
  campaignId: string,
  userId?: string,
): Promise<CampaignDetail> {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: {
      id: true,
      userId: true,
      name: true,
      description: true,
      status: true,
      executionMode: true,
      messageApprovalRequired: true,
      requireApproval: true,
      approvalMode: true,
      autoApproveMinScore: true,
      qualityMaxRegenerations: true,
      scheduledAt: true,
      intent: true,
      location: true,
      category: true,
      leadLimit: true,
      companyProfileId: true,
      companyProfile: {
        select: {
          id: true,
          name: true,
          description: true,
          isDefault: true,
        },
      },
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          leads: true,
          scrapeJobs: true,
        },
      },
      scrapeJobs: {
        take: 10,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          campaignId: true,
          status: true,
          provider: true,
          inputCount: true,
          processedCount: true,
          errorMessage: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          query: true,
          location: true,
          category: true,
          discoveryActor: true,
          enrichmentActor: true,
          requestedLimit: true,
          candidatesDiscovered: true,
          candidatesEnriched: true,
          candidatesSkipped: true,
        },
      },
    },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", "Campaign not found");
  }

  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    status: campaign.status,
    executionMode: campaign.executionMode,
    messageApprovalRequired: campaign.messageApprovalRequired,
    requireApproval: campaign.requireApproval,
    approvalMode: campaign.approvalMode,
    autoApproveMinScore: campaign.autoApproveMinScore,
    qualityMaxRegenerations: campaign.qualityMaxRegenerations,
    scheduledAt: campaign.scheduledAt,
    intent: campaign.intent,
    location: campaign.location,
    category: campaign.category,
    leadLimit: campaign.leadLimit,
    companyProfileId: campaign.companyProfileId,
    companyProfile: campaign.companyProfile,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    leadCount: campaign._count.leads,
    scrapeJobCount: campaign._count.scrapeJobs,
    recentScrapeJobs: campaign.scrapeJobs,
  };
}

const VALID_CAMPAIGN_STATUSES = new Set<string>([
  CampaignStatus.DRAFT,
  CampaignStatus.RUNNING,
  CampaignStatus.COMPLETED,
  CampaignStatus.FAILED,
]);

export async function updateCampaign(
  campaignId: string,
  input: unknown,
  userId?: string,
): Promise<{
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  executionMode: ExecutionMode;
  messageApprovalRequired: boolean;
  requireApproval: boolean;
  approvalMode: ApprovalMode;
  autoApproveMinScore: number;
  qualityMaxRegenerations: number;
  scheduledAt: Date | null;
  intent: string | null;
  location: string | null;
  category: string | null;
  leadLimit: number | null;
  companyProfileId: string;
  companyProfile?: {
    id: string;
    name: string;
    description: string;
    isDefault: boolean;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }

  const record = input as Record<string, unknown>;
  const prisma = getPrismaClient();
  const data: {
    name?: string;
    description?: string | null;
    status?: CampaignStatus;
    executionMode?: ExecutionMode;
    messageApprovalRequired?: boolean;
    requireApproval?: boolean;
    approvalMode?: ApprovalMode;
    autoApproveMinScore?: number;
    qualityMaxRegenerations?: number;
    scheduledAt?: Date | null;
    intent?: string | null;
    location?: string | null;
    category?: string | null;
    leadLimit?: number | null;
    companyProfileId?: string;
  } = {};

  // Verify campaign exists and belongs to user if specified
  const existing = await getCampaignById(campaignId, userId);

  if (record.name !== undefined) {
    if (typeof record.name !== "string") {
      throw new BadRequestError("INVALID_NAME", '"name" must be a string.');
    }
    const trimmed = record.name.trim();
    if (trimmed.length === 0) {
      throw new BadRequestError("EMPTY_NAME", '"name" cannot be empty.');
    }
    if (trimmed.length > MAX_CAMPAIGN_NAME_LENGTH) {
      throw new BadRequestError(
        "NAME_TOO_LONG",
        `"name" cannot exceed ${MAX_CAMPAIGN_NAME_LENGTH} characters.`,
      );
    }
    data.name = trimmed;
  }

  if (record.description !== undefined) {
    if (record.description === null) {
      data.description = null;
    } else if (typeof record.description === "string") {
      const trimmed = record.description.trim();
      if (trimmed.length > MAX_CAMPAIGN_DESC_LENGTH) {
        throw new BadRequestError(
          "DESCRIPTION_TOO_LONG",
          `"description" cannot exceed ${MAX_CAMPAIGN_DESC_LENGTH} characters.`,
        );
      }
      data.description = trimmed.length > 0 ? trimmed : null;
    } else {
      throw new BadRequestError(
        "INVALID_DESCRIPTION",
        '"description" must be a string or null.',
      );
    }
  }

  if (record.status !== undefined) {
    if (typeof record.status !== "string" || !VALID_CAMPAIGN_STATUSES.has(record.status)) {
      throw new BadRequestError(
        "INVALID_STATUS",
        `Invalid status "${String(record.status)}". Allowed values: DRAFT, RUNNING, COMPLETED, FAILED.`,
      );
    }

    const currentStatus = existing.status;
    const targetStatus = record.status as CampaignStatus;

    if (currentStatus !== targetStatus) {
      const allowedTransitions: Record<CampaignStatus, Set<CampaignStatus>> = {
        [CampaignStatus.DRAFT]: new Set([
          CampaignStatus.READY,
          CampaignStatus.RUNNING,
          CampaignStatus.CANCELLED,
        ]),
        [CampaignStatus.READY]: new Set([
          CampaignStatus.RUNNING,
          CampaignStatus.CANCELLED,
          CampaignStatus.DRAFT,
        ]),
        [CampaignStatus.RUNNING]: new Set([
          CampaignStatus.PAUSED,
          CampaignStatus.COMPLETED,
          CampaignStatus.PARTIAL,
          CampaignStatus.FAILED,
          CampaignStatus.CANCELLED,
          CampaignStatus.DRAFT,
        ]),
        [CampaignStatus.PAUSED]: new Set([
          CampaignStatus.RUNNING,
          CampaignStatus.CANCELLED,
        ]),
        [CampaignStatus.COMPLETED]: new Set([
          CampaignStatus.DRAFT,
          CampaignStatus.RUNNING,
        ]),
        [CampaignStatus.PARTIAL]: new Set([
          CampaignStatus.DRAFT,
          CampaignStatus.RUNNING,
        ]),
        [CampaignStatus.FAILED]: new Set([
          CampaignStatus.DRAFT,
          CampaignStatus.RUNNING,
        ]),
        [CampaignStatus.CANCELLED]: new Set([
          CampaignStatus.DRAFT,
        ]),
      };

      if (!allowedTransitions[currentStatus]?.has(targetStatus)) {
        throw new BadRequestError(
          "INVALID_STATUS_TRANSITION",
          `Cannot transition campaign status from "${currentStatus}" to "${targetStatus}".`,
        );
      }
      data.status = targetStatus;
    }
  }

  if (record.executionMode !== undefined && record.executionMode !== null) {
    if (
      record.executionMode !== ExecutionMode.MANUAL &&
      record.executionMode !== ExecutionMode.REVIEW_REQUIRED
    ) {
      throw new BadRequestError(
        "INVALID_EXECUTION_MODE",
        `Invalid executionMode "${String(record.executionMode)}". Allowed: MANUAL, REVIEW_REQUIRED.`,
      );
    }
    data.executionMode = record.executionMode as ExecutionMode;
  }

  if (record.messageApprovalRequired !== undefined) {
    if (typeof record.messageApprovalRequired !== "boolean") {
      throw new BadRequestError(
        "INVALID_APPROVAL_REQUIRED",
        '"messageApprovalRequired" must be a boolean.',
      );
    }
    data.messageApprovalRequired = record.messageApprovalRequired;
  }

  if (record.scheduledAt !== undefined) {
    if (record.scheduledAt === null) {
      data.scheduledAt = null;
    } else {
      const parsedDate = new Date(record.scheduledAt as string);
      if (Number.isNaN(parsedDate.getTime())) {
        throw new BadRequestError("INVALID_SCHEDULED_AT", 'Invalid date format for "scheduledAt".');
      }
      data.scheduledAt = parsedDate;
    }
  }

  if (record.intent !== undefined) {
    if (record.intent === null) {
      data.intent = null;
    } else if (typeof record.intent === "string") {
      const trimmed = record.intent.trim();
      if (trimmed.length > 500) {
        throw new BadRequestError("INTENT_TOO_LONG", '"intent" cannot exceed 500 characters.');
      }
      data.intent = trimmed.length > 0 ? trimmed : null;
    } else {
      throw new BadRequestError("INVALID_INTENT", '"intent" must be a string or null.');
    }
  }

  if (record.location !== undefined) {
    if (record.location === null) {
      data.location = null;
    } else if (typeof record.location === "string") {
      const trimmed = record.location.trim();
      if (trimmed.length > 200) {
        throw new BadRequestError("LOCATION_TOO_LONG", '"location" cannot exceed 200 characters.');
      }
      data.location = trimmed.length > 0 ? trimmed : null;
    } else {
      throw new BadRequestError("INVALID_LOCATION", '"location" must be a string or null.');
    }
  }

  if (record.category !== undefined) {
    if (record.category === null) {
      data.category = null;
    } else if (typeof record.category === "string") {
      const trimmed = record.category.trim();
      if (trimmed.length > 200) {
        throw new BadRequestError("CATEGORY_TOO_LONG", '"category" cannot exceed 200 characters.');
      }
      data.category = trimmed.length > 0 ? trimmed : null;
    } else {
      throw new BadRequestError("INVALID_CATEGORY", '"category" must be a string or null.');
    }
  }

  if (record.leadLimit !== undefined) {
    if (record.leadLimit === null) {
      data.leadLimit = null;
    } else {
      data.leadLimit = parseCampaignLeadLimit(record.leadLimit, "leadLimit");
    }
  }

  if (record.companyProfileId !== undefined) {
    if (typeof record.companyProfileId !== "string" || record.companyProfileId.trim().length === 0) {
      throw new BadRequestError("INVALID_COMPANY_PROFILE", '"companyProfileId" must be a non-empty string.');
    }
    const profileId = record.companyProfileId.trim();
    const profile = await prisma.companyProfile.findFirst({
      where: { id: profileId, ...(userId ? { userId } : {}) },
    });
    if (!profile) {
      throw new BadRequestError("PROFILE_NOT_FOUND", `Company profile "${profileId}" not found.`);
    }
    data.companyProfileId = profile.id;
  }

  // Step 6: quality gate + approval settings.
  if (record.requireApproval !== undefined) {
    if (typeof record.requireApproval !== "boolean") {
      throw new BadRequestError("INVALID_REQUIRE_APPROVAL", '"requireApproval" must be a boolean.');
    }
    data.requireApproval = record.requireApproval;
  }

  if (record.approvalMode !== undefined && record.approvalMode !== null) {
    if (
      record.approvalMode !== ApprovalMode.MANUAL &&
      record.approvalMode !== ApprovalMode.AUTO_ELIGIBLE
    ) {
      throw new BadRequestError(
        "INVALID_APPROVAL_MODE",
        `Invalid approvalMode "${String(record.approvalMode)}". Allowed: MANUAL, AUTO_ELIGIBLE.`,
      );
    }
    if (record.approvalMode === ApprovalMode.AUTO_ELIGIBLE) {
      const eligibility = await getAutoApprovalEligibility(campaignId);
      if (!eligibility.eligible) {
        throw new BadRequestError(
          "AUTO_APPROVAL_NOT_ELIGIBLE",
          `Auto approval cannot be enabled: ${eligibility.unmet.join("; ")}`,
        );
      }
    }
    data.approvalMode = record.approvalMode as ApprovalMode;
  }

  if (record.autoApproveMinScore !== undefined) {
    const value = record.autoApproveMinScore;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new BadRequestError(
        "INVALID_AUTO_APPROVE_MIN_SCORE",
        '"autoApproveMinScore" must be an integer between 0 and 100.',
      );
    }
    data.autoApproveMinScore = value;
  }

  if (record.qualityMaxRegenerations !== undefined) {
    const value = record.qualityMaxRegenerations;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
      throw new BadRequestError(
        "INVALID_QUALITY_MAX_REGENERATIONS",
        '"qualityMaxRegenerations" must be an integer between 0 and 5.',
      );
    }
    data.qualityMaxRegenerations = value;
  }

  // Reject unauthorized fields
  const allowedKeys = new Set([
    "name",
    "description",
    "status",
    "executionMode",
    "messageApprovalRequired",
    "requireApproval",
    "approvalMode",
    "autoApproveMinScore",
    "qualityMaxRegenerations",
    "scheduledAt",
    "intent",
    "location",
    "category",
    "leadLimit",
    "companyProfileId",
  ]);
  const unexpectedKeys = Object.keys(record).filter((k) => !allowedKeys.has(k));
  if (unexpectedKeys.length > 0) {
    throw new BadRequestError(
      "UNALLOWED_FIELDS",
      `Cannot update fields: ${unexpectedKeys.join(", ")}.`,
    );
  }

  if (Object.keys(data).length === 0) {
    throw new BadRequestError("NO_UPDATES", "No valid update fields were provided.");
  }

  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data,
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      executionMode: true,
      messageApprovalRequired: true,
      requireApproval: true,
      approvalMode: true,
      autoApproveMinScore: true,
      qualityMaxRegenerations: true,
      scheduledAt: true,
      intent: true,
      location: true,
      category: true,
      leadLimit: true,
      companyProfileId: true,
      companyProfile: {
        select: {
          id: true,
          name: true,
          description: true,
          isDefault: true,
        },
      },
      createdAt: true,
      updatedAt: true,
    },
  });

  return updated;
}

export async function deleteCampaign(
  campaignId: string,
  userId?: string,
): Promise<{
  id: string;
  name: string;
  deleted: true;
}> {
  // Verify campaign exists and belongs to user if specified
  const existing = await getCampaignById(campaignId, userId);

  const prisma = getPrismaClient();

  // Cascade onDelete in Prisma/DB automatically deletes leads and scrape jobs
  await prisma.campaign.delete({
    where: { id: campaignId },
  });

  return {
    id: existing.id,
    name: existing.name,
    deleted: true,
  };
}

export function parseCampaignScrapeRequest(body: unknown): CampaignScrapeInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ScrapeInputError(
      "INVALID_BODY",
      "Request body must be a JSON object.",
    );
  }

  const record = body as Record<string, unknown>;

  const rawCampaignId = record.campaignId;
  if (rawCampaignId === undefined) {
    throw new ScrapeInputError(
      "MISSING_CAMPAIGN_ID",
      '"campaignId" is required to persist scrape results.',
    );
  }
  if (typeof rawCampaignId !== "string") {
    throw new ScrapeInputError(
      "INVALID_CAMPAIGN_ID",
      '"campaignId" must be a string.',
    );
  }

  const campaignId = rawCampaignId.trim();
  if (!CAMPAIGN_ID_PATTERN.test(campaignId)) {
    throw new ScrapeInputError(
      "INVALID_CAMPAIGN_ID",
      '"campaignId" must be 1-64 characters using letters, numbers, "-" or "_".',
    );
  }

  // Accept both 'profiles' and 'usernames'
  const rawList = record.profiles ?? record.usernames;
  if (rawList === undefined) {
    throw new ScrapeInputError(
      "MISSING_PROFILES",
      '"profiles" or "usernames" array is required.',
    );
  }
  if (!Array.isArray(rawList)) {
    throw new ScrapeInputError(
      "INVALID_PROFILES",
      '"profiles" must be an array of strings.',
    );
  }
  if (rawList.length === 0) {
    throw new ScrapeInputError(
      "EMPTY_PROFILES",
      "At least one profile or username is required.",
    );
  }
  if (rawList.length > MAX_PROFILE_BATCH_SIZE) {
    throw new ScrapeInputError(
      "BATCH_TOO_LARGE",
      `Too many profiles: ${rawList.length}. The maximum for this batch is ${MAX_PROFILE_BATCH_SIZE}.`,
    );
  }

  const seen = new Set<string>();
  const usernames: string[] = [];

  for (const value of rawList) {
    if (typeof value !== "string") {
      throw new ScrapeInputError(
        "INVALID_PROFILE",
        "Each profile or username must be a string.",
      );
    }

    const username = normalizeInstagramUsername(value);
    if (username === null) {
      throw new ScrapeInputError(
        "INVALID_PROFILE",
        `Invalid Instagram username or profile URL: "${value.slice(0, 64)}".`,
      );
    }

    if (seen.has(username)) {
      continue;
    }

    seen.add(username);
    usernames.push(username);
  }

  if (usernames.length === 0) {
    throw new ScrapeInputError(
      "EMPTY_PROFILES",
      "At least one valid profile is required.",
    );
  }

  let campaignName: string | null = null;
  const rawCampaignName = record.campaignName;
  if (rawCampaignName !== undefined) {
    if (typeof rawCampaignName !== "string" || rawCampaignName.trim().length === 0) {
      throw new ScrapeInputError(
        "INVALID_CAMPAIGN_NAME",
        '"campaignName" must be a non-empty string when provided.',
      );
    }

    campaignName = rawCampaignName.trim().slice(0, MAX_CAMPAIGN_NAME_LENGTH);
  }

  // "Maximum Leads" — validated server-side and never trusted from the client.
  // The Actor input schema has no results limit, so this caps what we persist.
  const maxLeads = parseLeadLimit(record.maxLeads ?? record.limit);

  return { campaignId, campaignName, usernames, maxLeads };
}

export async function runCampaignScrape(
  input: CampaignScrapeInput,
  userId?: string,
): Promise<CampaignScrapeResult> {
  const prisma = getPrismaClient();

  // Validate campaign exists and belongs to user if specified
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: input.campaignId,
      ...(userId ? { userId } : {}),
    },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${input.campaignId}" was not found.`,
    );
  }

  const job = await prisma.scrapeJob.create({
    data: {
      campaignId: campaign.id,
      status: "RUNNING",
      provider: "apify",
      inputCount: input.usernames.length,
      processedCount: 0,
      startedAt: new Date(),
    },
  });

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "RUNNING" },
  });

  logScrape(
    `[SCRAPE] starting campaignId=${campaign.id} profiles=${input.usernames.join(", ")} limit=${input.maxLeads}`,
  );

  try {
    const {
      provider,
      runId,
      profiles: scrapedProfiles,
      skipped,
    } = await scrapeInstagramProfiles(input.usernames, input.maxLeads);

    logScrape(
      `[SCRAPE] results received count=${scrapedProfiles.length} skipped=${skipped.length} runId=${runId}`,
    );

    // Only the first `maxLeads` normalized profiles are persisted for this run.
    const profiles = scrapedProfiles.slice(0, input.maxLeads);

    logScrape(
      `[SCRAPE] normalized count=${profiles.length} limit=${input.maxLeads}`,
    );

    const maxLimit = campaign.leadLimit ?? input.maxLeads;
    const persistResult = await persistCampaignLeads(
      campaign.id,
      profiles,
      maxLimit,
    );

    logScrape(
      `[SCRAPE] persisted count=${persistResult.persisted} (new: ${persistResult.newLeads}, updated: ${persistResult.updatedLeads}) campaignId=${campaign.id}`,
    );

    const notice = buildScrapeNotice(persistResult.persisted, skipped);

    const completedJob = await prisma.scrapeJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        processedCount: persistResult.persisted,
        completedAt: new Date(),
        errorMessage: notice,
      },
    });

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "COMPLETED" },
    });

    return {
      campaignId: campaign.id,
      scrapeJobId: completedJob.id,
      provider,
      status: "COMPLETED",
      inputCount: input.usernames.length,
      processedCount: persistResult.persisted,
      notice,
      profiles: profiles.slice(0, persistResult.persisted),
    };
  } catch (error) {
    const errorMessage = describeError(error);

    logScrape(
      `[SCRAPE] failed campaignId=${campaign.id} error=${errorMessage}`,
    );

    await prisma.scrapeJob
      .update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          errorMessage,
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);

    await prisma.campaign
      .update({
        where: { id: campaign.id },
        data: { status: "FAILED" },
      })
      .catch(() => undefined);

    throw error;
  }
}

export async function persistCampaignLeads(
  campaignId: string,
  profiles: LeadProfile[],
  maxTotalLimit?: number,
  options?: { source?: string; scrapeJobId?: string | null; userId?: string },
): Promise<{
  persisted: number;
  newLeads: number;
  updatedLeads: number;
  dedupStats: DedupStats;
}> {
  if (profiles.length === 0) {
    return {
      persisted: 0,
      newLeads: 0,
      updatedLeads: 0,
      dedupStats: emptyDedupStats(),
    };
  }

  const prisma = getPrismaClient();
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { userId: true },
  });
  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign "${campaignId}" was not found.`,
    );
  }
  const userId = options?.userId ?? campaign.userId;
  const source = options?.source ?? "apify";

  return await prisma.$transaction(async (tx) => {
    const currentTotal = await tx.lead.count({ where: { campaignId } });

    // Per-user, cross-campaign deduplication: the same person is ONE lead.
    const classifications = await classifyProfiles({
      userId,
      campaignId,
      profiles,
      client: tx,
    });

    const result = await applyClassifiedProfiles(tx, {
      userId,
      campaignId,
      source,
      scrapeJobId: options?.scrapeJobId ?? null,
      profiles,
      classifications,
      maxTotalLimit,
      currentTotal,
      extraCreateFields: (profile) =>
        buildLeadCreateExtras(profile as LeadProfile),
      extraEnrichFields: (profile) =>
        buildLeadEnrichExtras(profile as LeadProfile),
    });

    return {
      // Hard duplicates are "known", not new leads in this campaign.
      persisted: result.stats.new + result.stats.enriched,
      newLeads: result.stats.new,
      updatedLeads: result.stats.enriched,
      dedupStats: result.stats,
    };
  });
}

/** Rich (enrichment) fields shared by create and enrich, unchanged from before. */
function richProfileFields(profile: LeadProfile) {
  return {
    profilePictureUrl:
      profile.profilePictureUrl ??
      profile.profilePicUrlHD ??
      profile.profilePicUrl ??
      null,
    profilePicUrl: profile.profilePicUrl ?? null,
    profilePicUrlHD: profile.profilePicUrlHD ?? null,
    isVerified: profile.isVerified ?? profile.verified ?? null,
    verified: profile.verified ?? profile.isVerified ?? null,
    isBusiness: profile.isBusiness ?? profile.isBusinessAccount ?? null,
    isBusinessAccount:
      profile.isBusinessAccount ?? profile.isBusiness ?? null,
    businessCategoryName:
      profile.businessCategoryName ?? profile.category ?? null,
    externalUrl: profile.externalUrl ?? profile.website ?? null,
    website: profile.website ?? null,
    websiteDomain: profile.websiteDomain ?? null,
    phone: profile.phone ?? null,
    phoneNormalized: profile.phoneNormalized ?? null,
    socialLink: profile.socialLink ?? null,
    socialPlatform: profile.socialPlatform ?? null,
    contactSource: profile.contactSource ?? null,
    availableChannels: profile.availableChannels ?? [],
  };
}

function buildLeadCreateExtras(
  profile: LeadProfile,
): Partial<Prisma.LeadUncheckedCreateInput> {
  return {
    ...richProfileFields(profile),
    relatedProfiles: toJsonValue(profile.relatedProfiles),
    latestPosts: toJsonValue(profile.latestPosts),
    rawProfileData: Prisma.DbNull,
    scrapedAt: toDate(profile.scrapedAt),
    followers: profile.followers ?? profile.followersCount ?? null,
    following: profile.following ?? profile.followsCount ?? null,
  } as Partial<Prisma.LeadUncheckedCreateInput>;
}

function buildLeadEnrichExtras(profile: LeadProfile): Prisma.LeadUpdateInput {
  return {
    ...richProfileFields(profile),
    followers: profile.followers ?? profile.followersCount ?? null,
    following: profile.following ?? profile.followsCount ?? null,
    postsCount: profile.postsCount ?? null,
    relatedProfiles: toJsonValue(profile.relatedProfiles),
    latestPosts: toJsonValue(profile.latestPosts),
    rawProfileData: Prisma.DbNull,
    scrapedAt: toDate(profile.scrapedAt),
  } as Prisma.LeadUpdateInput;
}

function toDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toJsonValue(
  value: unknown[] | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === null) {
    return Prisma.DbNull;
  }
  return value as Prisma.InputJsonValue;
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutConnectionString = raw.replace(
    /postgresql:\/\/[^\s"']+/gi,
    "postgresql://***",
  );

  return withoutConnectionString.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

const MAX_NOTICE_SKIPPED_ENTRIES = 5;

/**
 * Builds a user-facing notice that names the failing stage/reason instead of
 * silently returning "no leads". Returns null when every requested profile was
 * persisted successfully.
 */
function buildScrapeNotice(
  persisted: number,
  skipped: SkippedScrapeProfile[],
): string | null {
  if (persisted > 0 && skipped.length === 0) {
    return null;
  }

  const details = skipped
    .slice(0, MAX_NOTICE_SKIPPED_ENTRIES)
    .map((entry) => `${entry.username} (${entry.reason})`)
    .join("; ");

  if (persisted === 0) {
    return (
      skipped.length > 0
        ? `NO_RESULTS: Apify returned no usable profiles. Skipped ${skipped.length}: ${details}.`
        : "NO_RESULTS: Apify returned no usable profiles for the requested input. Verify the usernames/profile URLs and that the profiles are public."
    ).slice(0, MAX_ERROR_MESSAGE_LENGTH);
  }

  return `PARTIAL_RESULTS: persisted ${persisted}, skipped ${skipped.length}: ${details}.`.slice(
    0,
    MAX_ERROR_MESSAGE_LENGTH,
  );
}
