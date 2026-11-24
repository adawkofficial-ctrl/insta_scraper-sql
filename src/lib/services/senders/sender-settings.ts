import {
  calculateWarmupCap,
  getSenderDailyHardMax,
  getSenderHourlyHardMax,
} from "../messaging/send-gate";

export const SENDER_SETTINGS_DEFAULTS = {
  messagesPerDay: 25,
  minutesBetweenMessages: 10,
  jitterMinutes: 4,
  workingHoursStart: 9,
  workingHoursEnd: 18,
  warmUpEnabled: true,
} as const;

export const SENDER_RECOMMENDED = {
  maxMessagesPerDay: 25,
  minMinutesBetweenMessages: 8,
} as const;

export function getSenderMinGapFloorMinutes(): number {
  const parsed = Number(process.env.SENDER_MIN_GAP_FLOOR);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1;
}

export type SenderSettingsInput = {
  messagesPerDay?: number | null;
  minutesBetweenMessages?: number | null;
  jitterMinutes?: number | null;
  workingHoursStart?: number;
  workingHoursEnd?: number;
  warmUpEnabled?: boolean;
};

export type NormalizedSenderSettings = {
  messagesPerDay: number;
  minutesBetweenMessages: number;
  jitterMinutes: number;
  workingHoursStart: number;
  workingHoursEnd: number;
  warmUpEnabled: boolean;
};

export type SenderSettingsValidation =
  | { ok: true; value: NormalizedSenderSettings; riskWarnings: string[] }
  | { ok: false; code: string; message: string };

export function validateSenderSettings(input: SenderSettingsInput): SenderSettingsValidation {
  const hardMax = getSenderDailyHardMax();
  const gapFloor = getSenderMinGapFloorMinutes();

  const messagesPerDay =
    input.messagesPerDay === undefined || input.messagesPerDay === null
      ? SENDER_SETTINGS_DEFAULTS.messagesPerDay
      : input.messagesPerDay;
  if (!Number.isInteger(messagesPerDay) || messagesPerDay < 1 || messagesPerDay > hardMax) {
    return {
      ok: false,
      code: "INVALID_MESSAGES_PER_DAY",
      message: `Messages per day must be a whole number between 1 and ${hardMax}.`,
    };
  }

  const minutesBetweenMessages =
    input.minutesBetweenMessages === undefined || input.minutesBetweenMessages === null
      ? SENDER_SETTINGS_DEFAULTS.minutesBetweenMessages
      : input.minutesBetweenMessages;
  if (
    !Number.isInteger(minutesBetweenMessages) ||
    minutesBetweenMessages < gapFloor ||
    minutesBetweenMessages > 1440
  ) {
    return {
      ok: false,
      code: "INVALID_GAP",
      message: `Minutes between messages must be a whole number between ${gapFloor} and 1440.`,
    };
  }

  const jitterMinutes =
    input.jitterMinutes === undefined || input.jitterMinutes === null
      ? SENDER_SETTINGS_DEFAULTS.jitterMinutes
      : input.jitterMinutes;
  if (!Number.isInteger(jitterMinutes) || jitterMinutes < 0 || jitterMinutes > 60) {
    return {
      ok: false,
      code: "INVALID_JITTER",
      message: "Jitter minutes must be a whole number between 0 and 60.",
    };
  }

  const workingHoursStart = input.workingHoursStart ?? SENDER_SETTINGS_DEFAULTS.workingHoursStart;
  const workingHoursEnd = input.workingHoursEnd ?? SENDER_SETTINGS_DEFAULTS.workingHoursEnd;
  if (
    !Number.isInteger(workingHoursStart) ||
    !Number.isInteger(workingHoursEnd) ||
    workingHoursStart < 0 ||
    workingHoursStart > 23 ||
    workingHoursEnd < 1 ||
    workingHoursEnd > 24 ||
    workingHoursStart >= workingHoursEnd
  ) {
    return {
      ok: false,
      code: "INVALID_WORKING_HOURS",
      message: "Working hours must be whole hours with start before end (0-24).",
    };
  }

  const riskWarnings: string[] = [];
  if (messagesPerDay > SENDER_RECOMMENDED.maxMessagesPerDay) {
    riskWarnings.push(
      `Above the recommended ${SENDER_RECOMMENDED.maxMessagesPerDay} messages/day. Instagram may restrict the account.`,
    );
  }
  if (minutesBetweenMessages < SENDER_RECOMMENDED.minMinutesBetweenMessages) {
    riskWarnings.push(
      `Below the recommended ${SENDER_RECOMMENDED.minMinutesBetweenMessages}-minute gap. Rapid bursts increase checkpoint risk.`,
    );
  }

  return {
    ok: true,
    value: {
      messagesPerDay,
      minutesBetweenMessages,
      jitterMinutes,
      workingHoursStart,
      workingHoursEnd,
      warmUpEnabled: input.warmUpEnabled ?? SENDER_SETTINGS_DEFAULTS.warmUpEnabled,
    },
    riskWarnings,
  };
}

