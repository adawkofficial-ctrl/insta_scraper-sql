import { getPrismaClient } from "@/lib/db/prisma";
import {
  CampaignStatus,
  CampaignExecutionStatus,
  CampaignExecutionPhase,
  ExecutionItemStatus,
  ExecutionMode,
  BulkMessageJobStatus,
  BulkMessageItemStatus,
} from "@/generated/prisma/client";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { renderTemplate } from "../template/template-renderer";
import { getMessagingProvider } from "../messaging";
import { findConnectedSenderForDispatch } from "../senders/instagram-sender-service";
import { runDiscovery } from "../discovery/discovery-service";
import {
  createBulkMessageJob,
  dispatchBulkJobQueue,
  pauseBulkMessageJob,
  resumeBulkMessageJob,
  cancelBulkMessageJob,
  recoverStaleProcessingItems,
} from "../messaging/bulk-messaging-service";
import {
  checkLeadSuppression,
  checkManySuppression,
  DncChannel,
} from "../compliance/dnc-service";
import { notifySystemError } from "../notifications/notification-triggers";

// Worker lease configuration
export const LEASE_DURATION_MS = 60 * 1000; // 60 seconds lease
export const HEARTBEAT_INTERVAL_MS = 15 * 1000; // Heartbeat every 15 seconds

// In-process worker tracking to prevent duplicate workers for the same execution
const activeExecutionWorkers = new Set<string>();

const WRITE_CONFLICT_MAX_RETRIES = 5;

/**
 * Retries a write on Prisma P2034 (write conflict / serialization failure).
 * Campaign pause/resume/cancel and the execution worker update the same rows
 * concurrently; a short bounded retry turns a transient conflict into success
 * instead of a 500, without changing any status semantics.
 */
async function withWriteConflictRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < WRITE_CONFLICT_MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if ((error as { code?: string }).code !== "P2034") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

// Valid campaign status transitions
export const VALID_CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  [CampaignStatus.DRAFT]: [CampaignStatus.READY, CampaignStatus.RUNNING, CampaignStatus.CANCELLED],
  [CampaignStatus.READY]: [CampaignStatus.RUNNING, CampaignStatus.CANCELLED],
  [CampaignStatus.RUNNING]: [
    CampaignStatus.PAUSED,
    CampaignStatus.COMPLETED,
    CampaignStatus.PARTIAL,
    CampaignStatus.FAILED,
    CampaignStatus.CANCELLED,
  ],
  [CampaignStatus.PAUSED]: [CampaignStatus.RUNNING, CampaignStatus.CANCELLED],
  [CampaignStatus.COMPLETED]: [CampaignStatus.RUNNING], // Allowed only when explicit rerun is requested
  [CampaignStatus.PARTIAL]: [CampaignStatus.RUNNING],   // Allowed only when explicit rerun is requested
  [CampaignStatus.FAILED]: [CampaignStatus.RUNNING],    // Allowed only when explicit rerun is requested
  [CampaignStatus.CANCELLED]: [],
};

/**
 * Validates whether a CampaignStatus transition is allowed.
 */
export function validateCampaignStateTransition(
  currentStatus: CampaignStatus,
  targetStatus: CampaignStatus,
  allowRerun = false,
): void {
  if (currentStatus === targetStatus) return;

  const terminalStatuses: CampaignStatus[] = [
    CampaignStatus.COMPLETED,
    CampaignStatus.PARTIAL,
    CampaignStatus.FAILED,
  ];
  if (terminalStatuses.includes(currentStatus) && targetStatus === CampaignStatus.RUNNING && !allowRerun) {
    throw new BadRequestError(
      "INVALID_STATE_TRANSITION",
      `Cannot transition from terminal status "${currentStatus}" to "${targetStatus}" without explicit rerun.`,
    );
  }

  const allowed = VALID_CAMPAIGN_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(targetStatus)) {
    throw new BadRequestError(
      "INVALID_STATE_TRANSITION",
      `Invalid campaign status transition from "${currentStatus}" to "${targetStatus}".`,
    );
  }
}

export type ExecutionPreviewResponse = {
  campaignId: string;
  executionId: string;
  status: CampaignExecutionStatus;
  mode: ExecutionMode;
  totalEligibleLeads: number;
  planned: number;
  skipped: number;
  suppressedCount?: number;
  suppressedLeadIds?: string[];
  items: Array<{
    id: string;
    leadId: string;
    username: string;
    messagePreview: string;
    status: ExecutionItemStatus;
  }>;
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
  suppressedItems?: number;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{
    id: string;
    executionId: string;
    leadId: string;
    status: ExecutionItemStatus;
    messageText: string;
    errorMessage: string | null;
    processedAt: Date | null;
    createdAt: Date;
    lead: {
      id: string;
      username: string;
      fullName: string | null;
      profileUrl: string;
      category: string | null;
      followers: number | null;
    };
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

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
};

/**
 * Pre-flight validation before executing a campaign.
 */
export async function preflightValidateCampaignExecution(
  campaignId: string,
  userId: string,
  options?: { templateId?: string; rerun?: boolean; requireMessaging?: boolean },
) {
  const prisma = getPrismaClient();

  // 1. Authenticate & verify campaign exists and belongs to user
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
    include: {
      templates: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${campaignId}" was not found.`,
    );
  }

  // 2. Campaign must not be already RUNNING
  if (campaign.status === CampaignStatus.RUNNING) {
    throw new ConflictError(
      "CAMPAIGN_ALREADY_RUNNING",
      "Campaign is already running.",
    );
  }

  // 3. Campaign must not be already COMPLETED unless rerun is explicitly supported
  if (campaign.status === CampaignStatus.COMPLETED && !options?.rerun) {
    throw new BadRequestError(
      "CAMPAIGN_ALREADY_COMPLETED",
      "Campaign is already completed. Explicit rerun is required.",
    );
  }

  // 4. Lead limit validation
  if (campaign.leadLimit !== null && campaign.leadLimit !== undefined) {
    if (campaign.leadLimit < 1 || campaign.leadLimit > 100) {
      throw new BadRequestError(
        "INVALID_LEAD_LIMIT",
        "Lead limit must be between 1 and 100.",
      );
    }
  }

  // 5. Eligible work verification:
  // Must have existing leads OR a discovery intent/query
  const leadCount = await prisma.lead.count({ where: { campaignId: campaign.id } });
  const hasDiscoveryIntent = Boolean(campaign.intent && campaign.intent.trim().length > 0);

  if (leadCount === 0 && !hasDiscoveryIntent) {
    throw new BadRequestError(
      "NO_ELIGIBLE_WORK",
      "Campaign has no leads and no discovery intent configured. Configure a search query or add leads before execution.",
    );
  }

  // 6. Template validation:
  let selectedTemplate: { id: string; name: string; body: string } | null = null;
  if (options?.templateId) {
    const tmpl = await prisma.messageTemplate.findFirst({
      where: {
        id: options.templateId,
        OR: [{ campaignId: campaign.id }, { campaignId: null }],
      },
    });
    if (!tmpl) {
      throw new NotFoundError(
        "TEMPLATE_NOT_FOUND",
        `Message template "${options.templateId}" was not found for this campaign.`,
      );
    }
    selectedTemplate = tmpl;
  } else if (campaign.templates.length > 0) {
    selectedTemplate = campaign.templates[0];
  } else {
    // Check global template
    const globalTmpl = await prisma.messageTemplate.findFirst({
      where: { campaignId: null },
      orderBy: { createdAt: "desc" },
    });
    if (globalTmpl) {
      selectedTemplate = globalTmpl;
    }
  }

  // If messaging is explicitly required or configured, verify template presence
  if (options?.requireMessaging && !selectedTemplate) {
    throw new BadRequestError(
      "MISSING_TEMPLATE",
      "Messaging template is missing. A message template is required to execute messaging.",
    );
  }

  // 7. Messaging session status validation
  const provider = getMessagingProvider();
  const providerStatus = await provider.getStatus();

  if (options?.requireMessaging && !providerStatus.authenticated) {
    throw new BadRequestError(
      "AUTH_REQUIRED",
      "Instagram session requires authentication before messaging can start.",
    );
  }

  return {
    campaign,
    leadCount,
    hasDiscoveryIntent,
    template: selectedTemplate,
    providerStatus,
  };
}

