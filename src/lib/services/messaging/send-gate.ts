import "server-only";

import { createHash } from "node:crypto";
import { getPrismaClient } from "@/lib/db/prisma";
import {
  InstagramSenderStatus,
  MessageStatus,
} from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { withMysqlRetry } from "@/lib/db/mysql-retry";
import { logger } from "@/lib/logger";
import { checkLeadSuppression, DncChannel } from "../compliance";
import { notifySenderStatusChange } from "../notifications/notification-triggers";
import { extractDomainParts } from "../discovery/name-website-matcher";

// ---------------------------------------------------------------------------
// Configuration & Defaults (All Configurable via Environment)
// ---------------------------------------------------------------------------

export function getSenderDailyHardMax(): number {
  const envVal = process.env.SENDER_DAILY_HARD_MAX;
  const parsed = envVal ? Number(envVal) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 40;
}

export function getDefaultDailyCapNewAccount(): number {
  const envVal = process.env.SENDER_DAILY_DEFAULT;
  const parsed = envVal ? Number(envVal) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 25;
}

export function getDefaultHourlyCap(): number {
  const envVal = process.env.SENDER_HOURLY_CAP;
  const parsed = envVal ? Number(envVal) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 6;
}

export const getSenderHourlyCap = getDefaultHourlyCap;

export function getSenderHourlyHardMax(): number {
  const envVal = process.env.SENDER_HOURLY_HARD_MAX;
  const parsed = envVal ? Number(envVal) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 10;
}

export function getSenderMinGapSeconds(): number {
  const envVal =
    process.env.SENDER_MIN_GAP_SECONDS ??
    process.env.SENDER_MIN_GAP ??
    process.env.SENDER_COOLDOWN_SECONDS;
  if (envVal !== undefined && envVal !== "") {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  const minVal = process.env.SENDER_COOLDOWN_MINUTES;
  if (minVal !== undefined && minVal !== "") {
    const parsed = Number(minVal);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed) * 60;
  }
  return 360; // 6 minutes (360s)
}

