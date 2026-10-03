import "server-only";

import { Prisma } from "@/generated/prisma/client";
import {
  ApprovalMode,
  DraftReviewAction,
  DraftStatus,
  LeadStatus,
} from "@/generated/prisma/enums";
import { getPrismaClient } from "@/lib/db/prisma";
import { getServerEnv } from "@/lib/env";
import {
  BadRequestError,
  NotFoundError,
  QualityBlockedError,
  QualityWarningsRequiredError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { transitionLeadStatus } from "@/lib/services/lead/lead-status-service";
import { draftBodyHash, runQualityGate } from "../quality";
import { MAX_MESSAGE_LENGTH } from "../quality/rules";
import { editDistance } from "../quality/similarity";
import { generateAndCheckDraft, type GenerateAndCheckResult } from "./draft-pipeline-service";

const AUTO_APPROVE_MIN_SCORE = 90;
const REVIEW_HISTORY_LIMIT = 200;
const REJECT_REASONS = new Set([
  "TOO_GENERIC",
  "WRONG_FACT",
  "TOO_SALESY",
  "BAD_TONE",
  "NOT_TARGET",
  "TOO_LONG",
  "OTHER",
]);

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(getServerEnv(name) ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function finalBody(draft: { editedBody: string | null; body: string }): string {
  return draft.editedBody ?? draft.body;
}

function sanitizeEditedBody(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

const DRAFT_INCLUDE = {
  lead: {
    select: {
      id: true,
      username: true,
      fullName: true,
      followersCount: true,
      profilePictureUrl: true,
      status: true,
      leadScore: true,
      aiStatus: true,
    },
  },
  campaign: {
    select: {
      id: true,
      approvalMode: true,
      autoApproveMinScore: true,
      qualityMaxRegenerations: true,
    },
  },
} satisfies Prisma.MessageDraftInclude;

type DraftWithRelations = Prisma.MessageDraftGetPayload<{ include: typeof DRAFT_INCLUDE }>;

async function loadDraftForUser(draftId: string, userId: string): Promise<DraftWithRelations> {
  const draft = await getPrismaClient().messageDraft.findFirst({
    where: { id: draftId, userId },
    include: DRAFT_INCLUDE,
  });
  if (!draft) {
    throw new NotFoundError("DRAFT_NOT_FOUND", `Draft "${draftId}" was not found.`);
  }
  return draft;
}

function serializeDraft(draft: DraftWithRelations, reviews: unknown[] = []) {
  return {
    id: draft.id,
    leadId: draft.leadId,
    campaignId: draft.campaignId,
    body: finalBody(draft),
    generatedBody: draft.body,
    subject: draft.subject,
    status: draft.status,
    kind: draft.kind,
    replyToMessageId: draft.replyToMessageId,
    promptVersion: draft.promptVersion,
    model: draft.model,
    wordCount: draft.wordCount,
    personalizationPointsUsed: draft.personalizationPointsUsed,
    qualityVersion: draft.qualityVersion,
    qualityScore: draft.qualityScore,
    qualityPassed: draft.qualityPassed,
    qualityResult: draft.qualityResult,
    qualityCheckedAt: draft.qualityCheckedAt,
    regenerationCount: draft.regenerationCount,
    editDistance: draft.editDistance,
    warningOverrides: draft.warningOverrides,
    approvedAt: draft.approvedAt,
    approvedByType: draft.approvedByType,
    rejectedAt: draft.rejectedAt,
    rejectReasonCode: draft.rejectReasonCode,
    rejectNotes: draft.rejectNotes,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    lead: draft.lead,
    reviews,
  };
}

async function writeReview(input: {
  draftId: string;
  userId?: string | null;
  actorType: "user" | "system";
  action: DraftReviewAction;
  reasonCode?: string | null;
  notes?: string | null;
  meta?: Prisma.InputJsonValue | null;
  bodyHashBefore?: string | null;
  bodyHashAfter?: string | null;
}): Promise<void> {
  await getPrismaClient().draftReview.create({
    data: {
      draftId: input.draftId,
      userId: input.userId ?? null,
      actorType: input.actorType,
      action: input.action,
      reasonCode: input.reasonCode ?? null,
      notes: input.notes ?? null,
      meta: input.meta ?? undefined,
      bodyHashBefore: input.bodyHashBefore ?? null,
      bodyHashAfter: input.bodyHashAfter ?? null,
    },
  });
}

async function moveLeadBackToQualified(
  leadId: string,
  currentStatus: LeadStatus,
  userId: string,
): Promise<boolean> {
  if (currentStatus !== LeadStatus.READY_FOR_OUTREACH) return false;
  const result = await transitionLeadStatus({
    leadId,
    to: LeadStatus.QUALIFIED,
    reason: "draft_approval_revoked",
    actor: `user:${userId}`,
  });
  return result.transitioned;
}

export type ApproveDraftResult = {
  draftId: string;
  status: DraftStatus;
  approvedBodyHash: string;
  overriddenWarnings: string[];
  leadTransitioned: boolean;
};

/**
 * Approves a draft. Re-runs the gate with fresh DNC/duplicate/contact state;
 * BLOCKER failures reject the approval (draft -> BLOCKED). Every failed warning
 * must be listed in `overrideWarnings` and is recorded in DraftReview.
 */
export async function approveDraft(input: {
  userId: string;
  draftId: string;
  overrideWarnings?: string[];
}): Promise<ApproveDraftResult> {
  const prisma = getPrismaClient();
  const draft = await loadDraftForUser(input.draftId, input.userId);

  if (draft.status === DraftStatus.APPROVED) {
    return {
      draftId: draft.id,
      status: DraftStatus.APPROVED,
      approvedBodyHash: draft.approvedBodyHash ?? draftBodyHash(finalBody(draft)),
      overriddenWarnings: [],
      leadTransitioned: false,
    };
  }
  if (draft.status !== DraftStatus.PENDING_REVIEW) {
    throw new BadRequestError(
      "DRAFT_NOT_REVIEWABLE",
      `Draft status ${draft.status} cannot be approved.`,
    );
  }

  const result = await runQualityGate({ draftId: draft.id, applyStatus: false });
  if (!result.passed) {
    await prisma.messageDraft.update({
      where: { id: draft.id },
      data: { status: DraftStatus.BLOCKED },
    });
    await writeReview({
      draftId: draft.id,
      userId: input.userId,
      actorType: "user",
      action: DraftReviewAction.RECHECK,
      meta: { blockedBy: result.blockers.map((check) => check.id) },
    });
    throw new QualityBlockedError(result.blockers.map((check) => check.id));
  }

  const warningIds = result.warnings.map((check) => check.id);
  const provided = new Set(input.overrideWarnings ?? []);
  const missing = warningIds.filter((id) => !provided.has(id));
  if (missing.length > 0) {
    throw new QualityWarningsRequiredError(warningIds);
  }
  const overriddenWarnings = warningIds.filter((id) => provided.has(id));

  const body = finalBody(draft);
  const hash = draftBodyHash(body);

  await prisma.$transaction([
    ...overriddenWarnings.map((id) =>
      prisma.draftReview.create({
        data: {
          draftId: draft.id,
          userId: input.userId,
          actorType: "user",
          action: DraftReviewAction.OVERRIDE_WARNING,
          reasonCode: id,
        },
      }),
    ),
    prisma.messageDraft.update({
      where: { id: draft.id },
      data: {
        status: DraftStatus.APPROVED,
        approvedBodyHash: hash,
        approvedAt: new Date(),
        approvedByType: "user",
        approvedById: input.userId,
        warningOverrides: overriddenWarnings as unknown as Prisma.InputJsonValue,
        rejectedAt: null,
        rejectReasonCode: null,
        rejectNotes: null,
      },
    }),
    prisma.draftReview.create({
      data: {
        draftId: draft.id,
        userId: input.userId,
        actorType: "user",
        action: DraftReviewAction.APPROVE,
        bodyHashAfter: hash,
      },
    }),
  ]);

  let leadTransitioned = false;
  if (draft.lead.status === LeadStatus.QUALIFIED) {
    const transition = await transitionLeadStatus({
      leadId: draft.leadId,
      to: LeadStatus.READY_FOR_OUTREACH,
      reason: "draft_approved",
      actor: `user:${input.userId}`,
    });
    leadTransitioned = transition.transitioned;
  }

  logger.info("[QUALITY] draft approved", {
    draftId: draft.id,
    userId: input.userId,
    overriddenWarnings: overriddenWarnings.length,
  });

  return {
    draftId: draft.id,
    status: DraftStatus.APPROVED,
    approvedBodyHash: hash,
    overriddenWarnings,
    leadTransitioned,
  };
}

export type RejectDraftResult = {
  draftId: string;
  status: DraftStatus;
  regeneratedDraftId: string | null;
};

export async function rejectDraft(input: {
  userId: string;
  draftId: string;
  reasonCode: string;
  notes?: string;
  regenerate?: boolean;
}): Promise<RejectDraftResult> {
  if (!REJECT_REASONS.has(input.reasonCode)) {
    throw new BadRequestError("INVALID_REJECT_REASON", "Unknown reject reason code.");
  }
  const prisma = getPrismaClient();
  const draft = await loadDraftForUser(input.draftId, input.userId);
  if (draft.status === DraftStatus.SENT) {
    throw new BadRequestError("DRAFT_ALREADY_SENT", "A sent draft cannot be rejected.");
  }

  await prisma.messageDraft.update({
    where: { id: draft.id },
    data: {
      status: DraftStatus.REJECTED,
      rejectedAt: new Date(),
      rejectReasonCode: input.reasonCode,
      rejectNotes: input.notes ?? null,
      approvedBodyHash: null,
      approvedAt: null,
      approvedByType: null,
      approvedById: null,
      warningOverrides: Prisma.DbNull,
    },
  });
  await writeReview({
    draftId: draft.id,
    userId: input.userId,
    actorType: "user",
    action: DraftReviewAction.REJECT,
    reasonCode: input.reasonCode,
    notes: input.notes ?? null,
  });

  let regeneratedDraftId: string | null = null;
  if (input.regenerate) {
    const regenerated = await generateAndCheckDraft({ userId: input.userId, leadId: draft.leadId });
    regeneratedDraftId = regenerated.draftId;
  }

  return { draftId: draft.id, status: DraftStatus.REJECTED, regeneratedDraftId };
}

export type EditDraftResult = {
  draftId: string;
  status: DraftStatus;
  editDistance: number;
  passed: boolean;
  leadMovedBack: boolean;
  warnings: string[];
  blockers: string[];
};

/**
 * Stores an edited body, invalidates any prior approval, and re-runs the gate.
 * An edited body is never sendable until it is approved again.
 */
export async function editDraft(input: {
  userId: string;
  draftId: string;
  newBody: string;
}): Promise<EditDraftResult> {
  const prisma = getPrismaClient();
  const draft = await loadDraftForUser(input.draftId, input.userId);
  if (draft.status === DraftStatus.SENT) {
    throw new BadRequestError("DRAFT_ALREADY_SENT", "A sent draft cannot be edited.");
  }

  const body = sanitizeEditedBody(input.newBody);
  if (body.length === 0) {
    throw new BadRequestError("EMPTY_BODY", "Draft body cannot be empty.");
  }
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new BadRequestError("MESSAGE_TOO_LONG", `Draft body exceeds ${MAX_MESSAGE_LENGTH} characters.`);
  }

  const previousBody = draft.editedBody ?? draft.body;
  const distance = editDistance(previousBody, body, 2000);
  const wasApproved = draft.status === DraftStatus.APPROVED;

  await prisma.messageDraft.update({
    where: { id: draft.id },
    data: {
      editedBody: body,
      editDistance: distance,
      bodyHash: draftBodyHash(body),
      status: DraftStatus.DRAFT,
      approvedBodyHash: null,
      approvedAt: null,
      approvedByType: null,
      approvedById: null,
      warningOverrides: Prisma.DbNull,
    },
  });
  await writeReview({
    draftId: draft.id,
    userId: input.userId,
    actorType: "user",
    action: DraftReviewAction.EDIT,
    meta: { editDistance: distance },
  });

  const result = await runQualityGate({ draftId: draft.id, applyStatus: true });
  const leadMovedBack = wasApproved
    ? await moveLeadBackToQualified(draft.leadId, draft.lead.status, input.userId)
    : false;

  return {
    draftId: draft.id,
    status: result.passed ? DraftStatus.PENDING_REVIEW : DraftStatus.DRAFT,
    editDistance: distance,
    passed: result.passed,
    leadMovedBack,
    warnings: result.warnings.map((check) => check.id),
    blockers: result.blockers.map((check) => check.id),
  };
}

export async function revokeApproval(input: {
  userId: string;
  draftId: string;
}): Promise<{ draftId: string; status: DraftStatus; leadMovedBack: boolean }> {
  const prisma = getPrismaClient();
  const draft = await loadDraftForUser(input.draftId, input.userId);
  if (draft.status !== DraftStatus.APPROVED) {
    throw new BadRequestError("DRAFT_NOT_APPROVED", "Only an approved draft can be revoked.");
  }
  await prisma.messageDraft.update({
    where: { id: draft.id },
    data: {
      status: DraftStatus.PENDING_REVIEW,
      approvedBodyHash: null,
      approvedAt: null,
      approvedByType: null,
      approvedById: null,
      warningOverrides: Prisma.DbNull,
    },
  });
  await writeReview({
    draftId: draft.id,
    userId: input.userId,
    actorType: "user",
    action: DraftReviewAction.REVOKE_APPROVAL,
  });
  const leadMovedBack = await moveLeadBackToQualified(draft.leadId, draft.lead.status, input.userId);
  return { draftId: draft.id, status: DraftStatus.PENDING_REVIEW, leadMovedBack };
}

export async function recheckDraft(input: {
  userId: string;
  draftId: string;
}): Promise<{ draftId: string; passed: boolean; status: DraftStatus; score: number; blockers: string[]; warnings: string[] }> {
  const draft = await loadDraftForUser(input.draftId, input.userId);
  const result = await runQualityGate({ draftId: draft.id, applyStatus: true });
  await writeReview({
    draftId: draft.id,
    userId: input.userId,
    actorType: "user",
    action: DraftReviewAction.RECHECK,
    meta: { passed: result.passed, score: result.score },
  });
  return {
    draftId: draft.id,
    passed: result.passed,
    status: result.passed ? DraftStatus.PENDING_REVIEW : DraftStatus.DRAFT,
    score: result.score,
    blockers: result.blockers.map((check) => check.id),
    warnings: result.warnings.map((check) => check.id),
  };
}

export async function regenerateDraft(input: {
  userId: string;
  draftId: string;
}): Promise<GenerateAndCheckResult> {
  const draft = await loadDraftForUser(input.draftId, input.userId);
  await writeReview({
    draftId: draft.id,
    userId: input.userId,
    actorType: "user",
    action: DraftReviewAction.REGENERATE,
  });
  return generateAndCheckDraft({ userId: input.userId, leadId: draft.leadId });
}

export async function getDraftWithReviews(input: { userId: string; draftId: string }) {
  const prisma = getPrismaClient();
  const draft = await prisma.messageDraft.findFirst({
    where: { id: input.draftId, userId: input.userId },
    include: {
      ...DRAFT_INCLUDE,
      reviews: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!draft) {
    throw new NotFoundError("DRAFT_NOT_FOUND", `Draft "${input.draftId}" was not found.`);
  }
  const { reviews, ...rest } = draft;
  return serializeDraft(rest as DraftWithRelations, reviews);
}

export type ReviewQueueInput = {
  userId: string;
  campaignId: string;
  status?: string;
  kind?: "OUTREACH" | "REPLY";
  minScore?: number;
  sort?: "score" | "created";
  page?: number;
  pageSize?: number;
};

export async function listReviewQueue(input: ReviewQueueInput) {
  const prisma = getPrismaClient();
  const campaign = await prisma.campaign.findFirst({
    where: { id: input.campaignId, userId: input.userId },
    select: { id: true },
  });
  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign "${input.campaignId}" was not found.`);
  }

  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.max(1, Math.min(100, Math.trunc(input.pageSize ?? 25)));

  const where: Prisma.MessageDraftWhereInput = { campaignId: input.campaignId };
  if (input.status && input.status in DraftStatus) {
    where.status = input.status as DraftStatus;
  } else if (!input.status) {
    where.status = { in: [DraftStatus.PENDING_REVIEW, DraftStatus.BLOCKED, DraftStatus.APPROVED, DraftStatus.REJECTED] };
  }
  if (input.kind && (input.kind === "OUTREACH" || input.kind === "REPLY")) {
    where.kind = input.kind;
  }
  if (typeof input.minScore === "number" && Number.isFinite(input.minScore)) {
    where.qualityScore = { gte: Math.trunc(input.minScore) };
  }

  const orderBy: Prisma.MessageDraftOrderByWithRelationInput[] =
    input.sort === "created"
      ? [{ createdAt: "desc" }]
      : [{ qualityScore: "desc" }, { createdAt: "desc" }];

  const [items, total] = await Promise.all([
    prisma.messageDraft.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: DRAFT_INCLUDE,
    }),
    prisma.messageDraft.count({ where }),
  ]);

  return {
    items: items.map((draft) => serializeDraft(draft as DraftWithRelations)),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    },
  };
}

export type BulkApproveResult = { draftId: string; ok: boolean; code?: string };

/** Bulk-approves up to 200 clean PENDING_REVIEW drafts. Each still re-runs the gate. */
export async function bulkApproveDrafts(input: {
  userId: string;
  campaignId: string;
  draftIds: string[];
}): Promise<{ results: BulkApproveResult[]; approvedCount: number }> {
  if (!Array.isArray(input.draftIds) || input.draftIds.length === 0) {
    throw new BadRequestError("MISSING_DRAFT_IDS", '"draftIds" is required.');
  }
  if (input.draftIds.length > 200) {
    throw new BadRequestError("TOO_MANY_DRAFTS", "At most 200 drafts can be approved per request.");
  }
  const prisma = getPrismaClient();
  const campaign = await prisma.campaign.findFirst({
    where: { id: input.campaignId, userId: input.userId },
    select: { id: true },
  });
  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign "${input.campaignId}" was not found.`);
  }

  const drafts = await prisma.messageDraft.findMany({
    where: { id: { in: input.draftIds }, campaignId: input.campaignId, userId: input.userId },
    select: { id: true, status: true, qualityPassed: true, qualityResult: true },
  });
  const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));

  const results: BulkApproveResult[] = [];
  let approvedCount = 0;
  for (const draftId of input.draftIds) {
    const draft = draftsById.get(draftId);
    if (!draft) {
      results.push({ draftId, ok: false, code: "NOT_FOUND" });
      continue;
    }
    if (draft.status !== DraftStatus.PENDING_REVIEW) {
      results.push({ draftId, ok: false, code: "NOT_REVIEWABLE" });
      continue;
    }
    if (draft.qualityPassed !== true) {
      results.push({ draftId, ok: false, code: "QUALITY_NOT_PASSED" });
      continue;
    }
    const quality = (draft.qualityResult ?? null) as { warnings?: unknown[] } | null;
    if ((quality?.warnings?.length ?? 0) > 0) {
      results.push({ draftId, ok: false, code: "HAS_WARNINGS" });
      continue;
    }
    try {
      await approveDraft({ userId: input.userId, draftId });
      results.push({ draftId, ok: true });
      approvedCount += 1;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "ERROR";
      results.push({ draftId, ok: false, code });
    }
  }
  return { results, approvedCount };
}

