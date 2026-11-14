import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { decryptSecret } from "./email-crypto";
import { getEmailTransport, type EmailSendResult } from "./email-transport";
import { checkEmailAddress } from "./email-address-quality";
import {
  buildComplianceFooter,
  buildEmailGreeting,
  buildListUnsubscribeHeaders,
  buildUnsubscribeUrl,
  generateUnsubscribeToken,
  getAppPublicUrl,
  lintEmailContent,
  renderEmailTemplate,
} from "./email-compliance";
import { reserveEmailSend } from "./email-gate";

export type SendEmailOutcome = {
  status: "SENT" | "UNKNOWN" | "FAILED" | "SUPPRESSED" | "NEEDS_EDIT";
  reason?: string;
  emailSendId?: string;
  messageId?: string;
};

function getCompanyNameFromEnv(): string {
  return process.env.EMAIL_COMPANY_NAME?.trim() || "Insta Scraper";
}

function buildFromHeader(fromName: string, fromAddress: string): string {
  const safeName = fromName.replace(/["\r\n]/g, "").trim();
  return `${safeName} <${fromAddress}>`;
}

function isTimeoutError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    code === "ETIMEDOUT" ||
    code === "ESOCKET" ||
    code === "ECONNRESET" ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

function getSmtpStatus(error: unknown): number | null {
  const direct = (error as { responseCode?: number }).responseCode;
  if (typeof direct === "number") return direct;
  const response = (error as { response?: string }).response;
  const match = typeof response === "string" ? response.match(/^(\d{3})/) : null;
  return match ? Number.parseInt(match[1], 10) : null;
}

export async function sendEmailForLead(input: {
  leadId: string;
  campaignId?: string;
  senderAccountId?: string;
  now?: Date;
  jitterSecondsOverride?: number;
  recipientTimeZone?: string;
}): Promise<SendEmailOutcome> {
  const prisma = getPrismaClient();
  const now = input.now ?? new Date();

  if (!getAppPublicUrl()) {
    return { status: "SUPPRESSED", reason: "APP_PUBLIC_URL is not configured" };
  }

  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
    select: {
      id: true,
      campaignId: true,
      email: true,
      emailNormalized: true,
      emailSourceUrl: true,
      emailFoundAt: true,
      emailConfidence: true,
      emailInvalid: true,
      emailOptOutAt: true,
      fullName: true,
      username: true,
      city: true,
      website: true,
      groupKey: true,
      hasEmail: true,
      campaign: { select: { id: true, name: true, userId: true, companyProfile: { select: { name: true } } } },
    },
  });
  if (!lead) return { status: "SUPPRESSED", reason: "Lead not found" };

  const campaignId = input.campaignId ?? lead.campaignId;
  const settings = await prisma.emailCampaignSettings.findUnique({
    where: { campaignId },
  });
  if (!settings || !settings.enabled) {
    return { status: "NEEDS_EDIT", reason: "Email is not enabled for this campaign" };
  }

  const accountId =
    input.senderAccountId ??
    (
      await prisma.emailSenderAccount.findFirst({
        where: { userId: lead.campaign.userId, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      })
    )?.id;
  if (!accountId) return { status: "SUPPRESSED", reason: "No active email sender account" };

  const account = await prisma.emailSenderAccount.findUnique({ where: { id: accountId } });
  if (!account) return { status: "SUPPRESSED", reason: "Sender account not found" };

  const quality = await checkEmailAddress(lead.emailNormalized ?? lead.email, {
    checkMx: false,
  });
  if (!quality.valid || !quality.normalized) {
    return { status: "SUPPRESSED", reason: quality.reason ?? "Invalid recipient email" };
  }
  if (lead.emailInvalid || lead.emailOptOutAt) {
    return { status: "SUPPRESSED", reason: "Recipient is suppressed or opted out" };
  }

  const businessName = lead.fullName ?? lead.username ?? null;
  const templateContext = {
    businessName: businessName,
    city: lead.city,
    firstName: null,
  };
  const subjectRendered = renderEmailTemplate(settings.subjectTemplate, templateContext);
  const bodyRendered = renderEmailTemplate(settings.bodyTemplate, templateContext);
  const unresolved = Array.from(
    new Set([...subjectRendered.unresolved, ...bodyRendered.unresolved]),
  );
  if (unresolved.length > 0) {
    return {
      status: "NEEDS_EDIT",
      reason: `Unresolved placeholders: ${unresolved.map((p) => `{${p}}`).join(", ")}`,
    };
  }

  const greeting = buildEmailGreeting(templateContext.businessName);
  const bodyWithGreeting = bodyRendered.text.trim().startsWith(greeting)
    ? bodyRendered.text
    : `${greeting}\n\n${bodyRendered.text}`;

  const tokenValue = generateUnsubscribeToken();
  let unsubscribeUrl: string;
  try {
    unsubscribeUrl = buildUnsubscribeUrl(tokenValue);
  } catch {
    return { status: "SUPPRESSED", reason: "APP_PUBLIC_URL is not configured" };
  }

  const footer = buildComplianceFooter({
    senderName: account.fromName,
    companyName: getCompanyNameFromEnv(),
    postalAddress: account.postalAddress,
    unsubscribeUrl,
  });
  const finalBody = `${bodyWithGreeting.trimEnd()}\n${footer}\n`;

  const spamProblems = lintEmailContent(subjectRendered.text, finalBody);
  if (spamProblems.length > 0) {
    return { status: "NEEDS_EDIT", reason: spamProblems.join("; ") };
  }

  const reservation = await reserveEmailSend({
    senderAccountId: account.id,
    campaignId,
    leadId: lead.id,
    recipient: quality.normalized,
    subject: subjectRendered.text.trim(),
    body: finalBody,
    senderIdentity: `${account.fromName} <${account.fromAddress}>`,
    templateVersion: settings.templateVersion,
    addressSource: lead.emailSourceUrl,
    addressFoundAt: lead.emailFoundAt,
    addressConfidence: lead.emailConfidence,
    now,
    jitterSecondsOverride: input.jitterSecondsOverride,
    recipientTimeZone: input.recipientTimeZone,
  });
  if (!reservation.success) {
    return {
      status: reservation.reason.includes("cap") || reservation.reason.includes("hours") || reservation.reason.includes("Jitter")
        ? "SUPPRESSED"
        : "FAILED",
      reason: reservation.reason,
    };
  }

  const emailSendId = reservation.emailSendId;
  await prisma.emailUnsubscribeToken.create({
    data: {
      token: tokenValue,
      leadId: lead.id,
      campaignId,
      emailNormalized: quality.normalized,
    },
  });

  const transport = getEmailTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.secure,
    user: account.smtpUser,
    password: decryptSecret(account.smtpPasswordEncrypted),
  });

  let result: EmailSendResult;
  try {
    const info = await transport.sendMail({
      from: buildFromHeader(account.fromName, account.fromAddress),
      to: quality.normalized,
      subject: subjectRendered.text.trim(),
      text: finalBody,
      headers: {
        ...buildListUnsubscribeHeaders({
          mailto: account.fromAddress,
          unsubscribeUrl,
        }),
      },
    });
    result = {
      messageId: info.messageId ?? "",
      accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [],
      rejected: Array.isArray(info.rejected) ? info.rejected.map(String) : [],
      response: typeof info.response === "string" ? info.response : "",
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      await prisma.emailSend.update({
        where: { id: emailSendId },
        data: {
          status: "UNKNOWN",
          errorCode: "TIMEOUT",
          errorMessage: "SMTP outcome unknown after timeout; not retried",
        },
      });
      return {
        status: "UNKNOWN",
        reason: "SMTP timeout; marked UNKNOWN and will not be retried",
        emailSendId,
      };
    }

    const smtpStatus = getSmtpStatus(error);
    const isHardBounce = smtpStatus !== null && smtpStatus >= 500 && smtpStatus < 600;
    const isAuthError =
      smtpStatus === 535 ||
      smtpStatus === 534 ||
      smtpStatus === 530 ||
      (error instanceof Error && /auth|credentials|login/i.test(error.message));
    const isThrottle =
      smtpStatus === 421 ||
      smtpStatus === 450 ||
      smtpStatus === 451 ||
      smtpStatus === 452 ||
      smtpStatus === 454 ||
      (smtpStatus !== null && smtpStatus >= 400 && smtpStatus < 500);

    await prisma.emailSend.update({
      where: { id: emailSendId },
      data: {
        status: "FAILED",
        errorCode: isHardBounce
          ? "SMTP_5XX"
          : isAuthError
            ? "SMTP_AUTH"
            : isThrottle
              ? "SMTP_4XX"
              : "SMTP_ERROR",
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : "SMTP send failed",
      },
    });

    if (isHardBounce) {
      await markEmailHardBounce({ leadId: lead.id, email: quality.normalized });
    }

    const nextErrors = account.consecutiveErrors + 1;
    let pausedUntil: Date | null = null;
    let status = account.status;
    if (isAuthError) {
      pausedUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      status = "PAUSED";
    } else if (isThrottle) {
      pausedUntil = new Date(
        now.getTime() + Math.min(6 * 60 * 60 * 1000, 15 * 60 * 1000 * 2 ** (nextErrors - 1)),
      );
      status = "PAUSED";
    } else if (isHardBounce) {
      const last20 = await prisma.emailSend.findMany({
        where: { senderAccountId: account.id },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { status: true },
      });
      const failures = last20.filter((s) => s.status === "FAILED").length;
      if (last20.length >= 20 && failures / last20.length > 0.05) {
        pausedUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        status = "PAUSED";
      }
    }

    await prisma.emailSenderAccount.update({
      where: { id: account.id },
      data: {
        consecutiveErrors: nextErrors,
        lastError: isHardBounce ? "Hard bounce (5xx)" : isAuthError ? "SMTP auth error" : "SMTP throttle",
        status,
        pausedUntil,
      },
    });

    return {
      status: "FAILED",
      reason: error instanceof Error ? error.message.slice(0, 300) : "SMTP send failed",
      emailSendId,
    };
  }

  await prisma.emailSend.update({
    where: { id: emailSendId },
    data: {
      status: "SENT",
      sentAt: now,
      messageId: result.messageId || null,
    },
  });
  await prisma.emailSenderAccount.update({
    where: { id: account.id },
    data: {
      lastSentAt: now,
      consecutiveErrors: 0,
      lastError: null,
    },
  });

  return {
    status: "SENT",
    emailSendId,
    messageId: result.messageId,
  };
}