/**
 * Claims or renews an execution worker lease atomically.
 */
export async function claimExecutionLease(
  executionId: string,
  workerId: string,
  leaseMs: number = LEASE_DURATION_MS,
): Promise<boolean> {
  const prisma = getPrismaClient();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);

  const result = await prisma.campaignExecution.updateMany({
    where: {
      id: executionId,
      status: CampaignExecutionStatus.RUNNING,
      OR: [
        { workerId: null },
        { workerId },
        { leaseUntil: { lt: now } },
      ],
    },
    data: {
      workerId,
      heartbeatAt: now,
      leaseUntil,
    },
  });

  return result.count > 0;
}

/**
 * Updates the worker heartbeat on an active execution.
 */
export async function heartbeatExecution(
  executionId: string,
  workerId: string,
  leaseMs: number = LEASE_DURATION_MS,
): Promise<boolean> {
  const prisma = getPrismaClient();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);

  const result = await prisma.campaignExecution.updateMany({
    where: {
      id: executionId,
      workerId,
      status: CampaignExecutionStatus.RUNNING,
    },
    data: {
      heartbeatAt: now,
      leaseUntil,
    },
  });

  return result.count > 0;
}

/**
 * Releases worker lease upon worker completion or shutdown.
 */
export async function releaseExecutionLease(
  executionId: string,
  workerId: string,
): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.campaignExecution.updateMany({
    where: { id: executionId, workerId },
    data: {
      workerId: null,
      leaseUntil: null,
    },
  });
}

/**
 * Starts or resumes campaign execution explicitly.
 * Implements pre-flight checks, duplicate start protection, atomic transitions, and worker launch.
 */
export async function startCampaignExecution(
  campaignId: string,
  userId: string,
  options?: { templateId?: string; rerun?: boolean },
): Promise<{ execution: CampaignExecutionStatusResponse; isNew: boolean }> {
  const prisma = getPrismaClient();

  // 1. Duplicate active execution protection (Requirement 17)
  const existingActive = await prisma.campaignExecution.findFirst({
    where: {
      campaignId,
      status: { in: [CampaignExecutionStatus.RUNNING, CampaignExecutionStatus.PAUSED] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingActive) {
    if (existingActive.status === CampaignExecutionStatus.RUNNING) {
      // Already running: return existing execution status
      const statusRes = await getCampaignExecutionStatus(campaignId, userId);
      return { execution: statusRes, isNew: false };
    }

    if (existingActive.status === CampaignExecutionStatus.PAUSED) {
      // Resume paused execution
      await resumeCampaignExecution(campaignId, userId);
      const statusRes = await getCampaignExecutionStatus(campaignId, userId);
      return { execution: statusRes, isNew: false };
    }
  }

  // 2. Pre-flight validation
  const preflight = await preflightValidateCampaignExecution(campaignId, userId, options);

  // 3. Determine initial phase:
  // If leads already exist (e.g. >= leadLimit), skip discovery
  const leadLimit = preflight.campaign.leadLimit ?? 50;
  const initialPhase =
    preflight.leadCount > 0 && preflight.leadCount >= leadLimit
      ? CampaignExecutionPhase.READY
      : preflight.hasDiscoveryIntent
      ? CampaignExecutionPhase.DISCOVERY
      : CampaignExecutionPhase.READY;

  // 4. Validate transition
  validateCampaignStateTransition(preflight.campaign.status, CampaignStatus.RUNNING, options?.rerun);

  // 5. Create or reuse execution record atomically
  const execution = await prisma.$transaction(async (tx) => {
    const exec = await tx.campaignExecution.create({
      data: {
        campaignId,
        userId,
        status: CampaignExecutionStatus.RUNNING,
        phase: initialPhase,
        startedAt: new Date(),
        totalItems: preflight.leadCount,
        processedItems: 0,
        successfulItems: 0,
        failedItems: 0,
      },
    });

    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        status: CampaignStatus.RUNNING,
      },
    });

    return exec;
  });

  // 6. Launch background worker loop
  const workerId = `worker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  void runExecutionWorkerLoop(execution.id, workerId, preflight.template?.id).catch((err) => {
    logger.error("WORKER_ERROR", err, { executionId: execution.id, operation: "campaign_execution_worker" });
  });

  const statusResponse = await getCampaignExecutionStatus(campaignId, userId);
  return { execution: statusResponse, isNew: true };
}

/**
 * Pauses campaign execution safely. Survives refresh and restart.
 */
export async function pauseCampaignExecution(
  campaignId: string,
  userId: string,
): Promise<{ executionId: string; status: CampaignExecutionStatus; pausedAt: Date }> {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign with ID "${campaignId}" was not found.`);
  }

  if (campaign.status !== CampaignStatus.RUNNING) {
    throw new BadRequestError(
      "CANNOT_PAUSE",
      `Cannot pause campaign in "${campaign.status}" status. Only RUNNING campaigns can be paused.`,
    );
  }

  const execution = await prisma.campaignExecution.findFirst({
    where: { campaignId, status: CampaignExecutionStatus.RUNNING },
    orderBy: { createdAt: "desc" },
  });

  if (!execution) {
    throw new NotFoundError(
      "EXECUTION_NOT_FOUND",
      "No running execution found for this campaign.",
    );
  }

  const pausedAt = new Date();
  await withWriteConflictRetry(() =>
    prisma.$transaction([
      prisma.campaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.PAUSED },
      }),
      prisma.campaignExecution.update({
        where: { id: execution.id },
        data: {
          status: CampaignExecutionStatus.PAUSED,
          pausedAt,
          workerId: null,
          leaseUntil: null,
        },
      }),
    ]),
  );

  // Pause underlying BulkMessageJob if running
  if (execution.bulkMessageJobId) {
    try {
      await pauseBulkMessageJob(execution.bulkMessageJobId, userId);
    } catch {
      // Ignore if already paused or completed
    }
  }

  return { executionId: execution.id, status: CampaignExecutionStatus.PAUSED, pausedAt };
}