type HumanReviewStats = {
  reviewed: number;
  approvalRate: number;
  editRate: number;
  promptVersions: Set<string>;
};

async function getHumanReviewStats(campaignId: string): Promise<HumanReviewStats> {
  const prisma = getPrismaClient();
  const reviews = await prisma.draftReview.findMany({
    where: {
      draft: { campaignId },
      actorType: "user",
      action: { in: [DraftReviewAction.APPROVE, DraftReviewAction.REJECT] },
    },
    orderBy: { createdAt: "desc" },
    take: REVIEW_HISTORY_LIMIT,
    include: { draft: { select: { promptVersion: true, editDistance: true } } },
  });
  const approvals = reviews.filter((review) => review.action === DraftReviewAction.APPROVE);
  const reviewed = reviews.length;
  const approvalRate = reviewed > 0 ? approvals.length / reviewed : 0;
  const editedApprovals = approvals.filter((review) => (review.draft.editDistance ?? 0) > 0).length;
  const editRate = approvals.length > 0 ? editedApprovals / approvals.length : 0;
  const promptVersions = new Set(reviews.map((review) => review.draft.promptVersion));
  return { reviewed, approvalRate, editRate, promptVersions };
}

export type AutoApprovalEligibility = {
  eligible: boolean;
  unmet: string[];
  metrics: {
    enabled: boolean;
    reviewed: number;
    minReviewed: number;
    approvalRate: number;
    minApprovalRate: number;
    editRate: number;
    maxEditRate: number;
  };
};