export function getSenderMaxGapSeconds(): number {
  const envVal =
    process.env.SENDER_MAX_GAP_SECONDS ??
    process.env.SENDER_MAX_GAP;
  if (envVal !== undefined && envVal !== "") {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  const minGap = getSenderMinGapSeconds();
  return minGap === 0 ? 0 : Math.max(minGap, 900); // 15 minutes (900s) default or 0 if minGap is 0
}

export function getWorkingHoursStart(): number {
  const envVal = process.env.WORKING_HOURS_START;
  const parsed = envVal ? Number(envVal) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? Math.trunc(parsed) : 9; // 09:00
}

export function getWorkingHoursEnd(): number {
  const envVal = process.env.WORKING_HOURS_END;
  const parsed = envVal ? Number(envVal) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 24 ? Math.trunc(parsed) : 18; // 18:00
}

export function getSkipWeekends(): boolean {
  return process.env.SKIP_WEEKENDS === "true" || process.env.SKIP_WEEKENDS === "1";
}

export function getMessageVariationWindowMinutes(): number {
  const envVal = process.env.MESSAGE_VARIATION_WINDOW_MINUTES;
  const parsed = envVal ? Number(envVal) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 60; // 60 minutes
}

export function getFirstMessageMaxLinks(): number {
  const envVal = process.env.FIRST_MESSAGE_MAX_LINKS;
  const parsed = envVal ? Number(envVal) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 1;
}

// ---------------------------------------------------------------------------
// Global Outbound Sending Kill Switch & Dry-Run Lead Guard
// ---------------------------------------------------------------------------

let outboundSendingOverride: boolean | null = null;

export function setOutboundSendingEnabledForTesting(enabled: boolean | null): void {
  if (process.env.NODE_ENV !== "test") {
    return;
  }
  outboundSendingOverride = enabled;
}

export function isOutboundSendingEnabled(): boolean {
  if (process.env.NODE_ENV === "test" && outboundSendingOverride !== null) {
    return outboundSendingOverride;
  }
  const envVal = process.env.OUTBOUND_SENDING_ENABLED?.trim().toLowerCase();
  return envVal === "true" || envVal === "1";
}

export function isDryRunLead(lead: {
  isDryRun?: boolean | null;
  source?: string | null;
  username?: string | null;
  usernameNormalized?: string | null;
  rawProfileData?: unknown;
  website?: string | null;
  phone?: string | null;
  gmapsPlaceId?: string | null;
} | null | undefined): boolean {
  if (!lead) return false;
  if (lead.isDryRun === true) return true;
  if (lead.source === "dry_run" || lead.source === "sample") return true;
  if (typeof lead.source === "string" && lead.source.startsWith("sample_")) return true;
  const username = (lead.usernameNormalized || lead.username || "").toLowerCase();
  if (
    username.startsWith("sample_business") ||
    username.startsWith("sample_ig_place") ||
    username.startsWith("sample_")
  ) {
    return true;
  }
  if (lead.website && typeof lead.website === "string" && lead.website.toLowerCase().includes("example.com")) {
    return true;
  }
  if (lead.phone && typeof lead.phone === "string" && (lead.phone.includes("555-01") || lead.phone.includes("55501"))) {
    return true;
  }
  if (lead.gmapsPlaceId && typeof lead.gmapsPlaceId === "string" && lead.gmapsPlaceId.startsWith("ChIJmockPlace")) {
    return true;
  }
  if (
    lead.rawProfileData &&
    typeof lead.rawProfileData === "object" &&
    (lead.rawProfileData as Record<string, unknown>).isDryRun === true
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fake Clock Injection for Deterministic Tests
// ---------------------------------------------------------------------------

let injectedClock: (() => Date) | null = null;

export function setSendGateClock(clock: (() => Date) | null): void {
  if (process.env.NODE_ENV !== "test") {
    return;
  }
  injectedClock = clock;
}

export function getSendGateNow(): Date {
  if (process.env.NODE_ENV === "test" && injectedClock) {
    return injectedClock();
  }
  return new Date();
}

// ---------------------------------------------------------------------------
// Jitter Generator (Re-rolled per send)
// ---------------------------------------------------------------------------

export function getRandomGapMs(
  minSeconds = getSenderMinGapSeconds(),
  maxSeconds = getSenderMaxGapSeconds(),
  rng: () => number = Math.random,
): number {
  const min = Math.max(0, minSeconds * 1000);
  const max = Math.max(min, maxSeconds * 1000);
  if (min === max) return min;
  return Math.floor(min + rng() * (max - min));
}

// Micro delay before API call
export async function executeMicroDelay(
  minMs = 200,
  maxMs = 800,
): Promise<void> {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.SKIP_SEND_DELAYS === "1" ||
    process.env.CI === "true"
  ) {
    return;
  }
  const delay = Math.floor(minMs + Math.random() * (maxMs - minMs));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

// ---------------------------------------------------------------------------
// Timezone & Working Hours Resolver
// ---------------------------------------------------------------------------

const CITY_COUNTRY_TIMEZONE_MAP: Record<string, string> = {
  // US & Canada
  "new york": "America/New_York",
  "ny": "America/New_York",
  "nyc": "America/New_York",
  "los angeles": "America/Los_Angeles",
  "la": "America/Los_Angeles",
  "chicago": "America/Chicago",
  "houston": "America/Chicago",
  "dallas": "America/Chicago",
  "miami": "America/New_York",
  "san francisco": "America/Los_Angeles",
  "sf": "America/Los_Angeles",
  "seattle": "America/Los_Angeles",
  "boston": "America/New_York",
  "toronto": "America/Toronto",
  "vancouver": "America/Vancouver",
  "montreal": "America/Toronto",
  "calgary": "America/Edmonton",
  "ottawa": "America/Toronto",
  "usa": "America/New_York",
  "united states": "America/New_York",
  "canada": "America/Toronto",

  // UK & Europe
  "london": "Europe/London",
  "manchester": "Europe/London",
  "birmingham": "Europe/London",
  "uk": "Europe/London",
  "united kingdom": "Europe/London",
  "paris": "Europe/Paris",
  "france": "Europe/Paris",
  "berlin": "Europe/Berlin",
  "germany": "Europe/Berlin",
  "madrid": "Europe/Madrid",
  "spain": "Europe/Madrid",
  "rome": "Europe/Rome",
  "italy": "Europe/Rome",
  "amsterdam": "Europe/Amsterdam",
  "netherlands": "Europe/Amsterdam",

  // APAC & Australia
  "tokyo": "Asia/Tokyo",
  "japan": "Asia/Tokyo",
  "sydney": "Australia/Sydney",
  "melbourne": "Australia/Melbourne",
  "brisbane": "Australia/Brisbane",
  "perth": "Australia/Perth",
  "australia": "Australia/Sydney",
  "singapore": "Asia/Singapore",
  "hong kong": "Asia/Hong_Kong",
  "dubai": "Asia/Dubai",
  "uae": "Asia/Dubai",
  "karachi": "Asia/Karachi",
  "pakistan": "Asia/Karachi",
  "mumbai": "Asia/Kolkata",
  "delhi": "Asia/Kolkata",
  "india": "Asia/Kolkata",
};

export function resolveLeadTimezone(
  lead?: { city?: string | null; location?: string | null } | null,
  fallbackTz = "UTC",
): string {
  if (!lead) return fallbackTz;

  const rawLocation = [lead.city, lead.location]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .trim();

  if (!rawLocation) return fallbackTz;

  // Check direct matches or substring matches
  for (const [key, tz] of Object.entries(CITY_COUNTRY_TIMEZONE_MAP)) {
    const regex = new RegExp(`\\b${key}\\b`, "i");
    if (regex.test(rawLocation)) {
      return tz;
    }
  }

  // Check if string contains a valid IANA timezone name
  try {
    Intl.DateTimeFormat(undefined, { timeZone: rawLocation });
    return rawLocation;
  } catch {
    // Not a direct timezone name
  }

  return fallbackTz;
}

export type WorkingHoursCheck = {
  inWindow: boolean;
  localHour: number;
  localMinute: number;
  isWeekend: boolean;
  nextWindowStart: Date;
  timezone: string;
};

export function isWithinWorkingHours(
  now: Date,
  timezone: string,
  startHour = getWorkingHoursStart(),
  endHour = getWorkingHoursEnd(),
  skipWeekends = getSkipWeekends(),
): WorkingHoursCheck {
  let targetTz = timezone;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: targetTz });
  } catch {
    targetTz = "UTC";
  }

  // Format date components in target timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: targetTz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const partMap: Record<string, string> = {};
  for (const part of parts) {
    partMap[part.type] = part.value;
  }

  let localHour = parseInt(partMap.hour ?? "0", 10);
  if (localHour === 24) localHour = 0;
  const localMinute = parseInt(partMap.minute ?? "0", 10);
  const weekday = (partMap.weekday ?? "").toLowerCase();
  const isWeekend = weekday.startsWith("sat") || weekday.startsWith("sun");

  const withinHours = localHour >= startHour && localHour < endHour;
  const inWindow = withinHours && (!skipWeekends || !isWeekend);

  // Calculate next opening window
  const nowMs = now.getTime();
  let nextWindowStart = new Date(nowMs);

  if (!inWindow) {
    // If before startHour today and not weekend: opens today at startHour:00
    if (localHour < startHour && (!skipWeekends || !isWeekend)) {
      const msUntilStart = (startHour - localHour) * 3600 * 1000 - localMinute * 60 * 1000;
      nextWindowStart = new Date(nowMs + msUntilStart);
    } else {
      // Find days until next business day at startHour
      let daysToAdd = 1;
      if (skipWeekends) {
        if (weekday.startsWith("fri") && localHour >= endHour) daysToAdd = 3;
        else if (weekday.startsWith("sat")) daysToAdd = 2;
        else if (weekday.startsWith("sun")) daysToAdd = 1;
      }
      const msToAdd =
        daysToAdd * 24 * 3600 * 1000 +
        (startHour - localHour) * 3600 * 1000 -
        localMinute * 60 * 1000;
      nextWindowStart = new Date(nowMs + msToAdd);
    }
  }

  return {
    inWindow,
    localHour,
    localMinute,
    isWeekend,
    nextWindowStart,
    timezone: targetTz,
  };
}

// ---------------------------------------------------------------------------
// Warm-up Ramp Limits
// ---------------------------------------------------------------------------

export type WarmupRampInfo = {
  dailyCap: number;
  stage: string;
  daysActive: number;
  isWarming: boolean;
};

