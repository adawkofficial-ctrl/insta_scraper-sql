import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "./email-crypto";
import { checkEmailAddress, isFreeProviderDomain } from "./email-address-quality";
import { checkEmailDns, type EmailDnsHealth } from "./email-dns";
import { getEmailTransport } from "./email-transport";
import { getEmailDailyCap, getEmailHourlyCap } from "./email-gate";

export type EmailAccountInput = {
  fromName: string;
  fromAddress: string;
  postalAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword?: string;
  secure?: boolean;
  dailyCap?: number;
  hourlyCap?: number;
  dkimSelector?: string | null;
  allowDnsOverride?: boolean;
};

export type SafeEmailAccount = {
  id: string;
  fromName: string;
  fromAddress: string;
  postalAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  secure: boolean;
  status: string;
  dailyCap: number;
  hourlyCap: number;
  warmupStartedAt: string | null;
  lastSentAt: string | null;
  consecutiveErrors: number;
  pausedUntil: string | null;
  lastError: string | null;
  verifiedAt: string | null;
  dnsCheckedAt: string | null;
  spfStatus: string | null;
  dkimStatus: string | null;
  dmarcStatus: string | null;
  dkimSelector: string | null;
  allowDnsOverride: boolean;
  freeProviderWarning: boolean;
  createdAt: string;
  updatedAt: string;
};

import type { EmailSenderAccountModel } from "@/generated/prisma/models";

type AccountRow = EmailSenderAccountModel;

