import { z } from "zod";

import { NotificationEventType } from "@/generated/prisma/client";

/**
 * Typed accessors for every JSON-backed list field in the MySQL schema.
 * All accessors validate with zod and fall back to [] on missing/bad data.
 * Never cast JSON values directly in callers.
 */

const stringArraySchema = z.array(z.string());
const nonEmptyStringArraySchema = z.array(z.string().min(1));
const numberArraySchema = z.array(z.number().finite());
const positiveNumberArraySchema = z.array(z.number().finite().positive());
const notificationEventTypeSchema = z.enum(NotificationEventType);

function parseArray<T>(schema: z.ZodType<T[]>, value: unknown): T[] {
  const result = schema.safeParse(value);
  return result.success ? result.data : [];
}

export function parseStringArray(value: unknown): string[] {
  return parseArray(stringArraySchema, value);
}

export function parseNonEmptyStringArray(value: unknown): string[] {
  return parseArray(nonEmptyStringArraySchema, value);
}

export function parseNumberArray(value: unknown): number[] {
  return parseArray(numberArraySchema, value);
}

export function parsePositiveNumberArray(value: unknown): number[] {
  return parseArray(positiveNumberArraySchema, value);
}

export function parseCampaignFollowUpDelayDays(value: unknown): number[] {
  return parsePositiveNumberArray(value);
}

export function parseCampaignFollowUpTemplates(value: unknown): string[] {
  return parseStringArray(value);
}

export function parseCampaignPositiveKeywords(value: unknown): string[] {
  return parseStringArray(value);
}

export function parseCampaignNegativeKeywords(value: unknown): string[] {
  return parseStringArray(value);
}

export function parseLeadPreviousUsernames(value: unknown): string[] {
  return parseStringArray(value);
}

export function parseCompanyProfileServices(value: unknown): string[] {
  return parseStringArray(value);
}

export function parseCompanyTargetIndustries(value: unknown): string[] {
  return parseStringArray(value);
}

export function parseCompanyTargetCountries(value: unknown): string[] {
  return parseStringArray(value);
}

export function parseCompanyForbiddenClaims(value: unknown): string[] {
  return parseStringArray(value);
}

export function parseNotificationEventTypes(value: unknown): NotificationEventType[] {
  const result = notificationEventTypeSchema.array().safeParse(value);
  return result.success ? result.data : [];
}
