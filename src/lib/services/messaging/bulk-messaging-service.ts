import { getPrismaClient } from "@/lib/db/prisma";
import {
  BulkMessageJobStatus,
  BulkMessageItemStatus,
  LeadStatus,
  type Prisma,
} from "@/generated/prisma/client";
import { transitionLeadStatus } from "../lead/lead-status-service";
import { BadRequestError, NotFoundError, DncSuppressedError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  checkLeadSuppression,
  checkManySuppression,
  DncChannel,
} from "../compliance";
import {
  findConnectedSendersForDispatch,
} from "../senders/instagram-sender-service";
import { findSenderAccountOwned } from "../senders/instagram-sender-repository";
import { decideStaleRecovery, isManualRetryAllowed } from "../errors";
import { renderTemplate, validateTemplateVariables } from "../template/template-renderer";
import { sendSingleMessage } from "./messaging-service";
import {
  canSendNow,
  chooseHealthySender,
  getSendGateNow,
} from "./send-gate";
import { extractDomainParts } from "../discovery/name-website-matcher";
import type { SenderAccountRecord } from "../senders/instagram-sender-repository";
import { evaluateDraftDispatch } from "./draft-dispatch-guard";
import {
  calculateContentFingerprint,
  formatScopedIdempotencyKey,
} from "./idempotency";
import { classifyMessagingError } from "./error-classifier";
import { findPreviouslyContactedLeadIds } from "../dedup";
import {
  scheduleFollowUpsForLead,
  dispatchDueFollowUps,
} from "./follow-up-service";

/** Statuses at/after which a person is considered already contacted. */
const DEDUP_CONTACTED_OR_LATER: LeadStatus[] = [
  LeadStatus.CONTACTED,
  LeadStatus.REPLIED,
  LeadStatus.INTERESTED,
  LeadStatus.FOLLOW_UP,
  LeadStatus.MEETING,
  LeadStatus.CONVERTED,
  LeadStatus.NOT_INTERESTED,
];

const RESTRICTION_ERROR_CODES = new Set([
  "AUTH_REQUIRED",
  "SESSION_UNAVAILABLE",
  "RATE_LIMITED",
  "PLATFORM_BLOCKED",
  "CAPTCHA_REQUIRED",
  "ACCOUNT_RESTRICTED",
  "CHALLENGE_DETECTED",
]);

// Map to track active in-process job workers to avoid multiple background loops for the same job
const activeJobWorkers = new Set<string>();

// In-memory cache of last sent timestamp per sender account id to enforce inter-message cooldowns
const senderLastSentTimestampMap = new Map<string, number>();

/**
 * Returns the configured cooldown duration in milliseconds between messages for each sender account.
 * Configurable via SENDER_COOLDOWN_SECONDS or SENDER_COOLDOWN_MINUTES (default: 10 minutes = 600,000ms).
 */
export function getSenderCooldownMs(): number {
  const rawSeconds = process.env.SENDER_COOLDOWN_SECONDS;
  if (rawSeconds && !Number.isNaN(Number(rawSeconds))) {
    return Math.max(0, Number(rawSeconds) * 1000);
  }
  const rawMinutes = process.env.SENDER_COOLDOWN_MINUTES;
  if (rawMinutes && !Number.isNaN(Number(rawMinutes))) {
    return Math.max(0, Number(rawMinutes) * 60 * 1000);
  }
  return 10 * 60 * 1000; // default 10 minutes (600,000 ms)
}

/**
 * Retrieves the timestamp (ms) when a sender account last successfully sent a message.
 * Checks the database lastSentAt first, then in-memory map, falling back to querying the latest SENT MessageAttempt in DB.
 */