export function getWarmupLimit(
  warmupStartedAt: Date | null | undefined,
  configuredCap?: number | null,
  now: Date = getSendGateNow(),
): WarmupRampInfo {
  const hardMax = getSenderDailyHardMax();
  const defaultBaseCap = getDefaultDailyCapNewAccount();

  if (!warmupStartedAt) {
    return {
      dailyCap: 8,
      stage: "Days 1-3 (8/day)",
      daysActive: 1,
      isWarming: true,
    };
  }

  const elapsedMs = Math.max(0, now.getTime() - warmupStartedAt.getTime());
  const daysActive = Math.floor(elapsedMs / (24 * 3600 * 1000)) + 1;

  if (daysActive <= 3) {
    return {
      dailyCap: 8,
      stage: "Days 1-3 (8/day)",
      daysActive,
      isWarming: true,
    };
  }

  if (daysActive <= 7) {
    return {
      dailyCap: 15,
      stage: "Days 4-7 (15/day)",
      daysActive,
      isWarming: true,
    };
  }

  if (daysActive <= 14) {
    return {
      dailyCap: 25,
      stage: "Days 8-14 (25/day)",
      daysActive,
      isWarming: true,
    };
  }

  const targetCap = Math.min(configuredCap && configuredCap > 0 ? configuredCap : defaultBaseCap, hardMax);
  return {
    dailyCap: targetCap,
    stage: "Fully Warmed",
    daysActive,
    isWarming: false,
  };
}

export function calculateWarmupCap(input: {
  warmupStartedAt?: Date | null;
  configuredDailyCap?: number | null;
  now?: Date;
}): WarmupRampInfo {
  return getWarmupLimit(input.warmupStartedAt, input.configuredDailyCap, input.now);
}

// ---------------------------------------------------------------------------
// Danger Signals & Auto-Pause Backoff
// ---------------------------------------------------------------------------

export const DANGER_ERROR_CODES = new Set([
  "RATE_LIMITED",
  "PLATFORM_BLOCKED",
  "CAPTCHA_REQUIRED",
  "ACCOUNT_RESTRICTED",
  "AUTH_REQUIRED",
  "CHALLENGE_DETECTED",
  "EXPIRED",
  "SESSION_UNAVAILABLE",
]);

export function isDangerErrorCode(code?: string | null): boolean {
  if (!code) return false;
  return DANGER_ERROR_CODES.has(code.toUpperCase().trim());
}

export function calculateBackoffPauseUntil(
  consecutiveErrors: number,
  now: Date = getSendGateNow(),
): { pausedUntil: Date; backoffHours: number } {
  // Exponential backoff: 1h -> 6h -> 24h
  let hours = 1;
  if (consecutiveErrors === 2) {
    hours = 6;
  } else if (consecutiveErrors >= 3) {
    hours = 24;
  }
  const pausedUntil = new Date(now.getTime() + hours * 3600 * 1000);
  return { pausedUntil, backoffHours: hours };
}

// ---------------------------------------------------------------------------
// Helpers: Day/Hour Formatting for Persistent Rollovers
// ---------------------------------------------------------------------------

export function formatSenderDateString(date: Date, timezone = "UTC"): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date); // YYYY-MM-DD
  } catch {
    return date.toISOString().split("T")[0];
  }
}

export function formatSenderHourString(date: Date, timezone = "UTC"): string {
  try {
    const dateStr = formatSenderDateString(date, timezone);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    });
    const hour = formatter.format(date).padStart(2, "0");
    return `${dateStr}-${hour}`;
  } catch {
    return `${date.toISOString().slice(0, 13)}`;
  }
}

// ---------------------------------------------------------------------------
// STEP 1 â€” SHARED SEND GATE: canSendNow
// ---------------------------------------------------------------------------

export type CanSendNowInput = {
  senderAccountId: string;
  leadId?: string;
  lead?: {
    id?: string;
    city?: string | null;
    location?: string | null;
    username?: string | null;
    usernameNormalized?: string | null;
    instagramUserId?: string | null;
    source?: string | null;
    website?: string | null;
    isGroup?: boolean | null;
    groupKey?: string | null;
  } | null;
  campaignId?: string;
  now?: Date;
  /** Allow caller to pass already-loaded sender record to avoid extra DB query */
  preloadedSender?: {
    id: string;
    userId: string;
    status: InstagramSenderStatus;
    pausedUntil: Date | null;
    lastSentAt: Date | null;
    sentToday: number;
    sentTodayDate: string | null;
    sentThisHour: number;
    sentThisHourWindow: string | null;
    warmupStartedAt: Date | null;
    dailyCap: number | null;
    hourlyCap: number | null;
    customMinGapSeconds: number | null;
    customMaxGapSeconds: number | null;
    timezone: string;
    workingHoursStart: number;
    workingHoursEnd: number;
  } | null;
  bypassGapCheck?: boolean;
  bypassWorkingHours?: boolean;
  skipWeekends?: boolean;
  /** Reuse the caller's transaction connection to avoid pool starvation. */
  tx?: Prisma.TransactionClient;
};

export type CanSendNowResult = {
  allowed: boolean;
  reason: string;
  retryAt?: Date;
  details?: {
    dailyCap: number;
    sentToday: number;
    hourlyCap: number;
    sentThisHour: number;
    warmupStage: string;
    daysActive: number;
    workingHoursCheck?: WorkingHoursCheck;
  };
};

/**
 * STEP 1 â€” The single shared send gate.
 * Checks, strictly in order:
 * 1. Sender status healthy (not paused, connected/active/warming)
 * 2. DNC / suppression
 * 3. Daily cap (bounded by warmup and hard ceiling)
 * 4. Hourly cap
 * 5. Working-hours window (lead timezone)
 * 6. Minimum gap since last send (with jitter)
 * 7. Warm-up limit (integrated in daily cap)
 */
