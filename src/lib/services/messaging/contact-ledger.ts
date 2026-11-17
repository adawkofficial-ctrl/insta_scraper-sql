import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { MessageChannel } from "@/generated/prisma/enums";

export type ContactBlockReason = "ALREADY_CONTACTED" | "UNKNOWN_PENDING" | "LEDGER_CONFLICT";

export function normalizeContactHandle(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^@/, "").toLowerCase();
}

export type ReserveFirstContactInput = {
  userId: string;
  leadId: string;
  campaignId: string;
  handle: string;
  instagramUserId?: string | null;
  senderAccountId: string;
  senderUsername: string;
  step?: string;
  channel?: MessageChannel;
  templateId?: string | null;
  variant?: string | null;
  renderedTextHash?: string | null;
  scheduledAt?: Date | null;
};

export type ReserveFirstContactResult =
  | { kind: "reserved"; ledgerId: string }
  | {
      kind: "blocked";
      reason: ContactBlockReason;
      ledgerId: string | null;
      contactedAt: Date | null;
      contactedBySenderId: string | null;
      contactedByUsername: string | null;
      status: string | null;
    };

/**
 * Atomically reserves the one-and-only first message for a user's handle across
 * all campaigns. The unique key is the enforcement; no application-level check
 * can race it.
 */