export async function getLastSentAtForSender(senderAccountId: string): Promise<number> {
  const prisma = getPrismaClient();

  try {
    const sender = await prisma.instagramSenderAccount.findUnique({
      where: { id: senderAccountId },
      select: { lastSentAt: true },
    });
    if (sender?.lastSentAt) {
      const ts = sender.lastSentAt.getTime();
      senderLastSentTimestampMap.set(senderAccountId, ts);
      return ts;
    }
  } catch {
    // Fallback if table not ready or error
  }

  const cached = senderLastSentTimestampMap.get(senderAccountId);
  if (cached !== undefined) return cached;

  const lastAttempt = await prisma.messageAttempt.findFirst({
    where: { senderAccountId, status: "SENT" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  }).catch(() => null);

  const ts = lastAttempt ? lastAttempt.createdAt.getTime() : 0;
  senderLastSentTimestampMap.set(senderAccountId, ts);
  return ts;
}

/**
 * Updates the recorded sent timestamp for a sender account both in DB and in memory.
 */
export function recordSenderAccountSent(
  senderAccountId: string,
  timestamp: number = getSendGateNow().getTime(),
): void {
  senderLastSentTimestampMap.set(senderAccountId, timestamp);
  const prisma = getPrismaClient();
  prisma.instagramSenderAccount.update({
    where: { id: senderAccountId },
    data: { lastSentAt: new Date(timestamp) },
  }).catch(() => undefined);
}

/**
 * Responsive sleep helper that wakes up early if a job is paused or cancelled.
 */
export async function sleepWithJobCheck(jobId: string, durationMs: number): Promise<boolean> {
  const prisma = getPrismaClient();
  const checkIntervalMs = 1000;
  const endTime = Date.now() + durationMs;

  while (Date.now() < endTime) {
    const sleepTime = Math.min(checkIntervalMs, endTime - Date.now());
    if (sleepTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
    const job = await prisma.bulkMessageJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (
      !job ||
      job.status === BulkMessageJobStatus.PAUSED ||
      job.status === BulkMessageJobStatus.CANCELLED
    ) {
      return false;
    }
  }
  return true;
}

export type BulkMessageJobPreviewInput = {
  templateId?: string;
  leadIds?: string[];
  selection?: "selected" | "allEligible";
  senderAccountId?: string;
  filters?: {
    search?: string;
    category?: string;
    verified?: string;
    isBusinessAccount?: string;
    status?: string;
  };
};

export type BulkJobPreviewResult = {
  campaignId: string;
  templateId: string;
  templateName: string;
  totalSelected: number;
  eligibleCount: number;
  skippedCount: number;
  skippedReasons: Array<{
    leadId: string;
    username: string | null;
    reason: string;
  }>;
  suppressedCount: number;
  suppressedLeadIds: string[];
  /** Step 4 additive counters. */
  duplicateSkipped: number;
  possibleDuplicateSkipped: number;
  previouslyContactedSkipped: number;
  samples: Array<{
    leadId: string;
    username: string | null;
    fullName: string | null;
    renderedMessage: string;
  }>;
};

export type CreateBulkJobInput = {
  templateId: string;
  leadIds?: string[];
  selection?: "selected" | "allEligible";
  senderAccountId?: string;
  filters?: {
    search?: string;
    category?: string;
    verified?: string;
    isBusinessAccount?: string;
    status?: string;
  };
};

export type BulkJobStatusResponse = {
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
  items?: Array<{
    id: string;
    leadId: string;
    username: string | null;
    renderedMessage: string;
    status: BulkMessageItemStatus;
    errorCode: string | null;
    errorMessage: string | null;
    completedAt: string | null;
    attempts?: number;
  }>;
};

/**
 * Resolves the sender account for a bulk job. Client-provided ids are never
 * trusted: they must belong to the owning user and be CONNECTED.
 */
async function resolveBulkSenderAccountId(
  senderAccountId: string | undefined,
  userId: string,
): Promise<string | null> {
  if (
    !senderAccountId ||
    senderAccountId === "round_robin" ||
    senderAccountId === "all" ||
    !senderAccountId.trim()
  ) {
    // Null indicates all active connected sender accounts should rotate in round-robin
    return null;
  }

  const owned = await findSenderAccountOwned(senderAccountId.trim(), userId);
  if (!owned) {
    throw new NotFoundError(
      "SENDER_NOT_FOUND",
      `Instagram sender account "${senderAccountId}" was not found.`,
    );
  }
  if (owned.status !== "CONNECTED") {
    throw new BadRequestError(
      owned.status === "AUTH_REQUIRED" || owned.status === "EXPIRED"
        ? "AUTH_REQUIRED"
        : "SESSION_UNAVAILABLE",
      `Instagram sender @${owned.username} is not connected (status: ${owned.status}).`,
    );
  }
  return owned.id;
}

/**
 * Builds where conditions for leads based on selection and filters.
 */
function buildLeadFilterConditions(
  campaignId: string,
  input: BulkMessageJobPreviewInput,
): Prisma.LeadWhereInput {
  const conditions: Prisma.LeadWhereInput[] = [{ campaignId }];

  // Step 4 dedup: never select duplicate-linked leads. Possible duplicates are
  // excluded only when the referenced lead is already CONTACTED or later.
  conditions.push({ duplicateOfLeadId: null });
  conditions.push({
    OR: [
      { possibleDuplicateOfLeadId: null },
      {
        possibleDuplicateOf: {
          status: { notIn: DEDUP_CONTACTED_OR_LATER as LeadStatus[] },
        },
      },
    ],
  });

  if (input.selection === "allEligible") {
    const f = input.filters;
    if (f?.search && f.search.trim()) {
      const s = f.search.trim();
      conditions.push({
        OR: [
          { username: { contains: s, mode: "insensitive" } },
          { fullName: { contains: s, mode: "insensitive" } },
          { biography: { contains: s, mode: "insensitive" } },
        ],
      });
    }

    if (f?.category && f.category.trim()) {
      const c = f.category.trim();
      conditions.push({
        OR: [
          { category: { contains: c, mode: "insensitive" } },
          { businessCategoryName: { contains: c, mode: "insensitive" } },
        ],
      });
    }

    if (f?.verified !== undefined) {
      if (f.verified === "true" || f.verified === "verified") {
        conditions.push({ OR: [{ verified: true }, { isVerified: true }] });
      } else if (f.verified === "false" || f.verified === "unverified") {
        conditions.push({
          AND: [
            { OR: [{ verified: false }, { verified: null }] },
            { OR: [{ isVerified: false }, { isVerified: null }] },
          ],
        });
      }
    }

    if (f?.isBusinessAccount !== undefined) {
      if (f.isBusinessAccount === "true" || f.isBusinessAccount === "business") {
        conditions.push({ OR: [{ isBusinessAccount: true }, { isBusiness: true }] });
      } else if (f.isBusinessAccount === "false" || f.isBusinessAccount === "personal") {
        conditions.push({
          AND: [
            { OR: [{ isBusinessAccount: false }, { isBusinessAccount: null }] },
            { OR: [{ isBusiness: false }, { isBusiness: null }] },
          ],
        });
      }
    }

    if (f?.status && f.status.toUpperCase() !== "ALL") {
      const st = f.status.toUpperCase();
      if (st === "NEW") {
        conditions.push({ status: LeadStatus.NEW });
      } else if (st === "CONTACTED") {
        conditions.push({ status: LeadStatus.CONTACTED });
      } else if (st === "SENDING" || st === "QUEUED") {
        conditions.push({ status: LeadStatus.QUEUED });
      } else if (st === "FAILED") {
        conditions.push({ messages: { some: { status: "FAILED" } } });
      } else if (Object.values(LeadStatus).includes(st as LeadStatus)) {
        conditions.push({ status: st as LeadStatus });
      }
    }

    const tierFilter = (f as { tier?: string } | undefined)?.tier;
    if (tierFilter && tierFilter.toUpperCase() !== "ALL") {
      const allowed = tierFilter.split(",").map((t) => t.trim().toUpperCase());
      conditions.push({ qualityTier: { in: allowed } });
    } else {
      // Default: exclude tier D and hold tier C
      conditions.push({
        OR: [
          { qualityTier: null },
          { qualityTier: { notIn: ["D", "C"] } },
        ],
      });
    }
  } else if (input.leadIds && input.leadIds.length > 0) {
    // Unique lead IDs
    const uniqueIds = Array.from(new Set(input.leadIds.map((id) => id.trim()).filter(Boolean)));
    conditions.push({ id: { in: uniqueIds } });
  }

  return { AND: conditions };
}

/**
 * Validates and retrieves the template and campaign context.
 */
async function resolveCampaignAndTemplate(
  campaignId: string,
  templateId?: string,
  userId?: string,
) {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: { id: true, name: true, userId: true, description: true, intent: true },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign "${campaignId}" was not found.`);
  }

  let template;
  if (templateId) {
    template = await prisma.messageTemplate.findFirst({
      where: {
        id: templateId,
        OR: [{ campaignId: campaign.id }, { campaignId: null }],
      },
      select: { id: true, name: true, body: true, campaignId: true },
    });
    if (!template) {
      throw new NotFoundError("TEMPLATE_NOT_FOUND", `Message template "${templateId}" was not found.`);
    }
  } else {
    template = await prisma.messageTemplate.findFirst({
      where: { OR: [{ campaignId: campaign.id }, { campaignId: null }] },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, body: true, campaignId: true },
    });
    if (!template) {
      const defaultBody = campaign.description
        ? "Hi {{username}}, reaching out regarding {{campaignName}}.\n\n{{campaignDescription}}\n\nLet us know if you'd like more details!"
        : "Hi {{username}}, reaching out regarding {{campaignName}}! Let us know if you'd be interested in learning more.";

      template = await prisma.messageTemplate.create({
        data: {
          campaignId: campaign.id,
          name: "Default Campaign Outreach",
          body: defaultBody,
        },
        select: { id: true, name: true, body: true, campaignId: true },
      });
    }
  }

  let senderName: string | null = null;
  if (userId) {
    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    senderName = owner?.name ?? null;
  }

  return { campaign, template, senderName };
}

/**
 * Previews bulk messaging eligibility and personalized sample messages before sending.
 */
export async function previewBulkMessageJob(
  campaignId: string,
  input: unknown,
  userId?: string,
): Promise<BulkJobPreviewResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }

  const record = input as BulkMessageJobPreviewInput;
  const { campaign, template, senderName } = await resolveCampaignAndTemplate(
    campaignId,
    record.templateId,
    userId,
  );

  // Validates ownership/connected status when a sender is provided for preview.
  if (userId) {
    await resolveBulkSenderAccountId(record.senderAccountId, userId);
  }

  const prisma = getPrismaClient();
  const where = buildLeadFilterConditions(campaign.id, record);

  const rawLeads = await prisma.lead.findMany({
    where,
    orderBy: [{ qualityScore: "desc" }, { createdAt: "asc" }],
  });

  // Check which leads are already in an active/queued job
  const activeJobItemLeadIds = new Set(
    (
      await prisma.bulkMessageItem.findMany({
        where: {
          leadId: { in: rawLeads.map((l) => l.id) },
          status: { in: [BulkMessageItemStatus.QUEUED, BulkMessageItemStatus.PROCESSING] },
        },
        select: { leadId: true },
      })
    ).map((it) => it.leadId),
  );

  // Check Do Not Contact suppression across all candidate leads
  const suppressionMap = await checkManySuppression({
    userId: campaign.userId,
    leads: rawLeads,
    channel: DncChannel.INSTAGRAM,
  });

  const eligibleLeads: typeof rawLeads = [];
  const skippedReasons: Array<{ leadId: string; username: string; reason: string }> = [];
  let suppressedCount = 0;
  const suppressedLeadIds: string[] = [];

  // Step 4: a person contacted in ANY campaign is never selected again.
  const previouslyContacted = await findPreviouslyContactedLeadIds(
    rawLeads.map((l) => l.id),
  );
  let previouslyContactedSkipped = 0;

  const [duplicateSkipped, possibleDuplicateSkipped] = await Promise.all([
    prisma.lead.count({
      where: { campaignId: campaign.id, duplicateOfLeadId: { not: null } },
    }),
    prisma.lead.count({
      where: {
        campaignId: campaign.id,
        possibleDuplicateOfLeadId: { not: null },
        possibleDuplicateOf: { status: { in: DEDUP_CONTACTED_OR_LATER } },
      },
    }),
  ]);

  const contactedGroupKeys = new Set<string>();
  const existingCampaignGroupMessages = await prisma.message.findMany({
    where: {
      campaignId: campaign.id,
      direction: "OUTBOUND",
      status: { in: ["SENT", "QUEUED", "SENDING"] },
      lead: {
        OR: [{ groupKey: { not: null } }, { website: { not: null } }],
      },
    },
    select: {
      lead: {
        select: {
          groupKey: true,
          website: true,
        },
      },
    },
  });
  for (const m of existingCampaignGroupMessages) {
    if (m.lead?.groupKey) contactedGroupKeys.add(m.lead.groupKey);
    if (m.lead?.website) {
      const d = extractDomainParts(m.lead.website)?.domain;
      if (d) contactedGroupKeys.add(`domain:${d}`);
    }
  }

  for (const lead of rawLeads) {
    if (!lead.username || !lead.username.trim() || (lead.availableChannels && lead.availableChannels.length > 0 && !lead.availableChannels.includes("INSTAGRAM"))) {
      skippedReasons.push({
        leadId: lead.id,
        username: lead.username ?? "",
        reason: "Lead has no Instagram handle.",
      });
      continue;
    }

    const effectiveGroupKey = lead.groupKey || (lead.website ? `domain:${extractDomainParts(lead.website)?.domain}` : null);
    if (effectiveGroupKey && (lead.isGroup || lead.groupKey)) {
      if (contactedGroupKeys.has(effectiveGroupKey)) {
        skippedReasons.push({
          leadId: lead.id,
          username: lead.username ?? "",
          reason: "Group member already contacted for this campaign (dedup by domain/handle).",
        });
        continue;
      }
      contactedGroupKeys.add(effectiveGroupKey);
    }

    const suppression = suppressionMap.get(lead.id);
    if (suppression?.suppressed) {
      suppressedCount++;
      suppressedLeadIds.push(lead.id);
      skippedReasons.push({
        leadId: lead.id,
        username: lead.username ?? "",
        reason: "Lead is on the Do Not Contact suppression list.",
      });
      continue;
    }
    const rawUrl = lead.profileUrl?.trim() || "";
    if (!rawUrl.startsWith("http") || (!rawUrl.includes("instagram.com") && rawUrl.length < 10)) {
      skippedReasons.push({
        leadId: lead.id,
        username: lead.username ?? "",
        reason: "Missing or invalid Instagram profile URL.",
      });
      continue;
    }

    if (activeJobItemLeadIds.has(lead.id)) {
      skippedReasons.push({
        leadId: lead.id,
        username: lead.username,
        reason: "Lead is already in an active/queued bulk messaging job.",
      });
      continue;
    }

    if (previouslyContacted.has(lead.id)) {
      previouslyContactedSkipped++;
      skippedReasons.push({
        leadId: lead.id,
        username: lead.username,
        reason: "This person was already contacted (any campaign).",
      });
      continue;
    }

    // Render and check variables
    const rendered = renderTemplate(
      template.body,
      {
        username: lead.username,
        fullName: lead.fullName,
        biography: lead.biography,
        category: lead.category,
        businessCategory: lead.businessCategoryName,
        followersCount: lead.followersCount ?? lead.followers,
        followingCount: lead.followsCount ?? lead.following,
        postsCount: lead.postsCount,
        externalUrl: lead.externalUrl,
        profileUrl: lead.profileUrl,
      },
      {
        name: campaign.name,
        description: campaign.description,
        intent: campaign.intent,
      },
      senderName,
    );

    const varCheck = validateTemplateVariables(rendered);
    if (!varCheck.valid) {
      skippedReasons.push({
        leadId: lead.id,
        username: lead.username,
        reason: `Unsupported template variable(s): {{${varCheck.unsupported.join("}}, {{")}}}.`,
      });
      continue;
    }

    if (rendered.trim().length === 0) {
      skippedReasons.push({
        leadId: lead.id,
        username: lead.username,
        reason: "Rendered message is empty.",
      });
      continue;
    }

    if (rendered.length > 1000) {
      skippedReasons.push({
        leadId: lead.id,
        username: lead.username,
        reason: "Rendered message exceeds 1000 characters limit.",
      });
      continue;
    }

    eligibleLeads.push(lead);
  }

  // Generate 3 sample rendered messages
  const samples = eligibleLeads.slice(0, 3).map((lead) => ({
    leadId: lead.id,
    username: lead.username,
    fullName: lead.fullName,
    renderedMessage: renderTemplate(
      template.body,
      {
        username: lead.username ?? "",
        fullName: lead.fullName,
        biography: lead.biography,
        category: lead.category,
        businessCategory: lead.businessCategoryName,
        followersCount: lead.followersCount ?? lead.followers,
        followingCount: lead.followsCount ?? lead.following,
        postsCount: lead.postsCount,
        externalUrl: lead.externalUrl,
        profileUrl: lead.profileUrl,
      },
      {
        name: campaign.name,
        description: campaign.description,
        intent: campaign.intent,
      },
      senderName,
    ),
  }));

  return {
    campaignId: campaign.id,
    templateId: template.id,
    templateName: template.name,
    totalSelected: rawLeads.length,
    eligibleCount: eligibleLeads.length,
    skippedCount: skippedReasons.length,
    skippedReasons,
    suppressedCount,
    suppressedLeadIds,
    duplicateSkipped,
    possibleDuplicateSkipped,
    previouslyContactedSkipped,
    samples,
  };
}

/**
 * Creates a persistent BulkMessageJob and queued BulkMessageItems in a database transaction.
 */
export async function createBulkMessageJob(
  campaignId: string,
  input: unknown,
  userId: string,
): Promise<{
  job: BulkJobStatusResponse;
  summary: {
    totalSelected: number;
    eligibleCount: number;
    skippedCount: number;
    suppressedCount: number;
    suppressedLeadIds: string[];
    previouslyContactedSkipped: number;
  };
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }

  const record = input as CreateBulkJobInput;
  if (!record.templateId || typeof record.templateId !== "string" || !record.templateId.trim()) {
    throw new BadRequestError("MISSING_TEMPLATE_ID", '"templateId" is required.');
  }

  const { campaign, template, senderName } = await resolveCampaignAndTemplate(
    campaignId,
    record.templateId.trim(),
    userId,
  );

  const resolvedSenderAccountId = await resolveBulkSenderAccountId(
    record.senderAccountId,
    userId,
  );

  const prisma = getPrismaClient();
  const where = buildLeadFilterConditions(campaign.id, record);

  const rawLeads = await prisma.lead.findMany({
    where,
    orderBy: [{ qualityScore: "desc" }, { createdAt: "asc" }],
  });

  if (rawLeads.length === 0) {
    throw new BadRequestError("NO_LEADS_FOUND", "No leads match the specified criteria.");
  }

  // Active items check
  const activeJobItemLeadIds = new Set(
    (
      await prisma.bulkMessageItem.findMany({
        where: {
          leadId: { in: rawLeads.map((l) => l.id) },
          status: { in: [BulkMessageItemStatus.QUEUED, BulkMessageItemStatus.PROCESSING] },
        },
        select: { leadId: true },
      })
    ).map((it) => it.leadId),
  );

  // Check Do Not Contact suppression across all candidate leads
  const suppressionMap = await checkManySuppression({
    userId,
    leads: rawLeads,
    channel: DncChannel.INSTAGRAM,
  });

  const preparedItems: Array<{ leadId: string; renderedMessage: string }> = [];
  let skippedCount = 0;
  let suppressedCount = 0;
  let previouslyContactedSkipped = 0;
  const suppressedLeadIds: string[] = [];

  // Step 4: never message a person already contacted in any campaign.
  const previouslyContacted = await findPreviouslyContactedLeadIds(
    rawLeads.map((l) => l.id),
  );

  const startContactedGroupKeys = new Set<string>();
  const existingCampaignMessagesStart = await prisma.message.findMany({
    where: {
      campaignId: campaign.id,
      direction: "OUTBOUND",
      status: { in: ["SENT", "QUEUED", "SENDING"] },
      lead: {
        OR: [{ groupKey: { not: null } }, { website: { not: null } }],
      },
    },
    select: {
      lead: {
        select: {
          groupKey: true,
          website: true,
        },
      },
    },
  });
  for (const m of existingCampaignMessagesStart) {
    if (m.lead?.groupKey) startContactedGroupKeys.add(m.lead.groupKey);
    if (m.lead?.website) {
      const d = extractDomainParts(m.lead.website)?.domain;
      if (d) startContactedGroupKeys.add(`domain:${d}`);
    }
  }

  for (const lead of rawLeads) {
    if (!lead.username || !lead.username.trim() || (lead.availableChannels && lead.availableChannels.length > 0 && !lead.availableChannels.includes("INSTAGRAM"))) {
      skippedCount++;
      continue;
    }

    const effectiveGroupKey = lead.groupKey || (lead.website ? `domain:${extractDomainParts(lead.website)?.domain}` : null);
    if (effectiveGroupKey && (lead.isGroup || lead.groupKey)) {
      if (startContactedGroupKeys.has(effectiveGroupKey)) {
        skippedCount++;
        continue;
      }
      startContactedGroupKeys.add(effectiveGroupKey);
    }

    const suppression = suppressionMap.get(lead.id);
    if (suppression?.suppressed) {
      skippedCount++;
      suppressedCount++;
      suppressedLeadIds.push(lead.id);
      continue;
    }
    const rawUrl = lead.profileUrl?.trim() || "";
    if (!rawUrl.startsWith("http") || (!rawUrl.includes("instagram.com") && rawUrl.length < 10)) {
      skippedCount++;
      continue;
    }

    if (activeJobItemLeadIds.has(lead.id)) {
      skippedCount++;
      continue;
    }

    if (previouslyContacted.has(lead.id)) {
      skippedCount++;
      previouslyContactedSkipped++;
      continue;
    }

    const rendered = renderTemplate(
      template.body,
      {
        username: lead.username ?? "",
        fullName: lead.fullName,
        biography: lead.biography,
        category: lead.category,
        businessCategory: lead.businessCategoryName,
        followersCount: lead.followersCount ?? lead.followers,
        followingCount: lead.followsCount ?? lead.following,
        postsCount: lead.postsCount,
        externalUrl: lead.externalUrl,
        profileUrl: lead.profileUrl,
      },
      {
        name: campaign.name,
        description: campaign.description,
        intent: campaign.intent,
      },
      senderName,
    );

    const varCheck = validateTemplateVariables(rendered);
    if (!varCheck.valid || rendered.trim().length === 0 || rendered.length > 1000) {
      skippedCount++;
      continue;
    }

    preparedItems.push({
      leadId: lead.id,
      renderedMessage: rendered,
    });
  }

  if (preparedItems.length === 0) {
    throw new BadRequestError(
      "NO_ELIGIBLE_LEADS",
      "None of the selected leads are currently eligible for messaging.",
    );
  }

  // Transactionally create job and queued items
  const createdJob = await prisma.$transaction(async (tx) => {
    const job = await tx.bulkMessageJob.create({
      data: {
        campaignId: campaign.id,
        userId,
        templateId: template.id,
        senderAccountId: resolvedSenderAccountId,
        status: BulkMessageJobStatus.QUEUED,
        total: preparedItems.length,
        queued: preparedItems.length,
        skipped: skippedCount,
      },
    });

    await tx.bulkMessageItem.createMany({
      data: preparedItems.map((item) => ({
        jobId: job.id,
        leadId: item.leadId,
        renderedMessage: item.renderedMessage,
        status: BulkMessageItemStatus.QUEUED,
        contentHash: calculateContentFingerprint(job.campaignId, item.leadId, item.renderedMessage),
        idempotencyKey: formatScopedIdempotencyKey(undefined, job.campaignId, item.leadId, 1),
      })),
    });

    for (const item of preparedItems) {
      const currentLead = rawLeads.find((l) => l.id === item.leadId);
      if (
        currentLead &&
        (currentLead.status === LeadStatus.READY_FOR_OUTREACH ||
          currentLead.status === LeadStatus.QUALIFIED ||
          currentLead.status === LeadStatus.NEW)
      ) {
        await transitionLeadStatus({
          leadId: item.leadId,
          to: LeadStatus.QUEUED,
          reason: "bulk_message_job_queued",
          actor: userId ? `user:${userId}` : "system",
          tx,
        });
      }
    }

    return job;
  });

  return {
    job: {
      id: createdJob.id,
      campaignId: createdJob.campaignId,
      templateId: createdJob.templateId,
      senderAccountId: createdJob.senderAccountId,
      status: createdJob.status,
      total: createdJob.total,
      queued: createdJob.queued,
      processing: 0,
      sent: 0,
      failed: 0,
      skipped: createdJob.skipped,
      cancelled: 0,
      unknown: 0,
      progress: 0,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: createdJob.createdAt.toISOString(),
    },
    summary: {
      totalSelected: rawLeads.length,
      eligibleCount: preparedItems.length,
      skippedCount,
      suppressedCount,
      suppressedLeadIds,
      previouslyContactedSkipped,
    },
  };
}

/**
 * Returns real-time status of a BulkMessageJob derived from actual database records.
 */
export async function getBulkMessageJobStatus(
  jobId: string,
  userId?: string,
): Promise<BulkJobStatusResponse> {
  const prisma = getPrismaClient();

  const job = await prisma.bulkMessageJob.findFirst({
    where: {
      id: jobId,
      ...(userId ? { userId } : {}),
    },
  });

  if (!job) {
    throw new NotFoundError("JOB_NOT_FOUND", `Bulk message job "${jobId}" was not found.`);
  }

  const [statusCounts, items] = await Promise.all([
    prisma.bulkMessageItem.groupBy({
      by: ["status"],
      where: { jobId: job.id },
      _count: { _all: true },
    }),
    prisma.bulkMessageItem.findMany({
      where: { jobId: job.id },
      orderBy: { createdAt: "asc" },
      include: {
        lead: {
          select: { username: true },
        },
      },
      take: 50,
    }),
  ]);

  const countByStatus = (status: BulkMessageItemStatus): number =>
    statusCounts.find((row) => row.status === status)?._count._all ?? 0;

  const queued = countByStatus(BulkMessageItemStatus.QUEUED);
  const processing = countByStatus(BulkMessageItemStatus.PROCESSING);
  const sent = countByStatus(BulkMessageItemStatus.SENT);
  const failed = countByStatus(BulkMessageItemStatus.FAILED);
  const unknown = countByStatus(BulkMessageItemStatus.UNKNOWN) + (job.unknown ?? 0);
  const suppressedDnc = countByStatus(BulkMessageItemStatus.SUPPRESSED_DNC);
  const skipped = countByStatus(BulkMessageItemStatus.SKIPPED) + job.skipped + suppressedDnc;
  const cancelled = countByStatus(BulkMessageItemStatus.CANCELLED);
  const processed = sent + failed + cancelled + unknown + (skipped - job.skipped);

  const progress = job.total > 0 ? Math.min(100, Math.round((processed / job.total) * 100)) : 0;

  return {
    id: job.id,
    campaignId: job.campaignId,
    templateId: job.templateId,
    senderAccountId: job.senderAccountId,
    status: job.status,
    total: job.total,
    queued,
    processing,
    sent,
    failed,
    skipped,
    cancelled,
    unknown,
    progress,
    errorMessage: job.errorMessage,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    cancelledAt: job.cancelledAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    items: items.map((it) => ({
      id: it.id,
      leadId: it.leadId,
      username: it.lead.username,
      renderedMessage: it.renderedMessage,
      status: it.status,
      errorCode: it.errorCode,
      errorMessage: it.errorMessage,
      completedAt: it.completedAt?.toISOString() ?? null,
      attempts: it.attempts,
    })),
  };
}

/**
 * Atomically claims the next QUEUED item in a bulk job, moving it to PROCESSING.
 * Prevents concurrent workers or races from processing the same item.
 */
export async function claimNextQueuedItem(jobId: string) {
  const prisma = getPrismaClient();
  const nextItem = await prisma.bulkMessageItem.findFirst({
    where: { jobId, status: BulkMessageItemStatus.QUEUED },
    orderBy: { createdAt: "asc" },
  });

  if (!nextItem) return null;

  const claimResult = await prisma.bulkMessageItem.updateMany({
    where: { id: nextItem.id, status: BulkMessageItemStatus.QUEUED },
    data: {
      status: BulkMessageItemStatus.PROCESSING,
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });

  if (claimResult.count === 0) {
    return null;
  }

  return prisma.bulkMessageItem.findUnique({
    where: { id: nextItem.id },
  });
}

/**
 * Sequential controlled queue worker loop.
 */
export async function dispatchBulkJobQueue(jobId: string): Promise<void> {
  if (activeJobWorkers.has(jobId)) {
    return; // Worker already running for this job
  }

  activeJobWorkers.add(jobId);
  const prisma = getPrismaClient();

  try {
    const initialJob = await prisma.bulkMessageJob.findUnique({
      where: { id: jobId },
      select: { id: true, status: true, campaignId: true, userId: true, senderAccountId: true },
    });
    if (!initialJob) return;
    if (
      initialJob.status === BulkMessageJobStatus.COMPLETED ||
      initialJob.status === BulkMessageJobStatus.CANCELLED
    ) {
      return;
    }

    const initialQueuedCount = await prisma.bulkMessageItem.count({
      where: { jobId, status: BulkMessageItemStatus.QUEUED },
    });

    if (initialQueuedCount === 0) {
      const [sentCount, failedCount, unknownCount] = await Promise.all([
        prisma.bulkMessageItem.count({ where: { jobId, status: BulkMessageItemStatus.SENT } }),
        prisma.bulkMessageItem.count({ where: { jobId, status: BulkMessageItemStatus.FAILED } }),
        prisma.bulkMessageItem.count({ where: { jobId, status: BulkMessageItemStatus.UNKNOWN } }),
      ]);
      const finalStatus =
        failedCount === 0 && unknownCount === 0
          ? BulkMessageJobStatus.COMPLETED
          : sentCount > 0
          ? BulkMessageJobStatus.PARTIAL
          : BulkMessageJobStatus.CANCELLED;
      await prisma.bulkMessageJob.update({
        where: { id: jobId },
        data: {
          status: finalStatus,
          completedAt: new Date(),
        },
      });
      return;
    }

    // 1. Mark job RUNNING and startedAt
    await prisma.bulkMessageJob.update({
      where: { id: jobId },
      data: {
        status: BulkMessageJobStatus.RUNNING,
        startedAt: new Date(),
        errorMessage: null,
      },
    });

    // Load pool of connected sender accounts (or single sender if specifically selected)
    let activeSenders: SenderAccountRecord[] = [];
    if (initialJob.senderAccountId) {
      const specific = await findSenderAccountOwned(initialJob.senderAccountId, initialJob.userId);
      if (specific && specific.status === "CONNECTED") {
        activeSenders = [specific];
      }
    } else {
      activeSenders = await findConnectedSendersForDispatch(initialJob.userId);
    }

    if (activeSenders.length === 0) {
      await prisma.bulkMessageJob.update({
        where: { id: jobId },
        data: {
          status: BulkMessageJobStatus.PAUSED,
          errorMessage: "No connected Instagram sender accounts available for outreach.",
        },
      });
      return;
    }

    let roundRobinIndex = 0;

    while (true) {
      // Check current job status
      const currentJob = await prisma.bulkMessageJob.findUnique({
        where: { id: jobId },
        select: { id: true, status: true, campaignId: true, userId: true, senderAccountId: true },
      });

      if (!currentJob) break;
      if (
        currentJob.status === BulkMessageJobStatus.PAUSED ||
        currentJob.status === BulkMessageJobStatus.CANCELLED
      ) {
        break;
      }

      // Priority: follow-ups due today are sent before brand-new first messages
      try {
        await dispatchDueFollowUps({
          campaignId: currentJob.campaignId,
          now: getSendGateNow(),
          limit: 10,
        });
      } catch (fErr) {
        logger.warn("[BULK] dispatchDueFollowUps error in loop", {
          campaignId: currentJob.campaignId,
          error: fErr instanceof Error ? fErr.message : String(fErr),
        });
      }

      // 2. Atomically claim next queued item
      const nextItem = await claimNextQueuedItem(jobId);

      if (!nextItem) {
        // No more queued items (or claimed by another worker)
        const remainingQueued = await prisma.bulkMessageItem.count({
          where: { jobId, status: BulkMessageItemStatus.QUEUED },
        });
        if (remainingQueued === 0) {
          break;
        }
        continue;
      }

      // Requirement 14: Bulk job safety check before dispatching
      const lead = await prisma.lead.findFirst({
        where: { id: nextItem.leadId, campaignId: currentJob.campaignId },
      });
      if (!lead) {
        await prisma.bulkMessageItem.update({
          where: { id: nextItem.id },
          data: {
            status: BulkMessageItemStatus.SKIPPED,
            completedAt: new Date(),
            errorMessage: "Lead does not belong to campaign or was removed.",
          },
        });
        await prisma.bulkMessageJob.update({
          where: { id: jobId },
          data: {
            skipped: { increment: 1 },
            queued: { decrement: 1 },
          },
        });
        continue;
      }

      const alreadySent = await prisma.message.findFirst({
        where: {
          campaignId: currentJob.campaignId,
          leadId: nextItem.leadId,
          status: "SENT",
        },
      });
      if (alreadySent) {
        await prisma.bulkMessageItem.update({
          where: { id: nextItem.id },
          data: {
            status: BulkMessageItemStatus.SKIPPED,
            completedAt: new Date(),
            errorMessage: "Lead already received a SENT message in this campaign.",
          },
        });
        await prisma.bulkMessageJob.update({
          where: { id: jobId },
          data: {
            skipped: { increment: 1 },
            queued: { decrement: 1 },
          },
        });
        continue;
      }

      // Requirement: Dispatch-time DNC check against fresh DB state (guards against races / additions after enqueue)
      // Even if a lead was added to DNC after job enqueue, this fresh query blocks it immediately before Playwright is invoked.
      const suppression = await checkLeadSuppression({
        userId: currentJob.userId,
        lead,
        channel: DncChannel.INSTAGRAM,
      });
      if (suppression.suppressed) {
        await prisma.bulkMessageItem.update({
          where: { id: nextItem.id },
          data: {
            status: BulkMessageItemStatus.SUPPRESSED_DNC,
            errorCode: "SUPPRESSED_DNC",
            errorMessage: "Lead suppressed by Do Not Contact list.",
            completedAt: new Date(),
          },
        });
        await prisma.bulkMessageJob.update({
          where: { id: jobId },
          data: {
            skipped: { increment: 1 },
            queued: { decrement: 1 },
          },
        });
        continue;
      }

      // 2b. Step 6 draft-based items: re-verify approval + hash + blockers at dispatch time.
      let dispatchMessageText = nextItem.renderedBody ?? nextItem.renderedMessage;
      let dispatchDraftId: string | undefined;
      let dispatchPromptVersion: string | undefined;
      let dispatchAiGenerated = false;

      if (nextItem.draftId) {
        const decision = await evaluateDraftDispatch(nextItem.draftId);
        if (decision.action === "SKIP") {
          await prisma.bulkMessageItem.update({
            where: { id: nextItem.id },
            data: {
              status: BulkMessageItemStatus.SKIPPED,
              errorCode: decision.code,
              errorMessage: `Skipped before send: ${decision.code}`,
              completedAt: new Date(),
            },
          });
          await prisma.bulkMessageJob.update({
            where: { id: jobId },
            data: {
              skipped: { increment: 1 },
              queued: { decrement: 1 },
            },
          });
          // Return the lead to its pre-queue status so the draft can be fixed/re-approved.
          try {
            const lastQueueHistory = await prisma.leadStatusHistory.findFirst({
              where: { leadId: nextItem.leadId, toStatus: LeadStatus.QUEUED },
              orderBy: { createdAt: "desc" },
            });
            const revertStatus =
              lastQueueHistory?.fromStatus &&
              (lastQueueHistory.fromStatus === LeadStatus.READY_FOR_OUTREACH ||
                lastQueueHistory.fromStatus === LeadStatus.QUALIFIED ||
                lastQueueHistory.fromStatus === LeadStatus.NEW)
                ? lastQueueHistory.fromStatus
                : LeadStatus.READY_FOR_OUTREACH;
            await transitionLeadStatus({
              leadId: nextItem.leadId,
              to: revertStatus,
              reason: "draft_send_skipped",
              actor: "worker",
            });
          } catch (statusErr) {
            logger.warn("[BULK] Failed to revert lead status after draft skip", {
              leadId: nextItem.leadId,
              error: statusErr instanceof Error ? statusErr.message : String(statusErr),
            });
          }
          continue;
        }
        dispatchMessageText = decision.messageText;
        dispatchDraftId = decision.draftId;
        dispatchPromptVersion = decision.promptVersion;
        dispatchAiGenerated = true;
      }

      if (activeSenders.length === 0) {
        await prisma.bulkMessageJob.update({
          where: { id: jobId },
          data: {
            status: BulkMessageJobStatus.PAUSED,
            errorMessage: "All sender accounts became unavailable or restricted.",
          },
        });
        break;
      }

      // Refresh active senders from DB to have fresh counters
      const freshActiveSenders = await prisma.instagramSenderAccount.findMany({
        where: { id: { in: activeSenders.map((s) => s.id) } },
      });
      if (freshActiveSenders.length > 0) {
        activeSenders = freshActiveSenders.filter(
          (s) =>
            (s.status === "CONNECTED" || s.status === "ACTIVE" || s.status === "WARMING") &&
            (!s.pausedUntil || Date.now() >= s.pausedUntil.getTime()),
        );
      }

      if (activeSenders.length === 0) {
        await prisma.bulkMessageJob.update({
          where: { id: jobId },
          data: {
            status: BulkMessageJobStatus.PAUSED,
            errorMessage: "All sender accounts became unavailable, restricted, or paused.",
          },
        });
        break;
      }

      // 3. Pick healthy sender spreading sends by remaining quota (round-robin)
      let candidateSender = chooseHealthySender(activeSenders);
      if (!candidateSender && activeSenders.length > 0) {
        candidateSender = activeSenders[roundRobinIndex % activeSenders.length];
      }

      if (!candidateSender) {
        break;
      }

      // Check send gate right before dispatch
      const gateCheck = await canSendNow({
        senderAccountId: candidateSender.id,
        leadId: nextItem.leadId,
        lead,
        campaignId: currentJob.campaignId,
      });

      if (!gateCheck.allowed) {
        if (gateCheck.reason === "SENDING_DISABLED") {
          logger.info("[BULK_SEND_GATE] Global outbound sending disabled, deferring item", {
            leadId: nextItem.leadId,
          });
          await prisma.bulkMessageItem.update({
            where: { id: nextItem.id },
            data: {
              status: BulkMessageItemStatus.QUEUED,
              errorMessage: "Queued: Outbound sending is disabled (OUTBOUND_SENDING_ENABLED=false)",
            },
          });
          break;
        }

        if (gateCheck.reason === "DRY_RUN_LEAD_CANNOT_BE_SENT") {
          logger.warn("[BULK_SEND_GATE] Cannot send to dry-run or sample lead", {
            leadId: nextItem.leadId,
          });
          await prisma.bulkMessageItem.update({
            where: { id: nextItem.id },
            data: {
              status: BulkMessageItemStatus.SKIPPED,
              errorMessage: "Skipped: Lead is marked as dry-run/sample data",
            },
          });
          continue;
        }

        if (gateCheck.reason === "OUTSIDE_WORKING_HOURS") {
          logger.info("[BULK_SEND_GATE] Lead outside working hours, deferring item", {
            leadId: nextItem.leadId,
            retryAt: gateCheck.retryAt,
          });
          // Item stays QUEUED with retryAt info (not failed!)
          await prisma.bulkMessageItem.update({
            where: { id: nextItem.id },
            data: {
              status: BulkMessageItemStatus.QUEUED,
              errorMessage: `Queued: Outside recipient working hours (resumes at ${gateCheck.retryAt?.toISOString() ?? "next window"})`,
            },
          });
          break;
        }

        if (gateCheck.reason === "COOLDOWN_ACTIVE" && gateCheck.retryAt) {
          if (process.env.NODE_ENV === "test" || process.env.SKIP_SEND_DELAYS === "1") {
            logger.info("[BULK_SEND_GATE] Test environment: skipping real-time jitter sleep");
          } else {
            const waitTime = Math.max(1000, gateCheck.retryAt.getTime() - Date.now());
            logger.info("[BULK_SEND_GATE] Sender in cooldown / jitter gap, waiting", {
              senderId: candidateSender.id,
              remainingWaitMs: waitTime,
            });
            const shouldContinue = await sleepWithJobCheck(jobId, waitTime);
            if (!shouldContinue) {
              break;
            }
          }
        }
      }

      // Dispatch item using single-lead messaging service
      const itemAttemptNumber = nextItem.attempts;
      const idempotencyKey =
        nextItem.idempotencyKey ||
        formatScopedIdempotencyKey(undefined, currentJob.campaignId, nextItem.leadId, itemAttemptNumber);

      let sendResult;
      try {
        sendResult = await sendSingleMessage(
          {
            campaignId: currentJob.campaignId,
            leadId: nextItem.leadId,
            message: dispatchMessageText,
            senderAccountId: candidateSender.id,
            jobId: currentJob.id,
            itemId: nextItem.id,
            idempotencyKey,
            attemptNumber: itemAttemptNumber,
            draftId: dispatchDraftId,
            aiGenerated: dispatchAiGenerated,
            promptVersion: dispatchPromptVersion,
          },
          currentJob.userId,
        );
      } catch (err) {
        if (
          err instanceof DncSuppressedError ||
          (err as { code?: string })?.code === "DNC_SUPPRESSED"
        ) {
          await prisma.bulkMessageItem.update({
            where: { id: nextItem.id },
            data: {
              status: BulkMessageItemStatus.SUPPRESSED_DNC,
              errorCode: "SUPPRESSED_DNC",
              errorMessage: "Lead suppressed by Do Not Contact list.",
              completedAt: new Date(),
            },
          });
          await prisma.bulkMessageJob.update({
            where: { id: jobId },
            data: {
              skipped: { increment: 1 },
              queued: { decrement: 1 },
            },
          });
          continue;
        }
        // Classify through the central taxonomy; never surface raw browser or
        // provider errors to the client.
        const classified = classifyMessagingError("WORKER_ERROR", err);
        logger.error("WORKER_ERROR", err, {
          jobId,
          leadId: nextItem.leadId,
          campaignId: currentJob.campaignId,
          operation: "bulk_dispatch_item",
        });
        sendResult = {
          success: false as const,
          leadId: nextItem.leadId,
          status: "FAILED" as const,
          errorCode: classified.isFatalPlatformRestriction
            ? classified.code
            : "WORKER_ERROR",
          error: classified.userFacingMessage,
          isFatalPlatformRestriction: classified.isFatalPlatformRestriction,
        };
      }

      // 4. Update item status in DB based on result
      if (sendResult.status === "SENT") {
        recordSenderAccountSent(candidateSender.id, getSendGateNow().getTime());
        roundRobinIndex++;

        await prisma.bulkMessageItem.update({
          where: { id: nextItem.id },
          data: {
            status: BulkMessageItemStatus.SENT,
            completedAt: new Date(),
            providerMessageId: sendResult.messageId,
          },
        });
        await prisma.bulkMessageJob.update({
          where: { id: jobId },
          data: {
            sent: { increment: 1 },
            queued: { decrement: 1 },
          },
        });

        try {
          await transitionLeadStatus({
            leadId: nextItem.leadId,
            to: LeadStatus.CONTACTED,
            reason: "bulk_message_sent",
            actor: "worker",
          });
        } catch (statusErr) {
          logger.warn("[BULK] Failed to transition lead status to CONTACTED", {
            leadId: nextItem.leadId,
            error: statusErr instanceof Error ? statusErr.message : String(statusErr),
          });
        }

        try {
          await scheduleFollowUpsForLead({
            campaignId: currentJob.campaignId,
            leadId: nextItem.leadId,
            sentAt: new Date(),
            initialMessageText: dispatchMessageText,
            threadId: null,
            senderAccountId: candidateSender.id,
          });
        } catch (followUpErr) {
          logger.warn("[BULK] Failed to schedule follow-up messages for lead", {
            leadId: nextItem.leadId,
            error: followUpErr instanceof Error ? followUpErr.message : String(followUpErr),
          });
        }
      } else if (sendResult.status === "UNKNOWN") {
        await prisma.bulkMessageItem.update({
          where: { id: nextItem.id },
          data: {
            status: BulkMessageItemStatus.UNKNOWN,
            completedAt: new Date(),
            errorCode: sendResult.errorCode || "UNKNOWN",
            errorMessage:
              sendResult.error ||
              "Delivery could not be confirmed. The message may have been sent.",
          },
        });
        await prisma.bulkMessageJob.update({
          where: { id: jobId },
          data: {
            unknown: { increment: 1 },
            queued: { decrement: 1 },
          },
        });
      } else {
        await prisma.bulkMessageItem.update({
          where: { id: nextItem.id },
          data: {
            status: BulkMessageItemStatus.FAILED,
            completedAt: new Date(),
            errorCode: sendResult.errorCode || "FAILED",
            errorMessage: sendResult.error || "Message dispatch failed.",
          },
        });
        await prisma.bulkMessageJob.update({
          where: { id: jobId },
          data: {
            failed: { increment: 1 },
            queued: { decrement: 1 },
          },
        });

        try {
          const lastQueueHistory = await prisma.leadStatusHistory.findFirst({
            where: { leadId: nextItem.leadId, toStatus: LeadStatus.QUEUED },
            orderBy: { createdAt: "desc" },
          });
          const revertStatus =
            lastQueueHistory?.fromStatus === LeadStatus.READY_FOR_OUTREACH
              ? LeadStatus.READY_FOR_OUTREACH
              : LeadStatus.NEW;

          await transitionLeadStatus({
            leadId: nextItem.leadId,
            to: revertStatus,
            reason: "bulk_message_failed_without_send",
            actor: "worker",
          });
        } catch (statusErr) {
          logger.warn("[BULK] Failed to revert lead status on failed dispatch", {
            leadId: nextItem.leadId,
            error: statusErr instanceof Error ? statusErr.message : String(statusErr),
          });
        }
      }

      // 5. Safety boundary: check if error is a platform challenge, rate limit, or auth restriction
      if (!sendResult.success) {
        const isRestricted =
          Boolean(sendResult.isFatalPlatformRestriction) ||
          (Boolean(sendResult.errorCode) && RESTRICTION_ERROR_CODES.has(sendResult.errorCode));

        if (isRestricted) {
          logger.warn("[BULK_ROTATION] Sender account restricted, removing from pool", {
            senderId: candidateSender.id,
            username: candidateSender.username,
            errorCode: sendResult.errorCode,
            error: sendResult.error,
          });

          // Mark restricted sender in database
          await prisma.instagramSenderAccount.update({
            where: { id: candidateSender.id },
            data: {
              status: "AUTH_REQUIRED",
              lastError: `[${sendResult.errorCode}] ${sendResult.error}`,
            },
          }).catch(() => {});

          // Remove restricted sender from active rotation pool
          activeSenders = activeSenders.filter((s) => s.id !== candidateSender.id);

          if (activeSenders.length === 0) {
            await prisma.bulkMessageJob.update({
              where: { id: jobId },
              data: {
                status: BulkMessageJobStatus.PAUSED,
                errorMessage: `Job paused automatically: all sender accounts restricted. Last error: [${sendResult.errorCode}] ${sendResult.error}`,
              },
            });
            break; // Stop immediately when all accounts in pool are exhausted
          }
          // Healthy accounts still remain in activeSenders! Rotate to next healthy account.
        } else {
          // Advance rotation index on normal item failure
          roundRobinIndex++;
        }
      }

      // Brief sequential breathing interval (1.5s) between items
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // 6. Determine final status if not paused or cancelled
    const finalJob = await prisma.bulkMessageJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });

    if (
      finalJob &&
      finalJob.status !== BulkMessageJobStatus.PAUSED &&
      finalJob.status !== BulkMessageJobStatus.CANCELLED
    ) {
      const remainingQueued = await prisma.bulkMessageItem.count({
        where: { jobId, status: BulkMessageItemStatus.QUEUED },
      });

      if (remainingQueued === 0) {
        const [sentCount, failedCount, unknownCount] = await Promise.all([
          prisma.bulkMessageItem.count({ where: { jobId, status: BulkMessageItemStatus.SENT } }),
          prisma.bulkMessageItem.count({ where: { jobId, status: BulkMessageItemStatus.FAILED } }),
          prisma.bulkMessageItem.count({ where: { jobId, status: BulkMessageItemStatus.UNKNOWN } }),
        ]);

        const finalStatus =
          failedCount === 0 && unknownCount === 0
            ? BulkMessageJobStatus.COMPLETED
            : sentCount > 0
            ? BulkMessageJobStatus.PARTIAL
            : BulkMessageJobStatus.FAILED;

        await prisma.bulkMessageJob.update({
          where: { id: jobId },
          data: {
            status: finalStatus,
            completedAt: new Date(),
          },
        });
      }
    }
  } finally {
    activeJobWorkers.delete(jobId);
  }
}

/**
 * Conservative recovery mechanism for stale PROCESSING items after server restart or crash.
 * Safely resolves items without duplicate sends or blind resending.
 */
export async function recoverStaleProcessingItems(
  jobId?: string,
  staleThresholdMs: number = 5 * 60 * 1000,
) {
  const prisma = getPrismaClient();
  const thresholdDate = new Date(Date.now() - staleThresholdMs);

  const staleItems = await prisma.bulkMessageItem.findMany({
    where: {
      status: BulkMessageItemStatus.PROCESSING,
      startedAt: { lte: thresholdDate },
      ...(jobId ? { jobId } : {}),
    },
    include: {
      messageAttempts: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  const recovered: Array<{ id: string; resolution: string }> = [];

  for (const item of staleItems) {
    const latestAttempt = item.messageAttempts[0];
    // Centralized decision (no blind resend of unconfirmed deliveries).
    const resolution = decideStaleRecovery(
      latestAttempt?.status as string | undefined,
    );

    switch (resolution) {
      case "RESOLVED_SENT":
        await prisma.bulkMessageItem.update({
          where: { id: item.id },
          data: {
            status: BulkMessageItemStatus.SENT,
            completedAt: latestAttempt?.completedAt ?? new Date(),
            providerMessageId: latestAttempt?.providerMessageId ?? null,
          },
        });
        break;
      case "RESOLVED_FAILED":
        await prisma.bulkMessageItem.update({
          where: { id: item.id },
          data: {
            status: BulkMessageItemStatus.FAILED,
            completedAt: latestAttempt?.completedAt ?? new Date(),
            errorCode: latestAttempt?.errorCode ?? "WORKER_ERROR",
            errorMessage:
              latestAttempt?.errorMessage ??
              "The message could not be delivered.",
          },
        });
        break;
      case "MARKED_UNKNOWN":
        await prisma.bulkMessageItem.update({
          where: { id: item.id },
          data: {
            status: BulkMessageItemStatus.UNKNOWN,
            completedAt: new Date(),
            errorCode: "UNKNOWN",
            errorMessage:
              "Worker interrupted while processing. Delivery could not be confirmed; it will not be resent automatically.",
          },
        });
        break;
      default:
        // No attempt record exists (crashed before dispatch started): safe to re-queue.
        await prisma.bulkMessageItem.update({
          where: { id: item.id },
          data: {
            status: BulkMessageItemStatus.QUEUED,
            startedAt: null,
          },
        });
        break;
    }

    recovered.push({ id: item.id, resolution });
  }

  return { recoveredCount: recovered.length, details: recovered };
}

/**
 * Explicitly retries a FAILED or UNKNOWN bulk message item by queueing a new attempt.
 */
export async function retryBulkMessageItem(
  jobId: string,
  itemId: string,
  userId?: string,
): Promise<BulkJobStatusResponse> {
  const prisma = getPrismaClient();

  const job = await prisma.bulkMessageJob.findFirst({
    where: {
      id: jobId,
      ...(userId ? { userId } : {}),
    },
  });
  if (!job) {
    throw new NotFoundError("JOB_NOT_FOUND", `Job "${jobId}" not found or unauthorized.`);
  }

  const item = await prisma.bulkMessageItem.findFirst({
    where: { id: itemId, jobId },
  });
  if (!item) {
    throw new NotFoundError("ITEM_NOT_FOUND", `Item "${itemId}" not found in job "${jobId}".`);
  }

  if (!isManualRetryAllowed(item.status)) {
    throw new BadRequestError(
      "INVALID_RETRY_STATE",
      `Cannot retry item in status "${item.status}". Only FAILED or UNKNOWN items can be retried.`,
      { userMessage: "This message cannot be retried in its current state." },
    );
  }

  // STEP 2 & 4: Prevent double-sends if lead has confirmed SENT idempotency record
  const confirmedSent = await prisma.outboundSendIdempotency.findFirst({
    where: {
      campaignId: job.campaignId,
      leadId: item.leadId,
      status: "SENT",
    },
  });
  if (confirmedSent) {
    throw new BadRequestError(
      "ALREADY_SENT",
      "This lead already received a confirmed sent message in this campaign; resend is blocked to prevent duplicate DMs.",
      { userMessage: "This recipient already received a confirmed message in this campaign." },
    );
  }

  const previousStatus = item.status;
  const nextAttemptNumber = item.attempts + 1;
  const newIdempotencyKey = formatScopedIdempotencyKey(undefined, job.campaignId, item.leadId, nextAttemptNumber);

  await prisma.$transaction(async (tx) => {
    await tx.bulkMessageItem.update({
      where: { id: itemId },
      data: {
        status: BulkMessageItemStatus.QUEUED,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        idempotencyKey: newIdempotencyKey,
      },
    });

    const jobData: Prisma.BulkMessageJobUpdateInput = {
      queued: { increment: 1 },
    };
    if (previousStatus === BulkMessageItemStatus.FAILED) {
      jobData.failed = { decrement: 1 };
    } else if (previousStatus === BulkMessageItemStatus.UNKNOWN) {
      jobData.unknown = { decrement: 1 };
    }

    if (
      job.status === BulkMessageJobStatus.COMPLETED ||
      job.status === BulkMessageJobStatus.PARTIAL ||
      job.status === BulkMessageJobStatus.FAILED
    ) {
      jobData.status = BulkMessageJobStatus.RUNNING;
      jobData.completedAt = null;
    }

    await tx.bulkMessageJob.update({
      where: { id: jobId },
      data: jobData,
    });
  });

  if (job.status !== BulkMessageJobStatus.PAUSED) {
    Promise.resolve().then(() => {
      dispatchBulkJobQueue(jobId).catch((err) => {
        logger.error("WORKER_ERROR", err, {
          jobId,
          operation: "bulk_worker_retry",
        });
      });
    });
  }

  return getBulkMessageJobStatus(jobId, userId);
}

/**
 * Pauses a BulkMessageJob. Currently in-flight item finishes; queue stops.
 */
export async function pauseBulkMessageJob(
  jobId: string,
  userId?: string,
): Promise<BulkJobStatusResponse> {
  const prisma = getPrismaClient();

  const job = await prisma.bulkMessageJob.findFirst({
    where: {
      id: jobId,
      ...(userId ? { userId } : {}),
    },
  });

  if (!job) {
    throw new NotFoundError("JOB_NOT_FOUND", `Bulk message job "${jobId}" was not found.`);
  }

  if (
    job.status !== BulkMessageJobStatus.QUEUED &&
    job.status !== BulkMessageJobStatus.RUNNING
  ) {
    throw new BadRequestError(
      "CANNOT_PAUSE",
      `Cannot pause job in status "${job.status}". Only QUEUED or RUNNING jobs can be paused.`,
    );
  }

  await prisma.bulkMessageJob.update({
    where: { id: jobId },
    data: { status: BulkMessageJobStatus.PAUSED },
  });

  return getBulkMessageJobStatus(jobId, userId);
}

/**
 * Resumes a PAUSED BulkMessageJob.
 */
export async function resumeBulkMessageJob(
  jobId: string,
  userId?: string,
): Promise<BulkJobStatusResponse> {
  const prisma = getPrismaClient();

  const job = await prisma.bulkMessageJob.findFirst({
    where: {
      id: jobId,
      ...(userId ? { userId } : {}),
    },
  });

  if (!job) {
    throw new NotFoundError("JOB_NOT_FOUND", `Bulk message job "${jobId}" was not found.`);
  }

  if (job.status !== BulkMessageJobStatus.PAUSED) {
    throw new BadRequestError(
      "CANNOT_RESUME",
      `Cannot resume job in status "${job.status}". Only PAUSED jobs can be resumed.`,
    );
  }

  // Update status to RUNNING in database
  await prisma.bulkMessageJob.update({
    where: { id: jobId },
    data: {
      status: BulkMessageJobStatus.RUNNING,
      errorMessage: null,
    },
  });

  // Trigger worker loop asynchronously
  Promise.resolve().then(() => {
    dispatchBulkJobQueue(job.id).catch((err) => {
      logger.error("WORKER_ERROR", err, { jobId: job.id, operation: "bulk_worker" });
    });
  });

  return getBulkMessageJobStatus(jobId, userId);
}

/**
 * Cancels a BulkMessageJob and marks remaining QUEUED items as CANCELLED.
 */
export async function cancelBulkMessageJob(
  jobId: string,
  userId?: string,
): Promise<BulkJobStatusResponse> {
  const prisma = getPrismaClient();

  const job = await prisma.bulkMessageJob.findFirst({
    where: {
      id: jobId,
      ...(userId ? { userId } : {}),
    },
  });

  if (!job) {
    throw new NotFoundError("JOB_NOT_FOUND", `Bulk message job "${jobId}" was not found.`);
  }

  if (
    job.status === BulkMessageJobStatus.COMPLETED ||
    job.status === BulkMessageJobStatus.CANCELLED
  ) {
    throw new BadRequestError(
      "ALREADY_TERMINAL",
      `Cannot cancel job in terminal status "${job.status}".`,
    );
  }

  // Mark all remaining QUEUED items as CANCELLED and revert lead statuses
  await prisma.$transaction(async (tx) => {
    const queuedItems = await tx.bulkMessageItem.findMany({
      where: { jobId, status: BulkMessageItemStatus.QUEUED },
      select: { id: true, leadId: true },
    });

    const cancelledCount = await tx.bulkMessageItem.updateMany({
      where: { jobId, status: BulkMessageItemStatus.QUEUED },
      data: { status: BulkMessageItemStatus.CANCELLED },
    });

    await tx.bulkMessageJob.update({
      where: { id: jobId },
      data: {
        status: BulkMessageJobStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelled: cancelledCount.count,
        queued: 0,
      },
    });

    for (const item of queuedItems) {
      const lastQueueHistory = await tx.leadStatusHistory.findFirst({
        where: { leadId: item.leadId, toStatus: LeadStatus.QUEUED },
        orderBy: { createdAt: "desc" },
      });
      const revertStatus =
        lastQueueHistory?.fromStatus === LeadStatus.READY_FOR_OUTREACH
          ? LeadStatus.READY_FOR_OUTREACH
          : LeadStatus.NEW;

      await transitionLeadStatus({
        leadId: item.leadId,
        to: revertStatus,
        reason: "bulk_job_cancelled",
        actor: userId ? `user:${userId}` : "worker",
        tx,
      });
    }
  });

  return getBulkMessageJobStatus(jobId, userId);
}

/**
 * Starts execution of a QUEUED job.
 */
export async function startBulkMessageJob(
  jobId: string,
  userId?: string,
): Promise<BulkJobStatusResponse> {
  const prisma = getPrismaClient();

  const job = await prisma.bulkMessageJob.findFirst({
    where: {
      id: jobId,
      ...(userId ? { userId } : {}),
    },
  });

  if (!job) {
    throw new NotFoundError("JOB_NOT_FOUND", `Bulk message job "${jobId}" was not found.`);
  }

  if (job.status !== BulkMessageJobStatus.QUEUED) {
    throw new BadRequestError(
      "CANNOT_START",
      `Cannot start job in status "${job.status}". Only QUEUED jobs can be started.`,
    );
  }

  // Trigger worker loop asynchronously
  Promise.resolve().then(() => {
    dispatchBulkJobQueue(job.id).catch((err) => {
      logger.error("WORKER_ERROR", err, { jobId: job.id, operation: "bulk_worker" });
    });
  });

  return getBulkMessageJobStatus(jobId, userId);
}

/**
 * Lists bulk message jobs for a campaign.
 */
export async function listCampaignBulkJobs(
  campaignId: string,
  userId?: string,
): Promise<BulkJobStatusResponse[]> {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: { id: true },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign "${campaignId}" was not found.`);
  }

  const jobs = await prisma.bulkMessageJob.findMany({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return Promise.all(jobs.map((j) => getBulkMessageJobStatus(j.id, userId)));
}
