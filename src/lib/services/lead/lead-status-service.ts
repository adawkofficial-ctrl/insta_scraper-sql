import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { LeadStatus } from "@/generated/prisma/enums";
import { getPrismaClient } from "@/lib/db/prisma";
import { BadRequestError, NotFoundError } from "@/lib/errors";

export { LeadStatus };

/**
 * Authoritative lead lifecycle transition map.
 *
 * Rules:
 * - any status -> DO_NOT_CONTACT is always permitted.
 * - DO_NOT_CONTACT can only be left via an explicit user action (actor starts with "user:").
 * - NEW -> QUALIFYING -> QUALIFIED -> READY_FOR_OUTREACH -> QUEUED -> CONTACTED -> REPLIED -> (INTERESTED | NOT_INTERESTED | FOLLOW_UP | MEETING) -> CONVERTED.
 * - QUEUED -> READY_FOR_OUTREACH (or NEW for legacy flow) permitted for cancelled/failed jobs.
 * - Legacy outreach shortcuts permitted (NEW -> QUEUED, NEW -> CONTACTED, QUALIFIED -> QUEUED, READY_FOR_OUTREACH -> CONTACTED).
 * - Backward jumps otherwise strictly rejected.
 */
export const ALLOWED_LEAD_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  [LeadStatus.NEW]: [
    LeadStatus.QUALIFYING,
    LeadStatus.QUEUED,             // Legacy direct queue
    LeadStatus.CONTACTED,          // Legacy direct send
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.QUALIFYING]: [
    LeadStatus.QUALIFIED,
    LeadStatus.NOT_INTERESTED,
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.QUALIFIED]: [
    LeadStatus.READY_FOR_OUTREACH,
    LeadStatus.QUEUED,             // Direct bulk queue
    LeadStatus.CONTACTED,          // Direct send
    LeadStatus.NOT_INTERESTED,
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.READY_FOR_OUTREACH]: [
    LeadStatus.QUALIFIED,          // Step 6: approval revoked/edited before send
    LeadStatus.QUEUED,
    LeadStatus.CONTACTED,          // Direct send
    LeadStatus.NOT_INTERESTED,
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.QUEUED]: [
    LeadStatus.CONTACTED,          // Successful delivery
    LeadStatus.READY_FOR_OUTREACH, // Job cancelled/failed without send
    LeadStatus.NEW,                // Job cancelled/failed from legacy NEW
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.CONTACTED]: [
    LeadStatus.REPLIED,
    LeadStatus.NOT_INTERESTED,
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.REPLIED]: [
    LeadStatus.INTERESTED,
    LeadStatus.NOT_INTERESTED,
    LeadStatus.FOLLOW_UP,
    LeadStatus.MEETING,
    LeadStatus.CONVERTED,
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.INTERESTED]: [
    LeadStatus.FOLLOW_UP,
    LeadStatus.MEETING,
    LeadStatus.CONVERTED,
    LeadStatus.NOT_INTERESTED,
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.FOLLOW_UP]: [
    LeadStatus.INTERESTED,
    LeadStatus.MEETING,
    LeadStatus.CONVERTED,
    LeadStatus.NOT_INTERESTED,
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.MEETING]: [
    LeadStatus.CONVERTED,
    LeadStatus.FOLLOW_UP,
    LeadStatus.NOT_INTERESTED,
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.CONVERTED]: [
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.NOT_INTERESTED]: [
    LeadStatus.DO_NOT_CONTACT,
  ],
  [LeadStatus.DO_NOT_CONTACT]: [
    LeadStatus.NEW,
    LeadStatus.QUALIFYING,
    LeadStatus.QUALIFIED,
    LeadStatus.READY_FOR_OUTREACH,
  ],
};

/**
 * Validates whether a transition from fromStatus to toStatus by actor is legal.
 */