export async function reserveFirstContact(
  input: ReserveFirstContactInput,
): Promise<ReserveFirstContactResult> {
  const prisma = getPrismaClient();
  const step = input.step ?? "1";
  const channel = input.channel ?? MessageChannel.INSTAGRAM;
  const handleNormalized = normalizeContactHandle(input.handle);
  if (!handleNormalized) throw new Error("Contact ledger requires a non-empty handle.");

  try {
    const ledger = await prisma.$transaction(async (tx) => {
      const created = await tx.leadContactLedger.create({
        data: {
          userId: input.userId,
          leadId: input.leadId,
          campaignId: input.campaignId,
          senderAccountId: input.senderAccountId,
          handle: input.handle.trim().replace(/^@/, ""),
          handleNormalized,
          instagramUserId: input.instagramUserId ?? null,
          step,
          channel,
          status: "RESERVED",
          templateId: input.templateId ?? null,
          variant: input.variant ?? null,
          renderedTextHash: input.renderedTextHash ?? null,
          senderUsernameSnapshot: input.senderUsername,
          metadata: { scheduledAt: input.scheduledAt?.toISOString() ?? null },
        },
      });

      // Sticky assignment: only set when the lead has no prior owner.
      await tx.lead.updateMany({
        where: { id: input.leadId, assignedSenderAccountId: null },
        data: {
          assignedSenderAccountId: input.senderAccountId,
          contactedByUsernameSnapshot: input.senderUsername,
        },
      });

      await tx.leadContactEvent.create({
        data: {
          ledgerId: created.id,
          userId: input.userId,
          leadId: input.leadId,
          campaignId: input.campaignId,
          senderAccountId: input.senderAccountId,
          senderUsernameSnapshot: input.senderUsername,
          step,
          channel,
          status: "RESERVED",
          templateId: input.templateId ?? null,
          variant: input.variant ?? null,
          renderedTextHash: input.renderedTextHash ?? null,
          scheduledAt: input.scheduledAt ?? null,
        },
      });
      return created;
    });
    return { kind: "reserved", ledgerId: ledger.id };
  } catch (error) {
    // A concurrent writer may surface as P2002 or a MySQL deadlock (P2034).
    // Re-read the unique key: if a reservation exists, this attempt lost.
    const existing = await prisma.leadContactLedger.findFirst({
      where: {
        userId: input.userId,
        step,
        channel,
        OR: [
          { handleNormalized },
          ...(input.instagramUserId ? [{ instagramUserId: input.instagramUserId }] : []),
        ],
      },
      include: { senderAccount: { select: { id: true, username: true } } },
      orderBy: { reservedAt: "desc" },
    });
    if (!existing) throw error;

    const campaign = await prisma.campaign.findUnique({
      where: { id: input.campaignId },
      select: { reContactCooldownDays: true },
    });
    const metadata = (existing.metadata ?? {}) as Record<string, unknown>;
    const overrideAt = typeof metadata.overrideAt === "string" ? new Date(metadata.overrideAt) : null;
    const overrideActive =
      overrideAt !== null && Date.now() - overrideAt.getTime() < 30 * 86400000;
    const cooldownDays = campaign?.reContactCooldownDays ?? null;
    const cooldownElapsed =
      cooldownDays !== null &&
      existing.sentAt !== null &&
      Date.now() - existing.sentAt.getTime() >= cooldownDays * 86400000;

    if (existing.status === "SENT" && (cooldownElapsed || overrideActive)) {
      try {
        const renewed = await prisma.$transaction(async (tx) => {
          const row = await tx.leadContactLedger.update({
            where: { id: existing.id },
            data: {
              leadId: input.leadId,
              campaignId: input.campaignId,
              senderAccountId: input.senderAccountId,
              handle: input.handle.trim().replace(/^@/, ""),
              handleNormalized,
              instagramUserId: input.instagramUserId ?? existing.instagramUserId,
              status: "RESERVED",
              reason: overrideActive ? "MANUAL_OVERRIDE" : "COOLDOWN_ELAPSED",
              templateId: input.templateId ?? null,
              variant: input.variant ?? null,
              renderedTextHash: input.renderedTextHash ?? null,
              providerMessageId: null,
              threadId: null,
              reservedAt: new Date(),
              sentAt: null,
              completedAt: null,
              errorCode: null,
              senderUsernameSnapshot: input.senderUsername,
              metadata: { ...metadata, overrideAt: null, reContact: true },
            },
          });
          await tx.lead.updateMany({
            where: { id: input.leadId, assignedSenderAccountId: null },
            data: {
              assignedSenderAccountId: input.senderAccountId,
              contactedByUsernameSnapshot: input.senderUsername,
            },
          });
          await tx.leadContactEvent.create({
            data: {
              ledgerId: row.id,
              userId: input.userId,
              leadId: input.leadId,
              campaignId: input.campaignId,
              senderAccountId: input.senderAccountId,
              senderUsernameSnapshot: input.senderUsername,
              step,
              channel,
              status: "RECONTACT",
              reason: overrideActive ? "MANUAL_OVERRIDE" : "COOLDOWN_ELAPSED",
              templateId: input.templateId ?? null,
              variant: input.variant ?? null,
              renderedTextHash: input.renderedTextHash ?? null,
              scheduledAt: input.scheduledAt ?? null,
            },
          });
          return row;
        });
        return { kind: "reserved", ledgerId: renewed.id };
      } catch {
        // A rename collided with another reservation; treat as already contacted.
      }
    }

    const blockedStatus =
      existing?.status === "UNKNOWN" ? "UNKNOWN_PENDING" : ("ALREADY_CONTACTED" as const);
    await prisma.leadContactEvent.create({
      data: {
        ledgerId: existing?.id ?? null,
        userId: input.userId,
        leadId: input.leadId,
        campaignId: input.campaignId,
        senderAccountId: input.senderAccountId,
        senderUsernameSnapshot: input.senderUsername,
        step,
        channel,
        status: "BLOCKED",
        reason: blockedStatus,
        templateId: input.templateId ?? null,
        variant: input.variant ?? null,
        renderedTextHash: input.renderedTextHash ?? null,
        scheduledAt: input.scheduledAt ?? null,
      },
    });
    return {
      kind: "blocked",
      reason: blockedStatus,
      ledgerId: existing?.id ?? null,
      contactedAt: existing?.sentAt ?? existing?.reservedAt ?? null,
      contactedBySenderId: existing?.senderAccountId ?? null,
      contactedByUsername:
        existing?.senderUsernameSnapshot ?? existing?.senderAccount?.username ?? null,
      status: existing?.status ?? null,
    };
  }
}