export function sanitizeEmailAccount(account: AccountRow): SafeEmailAccount {
  const domain = account.fromAddress.split("@")[1]?.toLowerCase() ?? "";
  return {
    id: account.id,
    fromName: account.fromName,
    fromAddress: account.fromAddress,
    postalAddress: account.postalAddress,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpUser: account.smtpUser,
    secure: account.secure,
    status: account.status,
    dailyCap: account.dailyCap,
    hourlyCap: account.hourlyCap,
    warmupStartedAt: account.warmupStartedAt?.toISOString() ?? null,
    lastSentAt: account.lastSentAt?.toISOString() ?? null,
    consecutiveErrors: account.consecutiveErrors,
    pausedUntil: account.pausedUntil?.toISOString() ?? null,
    lastError: account.lastError,
    verifiedAt: account.verifiedAt?.toISOString() ?? null,
    dnsCheckedAt: account.dnsCheckedAt?.toISOString() ?? null,
    spfStatus: account.spfStatus,
    dkimStatus: account.dkimStatus,
    dmarcStatus: account.dmarcStatus,
    dkimSelector: account.dkimSelector,
    allowDnsOverride: account.allowDnsOverride,
    freeProviderWarning: domain ? isFreeProviderDomain(domain) : false,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

export async function createEmailSenderAccount(
  userId: string,
  input: EmailAccountInput,
): Promise<SafeEmailAccount> {
  const quality = await checkEmailAddress(input.fromAddress, { checkMx: false });
  if (!quality.valid || !quality.normalized) {
    throw new Error(quality.reason ?? "Invalid from address");
  }
  if (!input.smtpPassword?.trim()) {
    throw new Error("SMTP password is required");
  }
  const account = await getPrismaClient().emailSenderAccount.create({
    data: {
      userId,
      fromName: input.fromName.trim(),
      fromAddress: quality.normalized,
      postalAddress: input.postalAddress.trim(),
      smtpHost: input.smtpHost.trim(),
      smtpPort: input.smtpPort,
      smtpUser: input.smtpUser.trim(),
      smtpPasswordEncrypted: encryptSecret(input.smtpPassword),
      secure: input.secure ?? true,
      status: "PENDING",
      dailyCap: Math.min(input.dailyCap ?? 15, 30),
      hourlyCap: input.hourlyCap ?? getEmailHourlyCap(),
      dkimSelector: input.dkimSelector?.trim() || null,
      allowDnsOverride: input.allowDnsOverride ?? false,
      dnsCheckedAt: null,
    },
  });
  return sanitizeEmailAccount(account);
}

export async function updateEmailSenderAccount(
  userId: string,
  accountId: string,
  input: Partial<EmailAccountInput> & { status?: string },
): Promise<SafeEmailAccount> {
  const existing = await getPrismaClient().emailSenderAccount.findFirst({
    where: { id: accountId, userId },
  });
  if (!existing) throw new Error("Email account not found");

  const data: Record<string, unknown> = {};
  if (input.fromName !== undefined) data.fromName = input.fromName.trim();
  if (input.fromAddress !== undefined) {
    const quality = await checkEmailAddress(input.fromAddress, { checkMx: false });
    if (!quality.valid || !quality.normalized) throw new Error(quality.reason ?? "Invalid from address");
    data.fromAddress = quality.normalized;
  }
  if (input.postalAddress !== undefined) data.postalAddress = input.postalAddress.trim();
  if (input.smtpHost !== undefined) data.smtpHost = input.smtpHost.trim();
  if (input.smtpPort !== undefined) data.smtpPort = input.smtpPort;
  if (input.smtpUser !== undefined) data.smtpUser = input.smtpUser.trim();
  if (input.smtpPassword) data.smtpPasswordEncrypted = encryptSecret(input.smtpPassword);
  if (input.secure !== undefined) data.secure = input.secure;
  if (input.dailyCap !== undefined) data.dailyCap = Math.min(input.dailyCap, 30);
  if (input.hourlyCap !== undefined) data.hourlyCap = input.hourlyCap;
  if (input.dkimSelector !== undefined) data.dkimSelector = input.dkimSelector?.trim() || null;
  if (input.allowDnsOverride !== undefined) data.allowDnsOverride = input.allowDnsOverride;
  if (input.status !== undefined) data.status = input.status;

  const account = await getPrismaClient().emailSenderAccount.update({
    where: { id: existing.id },
    data,
  });
  return sanitizeEmailAccount(account);
}

export async function verifyEmailSenderAccount(
  userId: string,
  accountId: string,
): Promise<{ ok: boolean; error?: string }> {
  const account = await getPrismaClient().emailSenderAccount.findFirst({
    where: { id: accountId, userId },
  });
  if (!account) throw new Error("Email account not found");
  const transport = getEmailTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.secure,
    user: account.smtpUser,
    password: decryptSecret(account.smtpPasswordEncrypted),
  });
  try {
    await transport.verify();
    await getPrismaClient().emailSenderAccount.update({
      where: { id: account.id },
      data: { verifiedAt: new Date(), lastError: null },
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "SMTP verification failed";
    await getPrismaClient().emailSenderAccount.update({
      where: { id: account.id },
      data: { lastError: message },
    });
    return { ok: false, error: message };
  }
}

export async function checkEmailSenderDns(
  userId: string,
  accountId: string,
  selector?: string | null,
): Promise<EmailDnsHealth> {
  const prisma = getPrismaClient();
  const account = await prisma.emailSenderAccount.findFirst({
    where: { id: accountId, userId },
  });
  if (!account) throw new Error("Email account not found");
  const health = await checkEmailDns(account.fromAddress, selector ?? account.dkimSelector);
  await prisma.emailSenderAccount.update({
    where: { id: account.id },
    data: {
      spfStatus: health.spf,
      dkimStatus: health.dkim,
      dmarcStatus: health.dmarc,
      dnsCheckedAt: new Date(),
      dkimSelector: selector ?? account.dkimSelector,
    },
  });
  return health;
}

export async function sendTestEmail(
  userId: string,
  accountId: string,
): Promise<{ ok: boolean; error?: string }> {
  const prisma = getPrismaClient();
  const account = await prisma.emailSenderAccount.findFirst({
    where: { id: accountId, userId },
  });
  if (!account) throw new Error("Email account not found");

  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const hourStart = new Date(now.getTime() - 60 * 60 * 1000);
  const [daily, hourly] = await Promise.all([
    prisma.emailSend.count({
      where: { senderAccountId: account.id, OR: [{ sentAt: { gte: dayStart } }, { status: "QUEUED", reservedAt: { gte: dayStart } }] },
    }),
    prisma.emailSend.count({
      where: { senderAccountId: account.id, OR: [{ sentAt: { gte: hourStart } }, { status: "QUEUED", reservedAt: { gte: hourStart } }] },
    }),
  ]);
  const dailyCap = Math.min(account.dailyCap, getEmailDailyCap());
  if (daily >= dailyCap) return { ok: false, error: `Daily test cap reached (${dailyCap})` };
  if (hourly >= account.hourlyCap) return { ok: false, error: "Hourly cap reached" };

  const transport = getEmailTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.secure,
    user: account.smtpUser,
    password: decryptSecret(account.smtpPasswordEncrypted),
  });
  try {
    const info = await transport.sendMail({
      from: `${account.fromName} <${account.fromAddress}>`,
      to: account.fromAddress,
      subject: "SMTP test email",
      text: "This is a test email from your Insta Scraper email account.",
    });
    await prisma.emailSend.create({
      data: {
        campaignId: null,
        leadId: null,
        senderAccountId: account.id,
        recipient: account.fromAddress,
        recipientDomain: account.fromAddress.split("@")[1] ?? null,
        status: "SENT",
        subject: "SMTP test email",
        body: "Test email",
        messageId: info.messageId ?? null,
        senderIdentity: `${account.fromName} <${account.fromAddress}>`,
        templateVersion: 0,
        isTest: true,
        sentAt: now,
      },
    });
    await prisma.emailSenderAccount.update({
      where: { id: account.id },
      data: { lastSentAt: now, consecutiveErrors: 0, lastError: null },
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Test send failed";
    await prisma.emailSenderAccount.update({
      where: { id: account.id },
      data: { lastError: message, consecutiveErrors: { increment: 1 } },
    });
    return { ok: false, error: message };
  }
}
