import "server-only";

import {
  type Prisma,
  DncChannel,
  DncIdentifierType,
  DncSource,
  LeadStatus,
  BulkMessageItemStatus,
  ExecutionItemStatus,
  MessageStatus,
  BulkMessageJobStatus,
  CampaignExecutionStatus,
} from "@/generated/prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { transitionLeadStatus } from "../lead/lead-status-service";

export { DncChannel, DncIdentifierType, DncSource };

// ============================================================================
// Normalization Helpers
// ============================================================================

/**
 * Normalizes an Instagram username:
 * - Trims whitespace
 * - Converts to lowercase
 * - Strips leading "@"
 * - Strips Instagram URL wrappers (e.g. "https://instagram.com/user", "instagram.com/user/")
 * - Strips trailing query parameters and slashes
 */
export function normalizeUsername(rawUsername: string): string {
  if (!rawUsername) return "";
  let cleaned = rawUsername.trim().toLowerCase();

  // Strip full or partial Instagram URLs
  cleaned = cleaned.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "");
  cleaned = cleaned.replace(/^instagram\.com\//i, "");

  // Strip query strings or fragment anchors
  cleaned = cleaned.split("?")[0].split("#")[0];

  // Strip leading '@' and slashes
  cleaned = cleaned.replace(/^[@/]+/, "").replace(/\/+$/, "");

  // Clean trailing punctuation
  cleaned = cleaned.trim();
  return cleaned;
}

/**
 * Normalizes an email address:
 * - Strips "mailto:" prefix
 * - Trims whitespace
 * - Converts to lowercase
 * - Strips dots from localpart for Gmail addresses (e.g. john.doe@gmail.com -> johndoe@gmail.com)
 */
export function normalizeEmail(rawEmail: string): string {
  if (!rawEmail) return "";
  let cleaned = rawEmail.trim().toLowerCase();
  cleaned = cleaned.replace(/^mailto:/i, "").trim();

  const atIndex = cleaned.lastIndexOf("@");
  if (atIndex > 0) {
    let local = cleaned.slice(0, atIndex);
    const domain = cleaned.slice(atIndex + 1);

    if (domain === "gmail.com" || domain === "googlemail.com") {
      local = local.replace(/\./g, "");
      return `${local}@${domain}`;
    }
  }

  return cleaned;
}

/**
 * Normalizes a domain name:
 * - Trims whitespace
 * - Converts to lowercase
 * - Strips protocol (http://, https://)
 * - Strips "www."
 * - Strips path, query, hash, and trailing slash
 */
