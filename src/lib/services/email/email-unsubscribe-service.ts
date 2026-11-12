import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { getEmailDomain } from "./email-address-quality";

export type UnsubscribeResult =
  | { ok: true; email: string; alreadyUsed: boolean }
  | { ok: false; reason: string };

export async function processEmailUnsubscribe(token: string): Promise<UnsubscribeResult> {
  const prisma = getPrismaClient();
  const row = await prisma.emailUnsubscribeToken.findUnique({
    where: { token },
    select: {
      id: true,
      leadId: true,
      campaignId: true,
      emailNormalized: true,
      usedAt: true,
      lead: { select: { campaign: { select: { userId: true } } } },
    },
  });
  if (!row) return { ok: false, reason: "Unsubscribe link is invalid or expired" };

  if (row.usedAt) {
    return { ok: true, email: row.emailNormalized, alreadyUsed: true };
  }

  const userId = row.lead.campaign.userId;
  const domain = getEmailDomain(row.emailNormalized);
  const now = new Date();

  await prisma.$transaction([
    prisma.emailUnsubscribeToken.update({
      where: { id: row.id },
      data: { usedAt: now },
    }),
    prisma.lead.update({
      where: { id: row.leadId },
      data: { emailOptOutAt: now, emailInvalid: true },
    }),
    prisma.doNotContact.upsert({
      where: {
        userId_channel_identifierType_identifierNormalized: {
          userId,
          channel: "EMAIL",
          identifierType: "EMAIL",
          identifierNormalized: row.emailNormalized,
        },
      },
      create: {
        userId,
        channel: "EMAIL",
        identifierType: "EMAIL",
        identifierNormalized: row.emailNormalized,
        reason: "Unsubscribe link",
        source: "UNSUBSCRIBE",
      },
      update: { reason: "Unsubscribe link" },
    }),
    ...(domain
      ? [
          prisma.doNotContact.upsert({
            where: {
              userId_channel_identifierType_identifierNormalized: {
                userId,
                channel: "EMAIL",
                identifierType: "DOMAIN",
                identifierNormalized: domain,
              },
            },
            create: {
              userId,
              channel: "EMAIL",
              identifierType: "DOMAIN",
              identifierNormalized: domain,
              reason: "Unsubscribe link",
              source: "UNSUBSCRIBE",
            },
            update: { reason: "Unsubscribe link" },
          }),
        ]
      : []),
  ]);

  return { ok: true, email: row.emailNormalized, alreadyUsed: false };
}

export async function getUnsubscribeTokenPreview(token: string): Promise<{
  valid: boolean;
  used: boolean;
  email: string | null;
}> {
  const row = await getPrismaClient().emailUnsubscribeToken.findUnique({
    where: { token },
    select: { emailNormalized: true, usedAt: true },
  });
  return {
    valid: Boolean(row),
    used: Boolean(row?.usedAt),
    email: row?.emailNormalized ?? null,
  };
}
