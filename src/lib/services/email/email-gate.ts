import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { isOutboundSendingEnabled } from "../messaging/send-gate";
import { getEmailDomain } from "./email-address-quality";
import { getAppPublicUrl } from "./email-compliance";

export type EmailGateInput = {
  senderAccountId: string;
  campaignId: string;
  leadId: string;
  now?: Date;
  jitterSecondsOverride?: number;
  recipientTimeZone?: string;
};

export type EmailGateResult =
  | { allowed: true; effectiveDailyCap: number; nextAllowedAt: Date | null }
  | { allowed: false; reason: string; retryAt?: Date | null };

export type ReserveEmailInput = EmailGateInput & {
  recipient: string;
  subject: string;
  body: string;
  senderIdentity: string;
  templateVersion: number;
  addressSource?: string | null;
  addressFoundAt?: Date | null;
  addressConfidence?: number | null;
};

export type ReserveEmailResult =
  | { success: true; emailSendId: string; nextAllowedAt: Date | null }
  | { success: false; reason: string };

function intEnv(name: string, fallback: number, min = 1): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function getEmailDailyCap(): number {
  return Math.min(intEnv("EMAIL_DAILY_CAP", 15), intEnv("EMAIL_DAILY_HARD_MAX", 30));
}

export function getEmailHourlyCap(): number {
  return intEnv("EMAIL_HOURLY_CAP", 4);
}

export function getEmailJitterSeconds(): { min: number; max: number } {
  const min = intEnv("EMAIL_JITTER_MIN_SECONDS", 240, 0);
  const max = Math.max(min, intEnv("EMAIL_JITTER_MAX_SECONDS", 720, 0));
  return { min, max };
}

function startOfDayUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

const CITY_TIMEZONES: Record<string, string> = {
  toronto: "America/Toronto",
  vancouver: "America/Vancouver",
  montreal: "America/Toronto",
  calgary: "America/Edmonton",
  ottawa: "America/Toronto",
  edmonton: "America/Edmonton",
  "new york": "America/New_York",
  "los angeles": "America/Los_Angeles",
  chicago: "America/Chicago",
  houston: "America/Chicago",
  miami: "America/New_York",
  "san francisco": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  boston: "America/New_York",
  austin: "America/Chicago",
  dallas: "America/Chicago",
  atlanta: "America/New_York",
  london: "Europe/London",
  tokyo: "Asia/Tokyo",
  sydney: "Australia/Sydney",
};

export function resolveRecipientTimeZone(input: {
  city?: string | null;
  country?: string | null;
  override?: string;
}): string {
  if (input.override) return input.override;
  const city = input.city?.trim().toLowerCase();
  if (city && CITY_TIMEZONES[city]) return CITY_TIMEZONES[city];
  const country = input.country?.trim().toLowerCase();
  if (country === "ca" || country === "canada") return "America/Toronto";
  if (country === "us" || country === "usa" || country === "united states") {
    return "America/New_York";
  }
  if (country === "gb" || country === "uk" || country === "united kingdom") {
    return "Europe/London";
  }
  if (country === "au" || country === "australia") return "Australia/Sydney";
  return "UTC";
}

function localParts(date: Date, timeZone: string): {
  weekday: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    weekday: weekdayMap[parts.weekday ?? "Sun"] ?? 0,
    hour: Number.parseInt(parts.hour ?? "0", 10),
    minute: Number.parseInt(parts.minute ?? "0", 10),
  };
}

export function isRecipientWorkingHours(now: Date, timeZone: string): boolean {
  const { weekday, hour } = localParts(now, timeZone);
  const start = intEnv("EMAIL_WORKING_HOURS_START", 9, 0);
  const end = intEnv("EMAIL_WORKING_HOURS_END", 17, 1);
  return weekday >= 1 && weekday <= 5 && hour >= start && hour < end;
}