/** Conditions to switch a campaign to AUTO_ELIGIBLE (does not require the mode itself). */
export async function getAutoApprovalEligibility(campaignId: string): Promise<AutoApprovalEligibility> {
  const enabled = getServerEnv("AUTO_APPROVAL_ENABLED") === "true";
  const minReviewed = numberFromEnv("AUTO_APPROVE_MIN_REVIEWED", 200);
  const minApprovalRate = numberFromEnv("AUTO_APPROVE_MIN_APPROVAL_RATE", 0.8);
  const maxEditRate = numberFromEnv("AUTO_APPROVE_MAX_EDIT_RATE", 0.3);

  const stats = await getHumanReviewStats(campaignId);
  const unmet: string[] = [];
  if (!enabled) unmet.push("auto_approval_disabled: set AUTO_APPROVAL_ENABLED=true");
  if (stats.reviewed < minReviewed) {
    unmet.push(`insufficient_human_reviews: ${stats.reviewed}/${minReviewed}`);
  }
  if (stats.approvalRate < minApprovalRate) {
    unmet.push(`approval_rate_too_low: ${stats.approvalRate.toFixed(2)} < ${minApprovalRate}`);
  }
  if (stats.editRate > maxEditRate) {
    unmet.push(`edit_rate_too_high: ${stats.editRate.toFixed(2)} > ${maxEditRate}`);
  }

  return {
    eligible: unmet.length === 0,
    unmet,
    metrics: {
      enabled,
      reviewed: stats.reviewed,
      minReviewed,
      approvalRate: stats.approvalRate,
      minApprovalRate,
      editRate: stats.editRate,
      maxEditRate,
    },
  };
}