export function isLeadTransitionAllowed(
  fromStatus: LeadStatus,
  toStatus: LeadStatus,
  actor: string,
): { allowed: boolean; reason?: string } {
  if (fromStatus === toStatus) {
    return { allowed: true };
  }

  // Any status -> DO_NOT_CONTACT is always allowed
  if (toStatus === LeadStatus.DO_NOT_CONTACT) {
    return { allowed: true };
  }

  // Leaving DO_NOT_CONTACT requires explicit user action
  if (fromStatus === LeadStatus.DO_NOT_CONTACT) {
    if (!actor.startsWith("user:")) {
      return {
        allowed: false,
        reason: 'Leaving DO_NOT_CONTACT requires an explicit user action (actor must start with "user:").',
      };
    }
  }

  const allowedTargets = ALLOWED_LEAD_TRANSITIONS[fromStatus] ?? [];
  if (!allowedTargets.includes(toStatus)) {
    return {
      allowed: false,
      reason: `Illegal lead status transition from "${fromStatus}" to "${toStatus}".`,
    };
  }

  return { allowed: true };
}

export type TransitionLeadStatusInput = {
  leadId: string;
  to: LeadStatus;
  reason?: string | null;
  actor: string;
  tx?: Prisma.TransactionClient;
};

export type TransitionLeadStatusResult = {
  id: string;
  status: LeadStatus;
  previousStatus?: LeadStatus;
  transitioned: boolean;
};

/**
 * Transition a single lead's status within an ACID transaction.
 * Updates Lead.status + statusUpdatedAt, writes LeadStatusHistory,
 * and sets lastContactedAt when moving to CONTACTED.
 */
export async function transitionLeadStatus(
  input: TransitionLeadStatusInput,
): Promise<TransitionLeadStatusResult> {
  const { leadId, to, reason, actor, tx } = input;

  if (!leadId || typeof leadId !== "string" || !leadId.trim()) {
    throw new BadRequestError("INVALID_LEAD_ID", '"leadId" is required.');
  }

  if (!actor || typeof actor !== "string" || !actor.trim()) {
    throw new BadRequestError("INVALID_ACTOR", '"actor" is required.');
  }

  const executeTransition = async (client: Prisma.TransactionClient): Promise<TransitionLeadStatusResult> => {
    const lead = await client.lead.findUnique({
      where: { id: leadId },
      select: { id: true, status: true, lastContactedAt: true },
    });

    if (!lead) {
      throw new NotFoundError("LEAD_NOT_FOUND", `Lead with ID "${leadId}" was not found.`);
    }

    // No-op if status is unchanged
    if (lead.status === to) {
      return {
        id: lead.id,
        status: lead.status,
        transitioned: false,
      };
    }

    // Validate transition legality
    const validation = isLeadTransitionAllowed(lead.status, to, actor);
    if (!validation.allowed) {
      throw new BadRequestError(
        "INVALID_LEAD_STATUS_TRANSITION",
        validation.reason ?? `Cannot transition lead from "${lead.status}" to "${to}".`,
      );
    }

    const now = new Date();
    const updateData: Prisma.LeadUpdateInput = {
      status: to,
      statusUpdatedAt: now,
    };

    if (to === LeadStatus.CONTACTED) {
      updateData.lastContactedAt = now;
    }

    const updated = await client.lead.update({
      where: { id: leadId },
      data: updateData,
      select: { id: true, status: true },
    });

    await client.leadStatusHistory.create({
      data: {
        leadId,
        fromStatus: lead.status,
        toStatus: to,
        reason: reason ?? null,
        actor,
        createdAt: now,
      },
    });

    return {
      id: updated.id,
      status: updated.status,
      previousStatus: lead.status,
      transitioned: true,
    };
  };

  if (tx) {
    return executeTransition(tx);
  }

  const prisma = getPrismaClient();
  return prisma.$transaction(async (innerTx) => {
    return executeTransition(innerTx);
  });
}

export type BulkTransitionLeadItem = {
  leadId: string;
  to: LeadStatus;
  reason?: string | null;
  actor: string;
};

/**
 * Bulk transition leads inside a single transaction.
 */
export async function bulkTransitionLeadStatus(
  items: BulkTransitionLeadItem[],
  tx?: Prisma.TransactionClient,
): Promise<TransitionLeadStatusResult[]> {
  if (items.length === 0) return [];

  const executeBulk = async (client: Prisma.TransactionClient): Promise<TransitionLeadStatusResult[]> => {
    const results: TransitionLeadStatusResult[] = [];
    for (const item of items) {
      const result = await transitionLeadStatus({
        ...item,
        tx: client,
      });
      results.push(result);
    }
    return results;
  };

  if (tx) {
    return executeBulk(tx);
  }

  const prisma = getPrismaClient();
  return prisma.$transaction(async (innerTx) => {
    return executeBulk(innerTx);
  });
}