export function normalizeDomain(rawDomain: string): string {
  if (!rawDomain) return "";
  let cleaned = rawDomain.trim().toLowerCase();

  // Strip protocol
  cleaned = cleaned.replace(/^https?:\/\//i, "");

  // Strip www.
  cleaned = cleaned.replace(/^www\./i, "");

  // Strip path, query params, hash
  cleaned = cleaned.split("/")[0].split("?")[0].split("#")[0];

  return cleaned.trim();
}

/**
 * Dispatches normalization based on DncIdentifierType.
 */
export function normalizeIdentifier(type: DncIdentifierType, value: string): string {
  switch (type) {
    case DncIdentifierType.USERNAME:
      return normalizeUsername(value);
    case DncIdentifierType.EMAIL:
      return normalizeEmail(value);
    case DncIdentifierType.DOMAIN:
      return normalizeDomain(value);
    case DncIdentifierType.INSTAGRAM_ID:
      return value.trim();
    default:
      return value.trim().toLowerCase();
  }
}

// ============================================================================
// Lead Identifier Extraction
// ============================================================================

export type LeadIdentifiers = {
  username?: string;
  instagramUserId?: string;
  email?: string;
  emailNormalized?: string;
  websiteDomain?: string;
  emailDomain?: string;
};

export function getLeadIdentifiers(lead: {
  username?: string | null;
  instagramUserId?: string | null;
  email?: string | null;
  emailNormalized?: string | null;
  website?: string | null;
  websiteDomain?: string | null;
}): LeadIdentifiers {
  const result: LeadIdentifiers = {};

  if (lead.username) {
    const norm = normalizeUsername(lead.username);
    if (norm) result.username = norm;
  }

  if (lead.instagramUserId && lead.instagramUserId.trim()) {
    result.instagramUserId = lead.instagramUserId.trim();
  }

  const rawEmail = lead.emailNormalized || lead.email;
  if (rawEmail) {
    const normEmail = normalizeEmail(rawEmail);
    if (normEmail) {
      result.email = normEmail;
      result.emailNormalized = normEmail;
      const parts = normEmail.split("@");
      if (parts.length === 2 && parts[1]) {
        result.emailDomain = normalizeDomain(parts[1]);
      }
    }
  }

  const rawDomain = lead.websiteDomain || lead.website;
  if (rawDomain) {
    const normDomain = normalizeDomain(rawDomain);
    if (normDomain) result.websiteDomain = normDomain;
  }

  return result;
}

// ============================================================================
// Lead Suppression Checks
// ============================================================================

export type DncSuppressionMatch = {
  entryId: string;
  identifierType: DncIdentifierType;
  channel: DncChannel;
  source: DncSource;
  reason: string | null;
};

export type LeadSuppressionResult = {
  suppressed: boolean;
  matches: DncSuppressionMatch[];
};

export type CheckLeadSuppressionInput = {
  userId: string;
  lead: {
    id?: string;
    status?: LeadStatus;
    username?: string | null;
    instagramUserId?: string | null;
    email?: string | null;
    emailNormalized?: string | null;
    website?: string | null;
    websiteDomain?: string | null;
  };
  channel?: DncChannel;
  tx?: Prisma.TransactionClient;
};

/**
 * Checks if a single lead is suppressed by DoNotContact rules for the given user and channel.
 *
 * Matching rules:
 * - USERNAME / INSTAGRAM_ID match the lead's username / instagramUserId.
 * - EMAIL entries match the lead's email.
 * - DOMAIN entries match the lead's email domain ONLY when outreach channel is EMAIL (or entry channel is ALL).
 *   (A domain entry must NOT block Instagram DMs to a lead that merely lists that website in their bio, unless the entry is channel ALL).
 * - Entry with channel ALL applies to every outreach channel. Entry with INSTAGRAM applies only to Instagram; EMAIL only to email.
 * - If lead status is DO_NOT_CONTACT, always treat as suppressed regardless of table matches (defense in depth).
 */
export async function checkLeadSuppression(
  input: CheckLeadSuppressionInput,
): Promise<LeadSuppressionResult> {
  const { userId, lead, channel = DncChannel.INSTAGRAM, tx } = input;
  const client = tx ?? getPrismaClient();

  // Defense in depth: if lead status is already DO_NOT_CONTACT, treat as suppressed immediately
  if (lead.status === LeadStatus.DO_NOT_CONTACT) {
    return {
      suppressed: true,
      matches: [
        {
          entryId: "lead_status",
          identifierType: DncIdentifierType.USERNAME,
          channel: DncChannel.ALL,
          source: DncSource.MANUAL,
          reason: "Lead status is DO_NOT_CONTACT",
        },
      ],
    };
  }

  const ids = getLeadIdentifiers(lead);

  // Channels that apply: the requested channel + ALL
  const applicableChannels: DncChannel[] = [channel, DncChannel.ALL];

  // Build OR condition for exact identifier matches
  const orConditions: Prisma.DoNotContactWhereInput[] = [];

  if (ids.username) {
    orConditions.push({
      identifierType: DncIdentifierType.USERNAME,
      identifierNormalized: ids.username,
      channel: { in: applicableChannels },
    });
  }

  if (ids.instagramUserId) {
    orConditions.push({
      identifierType: DncIdentifierType.INSTAGRAM_ID,
      identifierNormalized: ids.instagramUserId,
      channel: { in: applicableChannels },
    });
  }

  if (ids.email) {
    orConditions.push({
      identifierType: DncIdentifierType.EMAIL,
      identifierNormalized: ids.email,
      channel: { in: applicableChannels },
    });
  }

  // Domain matching rules:
  // DOMAIN entries match email domain only when outreach channel is EMAIL, OR entry channel is ALL
  if (ids.emailDomain && channel === DncChannel.EMAIL) {
    orConditions.push({
      identifierType: DncIdentifierType.DOMAIN,
      identifierNormalized: ids.emailDomain,
      channel: { in: applicableChannels },
    });
  }

  // If entry channel is ALL, a domain entry can suppress any channel
  if (ids.websiteDomain || ids.emailDomain) {
    const domainToMatch = ids.websiteDomain || ids.emailDomain;
    if (domainToMatch) {
      orConditions.push({
        identifierType: DncIdentifierType.DOMAIN,
        identifierNormalized: domainToMatch,
        channel: DncChannel.ALL,
      });
    }
  }

  if (orConditions.length === 0) {
    return { suppressed: false, matches: [] };
  }

  const entries = await client.doNotContact.findMany({
    where: {
      userId,
      OR: orConditions,
    },
  });

  if (entries.length === 0) {
    return { suppressed: false, matches: [] };
  }

  return {
    suppressed: true,
    matches: entries.map((e) => ({
      entryId: e.id,
      identifierType: e.identifierType,
      channel: e.channel,
      source: e.source,
      reason: e.reason,
    })),
  };
}

/**
 * Batch checks suppression for multiple leads using bounded queries (NO N+1).
 * Executes at most ONE query per identifier type.
 */
export async function checkManySuppression(input: {
  userId: string;
  leads: Array<{
    id: string;
    status?: LeadStatus;
    username?: string | null;
    instagramUserId?: string | null;
    email?: string | null;
    emailNormalized?: string | null;
    website?: string | null;
    websiteDomain?: string | null;
  }>;
  channel?: DncChannel;
  tx?: Prisma.TransactionClient;
}): Promise<Map<string, LeadSuppressionResult>> {
  const { userId, leads, channel = DncChannel.INSTAGRAM, tx } = input;
  const client = tx ?? getPrismaClient();
  const results = new Map<string, LeadSuppressionResult>();

  if (leads.length === 0) {
    return results;
  }

  const applicableChannels: DncChannel[] = [channel, DncChannel.ALL];

  // Collect all unique normalized identifiers across leads
  const usernames: string[] = [];
  const instagramUserIds: string[] = [];
  const emails: string[] = [];
  const emailDomains: string[] = [];
  const websiteDomains: string[] = [];

  const leadIdToIdentifiers = new Map<string, LeadIdentifiers>();

  for (const lead of leads) {
    // If status is already DO_NOT_CONTACT, mark suppressed right away
    if (lead.status === LeadStatus.DO_NOT_CONTACT) {
      results.set(lead.id, {
        suppressed: true,
        matches: [
          {
            entryId: "lead_status",
            identifierType: DncIdentifierType.USERNAME,
            channel: DncChannel.ALL,
            source: DncSource.MANUAL,
            reason: "Lead status is DO_NOT_CONTACT",
          },
        ],
      });
      continue;
    }

    const ids = getLeadIdentifiers(lead);
    leadIdToIdentifiers.set(lead.id, ids);

    if (ids.username) usernames.push(ids.username);
    if (ids.instagramUserId) instagramUserIds.push(ids.instagramUserId);
    if (ids.email) emails.push(ids.email);
    if (ids.emailDomain) emailDomains.push(ids.emailDomain);
    if (ids.websiteDomain) websiteDomains.push(ids.websiteDomain);
  }

  // Build batch query conditions
  const orConditions: Prisma.DoNotContactWhereInput[] = [];

  if (usernames.length > 0) {
    orConditions.push({
      identifierType: DncIdentifierType.USERNAME,
      identifierNormalized: { in: Array.from(new Set(usernames)) },
      channel: { in: applicableChannels },
    });
  }

  if (instagramUserIds.length > 0) {
    orConditions.push({
      identifierType: DncIdentifierType.INSTAGRAM_ID,
      identifierNormalized: { in: Array.from(new Set(instagramUserIds)) },
      channel: { in: applicableChannels },
    });
  }

  if (emails.length > 0) {
    orConditions.push({
      identifierType: DncIdentifierType.EMAIL,
      identifierNormalized: { in: Array.from(new Set(emails)) },
      channel: { in: applicableChannels },
    });
  }

  if (channel === DncChannel.EMAIL && emailDomains.length > 0) {
    orConditions.push({
      identifierType: DncIdentifierType.DOMAIN,
      identifierNormalized: { in: Array.from(new Set(emailDomains)) },
      channel: { in: applicableChannels },
    });
  }

  const allDomains = Array.from(new Set([...emailDomains, ...websiteDomains]));
  if (allDomains.length > 0) {
    orConditions.push({
      identifierType: DncIdentifierType.DOMAIN,
      identifierNormalized: { in: allDomains },
      channel: DncChannel.ALL,
    });
  }

  // If no identifiers to check, return current results
  if (orConditions.length === 0) {
    for (const lead of leads) {
      if (!results.has(lead.id)) {
        results.set(lead.id, { suppressed: false, matches: [] });
      }
    }
    return results;
  }

  // Single batch query
  const matchingEntries = await client.doNotContact.findMany({
    where: {
      userId,
      OR: orConditions,
    },
  });

  // Map entries back to each lead
  for (const lead of leads) {
    if (results.has(lead.id)) continue; // Already marked suppressed by DO_NOT_CONTACT status

    const ids = leadIdToIdentifiers.get(lead.id) || {};
    const leadMatches: DncSuppressionMatch[] = [];

    for (const entry of matchingEntries) {
      const type = entry.identifierType;
      const norm = entry.identifierNormalized;
      const entChannel = entry.channel;

      let isMatch = false;

      if (type === DncIdentifierType.USERNAME && ids.username === norm) {
        isMatch = true;
      } else if (type === DncIdentifierType.INSTAGRAM_ID && ids.instagramUserId === norm) {
        isMatch = true;
      } else if (type === DncIdentifierType.EMAIL && ids.email === norm) {
        isMatch = true;
      } else if (type === DncIdentifierType.DOMAIN) {
        if (entChannel === DncChannel.ALL) {
          if (ids.websiteDomain === norm || ids.emailDomain === norm) {
            isMatch = true;
          }
        } else if (channel === DncChannel.EMAIL && ids.emailDomain === norm) {
          isMatch = true;
        }
      }

      if (isMatch) {
        leadMatches.push({
          entryId: entry.id,
          identifierType: entry.identifierType,
          channel: entry.channel,
          source: entry.source,
          reason: entry.reason,
        });
      }
    }

    results.set(lead.id, {
      suppressed: leadMatches.length > 0,
      matches: leadMatches,
    });
  }

  return results;
}

// ============================================================================
// Cancellation of Pending Outreach
// ============================================================================

export type CancelPendingOutreachResult = {
  cancelledBulkItems: number;
  cancelledExecutionItems: number;
  cancelledMessages: number;
};

/**
 * Cancels pending/queued outreach work across all send paths for a set of lead IDs.
 * Atomic: executes inside the provided transaction (or starts one).
 */
export async function cancelPendingOutreachForLeads(input: {
  userId: string;
  leadIds: string[];
  tx?: Prisma.TransactionClient;
}): Promise<CancelPendingOutreachResult> {
  const { userId, leadIds, tx } = input;
  if (leadIds.length === 0) {
    return { cancelledBulkItems: 0, cancelledExecutionItems: 0, cancelledMessages: 0 };
  }

  const runWithTx = async (prisma: Prisma.TransactionClient) => {
    // 1. Cancel QUEUED / PROCESSING BulkMessageItems for these leads
    const activeBulkItems = await prisma.bulkMessageItem.findMany({
      where: {
        leadId: { in: leadIds },
        status: { in: [BulkMessageItemStatus.QUEUED, BulkMessageItemStatus.PROCESSING] },
        job: { userId },
      },
      select: { id: true, jobId: true, status: true },
    });

    let cancelledBulkItems = 0;
    if (activeBulkItems.length > 0) {
      const itemIds = activeBulkItems.map((it) => it.id);
      const updateResult = await prisma.bulkMessageItem.updateMany({
        where: { id: { in: itemIds } },
        data: {
          status: BulkMessageItemStatus.SUPPRESSED_DNC,
          errorCode: "SUPPRESSED_DNC",
          errorMessage: "Cancelled: Lead added to Do Not Contact list.",
          completedAt: new Date(),
        },
      });
      cancelledBulkItems = updateResult.count;

      // Group by jobId to update BulkMessageJob counters and check completion
      const jobCounts = new Map<string, { queued: number; processing: number }>();
      for (const it of activeBulkItems) {
        const counts = jobCounts.get(it.jobId) || { queued: 0, processing: 0 };
        if (it.status === BulkMessageItemStatus.QUEUED) counts.queued++;
        if (it.status === BulkMessageItemStatus.PROCESSING) counts.processing++;
        jobCounts.set(it.jobId, counts);
      }

      for (const [jobId, counts] of jobCounts.entries()) {
        await prisma.bulkMessageJob.update({
          where: { id: jobId },
          data: {
            queued: { decrement: counts.queued },
            cancelled: { increment: counts.queued + counts.processing },
          },
        });

        // Check if job is now complete (no remaining queued or processing items)
        const remainingActive = await prisma.bulkMessageItem.count({
          where: {
            jobId,
            status: { in: [BulkMessageItemStatus.QUEUED, BulkMessageItemStatus.PROCESSING] },
          },
        });

        if (remainingActive === 0) {
          const sentCount = await prisma.bulkMessageItem.count({
            where: { jobId, status: BulkMessageItemStatus.SENT },
          });

          await prisma.bulkMessageJob.update({
            where: { id: jobId },
            data: {
              status: sentCount > 0 ? BulkMessageJobStatus.COMPLETED : BulkMessageJobStatus.CANCELLED,
              completedAt: new Date(),
            },
          });
        }
      }
    }

    // 2. Cancel PENDING / SENDING CampaignExecutionItems
    const activeExecItems = await prisma.campaignExecutionItem.findMany({
      where: {
        leadId: { in: leadIds },
        status: { in: [ExecutionItemStatus.PENDING, ExecutionItemStatus.SENDING] },
        execution: { campaign: { userId } },
      },
      select: { id: true, executionId: true },
    });

    let cancelledExecutionItems = 0;
    if (activeExecItems.length > 0) {
      const execItemIds = activeExecItems.map((it) => it.id);
      const updateResult = await prisma.campaignExecutionItem.updateMany({
        where: { id: { in: execItemIds } },
        data: {
          status: ExecutionItemStatus.SUPPRESSED_DNC,
          errorMessage: "Cancelled: Lead added to Do Not Contact list.",
          processedAt: new Date(),
        },
      });
      cancelledExecutionItems = updateResult.count;

      // Update parent CampaignExecution status if all remaining items are terminal
      const uniqueExecIds = Array.from(new Set(activeExecItems.map((it) => it.executionId)));
      for (const execId of uniqueExecIds) {
        const remainingActive = await prisma.campaignExecutionItem.count({
          where: {
            executionId: execId,
            status: { in: [ExecutionItemStatus.PENDING, ExecutionItemStatus.APPROVED, ExecutionItemStatus.SENDING] },
          },
        });
        if (remainingActive === 0) {
          const sentCount = await prisma.campaignExecutionItem.count({
            where: { executionId: execId, status: ExecutionItemStatus.SENT },
          });
          await prisma.campaignExecution.update({
            where: { id: execId },
            data: {
              status: sentCount > 0 ? CampaignExecutionStatus.COMPLETED : CampaignExecutionStatus.CANCELLED,
              completedAt: new Date(),
            },
          });
        }
      }
    }

    // 3. Cancel QUEUED / SENDING / DRAFT Message rows
    const updateMessagesResult = await prisma.message.updateMany({
      where: {
        leadId: { in: leadIds },
        status: { in: [MessageStatus.DRAFT, MessageStatus.SENDING] },
        campaign: { userId },
      },
      data: {
        status: MessageStatus.FAILED,
        errorCode: "SUPPRESSED_DNC",
        errorMessage: "Cancelled: Lead added to Do Not Contact list.",
      },
    });
    const cancelledMessages = updateMessagesResult.count;

    return {
      cancelledBulkItems,
      cancelledExecutionItems,
      cancelledMessages,
    };
  };

  if (tx) {
    return runWithTx(tx);
  }
  return getPrismaClient().$transaction(runWithTx);
}

// ============================================================================
// DNC CRUD Operations
// ============================================================================

export type AddDncEntryInput = {
  identifierType: DncIdentifierType;
  value: string;
  channel?: DncChannel;
  reason?: string;
};

export type AddDoNotContactInput = {
  userId: string;
  entries: AddDncEntryInput[];
  source?: DncSource;
  reason?: string;
  actor: string;
  tx?: Prisma.TransactionClient;
};

export type AddDoNotContactResult = {
  created: number;
  alreadyExisted: number;
  leadsUpdated: number;
  pendingCancelled: number;
};

/**
 * Adds entries to the Do Not Contact list idempotently, transitions matching leads to
 * DO_NOT_CONTACT with full audit history, and cancels pending outreach.
 */
export async function addDoNotContact(
  input: AddDoNotContactInput,
): Promise<AddDoNotContactResult> {
  const {
    userId,
    entries: rawEntries,
    source = DncSource.MANUAL,
    reason: defaultReason,
    actor,
    tx,
  } = input;

  if (!rawEntries || rawEntries.length === 0) {
    return { created: 0, alreadyExisted: 0, leadsUpdated: 0, pendingCancelled: 0 };
  }

  if (rawEntries.length > 1000) {
    throw new BadRequestError("LIMIT_EXCEEDED", "Maximum 1000 DNC entries per request.");
  }

  const runWithTx = async (prisma: Prisma.TransactionClient) => {
    let created = 0;
    let alreadyExisted = 0;

    // Collect normalized entries to search matching leads
    const normalizedList: Array<{
      type: DncIdentifierType;
      channel: DncChannel;
      normalized: string;
      reason?: string;
    }> = [];

    for (const raw of rawEntries) {
      if (!raw.value || typeof raw.value !== "string" || !raw.value.trim()) {
        continue;
      }

      const type = raw.identifierType;
      const channel = raw.channel || DncChannel.ALL;
      const normalized = normalizeIdentifier(type, raw.value);
      if (!normalized) continue;

      const entryReason = raw.reason?.trim() || defaultReason?.trim() || null;

      // Upsert entry on @@unique([userId, channel, identifierType, identifierNormalized])
      const existing = await prisma.doNotContact.findUnique({
        where: {
          userId_channel_identifierType_identifierNormalized: {
            userId,
            channel,
            identifierType: type,
            identifierNormalized: normalized,
          },
        },
      });

      if (existing) {
        alreadyExisted++;
      } else {
        await prisma.doNotContact.create({
          data: {
            userId,
            channel,
            identifierType: type,
            identifierNormalized: normalized,
            reason: entryReason,
            source,
          },
        });
        created++;
      }

      normalizedList.push({ type, channel, normalized, reason: entryReason ?? undefined });
    }

    // Find all leads across this user's campaigns that match any of the entries
    const userCampaigns = await prisma.campaign.findMany({
      where: { userId },
      select: { id: true },
    });
    const campaignIds = userCampaigns.map((c) => c.id);

    if (campaignIds.length === 0 || normalizedList.length === 0) {
      return { created, alreadyExisted, leadsUpdated: 0, pendingCancelled: 0 };
    }

    const leadOrConditions: Prisma.LeadWhereInput[] = [];

    const usernames = normalizedList
      .filter((e) => e.type === DncIdentifierType.USERNAME)
      .map((e) => e.normalized);
    if (usernames.length > 0) {
      leadOrConditions.push({ username: { in: usernames, mode: "insensitive" } });
    }

    const igIds = normalizedList
      .filter((e) => e.type === DncIdentifierType.INSTAGRAM_ID)
      .map((e) => e.normalized);
    if (igIds.length > 0) {
      leadOrConditions.push({ instagramUserId: { in: igIds } });
    }

    const emails = normalizedList
      .filter((e) => e.type === DncIdentifierType.EMAIL)
      .map((e) => e.normalized);
    if (emails.length > 0) {
      leadOrConditions.push(
        { email: { in: emails, mode: "insensitive" } },
        { emailNormalized: { in: emails } },
      );
    }

    const domains = normalizedList
      .filter((e) => e.type === DncIdentifierType.DOMAIN)
      .map((e) => e.normalized);
    if (domains.length > 0) {
      leadOrConditions.push(
        { websiteDomain: { in: domains } },
        { website: { in: domains, mode: "insensitive" } },
      );
    }

    let matchingLeads: Array<{ id: string; status: LeadStatus }> = [];
    if (leadOrConditions.length > 0) {
      matchingLeads = await prisma.lead.findMany({
        where: {
          campaignId: { in: campaignIds },
          OR: leadOrConditions,
        },
        select: { id: true, status: true },
      });
    }

    // Transition matching leads to DO_NOT_CONTACT
    let leadsUpdated = 0;
    const leadsToCancel: string[] = [];

    for (const lead of matchingLeads) {
      leadsToCancel.push(lead.id);

      if (lead.status !== LeadStatus.DO_NOT_CONTACT) {
        await transitionLeadStatus({
          leadId: lead.id,
          to: LeadStatus.DO_NOT_CONTACT,
          reason: `dnc:${source}`,
          actor,
          tx: prisma,
        });
        leadsUpdated++;
      }
    }

    // Cancel pending outreach for all matching leads
    const cancelRes = await cancelPendingOutreachForLeads({
      userId,
      leadIds: leadsToCancel,
      tx: prisma,
    });

    const pendingCancelled =
      cancelRes.cancelledBulkItems +
      cancelRes.cancelledExecutionItems +
      cancelRes.cancelledMessages;

    logger.info("[DNC] entries added", {
      userId,
      created,
      alreadyExisted,
      leadsUpdated,
      pendingCancelled,
    });

    return { created, alreadyExisted, leadsUpdated, pendingCancelled };
  };

  if (tx) {
    return runWithTx(tx);
  }
  return getPrismaClient().$transaction(runWithTx);
}

/**
 * Removes an entry from the Do Not Contact list.
 * Only permitted for actors starting with "user:".
 * Restores matching leads back to their previous status from LeadStatusHistory ONLY IF
 * no other DNC entry continues to match them.
 */
export async function removeDoNotContact(input: {
  userId: string;
  entryId: string;
  actor: string;
  tx?: Prisma.TransactionClient;
}): Promise<{ success: true; leadsRestored: number }> {
  const { userId, entryId, actor, tx } = input;

  if (!actor || !actor.startsWith("user:")) {
    throw new BadRequestError(
      "UNAUTHORIZED_ACTION",
      "DNC removal requires explicit user action (actor must start with user:).",
    );
  }

  const runWithTx = async (prisma: Prisma.TransactionClient) => {
    const entry = await prisma.doNotContact.findUnique({
      where: { id: entryId },
    });

    if (!entry || entry.userId !== userId) {
      throw new NotFoundError("DNC_ENTRY_NOT_FOUND", "Do Not Contact entry was not found.");
    }

    // Find all leads of this user currently in DO_NOT_CONTACT that match this entry
    const userCampaigns = await prisma.campaign.findMany({
      where: { userId },
      select: { id: true },
    });
    const campaignIds = userCampaigns.map((c) => c.id);

    let candidateLeads: Array<{
      id: string;
      status: LeadStatus;
      username: string;
      instagramUserId: string | null;
      email: string | null;
      emailNormalized: string | null;
      website: string | null;
      websiteDomain: string | null;
    }> = [];

    if (campaignIds.length > 0) {
      const filter: Prisma.LeadWhereInput = {
        campaignId: { in: campaignIds },
        status: LeadStatus.DO_NOT_CONTACT,
      };

      if (entry.identifierType === DncIdentifierType.USERNAME) {
        filter.username = { equals: entry.identifierNormalized, mode: "insensitive" };
      } else if (entry.identifierType === DncIdentifierType.INSTAGRAM_ID) {
        filter.instagramUserId = entry.identifierNormalized;
      } else if (entry.identifierType === DncIdentifierType.EMAIL) {
        filter.OR = [
          { email: { equals: entry.identifierNormalized, mode: "insensitive" } },
          { emailNormalized: entry.identifierNormalized },
        ];
      } else if (entry.identifierType === DncIdentifierType.DOMAIN) {
        filter.OR = [
          { websiteDomain: entry.identifierNormalized },
          { website: { contains: entry.identifierNormalized, mode: "insensitive" } },
        ];
      }

      candidateLeads = await prisma.lead.findMany({
        where: filter,
        select: {
          id: true,
          status: true,
          username: true,
          instagramUserId: true,
          email: true,
          emailNormalized: true,
          website: true,
          websiteDomain: true,
        },
      });
    }

    // Delete the entry
    await prisma.doNotContact.delete({
      where: { id: entryId },
    });

    let leadsRestored = 0;

    // For each candidate lead, check if another DNC entry still suppresses it
    for (const lead of candidateLeads) {
      const stillSuppressed = await checkLeadSuppression({
        userId,
        lead: {
          ...lead,
          // Temporarily test without the status fallback
          status: LeadStatus.NEW,
        },
        channel: DncChannel.INSTAGRAM,
        tx: prisma,
      });

      if (!stillSuppressed.suppressed) {
        // Find previous status from LeadStatusHistory
        const historyRows = await prisma.leadStatusHistory.findMany({
          where: { leadId: lead.id },
          orderBy: { createdAt: "desc" },
        });

        // Find the history row where toStatus was DO_NOT_CONTACT
        const dncHistory = historyRows.find((h) => h.toStatus === LeadStatus.DO_NOT_CONTACT);
        const restoredStatus =
          dncHistory?.fromStatus && dncHistory.fromStatus !== LeadStatus.DO_NOT_CONTACT
            ? dncHistory.fromStatus
            : LeadStatus.READY_FOR_OUTREACH;

        await transitionLeadStatus({
          leadId: lead.id,
          to: restoredStatus,
          reason: "dnc_removed",
          actor,
          tx: prisma,
        });
        leadsRestored++;
      }
    }

    logger.info("[DNC] entry removed", {
      userId,
      entryId,
      leadsRestored,
    });

    return { success: true as const, deleted: true as const, leadsRestored };
  };

  if (tx) {
    return runWithTx(tx);
  }
  return getPrismaClient().$transaction(runWithTx);
}

/**
 * Lists Do Not Contact entries for a user with optional filters and pagination.
 */
export async function listDoNotContact(input: {
  userId: string;
  channel?: DncChannel;
  search?: string;
  page?: number;
  pageSize?: number;
}) {
  const { userId, channel, search, page = 1, pageSize = 50 } = input;
  const prisma = getPrismaClient();

  const where: Prisma.DoNotContactWhereInput = {
    userId,
    ...(channel ? { channel } : {}),
    ...(search && search.trim()
      ? {
          OR: [
            { identifierNormalized: { contains: search.trim().toLowerCase() } },
            { reason: { contains: search.trim(), mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.doNotContact.count({ where }),
    prisma.doNotContact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: Math.max(0, (page - 1) * pageSize),
      take: Math.min(100, Math.max(1, pageSize)),
    }),
  ]);

  return {
    items: items.map((it) => ({
      id: it.id,
      userId: it.userId,
      channel: it.channel,
      identifierType: it.identifierType,
      identifierNormalized: it.identifierNormalized,
      reason: it.reason,
      source: it.source,
      createdAt: it.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1,
  };
}