export async function canSendNow(
  arg1: string | CanSendNowInput,
  arg2?: Date | (Omit<CanSendNowInput, "senderAccountId"> & { now?: Date }),
): Promise<CanSendNowResult> {
  let input: CanSendNowInput;
  if (typeof arg1 === "string") {
    if (arg2 instanceof Date) {
      input = { senderAccountId: arg1, now: arg2 };
    } else if (arg2 && typeof arg2 === "object") {
      input = { senderAccountId: arg1, ...arg2 };
    } else {
      input = { senderAccountId: arg1 };
    }
  } else {
    input = arg1;
  }

  const prisma = input.tx ?? getPrismaClient();
  const now = input.now ?? getSendGateNow();

  // 0a. Global Outbound Sending Kill Switch
  if (!isOutboundSendingEnabled()) {
    return {
      allowed: false,
      reason: "SENDING_DISABLED",
    };
  }

  // 0b. Reject dry-run / sample leads outright
  if (input.lead && isDryRunLead(input.lead)) {
    return {
      allowed: false,
      reason: "DRY_RUN_LEAD_CANNOT_BE_SENT",
    };
  }
  let dbLead: {
    id: string;
    isDryRun: boolean;
    source: string | null;
    username: string | null;
    usernameNormalized: string | null;
    rawProfileData: unknown;
    website: string | null;
    phone: string | null;
    gmapsPlaceId: string | null;
    isGroup: boolean;
    groupKey: string | null;
    campaignId: string;
  } | null = null;

  if (!input.lead && input.leadId) {
    dbLead = await prisma.lead.findUnique({
      where: { id: input.leadId },
      select: {
        id: true,
        isDryRun: true,
        source: true,
        username: true,
        usernameNormalized: true,
        rawProfileData: true,
        website: true,
        phone: true,
        gmapsPlaceId: true,
        isGroup: true,
        groupKey: true,
        campaignId: true,
      },
    });
    if (dbLead && isDryRunLead(dbLead)) {
      return {
        allowed: false,
        reason: "DRY_RUN_LEAD_CANNOT_BE_SENT",
      };
    }
  }

  // 0c. Reject leads without Instagram handle
  const leadToCheck = input.lead ?? dbLead;
  if (leadToCheck) {
    const rawUsername = (leadToCheck.usernameNormalized || leadToCheck.username || "").trim();
    if (!rawUsername) {
      return {
        allowed: false,
        reason: "NO_INSTAGRAM_HANDLE",
      };
    }

    // 0d. Multi-location group dedup: ensure only ONE outreach message per group per campaign
    const effectiveCampaignId = input.campaignId ?? (dbLead?.campaignId || undefined);
    if (effectiveCampaignId) {
      const targetGroupKey = (leadToCheck as { groupKey?: string | null }).groupKey;
      const targetDomain = (leadToCheck as { website?: string | null }).website
        ? extractDomainParts((leadToCheck as { website?: string | null }).website)?.domain
        : null;

      if (targetGroupKey || targetDomain) {
        const existingGroupMessage = await prisma.message.findFirst({
          where: {
            campaignId: effectiveCampaignId,
            direction: "OUTBOUND",
              status: { in: [MessageStatus.SENT, MessageStatus.SENDING] },
            lead: {
              id: input.leadId ? { not: input.leadId } : (leadToCheck.id ? { not: leadToCheck.id } : undefined),
              OR: [
                ...(targetGroupKey ? [{ groupKey: targetGroupKey }] : []),
                ...(targetDomain ? [{ website: { contains: targetDomain } }] : []),
              ],
            },
          },
          select: { id: true },
        });

        if (existingGroupMessage) {
          return {
            allowed: false,
            reason: "GROUP_ALREADY_CONTACTED",
          };
        }
      }
    }
  }

  // Load sender
  let sender = input.preloadedSender;
  if (!sender) {
    sender = await prisma.instagramSenderAccount.findUnique({
      where: { id: input.senderAccountId },
      select: {
        id: true,
        userId: true,
        status: true,
        pausedUntil: true,
        lastSentAt: true,
        sentToday: true,
        sentTodayDate: true,
        sentThisHour: true,
        sentThisHourWindow: true,
        warmupStartedAt: true,
        dailyCap: true,
        hourlyCap: true,
        customMinGapSeconds: true,
        customMaxGapSeconds: true,
        timezone: true,
        workingHoursStart: true,
        workingHoursEnd: true,
      },
    });
  }

  if (!sender) {
    return {
      allowed: false,
      reason: "SENDER_NOT_FOUND",
    };
  }

  // 1. Sender status healthy
  const healthyStatuses: InstagramSenderStatus[] = [
    InstagramSenderStatus.CONNECTED,
    InstagramSenderStatus.ACTIVE,
    InstagramSenderStatus.WARMING,
  ];

  // Auto-unpause if pausedUntil has elapsed
  if (sender.pausedUntil && now.getTime() >= sender.pausedUntil.getTime()) {
    sender.pausedUntil = null;
    if (sender.status === InstagramSenderStatus.PAUSED) {
      sender.status = InstagramSenderStatus.ACTIVE;
    }
  }

  if (sender.pausedUntil && now.getTime() < sender.pausedUntil.getTime()) {
    return {
      allowed: false,
      reason: "SENDER_PAUSED",
      retryAt: sender.pausedUntil,
    };
  }

  if (!healthyStatuses.includes(sender.status)) {
    return {
      allowed: false,
      reason: `SENDER_UNHEALTHY: ${sender.status}`,
    };
  }

  // 2. DNC / suppression (Fix 1)
  if (input.leadId || input.lead) {
    let leadToCheck = input.lead;
    if (!leadToCheck && input.leadId) {
      leadToCheck = await prisma.lead.findUnique({
        where: { id: input.leadId },
        select: {
          id: true,
          username: true,
          instagramUserId: true,
          city: true,
          location: true,
        },
      });
    }

    if (leadToCheck) {
      const suppression = await checkLeadSuppression({
        userId: sender.userId,
        lead: leadToCheck,
        channel: DncChannel.INSTAGRAM,
        tx: input.tx,
      });

      if (suppression.suppressed) {
        return {
          allowed: false,
          reason: "SUPPRESSED_DNC",
        };
      }

      // Cross-channel rule: a lead already contacted by email is never DM'd.
      if (leadToCheck.id) {
        const emailContact = await prisma.emailSend.findUnique({
          where: { leadId: leadToCheck.id },
          select: { id: true, status: true },
        });
        if (emailContact) {
          return {
            allowed: false,
            reason: `Lead was contacted by email (${emailContact.status}); Instagram DM blocked.`,
          };
        }
      }
    }
  }

  // 3. Daily cap & Warmup calculation
  const todayStr = formatSenderDateString(now, sender.timezone);
  const effectiveSentToday =
    sender.sentTodayDate === todayStr ? sender.sentToday : 0;

  const warmup = getWarmupLimit(sender.warmupStartedAt, sender.dailyCap, now);
  const hardMax = getSenderDailyHardMax();
  const effectiveDailyCap = Math.min(
    sender.dailyCap && sender.dailyCap > 0 ? sender.dailyCap : warmup.dailyCap,
    hardMax,
  );

  if (effectiveSentToday >= effectiveDailyCap) {
    // Next day start in sender timezone
    const nextDayStart = new Date(now.getTime() + 24 * 3600 * 1000);
    nextDayStart.setHours(0, 0, 0, 0);
    return {
      allowed: false,
      reason: "DAILY_CAP_REACHED",
      retryAt: nextDayStart,
      details: {
        dailyCap: effectiveDailyCap,
        sentToday: effectiveSentToday,
        hourlyCap: sender.hourlyCap ?? getDefaultHourlyCap(),
        sentThisHour: sender.sentThisHour,
        warmupStage: warmup.stage,
        daysActive: warmup.daysActive,
      },
    };
  }

  // 4. Hourly cap
  const hourStr = formatSenderHourString(now, sender.timezone);
  const effectiveSentThisHour =
    sender.sentThisHourWindow === hourStr ? sender.sentThisHour : 0;
  const hourlyCap = Math.min(
    sender.hourlyCap && sender.hourlyCap > 0
      ? sender.hourlyCap
      : getDefaultHourlyCap(),
    getSenderHourlyHardMax(),
  );

  if (effectiveSentThisHour >= hourlyCap) {
    const nextHourStart = new Date(now.getTime() + 3600 * 1000);
    nextHourStart.setMinutes(0, 0, 0);
    return {
      allowed: false,
      reason: "HOURLY_CAP_REACHED",
      retryAt: nextHourStart,
      details: {
        dailyCap: effectiveDailyCap,
        sentToday: effectiveSentToday,
        hourlyCap,
        sentThisHour: effectiveSentThisHour,
        warmupStage: warmup.stage,
        daysActive: warmup.daysActive,
      },
    };
  }

  // 5. Working-hours window (Lead's timezone derived from city/country, fallback campaign/sender/UTC)
  const leadTimezone = resolveLeadTimezone(input.lead, sender.timezone || "UTC");
  const effectiveStart =
    process.env.NODE_ENV === "test" && process.env.WORKING_HOURS_START !== undefined
      ? getWorkingHoursStart()
      : (sender.workingHoursStart ?? getWorkingHoursStart());
  const effectiveEnd =
    process.env.NODE_ENV === "test" && process.env.WORKING_HOURS_END !== undefined
      ? getWorkingHoursEnd()
      : (sender.workingHoursEnd ?? getWorkingHoursEnd());
  const workingHours = isWithinWorkingHours(
    now,
    leadTimezone,
    effectiveStart,
    effectiveEnd,
    getSkipWeekends(),
  );

  if (!workingHours.inWindow) {
    return {
      allowed: false,
      reason: "OUTSIDE_WORKING_HOURS",
      retryAt: workingHours.nextWindowStart,
      details: {
        dailyCap: effectiveDailyCap,
        sentToday: effectiveSentToday,
        hourlyCap,
        sentThisHour: effectiveSentThisHour,
        warmupStage: warmup.stage,
        daysActive: warmup.daysActive,
        workingHoursCheck: workingHours,
      },
    };
  }

  // 6. Minimum gap since last send (with jitter: random between 6-15 min, re-rolled)
  if (!input.bypassGapCheck && sender.lastSentAt) {
    const minSec = sender.customMinGapSeconds ?? getSenderMinGapSeconds();
    const maxSec = sender.customMaxGapSeconds ?? getSenderMaxGapSeconds();
    const requiredGapMs = getRandomGapMs(minSec, maxSec);
    const elapsedMs = now.getTime() - sender.lastSentAt.getTime();

    if (elapsedMs < requiredGapMs) {
      const retryAt = new Date(sender.lastSentAt.getTime() + requiredGapMs);
      return {
        allowed: false,
        reason: "COOLDOWN_ACTIVE",
        retryAt,
        details: {
          dailyCap: effectiveDailyCap,
          sentToday: effectiveSentToday,
          hourlyCap,
          sentThisHour: effectiveSentThisHour,
          warmupStage: warmup.stage,
          daysActive: warmup.daysActive,
          workingHoursCheck: workingHours,
        },
      };
    }
  }

  // 7. Warm-up limit check (already enforced under daily cap)
  return {
    allowed: true,
    reason: "ALLOWED",
    details: {
      dailyCap: effectiveDailyCap,
      sentToday: effectiveSentToday,
      hourlyCap,
      sentThisHour: effectiveSentThisHour,
      warmupStage: warmup.stage,
      daysActive: warmup.daysActive,
      workingHoursCheck: workingHours,
    },
  };
}