/**
 * Resumes paused campaign execution from persisted state. Never restarts completed work.
 */
export async function resumeCampaignExecution(
  campaignId: string,
  userId: string,
): Promise<{ executionId: string; status: CampaignExecutionStatus }> {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign with ID "${campaignId}" was not found.`);
  }

  if (campaign.status !== CampaignStatus.PAUSED) {
    throw new BadRequestError(
      "CANNOT_RESUME",
      `Cannot resume campaign in "${campaign.status}" status. Only PAUSED campaigns can be resumed.`,
    );
  }

  const execution = await prisma.campaignExecution.findFirst({
    where: { campaignId, status: CampaignExecutionStatus.PAUSED },
    orderBy: { createdAt: "desc" },
  });

  if (!execution) {
    throw new NotFoundError(
      "EXECUTION_NOT_FOUND",
      "No paused execution found for this campaign.",
    );
  }

  // Pre-flight check: ensure messaging session is authenticated if in messaging phase
  if (execution.phase === CampaignExecutionPhase.MESSAGING) {
    const provider = getMessagingProvider();
    const providerStatus = await provider.getStatus();
    if (!providerStatus.authenticated) {
      throw new BadRequestError(
        "AUTH_REQUIRED",
        "Instagram session requires authentication before resuming messaging.",
      );
    }
  }

  await withWriteConflictRetry(() =>
    prisma.$transaction([
      prisma.campaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.RUNNING },
      }),
      prisma.campaignExecution.update({
        where: { id: execution.id },
        data: {
          status: CampaignExecutionStatus.RUNNING,
          pausedAt: null,
          errorMessage: null,
          errorCode: null,
        },
      }),
    ]),
  );

  // Resume underlying BulkMessageJob if it was paused
  if (execution.bulkMessageJobId) {
    try {
      await resumeBulkMessageJob(execution.bulkMessageJobId, userId);
    } catch {
      // Ignore if cannot resume
    }
  }

  // Launch worker to continue execution from persisted state
  const workerId = `worker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  void runExecutionWorkerLoop(execution.id, workerId).catch((err) => {
    logger.error("WORKER_ERROR", err, { executionId: execution.id, operation: "campaign_execution_resume" });
  });

  return { executionId: execution.id, status: CampaignExecutionStatus.RUNNING };
}

/**
 * Cancels campaign execution. Prevents new work; queued work cancelled; sent items remain sent.
 */