export async function markContactSent(input: {
  ledgerId: string;
  providerMessageId?: string | null;
  threadId?: string | null;
  sentAt: Date;
  renderedTextHash?: string | null;
}): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.$transaction(async (tx) => {
    const ledger = await tx.leadContactLedger.update({
      where: { id: input.ledgerId },
      data: {
        status: "SENT",
        sentAt: input.sentAt,
        completedAt: input.sentAt,
        providerMessageId: input.providerMessageId ?? null,
        threadId: input.threadId ?? null,
        ...(input.renderedTextHash ? { renderedTextHash: input.renderedTextHash } : {}),
      },
    });

    await tx.leadContactEvent.create({
      data: {
        ledgerId: ledger.id,
        userId: ledger.userId,
        leadId: ledger.leadId,
        campaignId: ledger.campaignId,
        senderAccountId: ledger.senderAccountId,
        senderUsernameSnapshot: ledger.senderUsernameSnapshot,
        step: ledger.step,
        channel: ledger.channel,
        status: "SENT",
        templateId: ledger.templateId,
        variant: ledger.variant,
        renderedTextHash: input.renderedTextHash ?? ledger.renderedTextHash,
        providerMessageId: input.providerMessageId ?? null,
        threadId: input.threadId ?? null,
        sentAt: input.sentAt,
      },
    });

    await tx.lead.update({
      where: { id: ledger.leadId },
      data: {
        firstContactedAt: ledger.sentAt ?? input.sentAt,
        firstContactedBySenderId: ledger.senderAccountId,
        assignedSenderAccountId: ledger.senderAccountId,
        contactedByUsernameSnapshot: ledger.senderUsernameSnapshot,
        lastContactedAt: input.sentAt,
        outreachCount: { increment: 1 },
      },
    });
  });
}

export async function markContactDeliveryStatus(input: {
  ledgerId: string;
  status: "FAILED" | "UNKNOWN";
  errorCode?: string | null;
  completedAt: Date;
}): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.$transaction(async (tx) => {
    const ledger = await tx.leadContactLedger.update({
      where: { id: input.ledgerId },
      data: {
        status: input.status,
        completedAt: input.completedAt,
        errorCode: input.errorCode ?? null,
      },
    });
    await tx.leadContactEvent.create({
      data: {
        ledgerId: ledger.id,
        userId: ledger.userId,
        leadId: ledger.leadId,
        campaignId: ledger.campaignId,
        senderAccountId: ledger.senderAccountId,
        senderUsernameSnapshot: ledger.senderUsernameSnapshot,
        step: ledger.step,
        channel: ledger.channel,
        status: input.status,
        reason: input.status === "UNKNOWN" ? "UNKNOWN_PENDING" : null,
        errorCode: input.errorCode ?? null,
        sentAt: input.status === "UNKNOWN" ? null : input.completedAt,
      },
    });
  });
}

export async function recordContactEvent(input: {
  userId: string;
  leadId: string;
  campaignId: string;
  senderAccountId?: string | null;
  senderUsername?: string | null;
  step?: string;
  channel?: MessageChannel;
  status: string;
  reason?: string | null;
  templateId?: string | null;
  variant?: string | null;
  renderedTextHash?: string | null;
  providerMessageId?: string | null;
  threadId?: string | null;
  scheduledAt?: Date | null;
  sentAt?: Date | null;
  errorCode?: string | null;
}): Promise<void> {
  await getPrismaClient().leadContactEvent.create({
    data: {
      userId: input.userId,
      leadId: input.leadId,
      campaignId: input.campaignId,
      senderAccountId: input.senderAccountId ?? null,
      senderUsernameSnapshot: input.senderUsername ?? null,
      step: input.step ?? "1",
      channel: input.channel ?? MessageChannel.INSTAGRAM,
      status: input.status,
      reason: input.reason ?? null,
      templateId: input.templateId ?? null,
      variant: input.variant ?? null,
      renderedTextHash: input.renderedTextHash ?? null,
      providerMessageId: input.providerMessageId ?? null,
      threadId: input.threadId ?? null,
      scheduledAt: input.scheduledAt ?? null,
      sentAt: input.sentAt ?? null,
      errorCode: input.errorCode ?? null,
    },
  });
}