// ---------------------------------------------------------------------------
// STEP 2 â€” PERSISTENT COUNTERS: Atomic Reservation & Release
// ---------------------------------------------------------------------------

export type ReserveSendSlotInput = {
  senderAccountId: string;
  campaignId: string;
  leadId: string;
  messageText?: string;
  lead?: {
    id: string;
    city?: string | null;
    location?: string | null;
    username?: string | null;
    usernameNormalized?: string | null;
    source?: string | null;
  } | null;
  step?: string | number;
  now?: Date;
  bypassGapCheck?: boolean;
  bypassWorkingHours?: boolean;
  skipWeekends?: boolean;
};

export type ReserveSendSlotResult =
  | {
    success: true;
    allowed: true;
    reservationId: string;
    senderAccountId: string;
    campaignId: string;
    leadId: string;
    step: string;
    idempotencyKey: string;
  }
  | {
    success: false;
    allowed: false;
    reason: string;
    retryAt?: Date;
  };

export async function reserveSendSlot(
  input: ReserveSendSlotInput,
): Promise<ReserveSendSlotResult> {
  // 0a. Global Outbound Sending Kill Switch
  if (!isOutboundSendingEnabled()) {
    return {
      success: false,
      allowed: false,
      reason: "SENDING_DISABLED",
    };
  }

  // 0b. Reject dry-run / sample leads outright
  if (input.lead && isDryRunLead(input.lead)) {
    return {
      success: false,
      allowed: false,
      reason: "DRY_RUN_LEAD_CANNOT_BE_SENT",
    };
  }

  const prisma = getPrismaClient();
  const now = input.now ?? getSendGateNow();
  const step = String(input.step ?? "1");
  const contentHash = input.messageText
    ? createHash("sha256").update(input.messageText.trim()).digest("hex")
    : null;

  return withMysqlRetry(() =>
    prisma.$transaction(async (tx) => {
    let dbLead: {
      id: string;
      isDryRun: boolean;
      source: string | null;
      username: string | null;
      usernameNormalized: string | null;
      rawProfileData: unknown;
      website: string | null;
      phone: string | null;
      gmapsPlaceId: string | null;
      isGroup: boolean;
      groupKey: string | null;
      campaignId: string;
    } | null = null;

    if (!input.lead && input.leadId) {
      dbLead = await tx.lead.findUnique({
        where: { id: input.leadId },
        select: {
          id: true,
          isDryRun: true,
          source: true,
          username: true,
          usernameNormalized: true,
          rawProfileData: true,
          website: true,
          phone: true,
          gmapsPlaceId: true,
          isGroup: true,
          groupKey: true,
          campaignId: true,
        },
      });
      if (dbLead && isDryRunLead(dbLead)) {
        return {
          success: false,
          allowed: false,
          reason: "DRY_RUN_LEAD_CANNOT_BE_SENT",
        };
      }
    }

    // Reject leads without Instagram handle
    const leadToCheck = input.lead ?? dbLead;
    if (leadToCheck) {
      const rawUsername = (leadToCheck.usernameNormalized || leadToCheck.username || "").trim();
      if (!rawUsername) {
        return {
          success: false,
          allowed: false,
          reason: "NO_INSTAGRAM_HANDLE",
        };
      }

      // Multi-location group dedup: ensure only ONE outreach message per group per campaign
      const effectiveCampaignId = input.campaignId ?? (dbLead?.campaignId || undefined);
      if (effectiveCampaignId) {
        const targetGroupKey = (leadToCheck as { groupKey?: string | null }).groupKey;
        const targetDomain = (leadToCheck as { website?: string | null }).website
          ? extractDomainParts((leadToCheck as { website?: string | null }).website)?.domain
          : null;

        if (targetGroupKey || targetDomain) {
          const existingGroupMessage = await tx.message.findFirst({
            where: {
              campaignId: effectiveCampaignId,
              direction: "OUTBOUND",
              status: { in: [MessageStatus.SENT, MessageStatus.SENDING] },
              lead: {
                id: input.leadId ? { not: input.leadId } : (leadToCheck.id ? { not: leadToCheck.id } : undefined),
                OR: [
                  ...(targetGroupKey ? [{ groupKey: targetGroupKey }] : []),
                  ...(targetDomain ? [{ website: { contains: targetDomain } }] : []),
                ],
              },
            },
            select: { id: true },
          });

          if (existingGroupMessage) {
            return {
              success: false,
              allowed: false,
              reason: "GROUP_ALREADY_CONTACTED",
            };
          }
        }
      }
    }

    // 0. Serialize concurrent slot allocations for this sender via row locking
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM \`InstagramSenderAccount\` WHERE id = ${input.senderAccountId} FOR UPDATE`,
    );

    // 1. Check idempotency: Never send the same (campaignId, leadId, step) twice
    const existing = await tx.outboundSendIdempotency.findUnique({
      where: {
        campaignId_leadId_step: {
          campaignId: input.campaignId,
          leadId: input.leadId,
          step,
        },
      },
    });

    if (existing) {
      if (existing.status === "SENT") {
        return {
          success: false,
          allowed: false,
          reason: "ALREADY_SENT",
        };
      }
      if (existing.status === "UNKNOWN") {
        return {
          success: false,
          allowed: false,
          reason: "UNKNOWN_DELIVERY_REQUIRES_RECONCILIATION",
        };
      }
      // If reserved recently (< 5 min), block concurrent duplicate
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
      if (existing.status === "RESERVED" && existing.reservedAt > fiveMinutesAgo) {
        return {
          success: false,
          allowed: false,
          reason: "ALREADY_IN_PROGRESS",
        };
      }
    }

    // 2. Load sender fresh within transaction
    const sender = await tx.instagramSenderAccount.findUnique({
      where: { id: input.senderAccountId },
      select: {
        id: true,
        userId: true,
        status: true,
        pausedUntil: true,
        lastSentAt: true,
        sentToday: true,
        sentTodayDate: true,
        sentThisHour: true,
        sentThisHourWindow: true,
        warmupStartedAt: true,
        dailyCap: true,
        hourlyCap: true,
        customMinGapSeconds: true,
        customMaxGapSeconds: true,
        timezone: true,
        workingHoursStart: true,
        workingHoursEnd: true,
      },
    });

    if (!sender) {
      return { success: false, allowed: false, reason: "SENDER_NOT_FOUND" };
    }

    // 3. Verify gate conditions
    const gateCheck = await canSendNow({
      senderAccountId: sender.id,
      leadId: input.leadId,
      lead: input.lead,
      campaignId: input.campaignId,
      now,
      preloadedSender: sender,
      bypassGapCheck: input.bypassGapCheck,
      bypassWorkingHours: input.bypassWorkingHours,
      skipWeekends: input.skipWeekends,
      tx,
    });

    if (!gateCheck.allowed) {
      return {
        success: false,
        allowed: false,
        reason: gateCheck.reason,
        retryAt: gateCheck.retryAt,
      };
    }

    // 4. Update persistent counters atomically
    const todayStr = formatSenderDateString(now, sender.timezone);
    const hourStr = formatSenderHourString(now, sender.timezone);

    const newSentToday = sender.sentTodayDate === todayStr ? sender.sentToday + 1 : 1;
    const newSentThisHour = sender.sentThisHourWindow === hourStr ? sender.sentThisHour + 1 : 1;

    await tx.instagramSenderAccount.update({
      where: { id: sender.id },
      data: {
        sentToday: newSentToday,
        sentTodayDate: todayStr,
        sentThisHour: newSentThisHour,
        sentThisHourWindow: hourStr,
        totalSent: { increment: 1 },
        lastSentAt: now,
        warmupStartedAt: sender.warmupStartedAt ?? now,
      },
    });

    // 5. Upsert idempotency record in RESERVED status
    const idempotency = await tx.outboundSendIdempotency.upsert({
      where: {
        campaignId_leadId_step: {
          campaignId: input.campaignId,
          leadId: input.leadId,
          step,
        },
      },
      create: {
        campaignId: input.campaignId,
        leadId: input.leadId,
        step,
        senderAccountId: sender.id,
        status: "RESERVED",
        contentHash,
        reservedAt: now,
      },
      update: {
        senderAccountId: sender.id,
        status: "RESERVED",
        contentHash,
        reservedAt: now,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });

    return {
      success: true,
      allowed: true,
      reservationId: idempotency.id,
      senderAccountId: sender.id,
      campaignId: input.campaignId,
      leadId: input.leadId,
      step,
      idempotencyKey: idempotency.id,
    };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 60_000,
      maxWait: 5_000,
    }),
  );
}