export async function markEmailHardBounce(input: {
  leadId: string;
  email: string;
}): Promise<void> {
  const prisma = getPrismaClient();
  const domain = input.email.split("@")[1]?.toLowerCase() ?? null;
  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
    select: { campaign: { select: { userId: true } } },
  });
  const userId = lead?.campaign?.userId;
  await prisma.lead.update({
    where: { id: input.leadId },
    data: { emailInvalid: true, emailOptOutAt: new Date() },
  });
  if (!userId) return;
  const rows = [
    {
      userId,
      channel: "EMAIL" as const,
      identifierType: "EMAIL" as const,
      identifierNormalized: input.email.toLowerCase(),
      reason: "Hard bounce",
      source: "MANUAL" as const,
    },
    ...(domain
      ? [
          {
            userId,
            channel: "EMAIL" as const,
            identifierType: "DOMAIN" as const,
            identifierNormalized: domain,
            reason: "Hard bounce",
            source: "MANUAL" as const,
          },
        ]
      : []),
  ];
  for (const row of rows) {
    await prisma.doNotContact.upsert({
      where: {
        userId_channel_identifierType_identifierNormalized: {
          userId: row.userId,
          channel: row.channel,
          identifierType: row.identifierType,
          identifierNormalized: row.identifierNormalized,
        },
      },
      create: row,
      update: { reason: row.reason },
    });
  }
}