export async function cancelCampaignExecution(
  campaignId: string,
  userId: string,
): Promise<{ executionId: string; status: CampaignExecutionStatus; cancelledAt: Date }> {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign with ID "${campaignId}" was not found.`);
  }

  const execution = await prisma.campaignExecution.findFirst({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
  });

  if (!execution) {
    throw new BadRequestError(
      "CANNOT_CANCEL",
      `Cannot cancel campaign in "${campaign.status}" status without an active or paused execution.`,
    );
  }

  const cancelledAt = new Date();
  await withWriteConflictRetry(() =>
    prisma.$transaction([
      prisma.campaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.CANCELLED },
      }),
      prisma.campaignExecution.update({
        where: { id: execution.id },
        data: {
          status: CampaignExecutionStatus.CANCELLED,
          cancelledAt,
          workerId: null,
          leaseUntil: null,
        },
      }),
    ]),
  );

  // Cancel underlying BulkMessageJob if present
  if (execution.bulkMessageJobId) {
    try {
      await cancelBulkMessageJob(execution.bulkMessageJobId, userId);
    } catch {
      // Ignore if already cancelled or completed
    }
  }

  return { executionId: execution.id, status: CampaignExecutionStatus.CANCELLED, cancelledAt };
}

/**
 * Orchestrator worker loop. Advances execution through phases:
 * DISCOVERY -> ENRICHMENT -> READY -> MESSAGING -> FINALIZING -> COMPLETED/PARTIAL/FAILED.
 */
export async function runExecutionWorkerLoop(
  executionId: string,
  workerId: string,
  templateId?: string,
): Promise<void> {
  if (activeExecutionWorkers.has(executionId)) {
    return;
  }
  activeExecutionWorkers.add(executionId);

  const prisma = getPrismaClient();

  try {
    // 1. Claim initial worker lease
    const claimed = await claimExecutionLease(executionId, workerId);
    if (!claimed) {
      return;
    }

    // Load initial execution & campaign details
    let execution = await prisma.campaignExecution.findUnique({
      where: { id: executionId },
      include: { campaign: true },
    });

    if (!execution || execution.status !== CampaignExecutionStatus.RUNNING) {
      return;
    }

    const campaign = execution.campaign;

    // --- PHASE 1: DISCOVERY ---
    if (execution.phase === CampaignExecutionPhase.DISCOVERY) {
      await heartbeatExecution(executionId, workerId);

      const existingLeadCount = await prisma.lead.count({ where: { campaignId: campaign.id } });
      const targetLimit = campaign.leadLimit || 50;

      if (existingLeadCount >= targetLimit || !campaign.intent) {
        // Skip discovery if campaign already has sufficient leads or no discovery query
        await prisma.campaignExecution.update({
          where: { id: executionId },
          data: { phase: CampaignExecutionPhase.ENRICHMENT },
        });
        execution.phase = CampaignExecutionPhase.ENRICHMENT;
      } else {
        try {
          const discoveryResult = await runDiscovery(
            {
              campaignId: campaign.id,
              query: campaign.intent,
              location: campaign.location,
              category: campaign.category,
              maxLeads: targetLimit,
            },
            campaign.userId,
          );

          await prisma.campaignExecution.update({
            where: { id: executionId },
            data: {
              scrapeJobId: discoveryResult.scrapeJobId,
              phase: CampaignExecutionPhase.ENRICHMENT,
            },
          });
          execution.phase = CampaignExecutionPhase.ENRICHMENT;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await prisma.$transaction([
            prisma.campaignExecution.update({
              where: { id: executionId },
              data: {
                status: CampaignExecutionStatus.FAILED,
                errorCode: "DISCOVERY_ERROR",
                errorMessage: `Discovery failed: ${msg.slice(0, 500)}`,
                completedAt: new Date(),
                workerId: null,
                leaseUntil: null,
              },
            }),
            prisma.campaign.update({
              where: { id: campaign.id },
              data: { status: CampaignStatus.FAILED },
            }),
          ]);

          const upper = msg.toUpperCase();
          if (
            upper.includes("QUOTA") ||
            upper.includes("AUTH_FAILED") ||
            upper.includes("AUTHENTICATION_FAILED")
          ) {
            await notifySystemError({
              userId: campaign.userId,
              provider: "Scraper",
              errorType: upper.includes("AUTH") ? "AUTH_FAILED" : "QUOTA_EXHAUSTED",
              details: msg.slice(0, 200),
            }).catch(() => undefined);
          }

          return;
        }
      }
    }

    // Refresh execution status
    execution = await prisma.campaignExecution.findUnique({
      where: { id: executionId },
      include: { campaign: true },
    });
    if (!execution || execution.status !== CampaignExecutionStatus.RUNNING) return;

    // --- PHASE 2: ENRICHMENT ---
    if (execution.phase === CampaignExecutionPhase.ENRICHMENT) {
      await heartbeatExecution(executionId, workerId);

      // Discovery handles enrichment up to leadLimit; advance to READY
      await prisma.campaignExecution.update({
        where: { id: executionId },
        data: { phase: CampaignExecutionPhase.READY },
      });
      execution.phase = CampaignExecutionPhase.READY;
    }

    // Refresh execution status
    execution = await prisma.campaignExecution.findUnique({
      where: { id: executionId },
      include: { campaign: true },
    });
    if (!execution || execution.status !== CampaignExecutionStatus.RUNNING) return;

    // --- PHASE 3: READY ---
    if (execution.phase === CampaignExecutionPhase.READY) {
      await heartbeatExecution(executionId, workerId);

      // Resolve template
      let effectiveTemplateId = templateId;
      if (!effectiveTemplateId) {
        const tmpl = await prisma.messageTemplate.findFirst({
          where: { OR: [{ campaignId: campaign.id }, { campaignId: null }] },
          orderBy: { createdAt: "desc" },
        });
        effectiveTemplateId = tmpl?.id;
      }

      // Check if template exists
      if (!effectiveTemplateId) {
        // No template configured: discovery-only campaign finishes as COMPLETED
        await finalizeExecution(executionId, CampaignExecutionStatus.COMPLETED);
        return;
      }

      // Check provider authentication
      const provider = getMessagingProvider();
      const providerStatus = await provider.getStatus();
      if (!providerStatus.authenticated) {
        // Pause execution safely if session requires attention
        await prisma.$transaction([
          prisma.campaignExecution.update({
            where: { id: executionId },
            data: {
              status: CampaignExecutionStatus.PAUSED,
              pausedAt: new Date(),
              errorCode: "AUTH_REQUIRED",
              errorMessage: "Instagram session requires authentication.",
              workerId: null,
              leaseUntil: null,
            },
          }),
          prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: CampaignStatus.PAUSED },
          }),
        ]);
        return;
      }

      // Create or locate BulkMessageJob
      let bulkJobId = execution.bulkMessageJobId;
      if (!bulkJobId) {
        try {
          const bulkJobCreation = await createBulkMessageJob(
            campaign.id,
            { templateId: effectiveTemplateId, selection: "allEligible" },
            campaign.userId,
          );
          bulkJobId = bulkJobCreation.job.id;
          await prisma.campaignExecution.update({
            where: { id: executionId },
            data: {
              bulkMessageJobId: bulkJobId,
              totalItems: bulkJobCreation.job.total,
              phase: CampaignExecutionPhase.MESSAGING,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // If NO_LEADS_FOUND or no eligible leads, finalize
          if (msg.includes("No leads") || msg.includes("NO_LEADS_FOUND")) {
            await finalizeExecution(executionId, CampaignExecutionStatus.COMPLETED);
            return;
          }
          throw err;
        }
      } else {
        await prisma.campaignExecution.update({
          where: { id: executionId },
          data: { phase: CampaignExecutionPhase.MESSAGING },
        });
      }
      execution.phase = CampaignExecutionPhase.MESSAGING;
    }

    // Refresh execution status
    execution = await prisma.campaignExecution.findUnique({
      where: { id: executionId },
      include: { campaign: true },
    });
    if (!execution || execution.status !== CampaignExecutionStatus.RUNNING) return;

    // --- PHASE 4: MESSAGING ---
    if (execution.phase === CampaignExecutionPhase.MESSAGING && execution.bulkMessageJobId) {
      await heartbeatExecution(executionId, workerId);

      // Execute bulk message job queue using Task 6/7 worker
      await dispatchBulkJobQueue(execution.bulkMessageJobId);

      // Re-read job state
      const bulkJob = await prisma.bulkMessageJob.findUnique({
        where: { id: execution.bulkMessageJobId },
      });

      // Check if bulk job was paused due to platform safety restrictions
      if (bulkJob?.status === BulkMessageJobStatus.PAUSED) {
        await prisma.$transaction([
          prisma.campaignExecution.update({
            where: { id: executionId },
            data: {
              status: CampaignExecutionStatus.PAUSED,
              pausedAt: new Date(),
              errorCode: "PLATFORM_BLOCKED",
              errorMessage: bulkJob.errorMessage || "Job paused due to platform restriction.",
              workerId: null,
              leaseUntil: null,
            },
          }),
          prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: CampaignStatus.PAUSED },
          }),
        ]);
        return;
      }

      // Check if campaign was cancelled during sending
      const currentExec = await prisma.campaignExecution.findUnique({
        where: { id: executionId },
      });
      if (currentExec?.status === CampaignExecutionStatus.CANCELLED) {
        return;
      }

      await prisma.campaignExecution.update({
        where: { id: executionId },
        data: { phase: CampaignExecutionPhase.FINALIZING },
      });
    }

    // --- PHASE 5: FINALIZING ---
    await finalizeExecution(executionId);
  } finally {
    activeExecutionWorkers.delete(executionId);
    await releaseExecutionLease(executionId, workerId);
  }
}

/**
 * Computes authoritative terminal state from persisted database records.
 */
async function finalizeExecution(
  executionId: string,
  overrideStatus?: CampaignExecutionStatus,
): Promise<void> {
  const prisma = getPrismaClient();
  const execution = await prisma.campaignExecution.findUnique({
    where: { id: executionId },
    include: { campaign: true },
  });

  if (!execution) return;

  let finalStatus = overrideStatus;

  if (!finalStatus) {
    if (execution.bulkMessageJobId) {
      const [sentCount, failedCount, unknownCount, totalCount] = await Promise.all([
        prisma.bulkMessageItem.count({ where: { jobId: execution.bulkMessageJobId, status: BulkMessageItemStatus.SENT } }),
        prisma.bulkMessageItem.count({ where: { jobId: execution.bulkMessageJobId, status: BulkMessageItemStatus.FAILED } }),
        prisma.bulkMessageItem.count({ where: { jobId: execution.bulkMessageJobId, status: BulkMessageItemStatus.UNKNOWN } }),
        prisma.bulkMessageItem.count({ where: { jobId: execution.bulkMessageJobId } }),
      ]);

      if (sentCount > 0 && failedCount === 0 && unknownCount === 0) {
        finalStatus = CampaignExecutionStatus.COMPLETED;
      } else if (sentCount > 0) {
        finalStatus = CampaignExecutionStatus.PARTIAL;
      } else if (failedCount > 0 || unknownCount > 0) {
        finalStatus = CampaignExecutionStatus.FAILED;
      } else if (totalCount === 0) {
        finalStatus = CampaignExecutionStatus.COMPLETED;
      } else {
        finalStatus = CampaignExecutionStatus.COMPLETED;
      }
    } else {
      finalStatus = CampaignExecutionStatus.COMPLETED;
    }
  }

  const campaignStatus =
    finalStatus === CampaignExecutionStatus.COMPLETED
      ? CampaignStatus.COMPLETED
      : finalStatus === CampaignExecutionStatus.PARTIAL
      ? CampaignStatus.PARTIAL
      : finalStatus === CampaignExecutionStatus.FAILED
      ? CampaignStatus.FAILED
      : finalStatus === CampaignExecutionStatus.CANCELLED
      ? CampaignStatus.CANCELLED
      : CampaignStatus.COMPLETED;

  // Only finalize while the execution is still RUNNING. If the user cancelled
  // (or paused) it concurrently, never overwrite that terminal status.
  await withWriteConflictRetry(async () => {
    const finalized = await prisma.campaignExecution.updateMany({
      where: { id: executionId, status: CampaignExecutionStatus.RUNNING },
      data: {
        status: finalStatus,
        phase: CampaignExecutionPhase.FINALIZING,
        completedAt: new Date(),
        workerId: null,
        leaseUntil: null,
      },
    });
    if (finalized.count > 0) {
      await prisma.campaign.update({
        where: { id: execution.campaignId },
        data: { status: campaignStatus },
      });
    }
  });
}

/**
 * Crash recovery mechanism: detects stale worker leases and recovers safe executions.
 */
export async function recoverStaleCampaignExecutions(
  staleThresholdMs: number = 2 * 60 * 1000,
  userId?: string,
): Promise<{ count: number; recovered: Array<{ executionId: string; resolution: string }> }> {
  const prisma = getPrismaClient();
  const now = new Date();
  const thresholdDate = new Date(Date.now() - staleThresholdMs);

  const staleExecutions = await prisma.campaignExecution.findMany({
    where: {
      status: CampaignExecutionStatus.RUNNING,
      // Tenant isolation: only recover executions owned by the caller.
      ...(userId ? { campaign: { userId } } : {}),
      OR: [
        { leaseUntil: { lte: now } },
        { heartbeatAt: { lte: thresholdDate } },
      ],
    },
    include: {
      bulkMessageJob: true,
      scrapeJob: true,
    },
  });

  const recovered: Array<{ executionId: string; resolution: string }> = [];

  for (const execution of staleExecutions) {
    if (execution.bulkMessageJobId) {
      await recoverStaleProcessingItems(execution.bulkMessageJobId, staleThresholdMs);
    }

    const bulkJob = execution.bulkMessageJobId
      ? await prisma.bulkMessageJob.findUnique({ where: { id: execution.bulkMessageJobId } })
      : null;

    if (
      bulkJob &&
      (bulkJob.status === BulkMessageJobStatus.COMPLETED ||
        bulkJob.status === BulkMessageJobStatus.PARTIAL ||
        bulkJob.status === BulkMessageJobStatus.FAILED)
    ) {
      const finalStatus =
        bulkJob.status === BulkMessageJobStatus.COMPLETED
          ? CampaignExecutionStatus.COMPLETED
          : bulkJob.status === BulkMessageJobStatus.PARTIAL
          ? CampaignExecutionStatus.PARTIAL
          : CampaignExecutionStatus.FAILED;

      await prisma.$transaction([
        prisma.campaignExecution.update({
          where: { id: execution.id },
          data: {
            status: finalStatus,
            phase: CampaignExecutionPhase.FINALIZING,
            completedAt: new Date(),
            workerId: null,
            leaseUntil: null,
          },
        }),
        prisma.campaign.update({
          where: { id: execution.campaignId },
          data: {
            status:
              finalStatus === CampaignExecutionStatus.COMPLETED
                ? CampaignStatus.COMPLETED
                : finalStatus === CampaignExecutionStatus.PARTIAL
                ? CampaignStatus.PARTIAL
                : CampaignStatus.FAILED,
          },
        }),
      ]);
      recovered.push({ executionId: execution.id, resolution: `Finalized as ${finalStatus}` });
    } else {
      // Pause execution safely so user can explicitly resume
      await prisma.$transaction([
        prisma.campaignExecution.update({
          where: { id: execution.id },
          data: {
            status: CampaignExecutionStatus.PAUSED,
            pausedAt: new Date(),
            errorMessage: "Execution paused automatically after worker heartbeat expired.",
            workerId: null,
            leaseUntil: null,
          },
        }),
        prisma.campaign.update({
          where: { id: execution.campaignId },
          data: { status: CampaignStatus.PAUSED },
        }),
      ]);
      recovered.push({ executionId: execution.id, resolution: "Paused stale execution" });
    }
  }

  return { count: recovered.length, recovered };
}

/**
 * Returns authoritative execution status derived directly from persisted database records.
 */
export async function getCampaignExecutionStatus(
  campaignId: string,
  userId?: string,
): Promise<CampaignExecutionStatusResponse> {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    include: {
      executions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          scrapeJob: true,
          bulkMessageJob: true,
        },
      },
    },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${campaignId}" was not found.`,
    );
  }

  const latestExecution = campaign.executions[0] ?? null;
  const totalLeads = await prisma.lead.count({ where: { campaignId } });

  // Discovery progress from ScrapeJob
  let discoveryProgress: CampaignExecutionStatusResponse["discoveryProgress"] = null;
  const scrapeJob = latestExecution?.scrapeJob;
  if (scrapeJob) {
    discoveryProgress = {
      candidatesDiscovered: scrapeJob.candidatesDiscovered ?? 0,
      candidatesEnriched: scrapeJob.candidatesEnriched ?? 0,
      candidatesSkipped: scrapeJob.candidatesSkipped ?? 0,
      persisted: scrapeJob.processedCount,
    };
  }

  // Messaging progress from BulkMessageJob / BulkMessageItem
  let messagingProgress: CampaignExecutionStatusResponse["messagingProgress"] = null;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let unknown = 0;
  let queued = 0;
  let processing = 0;
  let eligibleLeads = totalLeads;

  if (latestExecution?.bulkMessageJobId) {
    const counts = await prisma.bulkMessageItem.groupBy({
      by: ["status"],
      where: { jobId: latestExecution.bulkMessageJobId },
      _count: { _all: true },
    });

    const countByStatus = (status: BulkMessageItemStatus): number =>
      counts.find((row) => row.status === status)?._count._all ?? 0;

    sent = countByStatus(BulkMessageItemStatus.SENT);
    failed = countByStatus(BulkMessageItemStatus.FAILED);
    skipped = countByStatus(BulkMessageItemStatus.SKIPPED);
    unknown = countByStatus(BulkMessageItemStatus.UNKNOWN);
    queued = countByStatus(BulkMessageItemStatus.QUEUED);
    processing = countByStatus(BulkMessageItemStatus.PROCESSING);

    const total = latestExecution.bulkMessageJob?.total ?? (sent + failed + skipped + unknown + queued + processing);
    eligibleLeads = total;
    const processed = sent + failed + skipped + unknown;
    const progress = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

    messagingProgress = {
      total,
      sent,
      failed,
      skipped,
      unknown,
      queued,
      processing,
      progress,
    };
  }

  // Calculate lead capacity
  const leadLimit = campaign.leadLimit ?? null;
  const remainingCapacity = leadLimit != null ? Math.max(0, leadLimit - totalLeads) : null;
  const leadCapacity = {
    leadLimit,
    currentLeads: totalLeads,
    remainingCapacity,
  };

  // Discovery details
  const targetLimit = campaign.leadLimit ?? 50;
  const isDiscoverySkipped = Boolean(
    latestExecution &&
      !latestExecution.scrapeJobId &&
      latestExecution.phase !== CampaignExecutionPhase.DISCOVERY
  );
  const discoveryDetails: CampaignExecutionStatusResponse["discoveryDetails"] = {
    query: scrapeJob?.query ?? campaign.intent ?? null,
    location: scrapeJob?.location ?? campaign.location ?? null,
    category: scrapeJob?.category ?? campaign.category ?? null,
    targetLimit,
    candidatesFound: scrapeJob?.candidatesDiscovered ?? 0,
    enriched: scrapeJob?.candidatesEnriched ?? 0,
    saved: scrapeJob?.processedCount ?? 0,
    skipped: scrapeJob?.candidatesSkipped ?? 0,
    discoverySkipped: isDiscoverySkipped,
    skippedReason: isDiscoverySkipped ? "Existing campaign leads met target capacity" : null,
  };

  // Calculate deterministic overall progress (0-100)
  let overallProgress = 0;
  if (campaign.status === CampaignStatus.COMPLETED || latestExecution?.status === CampaignExecutionStatus.COMPLETED) {
    overallProgress = 100;
  } else if (messagingProgress && messagingProgress.total > 0) {
    overallProgress = messagingProgress.progress;
  } else if (latestExecution?.phase === CampaignExecutionPhase.FINALIZING) {
    overallProgress = 95;
  } else if (latestExecution?.phase === CampaignExecutionPhase.READY) {
    overallProgress = isDiscoverySkipped || totalLeads > 0 ? 50 : 25;
  } else if (
    latestExecution?.phase === CampaignExecutionPhase.ENRICHMENT ||
    latestExecution?.phase === CampaignExecutionPhase.DISCOVERY
  ) {
    const enriched = discoveryProgress?.candidatesEnriched ?? 0;
    overallProgress = targetLimit > 0 ? Math.min(50, Math.round((enriched / targetLimit) * 50)) : 20;
  } else if (campaign.status === CampaignStatus.READY) {
    overallProgress = 10;
  }
  overallProgress = Math.max(0, Math.min(100, Math.round(overallProgress)));

  // Elapsed seconds calculation
  let elapsedSeconds: number | null = null;
  if (latestExecution?.startedAt) {
    const endTime =
      latestExecution.completedAt ??
      latestExecution.cancelledAt ??
      latestExecution.pausedAt ??
      new Date();
    elapsedSeconds = Math.max(0, Math.floor((endTime.getTime() - latestExecution.startedAt.getTime()) / 1000));
  }

  return {
    campaignId: campaign.id,
    executionId: latestExecution?.id ?? null,
    campaignStatus: campaign.status,
    executionStatus: latestExecution?.status ?? null,
    currentPhase: latestExecution?.phase ?? null,
    totalLeads,
    eligibleLeads,
    overallProgress,
    leadCapacity,
    discoveryDetails,
    discoveryProgress,
    messagingProgress,
    sent,
    failed,
    skipped,
    unknown,
    queued,
    timestamps: {
      startedAt: latestExecution?.startedAt?.toISOString() ?? null,
      pausedAt: latestExecution?.pausedAt?.toISOString() ?? null,
      completedAt: latestExecution?.completedAt?.toISOString() ?? null,
      cancelledAt: latestExecution?.cancelledAt?.toISOString() ?? null,
      updatedAt: latestExecution?.updatedAt?.toISOString() ?? null,
      elapsedSeconds,
    },
    safeError:
      latestExecution?.errorMessage || latestExecution?.errorCode
        ? {
            errorCode: latestExecution.errorCode,
            errorMessage: latestExecution.errorMessage,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Legacy / compatibility helpers
// ---------------------------------------------------------------------------

export async function createExecutionPreview(
  campaignId: string,
  input?: unknown,
  userId?: string,
): Promise<ExecutionPreviewResponse> {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${campaignId}" was not found.`,
    );
  }

  let templateId: string | undefined;
  let requestedMode: ExecutionMode | undefined;
  let requestedLeadIds: string[] | undefined;

  if (input !== undefined && input !== null && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.templateId === "string" && record.templateId.trim()) {
      templateId = record.templateId.trim();
    }
    if (record.executionMode === ExecutionMode.MANUAL || record.executionMode === ExecutionMode.REVIEW_REQUIRED) {
      requestedMode = record.executionMode as ExecutionMode;
    }
    if (Array.isArray(record.leadIds)) {
      requestedLeadIds = record.leadIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    }
  }

  let selectedTemplate: { id: string; name: string; body: string } | null = null;
  if (templateId) {
    selectedTemplate = await prisma.messageTemplate.findFirst({
      where: { id: templateId, OR: [{ campaignId: campaign.id }, { campaignId: null }] },
      select: { id: true, name: true, body: true },
    });
  } else {
    selectedTemplate = await prisma.messageTemplate.findFirst({
      where: { OR: [{ campaignId: campaign.id }, { campaignId: null }] },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, body: true },
    });
  }

  if (!selectedTemplate || selectedTemplate.body.trim().length === 0) {
    throw new BadRequestError(
      "MISSING_TEMPLATE",
      "No valid message template found.",
    );
  }

  const leads = await prisma.lead.findMany({
    where: {
      campaignId: campaign.id,
      ...(requestedLeadIds ? { id: { in: requestedLeadIds } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  const eligibleLeads = leads.filter((l) => (l.profileUrl?.trim() || "").startsWith("http"));
  const nonUrlSkipped = leads.length - eligibleLeads.length;

  // Enforce DNC suppression on eligible leads
  const suppressionMap = await checkManySuppression({
    userId: campaign.userId,
    leads: eligibleLeads,
    channel: DncChannel.INSTAGRAM,
  });

  const activeLeads: typeof eligibleLeads = [];
  const suppressedLeadIds: string[] = [];

  for (const lead of eligibleLeads) {
    if (suppressionMap.get(lead.id)?.suppressed) {
      suppressedLeadIds.push(lead.id);
    } else {
      activeLeads.push(lead);
    }
  }

  const preparedItems = activeLeads.map((lead) => ({
    leadId: lead.id,
    username: lead.username,
    messageText: renderTemplate(selectedTemplate.body, { username: lead.username, fullName: lead.fullName }, campaign.name),
  }));

  const result = await prisma.$transaction(async (tx) => {
    const execution = await tx.campaignExecution.create({
      data: {
        campaignId: campaign.id,
        userId,
        status: CampaignExecutionStatus.PREVIEW,
        phase: CampaignExecutionPhase.READY,
        executionMode: requestedMode || campaign.executionMode,
        totalItems: preparedItems.length,
      },
    });

    if (preparedItems.length > 0) {
      await tx.campaignExecutionItem.createMany({
        data: preparedItems.map((item) => ({
          executionId: execution.id,
          leadId: item.leadId,
          status: ExecutionItemStatus.PENDING,
          messageText: item.messageText,
        })),
      });
    }

    const createdItems = await tx.campaignExecutionItem.findMany({
      where: { executionId: execution.id },
      include: { lead: { select: { username: true } } },
      orderBy: { createdAt: "asc" },
    });

    return { execution, items: createdItems };
  });

  return {
    campaignId: campaign.id,
    executionId: result.execution.id,
    status: result.execution.status,
    mode: result.execution.executionMode,
    totalEligibleLeads: eligibleLeads.length,
    planned: preparedItems.length,
    skipped: nonUrlSkipped + suppressedLeadIds.length,
    suppressedCount: suppressedLeadIds.length,
    suppressedLeadIds: suppressedLeadIds.slice(0, 10),
    items: result.items.map((it) => ({
      id: it.id,
      leadId: it.leadId,
      username: it.lead.username,
      messagePreview: it.messageText,
      status: it.status,
    })),
  };
}

export async function getExecutionById(
  executionId: string,
  searchParams?: URLSearchParams,
  userId?: string,
): Promise<ExecutionDetailResponse> {
  const prisma = getPrismaClient();

  const execution = await prisma.campaignExecution.findFirst({
    where: {
      id: executionId,
      ...(userId ? { campaign: { userId } } : {}),
    },
    include: { campaign: { select: { id: true, name: true } } },
  });

  if (!execution) {
    throw new NotFoundError("EXECUTION_NOT_FOUND", `Campaign execution with ID "${executionId}" was not found.`);
  }

  const rawPage = parseInt(searchParams?.get("page") || "1", 10);
  const rawLimit = parseInt(searchParams?.get("limit") || "25", 10);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 100 ? rawLimit : 25;

  const [total, items, statusCounts] = await Promise.all([
    prisma.campaignExecutionItem.count({ where: { executionId } }),
    prisma.campaignExecutionItem.findMany({
      where: { executionId },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "asc" },
      include: {
        lead: {
          select: {
            id: true,
            username: true,
            fullName: true,
            profileUrl: true,
            category: true,
            followers: true,
          },
        },
      },
    }),
    prisma.campaignExecutionItem.groupBy({
      by: ["status"],
      where: { executionId },
      _count: { _all: true },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const countByStatus = (status: ExecutionItemStatus): number =>
    statusCounts.find((row) => row.status === status)?._count._all ?? 0;

  return {
    id: execution.id,
    campaignId: execution.campaignId,
    campaignName: execution.campaign.name,
    status: execution.status,
    executionMode: execution.executionMode,
    totalItems: execution.totalItems,
    processedItems: execution.processedItems,
    successfulItems: execution.successfulItems,
    failedItems: execution.failedItems,
    pendingItems: countByStatus(ExecutionItemStatus.PENDING),
    approvedItems: countByStatus(ExecutionItemStatus.APPROVED),
    skippedItems: countByStatus(ExecutionItemStatus.SKIPPED),
    suppressedItems: countByStatus(ExecutionItemStatus.SUPPRESSED_DNC),
    errorMessage: execution.errorMessage,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    items,
    pagination: { page, limit, total, totalPages },
  };
}

export async function approveExecutionItem(
  executionId: string,
  itemId: string,
  input?: unknown,
  userId?: string,
) {
  const prisma = getPrismaClient();
  const execution = await prisma.campaignExecution.findFirst({
    where: { id: executionId, ...(userId ? { campaign: { userId } } : {}) },
    select: { id: true, campaign: { select: { userId: true } } },
  });

  if (!execution) {
    throw new NotFoundError("EXECUTION_NOT_FOUND", `Campaign execution "${executionId}" was not found.`);
  }

  const item = await prisma.campaignExecutionItem.findFirst({
    where: { id: itemId, executionId },
    include: { lead: true },
  });

  if (!item) {
    throw new NotFoundError("ITEM_NOT_FOUND", `Execution item "${itemId}" not found.`);
  }

  // Pre-approval suppression check
  const suppression = await checkLeadSuppression({
    userId: execution.campaign.userId,
    lead: item.lead,
    channel: DncChannel.INSTAGRAM,
  });

  if (suppression.suppressed) {
    throw new BadRequestError("LEAD_SUPPRESSED", "Cannot approve message for a suppressed lead.");
  }

  let updatedMessage: string | undefined;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.messageText === "string" && record.messageText.trim().length > 0) {
      updatedMessage = record.messageText.trim();
    }
  }

  return prisma.campaignExecutionItem.update({
    where: { id: itemId },
    data: {
      status: ExecutionItemStatus.APPROVED,
      ...(updatedMessage ? { messageText: updatedMessage } : {}),
    },
    select: { id: true, executionId: true, leadId: true, status: true, messageText: true, updatedAt: true },
  });
}

export async function skipExecutionItem(
  executionId: string,
  itemId: string,
  userId?: string,
) {
  const prisma = getPrismaClient();
  const execution = await prisma.campaignExecution.findFirst({
    where: { id: executionId, ...(userId ? { campaign: { userId } } : {}) },
    select: { id: true },
  });

  if (!execution) {
    throw new NotFoundError("EXECUTION_NOT_FOUND", `Campaign execution "${executionId}" was not found.`);
  }

  return prisma.campaignExecutionItem.update({
    where: { id: itemId },
    data: { status: ExecutionItemStatus.SKIPPED },
    select: { id: true, executionId: true, leadId: true, status: true, messageText: true, updatedAt: true },
  });
}

export async function cancelExecution(
  executionId: string,
  userId?: string,
) {
  const prisma = getPrismaClient();
  const execution = await prisma.campaignExecution.findFirst({
    where: { id: executionId, ...(userId ? { campaign: { userId } } : {}) },
  });

  if (!execution) {
    throw new NotFoundError("EXECUTION_NOT_FOUND", `Campaign execution "${executionId}" was not found.`);
  }

  const updated = await prisma.campaignExecution.update({
    where: { id: executionId },
    data: { status: CampaignExecutionStatus.CANCELLED, cancelledAt: new Date() },
    select: { id: true, status: true },
  });

  return { id: updated.id, status: updated.status, cancelled: true as const };
}

export async function dispatchExecution(
  executionId: string,
  userId?: string,
) {
  const prisma = getPrismaClient();
  const execution = await prisma.campaignExecution.findFirst({
    where: { id: executionId, ...(userId ? { campaign: { userId } } : {}) },
    include: {
      campaign: { select: { id: true, userId: true } },
      items: {
        orderBy: { createdAt: "asc" },
        include: { lead: { select: { id: true, username: true, profileUrl: true } } },
      },
    },
  });

  if (!execution) {
    throw new NotFoundError("EXECUTION_NOT_FOUND", `Campaign execution "${executionId}" was not found.`);
  }

  const approvedItems = execution.items.filter((item) => item.status === ExecutionItemStatus.APPROVED);
  if (approvedItems.length === 0) {
    throw new BadRequestError("NO_APPROVED_ITEMS", "Approve at least one message before sending.");
  }

  const provider = getMessagingProvider();
  const providerStatus = await provider.getStatus();

  // Route dispatch through the campaign owner's connected Instagram sender
  // account when one exists. Without a sender the provider's legacy path runs
  // and reports AUTH_REQUIRED (never a false SENT).
  const senderAccount = userId
    ? await findConnectedSenderForDispatch(userId)
    : null;

  await prisma.campaignExecution.update({
    where: { id: execution.id },
    data: { status: CampaignExecutionStatus.RUNNING, startedAt: new Date() },
  });

  let sent = 0;
  let failed = 0;
  let suppressed = 0;
  const results = [];

  for (const item of approvedItems) {
    // Fresh DB dispatch-time suppression check
    const freshLead = await prisma.lead.findUnique({
      where: { id: item.leadId },
    });

    if (freshLead) {
      const suppression = await checkLeadSuppression({
        userId: execution.campaign.userId,
        lead: freshLead,
        channel: DncChannel.INSTAGRAM,
      });

      if (suppression.suppressed) {
        await prisma.campaignExecutionItem.update({
          where: { id: item.id },
          data: {
            status: ExecutionItemStatus.SUPPRESSED_DNC,
            errorMessage: "Suppressed: Lead is in Do Not Contact list.",
            processedAt: new Date(),
          },
        });

        suppressed++;
        results.push({
          id: item.id,
          leadId: item.leadId,
          username: item.lead.username,
          status: ExecutionItemStatus.SUPPRESSED_DNC,
          errorMessage: "Suppressed by DNC",
        });
        continue;
      }
    }

    const dispatch = await provider.sendMessage({
      profileUrl: item.lead.profileUrl,
      message: item.messageText,
      senderAccountId: senderAccount?.id,
    });

    const itemStatus = dispatch.success ? ExecutionItemStatus.SENT : ExecutionItemStatus.FAILED;
    await prisma.campaignExecutionItem.update({
      where: { id: item.id },
      data: { status: itemStatus, processedAt: new Date() },
    });

    if (dispatch.success) sent++;
    else failed++;

    results.push({
      id: item.id,
      leadId: item.leadId,
      username: item.lead.username,
      status: itemStatus,
      errorMessage: dispatch.success ? null : dispatch.error?.message ?? "Failed",
    });
  }

  await prisma.campaignExecution.update({
    where: { id: execution.id },
    data: {
      status: failed === 0 ? CampaignExecutionStatus.COMPLETED : CampaignExecutionStatus.PARTIAL,
      successfulItems: { increment: sent },
      failedItems: { increment: failed },
      completedAt: new Date(),
    },
  });

  return {
    executionId: execution.id,
    campaignId: execution.campaignId,
    status: failed === 0 ? CampaignExecutionStatus.COMPLETED : CampaignExecutionStatus.PARTIAL,
    provider: provider.name,
    providerStatus: providerStatus.status,
    providerAuthenticated: providerStatus.authenticated,
    attempted: approvedItems.length,
    sent,
    failed,
    suppressed,
    remainingApproved: 0,
    errorMessage: null,
    items: results,
  };
}