export type ReleaseSendSlotInput = {
  status: "SENT" | "FAILED" | "UNKNOWN";
  messageId?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: Date;
  senderAccountId?: string;
  reservationId?: string;
  idempotencyKeyId?: string;
};

export async function releaseSendSlot(
  arg1: string | ReleaseSendSlotInput,
  arg2?: ReleaseSendSlotInput,
): Promise<void> {
  const prisma = getPrismaClient();

  let reservationId: string | undefined;
  let senderAccountId: string | undefined;
  let result: ReleaseSendSlotInput;

  if (typeof arg1 === "string") {
    reservationId = arg1;
    result = arg2 ?? { status: "FAILED" };
    senderAccountId = result.senderAccountId;
  } else {
    reservationId = arg1.reservationId || arg1.idempotencyKeyId;
    senderAccountId = arg1.senderAccountId;
    result = arg1;
  }

  const now = result.now ?? getSendGateNow();

  const reservation = reservationId
    ? await prisma.outboundSendIdempotency.findUnique({
      where: { id: reservationId },
    })
    : null;

  if (reservation) {
    senderAccountId = reservation.senderAccountId ?? undefined;
  }

  if (result.status === "SENT") {
    // Mark idempotency SENT
    if (reservationId) {
      await prisma.outboundSendIdempotency.update({
        where: { id: reservationId },
        data: {
          status: "SENT",
          messageId: result.messageId || null,
          completedAt: now,
          errorCode: null,
          errorMessage: null,
        },
      }).catch(() => undefined);
    }

    // Reset consecutiveErrors on sender
    if (senderAccountId) {
      await prisma.instagramSenderAccount.update({
        where: { id: senderAccountId },
        data: {
          consecutiveErrors: 0,
          lastErrorCode: null,
        },
      }).catch(() => undefined);
    }
  } else if (result.status === "FAILED") {
    // Release counters so a failed attempt does not consume sender quota
    if (reservationId) {
      await prisma.outboundSendIdempotency.update({
        where: { id: reservationId },
        data: {
          status: "FAILED",
          errorCode: result.errorCode || "SEND_FAILED",
          errorMessage: result.errorMessage || null,
          completedAt: now,
        },
      }).catch(() => undefined);
    }

    if (senderAccountId) {
      const sender = await prisma.instagramSenderAccount.findUnique({
        where: { id: senderAccountId },
      });

      if (sender) {
        const nextConsecutiveErrors = sender.consecutiveErrors + 1;
        const isDanger = isDangerErrorCode(result.errorCode);

        // Check recent failure rate (last 20 messages)
        const recentAttempts = await prisma.messageAttempt.findMany({
          where: { senderAccountId: sender.id },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { status: true },
        });

        const recentFailures = recentAttempts.filter((a) => a.status === MessageStatus.FAILED).length;
        const failureRate = recentAttempts.length > 0 ? recentFailures / recentAttempts.length : 0;
        const highFailureRate = recentAttempts.length >= 10 && failureRate > 0.3;

        const shouldAutoPause = isDanger || nextConsecutiveErrors >= 3 || highFailureRate;

        let nextStatus: InstagramSenderStatus = sender.status;
        let pausedUntil: Date | null = sender.pausedUntil;

        if (shouldAutoPause) {
          const backoff = calculateBackoffPauseUntil(nextConsecutiveErrors, now);
          pausedUntil = backoff.pausedUntil;
          nextStatus = isDanger && (result.errorCode === "AUTH_REQUIRED" || result.errorCode === "CAPTCHA_REQUIRED")
            ? InstagramSenderStatus.NEEDS_ATTENTION
            : InstagramSenderStatus.PAUSED;

          logger.warn("[SEND_GATE] Sender auto-paused due to danger signals", {
            senderAccountId: sender.id,
            username: sender.username,
            errorCode: result.errorCode,
            consecutiveErrors: nextConsecutiveErrors,
            pausedUntil: pausedUntil.toISOString(),
            nextStatus,
          });

          await notifySenderStatusChange({
            userId: sender.userId,
            senderUsername: sender.username,
            previousStatus: sender.status,
            newStatus: nextStatus,
            errorMessage: `Sender paused: [${result.errorCode ?? "ERROR"}] ${result.errorMessage ?? "Consecutive send failures"}`,
          }).catch(() => undefined);
        }

        await prisma.instagramSenderAccount.update({
          where: { id: sender.id },
          data: {
            // Reclaim quota on failed dispatch
            sentToday: Math.max(0, sender.sentToday - 1),
            sentThisHour: Math.max(0, sender.sentThisHour - 1),
            totalSent: Math.max(0, sender.totalSent - 1),
            consecutiveErrors: nextConsecutiveErrors,
            lastErrorCode: result.errorCode || "SEND_FAILED",
            status: nextStatus,
            pausedUntil,
            lastError: result.errorMessage || `[${result.errorCode}] Send failed`,
          },
        }).catch(() => undefined);
      }
    }
  } else {
    // UNKNOWN: Never treat "sent but unconfirmed" as failed-and-retry.
    // Mark it UNKNOWN and keep it preserved so no blind resend occurs.
    if (reservationId) {
      await prisma.outboundSendIdempotency.update({
        where: { id: reservationId },
        data: {
          status: "UNKNOWN",
          errorCode: result.errorCode || "UNKNOWN",
          errorMessage: result.errorMessage || "Delivery unconfirmed",
          completedAt: now,
        },
      }).catch(() => undefined);
    }

    if (senderAccountId) {
      await prisma.instagramSenderAccount.update({
        where: { id: senderAccountId },
        data: {
          lastErrorCode: result.errorCode || "UNKNOWN",
        },
      }).catch(() => undefined);
    }
  }
}