export function windowCapacity(messages: number, gapMinutes: number, hours: number): number {
  if (gapMinutes <= 0) return messages;
  return Math.max(1, Math.floor((hours * 60) / gapMinutes) + 1);
}

export type EffectiveSenderLimit = {
  effectiveMessagesPerDay: number;
  capacityFromGap: number;
  warmupCap: number;
  hardMax: number;
  configured: number;
  limitingFactor: "configured" | "warmup" | "hard_ceiling" | "window_capacity";
  warmupStage: string;
  warmupUntil: string | null;
};

export function calculateEffectiveSenderLimit(input: {
  messagesPerDay: number | null | undefined;
  minutesBetweenMessages: number | null | undefined;
  workingHoursStart: number;
  workingHoursEnd: number;
  warmupStartedAt: Date | null;
  warmupEnabled?: boolean;
  now?: Date;
}): EffectiveSenderLimit {
  const configured = Math.max(1, input.messagesPerDay ?? SENDER_SETTINGS_DEFAULTS.messagesPerDay);
  const gap = Math.max(
    getSenderMinGapFloorMinutes(),
    input.minutesBetweenMessages ?? SENDER_SETTINGS_DEFAULTS.minutesBetweenMessages,
  );
  const hours = Math.max(1, input.workingHoursEnd - input.workingHoursStart);
  const capacity = windowCapacity(configured, gap, hours);
  const warmup = input.warmupEnabled === false
    ? {
        dailyCap: configured,
        stage: "Warm-up disabled",
        daysActive: 0,
        isWarming: false,
        warmupUntil: null as Date | null,
      }
    : calculateWarmupCap({
        warmupStartedAt: input.warmupStartedAt,
        configuredDailyCap: configured,
        now: input.now,
      });
  const hardMax = getSenderDailyHardMax();

  const candidates: Array<[EffectiveSenderLimit["limitingFactor"], number]> = [
    ["configured", configured],
    ["warmup", warmup.dailyCap],
    ["hard_ceiling", hardMax],
    ["window_capacity", capacity],
  ];
  const limiting = candidates.reduce((min, next) => (next[1] < min[1] ? next : min));

  return {
    effectiveMessagesPerDay: limiting[1],
    capacityFromGap: capacity,
    warmupCap: warmup.dailyCap,
    hardMax,
    configured,
    limitingFactor: limiting[0],
    warmupStage: warmup.stage,
    warmupUntil:
      warmup.isWarming && input.warmupStartedAt
        ? new Date(input.warmupStartedAt.getTime() + 14 * 86400000).toISOString()
        : null,
  };
}

export function buildSenderSettingsPreview(input: {
  messagesPerDay: number;
  minutesBetweenMessages: number;
  workingHoursStart: number;
  workingHoursEnd: number;
  warmupStartedAt: Date | null;
  warmupEnabled?: boolean;
  now?: Date;
}): { preview: string; effective: EffectiveSenderLimit } {
  const effective = calculateEffectiveSenderLimit(input);
  const hours = input.workingHoursEnd - input.workingHoursStart;
  const label =
    effective.limitingFactor === "warmup"
      ? `warm-up (${effective.warmupStage})`
      : effective.limitingFactor === "hard_ceiling"
        ? "the hard ceiling"
        : effective.limitingFactor === "window_capacity"
          ? `${hours}h window at ${input.minutesBetweenMessages} min gap`
          : "your configured cap";
  const preview = `At ${input.messagesPerDay}/day and ${input.minutesBetweenMessages} min gap: about ${effective.effectiveMessagesPerDay} messages today, limited by ${label}.`;
  return { preview, effective };
}

export function calculateScheduleOffsetSeconds(index: number): number {
  // 61s steps keep ten accounts out of the same minute without large delays.
  return Math.max(0, Math.trunc(index)) * 61;
}

export function getHourlyCapFromGap(minutesBetweenMessages: number): number {
  return Math.max(1, Math.min(getSenderHourlyHardMax(), Math.floor(60 / Math.max(1, minutesBetweenMessages))));
}