export function getEffectiveDailyCap(
  configuredCap: number,
  warmupStartedAt: Date | null,
  now: Date,
): number {
  const cap = Math.min(configuredCap, getEmailDailyCap());
  if (!warmupStartedAt) return Math.min(5, cap);
  const days = Math.floor((now.getTime() - warmupStartedAt.getTime()) / 86_400_000) + 1;
  if (days <= 3) return Math.min(5, cap);
  if (days <= 7) return Math.min(10, cap);
  return cap;
}

export async function canSendEmailNow(input: EmailGateInput): Promise<EmailGateResult> {
  if (!isOutboundSendingEnabled()) {
    return { allowed: false, reason: "OUTBOUND_SENDING_ENABLED is false" };
  }
  if (!getAppPublicUrl()) {
    return { allowed: false, reason: "APP_PUBLIC_URL is not configured; email sending is disabled" };
  }

  const prisma = getPrismaClient();
  const now = input.now ?? new Date();
  const account = await prisma.emailSenderAccount.findUnique({
    where: { id: input.senderAccountId },
  });
  if (!account) return { allowed: false, reason: "Email sender account not found" };
  if (account.status !== "ACTIVE") {
    return { allowed: false, reason: `Email account status is ${account.status}` };
  }
  if (account.pausedUntil && account.pausedUntil > now) {
    return { allowed: false, reason: "Email account is paused", retryAt: account.pausedUntil };
  }
  if (account.dkimStatus !== "PASS" || account.spfStatus !== "PASS") {
    if (!account.allowDnsOverride) {
      return { allowed: false, reason: "SPF/DKIM DNS check failed for sender domain" };
    }
  }

  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
    select: {
      id: true,
      email: true,
      emailNormalized: true,
      emailInvalid: true,
      emailOptOutAt: true,
      website: true,
      websiteDomain: true,
      city: true,
      groupKey: true,
      campaignId: true,
      campaign: { select: { userId: true } },
    },
  });
  if (!lead) return { allowed: false, reason: "Lead not found" };
  if (!lead.emailNormalized) return { allowed: false, reason: "Lead has no email address" };
  if (lead.emailInvalid) return { allowed: false, reason: "Lead email is marked invalid" };
  if (lead.emailOptOutAt) return { allowed: false, reason: "Lead opted out of email" };

  const recipientTimeZone = resolveRecipientTimeZone({
    city: lead.city,
    override: input.recipientTimeZone,
  });
  if (!isRecipientWorkingHours(now, recipientTimeZone)) {
    return { allowed: false, reason: "Outside recipient working hours (Mon-Fri 09:00-17:00)" };
  }

  // Cross-channel: a lead already DM'd is never emailed.
  const dm = await prisma.message.findFirst({
    where: {
      leadId: lead.id,
      direction: "OUTBOUND",
      status: { in: ["SENT", "SENDING"] },
    },
    select: { id: true },
  });
  if (dm) return { allowed: false, reason: "Lead was already contacted by Instagram DM" };

  // One email per lead, ever.
  const existing = await prisma.emailSend.findUnique({
    where: { leadId: lead.id },
    select: { id: true, status: true },
  });
  if (existing) {
    return { allowed: false, reason: `Email already attempted for this lead (${existing.status})` };
  }

  // DNC: email, domain, or ALL.
  const domain = getEmailDomain(lead.emailNormalized);
  const userId = lead.campaign?.userId;
  if (userId) {
    const dnc = await prisma.doNotContact.findFirst({
      where: {
        userId,
        OR: [
          {
            channel: "EMAIL",
            identifierType: "EMAIL",
            identifierNormalized: lead.emailNormalized,
          },
          ...(domain
            ? [
                {
                  channel: "EMAIL" as const,
                  identifierType: "DOMAIN" as const,
                  identifierNormalized: domain,
                },
              ]
            : []),
          {
            channel: "ALL",
            identifierType: "EMAIL",
            identifierNormalized: lead.emailNormalized,
          },
          ...(domain
            ? [
                {
                  channel: "ALL" as const,
                  identifierType: "DOMAIN" as const,
                  identifierNormalized: domain,
                },
              ]
            : []),
        ],
      },
      select: { id: true },
    });
    if (dnc) return { allowed: false, reason: "Recipient/domain is on the Do Not Contact list" };
  }

  // One email per business group/domain per campaign.
  const groupMessage = await prisma.emailSend.findFirst({
    where: {
      campaignId: input.campaignId,
      recipientDomain: domain,
      status: { in: ["SENT", "QUEUED", "UNKNOWN"] },
    },
    select: { id: true },
  });
  if (groupMessage) {
    return { allowed: false, reason: "Another lead in this campaign/domain was already emailed" };
  }
  if (lead.groupKey) {
    const groupEmail = await prisma.emailSend.findFirst({
      where: {
        campaignId: input.campaignId,
        groupKey: lead.groupKey,
        status: { in: ["SENT", "QUEUED", "UNKNOWN"] },
      },
      select: { id: true },
    });
    if (groupEmail) return { allowed: false, reason: "This business group was already emailed" };
  }

  const effectiveDailyCap = getEffectiveDailyCap(account.dailyCap, account.warmupStartedAt, now);
  const dayStart = startOfDayUtc(now);
  const hourStart = new Date(now.getTime() - 60 * 60 * 1000);
  const [dailyCount, hourlyCount] = await Promise.all([
    prisma.emailSend.count({
      where: {
        senderAccountId: account.id,
        OR: [
          { sentAt: { gte: dayStart } },
          { status: "QUEUED", reservedAt: { gte: dayStart } },
        ],
      },
    }),
    prisma.emailSend.count({
      where: {
        senderAccountId: account.id,
        OR: [
          { sentAt: { gte: hourStart } },
          { status: "QUEUED", reservedAt: { gte: hourStart } },
        ],
      },
    }),
  ]);
  if (dailyCount >= effectiveDailyCap) {
    return { allowed: false, reason: `Daily email cap reached (${effectiveDailyCap})` };
  }
  if (hourlyCount >= account.hourlyCap) {
    return { allowed: false, reason: `Hourly email cap reached (${account.hourlyCap})` };
  }

  const jitter = getEmailJitterSeconds();
  const jitterSeconds =
    input.jitterSecondsOverride ??
    jitter.min + Math.floor(Math.random() * Math.max(1, jitter.max - jitter.min + 1));
  if (account.lastSentAt) {
    const nextAllowedAt = new Date(account.lastSentAt.getTime() + jitterSeconds * 1000);
    if (now < nextAllowedAt) {
      return { allowed: false, reason: "Jitter delay between emails", retryAt: nextAllowedAt };
    }
  }

  return { allowed: true, effectiveDailyCap, nextAllowedAt: null };
}

export async function reserveEmailSend(
  input: ReserveEmailInput,
): Promise<ReserveEmailResult> {
  const gate = await canSendEmailNow(input);
  if (!gate.allowed) return { success: false, reason: gate.reason };

  const prisma = getPrismaClient();
  const domain = getEmailDomain(input.recipient);
  try {
    const created = await prisma.emailSend.create({
      data: {
        campaignId: input.campaignId,
        leadId: input.leadId,
        senderAccountId: input.senderAccountId,
        recipient: input.recipient,
        recipientDomain: domain,
        status: "QUEUED",
        subject: input.subject,
        body: input.body,
        templateVersion: input.templateVersion,
        senderIdentity: input.senderIdentity,
        addressSource: input.addressSource ?? null,
        addressFoundAt: input.addressFoundAt ?? null,
        addressConfidence: input.addressConfidence ?? null,
        groupKey: null,
      },
      select: { id: true },
    });
    return { success: true, emailSendId: created.id, nextAllowedAt: null };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2002") {
      return { success: false, reason: "Email already attempted for this lead" };
    }
    throw error;
  }
}