export type AutoApprovalRunResult = {
  evaluated: boolean;
  approved: number;
  reason?: string;
  unmet?: string[];
  skipped: Array<{ draftId: string; reason: string }>;
};

/** Auto-approves only clean drafts, only when the kill switch + thresholds allow it. */
export async function evaluateAutoApproval(campaignId: string): Promise<AutoApprovalRunResult> {
  const prisma = getPrismaClient();
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, approvalMode: true, autoApproveMinScore: true },
  });
  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign "${campaignId}" was not found.`);
  }
  if (getServerEnv("AUTO_APPROVAL_ENABLED") !== "true") {
    return { evaluated: false, approved: 0, reason: "auto_approval_disabled", skipped: [] };
  }
  if (campaign.approvalMode !== ApprovalMode.AUTO_ELIGIBLE) {
    return { evaluated: false, approved: 0, reason: "manual_mode", skipped: [] };
  }
  const eligibility = await getAutoApprovalEligibility(campaignId);
  if (!eligibility.eligible) {
    return { evaluated: false, approved: 0, reason: "thresholds_unmet", unmet: eligibility.unmet, skipped: [] };
  }

  const stats = await getHumanReviewStats(campaignId);
  const candidates = await prisma.messageDraft.findMany({
    where: { campaignId, status: DraftStatus.PENDING_REVIEW },
    orderBy: { createdAt: "asc" },
    take: 200,
    include: { lead: { select: { id: true, status: true, leadScore: true } } },
  });

  let approved = 0;
  const skipped: Array<{ draftId: string; reason: string }> = [];

  for (const draft of candidates) {
    if (!stats.promptVersions.has(draft.promptVersion)) {
      skipped.push({ draftId: draft.id, reason: "prompt_version_changed" });
      continue;
    }
    if (draft.qualityPassed !== true) {
      skipped.push({ draftId: draft.id, reason: "quality_not_passed" });
      continue;
    }
    if ((draft.qualityScore ?? 0) < AUTO_APPROVE_MIN_SCORE) {
      skipped.push({ draftId: draft.id, reason: "score_below_90" });
      continue;
    }
    const quality = (draft.qualityResult ?? null) as { warnings?: unknown[] } | null;
    const warningCount = Array.isArray(quality?.warnings) ? quality!.warnings!.length : 1;
    if (warningCount > 0) {
      skipped.push({ draftId: draft.id, reason: "has_warnings" });
      continue;
    }
    if ((draft.lead.leadScore ?? 0) < campaign.autoApproveMinScore) {
      skipped.push({ draftId: draft.id, reason: "lead_score_below_threshold" });
      continue;
    }

    const body = finalBody(draft);
    const hash = draftBodyHash(body);
    await prisma.$transaction([
      prisma.messageDraft.update({
        where: { id: draft.id },
        data: {
          status: DraftStatus.APPROVED,
          approvedBodyHash: hash,
          approvedAt: new Date(),
          approvedByType: "system_auto",
          approvedById: null,
        },
      }),
      prisma.draftReview.create({
        data: {
          draftId: draft.id,
          actorType: "system",
          action: DraftReviewAction.AUTO_APPROVE,
          bodyHashAfter: hash,
        },
      }),
    ]);
    if (draft.lead.status === LeadStatus.QUALIFIED) {
      await transitionLeadStatus({
        leadId: draft.lead.id,
        to: LeadStatus.READY_FOR_OUTREACH,
        reason: "draft_auto_approved",
        actor: "system",
      }).catch(() => undefined);
    }
    approved += 1;
  }

  logger.info("[QUALITY] auto approval run", { campaignId, approved, skipped: skipped.length });
  return { evaluated: true, approved, skipped };
}

export type ReviewStats = {
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

export async function getReviewStats(input: {
  campaignId: string;
  userId: string;
  from?: Date;
  to?: Date;
}): Promise<ReviewStats> {
  const prisma = getPrismaClient();
  const campaign = await prisma.campaign.findFirst({
    where: { id: input.campaignId, userId: input.userId },
    select: { id: true },
  });
  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign "${input.campaignId}" was not found.`);
  }

  const createdAt: Prisma.DateTimeFilter = {};
  if (input.from) createdAt.gte = input.from;
  if (input.to) createdAt.lte = input.to;

  const drafts = await prisma.messageDraft.findMany({
    where: { campaignId: input.campaignId, ...(input.from || input.to ? { createdAt } : {}) },
    select: {
      status: true,
      editDistance: true,
      qualityScore: true,
      promptVersion: true,
      qualityVersion: true,
      qualityResult: true,
      rejectReasonCode: true,
    },
  });

  const counts: Record<string, number> = {};
  let editedApproved = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  let editDistanceSum = 0;
  let editDistanceCount = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  const rejectReasons = new Map<string, number>();
  const failedRules = new Map<string, number>();
  const byPrompt = new Map<string, { count: number; scoreSum: number; scoreCount: number; approved: number; reviewed: number }>();
  const byQuality = new Map<string, { count: number; scoreSum: number; scoreCount: number }>();

  for (const draft of drafts) {
    counts[draft.status] = (counts[draft.status] ?? 0) + 1;
    if (typeof draft.qualityScore === "number") {
      scoreSum += draft.qualityScore;
      scoreCount += 1;
    }
    if (draft.editDistance !== null) {
      editDistanceSum += draft.editDistance;
      editDistanceCount += 1;
    }
    if (draft.status === DraftStatus.APPROVED) {
      approvedCount += 1;
      if ((draft.editDistance ?? 0) > 0) editedApproved += 1;
    }
    if (draft.status === DraftStatus.REJECTED) {
      rejectedCount += 1;
      if (draft.rejectReasonCode) {
        rejectReasons.set(draft.rejectReasonCode, (rejectReasons.get(draft.rejectReasonCode) ?? 0) + 1);
      }
    }
    const quality = (draft.qualityResult ?? null) as
      | { blockers?: Array<{ id?: string }>; warnings?: Array<{ id?: string }> }
      | null;
    for (const rule of [...(quality?.blockers ?? []), ...(quality?.warnings ?? [])]) {
      if (rule?.id) failedRules.set(rule.id, (failedRules.get(rule.id) ?? 0) + 1);
    }
    const promptEntry = byPrompt.get(draft.promptVersion) ?? {
      count: 0,
      scoreSum: 0,
      scoreCount: 0,
      approved: 0,
      reviewed: 0,
    };
    promptEntry.count += 1;
    if (typeof draft.qualityScore === "number") {
      promptEntry.scoreSum += draft.qualityScore;
      promptEntry.scoreCount += 1;
    }
    if (draft.status === DraftStatus.APPROVED) promptEntry.approved += 1;
    if (draft.status === DraftStatus.APPROVED || draft.status === DraftStatus.REJECTED) {
      promptEntry.reviewed += 1;
    }
    byPrompt.set(draft.promptVersion, promptEntry);

    const qualityVersion = draft.qualityVersion ?? "unknown";
    const qualityEntry = byQuality.get(qualityVersion) ?? { count: 0, scoreSum: 0, scoreCount: 0 };
    qualityEntry.count += 1;
    if (typeof draft.qualityScore === "number") {
      qualityEntry.scoreSum += draft.qualityScore;
      qualityEntry.scoreCount += 1;
    }
    byQuality.set(qualityVersion, qualityEntry);
  }

  const reviewed = approvedCount + rejectedCount;
  const total = drafts.length;
  const sortDesc = (a: { count: number }, b: { count: number }) => b.count - a.count;

  return {
    total,
    counts,
    approvalRate: reviewed > 0 ? approvedCount / reviewed : 0,
    rejectionRate: reviewed > 0 ? rejectedCount / reviewed : 0,
    editRate: approvedCount > 0 ? editedApproved / approvedCount : 0,
    averageEditDistance: editDistanceCount > 0 ? editDistanceSum / editDistanceCount : 0,
    blockedRate: total > 0 ? (counts[DraftStatus.BLOCKED] ?? 0) / total : 0,
    averageQualityScore: scoreCount > 0 ? scoreSum / scoreCount : 0,
    topRejectReasons: Array.from(rejectReasons.entries())
      .map(([reasonCode, count]) => ({ reasonCode, count }))
      .sort(sortDesc),
    topFailedRules: Array.from(failedRules.entries())
      .map(([ruleId, count]) => ({ ruleId, count }))
      .sort(sortDesc),
    byPromptVersion: Array.from(byPrompt.entries())
      .map(([promptVersion, value]) => ({
        promptVersion,
        count: value.count,
        averageScore: value.scoreCount > 0 ? value.scoreSum / value.scoreCount : 0,
        approvalRate: value.reviewed > 0 ? value.approved / value.reviewed : 0,
      }))
      .sort((a, b) => b.count - a.count),
    byQualityVersion: Array.from(byQuality.entries())
      .map(([qualityVersion, value]) => ({
        qualityVersion,
        count: value.count,
        averageScore: value.scoreCount > 0 ? value.scoreSum / value.scoreCount : 0,
      }))
      .sort((a, b) => b.count - a.count),
  };
}