/**
 * Reconciles an idempotency slot stuck in UNKNOWN status after checking
 * the chat messages/thread on the provider.
 */
export async function reconcileUnknownSendSlot(
  campaignId: string,
  leadId: string,
  step: string | number,
  confirmedStatus: "SENT" | "FAILED",
): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.outboundSendIdempotency.updateMany({
    where: {
      campaignId,
      leadId,
      step: String(step),
      status: "UNKNOWN",
    },
    data: {
      status: confirmedStatus,
      completedAt: new Date(),
    },
  });
}


// ---------------------------------------------------------------------------
// STEP 3 â€” SPREAD SENDS ACROSS HEALTHY SENDERS (ROUND-ROBIN BY REMAINING QUOTA)
// ---------------------------------------------------------------------------

export type SenderWithQuota = {
  id: string;
  username: string;
  status: InstagramSenderStatus;
  sentToday: number;
  dailyCap: number | null;
  warmupStartedAt: Date | null;
  pausedUntil: Date | null;
  lastSentAt: Date | null;
  remainingQuota: number;
};

export function chooseHealthySender(
  senders: Array<{
    id: string;
    username: string;
    status: InstagramSenderStatus;
    sentToday: number;
    sentTodayDate?: string | null;
    dailyCap: number | null;
    warmupStartedAt: Date | null;
    pausedUntil: Date | null;
    lastSentAt: Date | null;
    timezone?: string;
    connectionMethod?: string | null;
  }>,
  now: Date = getSendGateNow(),
): (typeof senders)[number] | null {
  const healthyStatuses: InstagramSenderStatus[] = [
    InstagramSenderStatus.CONNECTED,
    InstagramSenderStatus.ACTIVE,
    InstagramSenderStatus.WARMING,
  ];

  const candidates: Array<{
    sender: (typeof senders)[number];
    remainingQuota: number;
    lastSentAtMs: number;
  }> = [];

  for (const s of senders) {
    // Exclude paused or unpaused future
    if (s.pausedUntil && now.getTime() < s.pausedUntil.getTime()) {
      continue;
    }
    if (!healthyStatuses.includes(s.status)) {
      continue;
    }

    const todayStr = formatSenderDateString(now, s.timezone || "UTC");
    const currentSentToday = s.sentTodayDate === todayStr ? s.sentToday : 0;
    const warmup = getWarmupLimit(s.warmupStartedAt, s.dailyCap, now);
    const hardMax = getSenderDailyHardMax();
    const effectiveCap = Math.min(
      s.dailyCap && s.dailyCap > 0 ? s.dailyCap : warmup.dailyCap,
      hardMax,
    );

    const remaining = Math.max(0, effectiveCap - currentSentToday);
    if (remaining > 0) {
      candidates.push({
        sender: s,
        remainingQuota: remaining,
        lastSentAtMs: s.lastSentAt ? s.lastSentAt.getTime() : 0,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Sort descending by remainingQuota; tie-break by oldest lastSentAt
  candidates.sort((a, b) => {
    if (b.remainingQuota !== a.remainingQuota) {
      return b.remainingQuota - a.remainingQuota;
    }
    return a.lastSentAtMs - b.lastSentAtMs;
  });

  return candidates[0].sender;
}

// ---------------------------------------------------------------------------
// STEP 5 â€” MESSAGE VARIATION & SPAM SIGNAL REDUCTION GUARD
// ---------------------------------------------------------------------------

export type MessageVariationValidationResult =
  | { valid: true }
  | {
    valid: false;
    reason: string;
    code:
    | "UNRESOLVED_PLACEHOLDERS"
    | "EMPTY_NAME"
    | "EMPTY_NAME_GREETING"
    | "EXCESSIVE_LINKS"
    | "TOO_MANY_LINKS_FIRST_MESSAGE"
    | "DUPLICATE_MESSAGE_DETECTED"
    | string;
    details?: Record<string, unknown>;
  };

export type MessageVariationInput = {
  text?: string;
  messageText?: string;
  senderAccountId?: string | null;
  lead?: { username?: string | null; fullName?: string | null } | null;
  isFirstMessage?: boolean;
  maxLinks?: number;
  windowMinutes?: number;
  now?: Date;
};

const UNRESOLVED_TOKEN_PATTERN = /\{[^{}]+?\}|\{\{[^{}]+?\}\}|\[[A-Za-z0-9_ ]+?\]/;
const URL_PATTERN = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/[^\s]*)/gi;
const EMPTY_GREETING_PATTERN = /^(hi|hello|hey|dear)\s*,\s*/i;

export async function validateMessageVariation(
  arg1: string | MessageVariationInput,
  arg2?: string | null,
  arg3?: {
    isFirstMessage?: boolean;
    maxLinks?: number;
    windowMinutes?: number;
    now?: Date;
  },
): Promise<MessageVariationValidationResult> {
  let text = "";
  let senderAccountId: string | null | undefined;
  let options: {
    isFirstMessage?: boolean;
    maxLinks?: number;
    windowMinutes?: number;
    now?: Date;
  } | undefined;

  if (typeof arg1 === "string") {
    text = arg1.trim();
    senderAccountId = arg2;
    options = arg3;
  } else if (arg1 && typeof arg1 === "object") {
    text = (arg1.text ?? arg1.messageText ?? "").trim();
    senderAccountId = arg1.senderAccountId;
    options = {
      isFirstMessage: arg1.isFirstMessage,
      maxLinks: arg1.maxLinks,
      windowMinutes: arg1.windowMinutes,
      now: arg1.now,
    };
  }

  // 1. Check for unresolved template placeholders
  if (UNRESOLVED_TOKEN_PATTERN.test(text)) {
    const matched = text.match(UNRESOLVED_TOKEN_PATTERN);
    return {
      valid: false,
      code: "UNRESOLVED_PLACEHOLDERS",
      reason: "UNRESOLVED_PLACEHOLDERS",
      details: {
        token: matched?.[0],
        message: `Message contains unresolved personalization token: ${matched?.[0] ?? "{placeholder}"}`,
      },
    };
  }

  // 2. Check for empty recipient name greeting (e.g. "Hi ,")
  if (EMPTY_GREETING_PATTERN.test(text)) {
    return {
      valid: false,
      code: "EMPTY_NAME_GREETING",
      reason: "EMPTY_NAME_GREETING",
      details: {
        message: "Message has an empty recipient name in the greeting (e.g. 'Hi ,').",
      },
    };
  }

  // 3. Link limits on first message
  const isFirstMessage = options?.isFirstMessage ?? true;
  if (isFirstMessage) {
    const maxLinks = options?.maxLinks ?? getFirstMessageMaxLinks();
    const linksFound = text.match(URL_PATTERN) || [];
    if (linksFound.length > maxLinks) {
      return {
        valid: false,
        code: "TOO_MANY_LINKS_FIRST_MESSAGE",
        reason: "TOO_MANY_LINKS_FIRST_MESSAGE",
        details: {
          linksFound,
          maxLinks,
          message: `First outreach message cannot contain more than ${maxLinks} link(s). Found: ${linksFound.length}.`,
        },
      };
    }
  }

  // 4. Block sending two messages with identical text from the same sender within window
  if (senderAccountId) {
    const prisma = getPrismaClient();
    const windowMins = options?.windowMinutes ?? getMessageVariationWindowMinutes();
    const now = options?.now ?? getSendGateNow();
    const windowStart = new Date(now.getTime() - windowMins * 60 * 1000);

    const duplicateRecent = await prisma.message.findFirst({
      where: {
        senderAccountId,
        messageText: text,
        createdAt: { gte: windowStart },
        status: { in: [MessageStatus.SENT, MessageStatus.SENDING] },
      },
      select: { id: true, createdAt: true },
    });

    if (duplicateRecent) {
      return {
        valid: false,
        code: "DUPLICATE_MESSAGE_DETECTED",
        reason: "DUPLICATE_MESSAGE_DETECTED",
        details: {
          previousMessageId: duplicateRecent.id,
          previousCreatedAt: duplicateRecent.createdAt,
          message: `An identical message was sent by this sender account within the last ${windowMins} minutes.`,
        },
      };
    }
  }

  return { valid: true };
}
