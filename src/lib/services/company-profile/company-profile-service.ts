import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { BadRequestError, CompanyProfileIncompleteError, NotFoundError } from "@/lib/errors";

/** Fields that MUST be present for any Gemini analysis/draft work. */
export const REQUIRED_COMPANY_PROFILE_FIELDS = [
  "name",
  "description",
  "services",
  "targetIndustries",
  "brandTone",
  "messageLanguage",
  "ctaStyle",
  "pricingPolicy",
  "preferredLength",
] as const;

export type CompanyProfileCompleteness = {
  complete: boolean;
  missingFields: string[];
  warnings: string[];
};

export type CompanyServiceEntry = { name: string; value?: string };

export type CompanyProfileDto = {
  id: string;
  name: string;
  isDefault: boolean;
  description: string;
  services: CompanyServiceEntry[];
  targetIndustries: string[];
  targetCountries: string[];
  idealCustomerProfile: string | null;
  brandTone: string | null;
  messageLanguage: string;
  preferredLength: { minWords: number; maxWords: number } | null;
  ctaStyle: string | null;
  forbiddenClaims: string[];
  pricingPolicy: string | null;
  exampleMessages: string[];
  objectionNotes: string | null;
  createdAt: string;
  updatedAt: string;
  campaignCount?: number;
};

export type CompanyProfileRecord = {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  description: string;
  services: unknown;
  targetIndustries: string[];
  targetCountries: string[];
  idealCustomerProfile: string | null;
  brandTone: string | null;
  messageLanguage: string;
  preferredLength: unknown;
  ctaStyle: string | null;
  forbiddenClaims: string[];
  pricingPolicy: string | null;
  exampleMessages: unknown;
  objectionNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { campaigns: number };
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function normalizeServiceEntries(value: unknown): CompanyServiceEntry[] {
  if (!Array.isArray(value)) return [];
  const out: CompanyServiceEntry[] = [];
  for (const entry of value) {
    if (isNonEmptyString(entry)) {
      out.push({ name: entry.trim() });
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      if (isNonEmptyString(record.name)) {
        const normalized: CompanyServiceEntry = { name: record.name.trim() };
        if (isNonEmptyString(record.value)) normalized.value = record.value.trim();
        out.push(normalized);
      }
    }
  }
  return out;
}

export function normalizePreferredLength(
  value: unknown,
): { minWords: number; maxWords: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const min = typeof record.minWords === "number" ? record.minWords : Number(record.minWords);
  const max = typeof record.maxWords === "number" ? record.maxWords : Number(record.maxWords);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { minWords: Math.trunc(min), maxWords: Math.trunc(max) };
}

/**
 * Pure completeness contract. No company data is invented anywhere; this only
 * checks that the user supplied what the AI needs.
 */
export function getCompanyProfileCompleteness(
  profile: CompanyProfileRecord | null,
): CompanyProfileCompleteness {
  const missingFields: string[] = [];
  const warnings: string[] = [];

  if (!profile) {
    return {
      complete: false,
      missingFields: [...REQUIRED_COMPANY_PROFILE_FIELDS],
      warnings: ["forbiddenClaims_empty", "idealCustomerProfile_empty"],
    };
  }

  if (!isNonEmptyString(profile.name)) missingFields.push("name");
  if (!isNonEmptyString(profile.description)) missingFields.push("description");
  if (normalizeServiceEntries(profile.services).length < 1) missingFields.push("services");
  if (asStringArray(profile.targetIndustries).filter(isNonEmptyString).length < 1) {
    missingFields.push("targetIndustries");
  }
  if (!isNonEmptyString(profile.brandTone)) missingFields.push("brandTone");
  if (!isNonEmptyString(profile.messageLanguage)) missingFields.push("messageLanguage");
  if (!isNonEmptyString(profile.ctaStyle)) missingFields.push("ctaStyle");
  if (!isNonEmptyString(profile.pricingPolicy)) missingFields.push("pricingPolicy");

  const preferred = normalizePreferredLength(profile.preferredLength);
  if (!preferred || preferred.minWords <= 0 || preferred.maxWords <= preferred.minWords) {
    missingFields.push("preferredLength");
  }

  if (asStringArray(profile.forbiddenClaims).filter(isNonEmptyString).length === 0) {
    warnings.push("forbiddenClaims_empty");
  }
  if (!isNonEmptyString(profile.idealCustomerProfile)) {
    warnings.push("idealCustomerProfile_empty");
  }

  return { complete: missingFields.length === 0, missingFields, warnings };
}

export function toCompanyProfileDto(record: CompanyProfileRecord): CompanyProfileDto {
  return {
    id: record.id,
    name: record.name,
    isDefault: Boolean(record.isDefault),
    description: record.description,
    services: normalizeServiceEntries(record.services),
    targetIndustries: asStringArray(record.targetIndustries),
    targetCountries: asStringArray(record.targetCountries),
    idealCustomerProfile: record.idealCustomerProfile,
    brandTone: record.brandTone,
    messageLanguage: record.messageLanguage,
    preferredLength: normalizePreferredLength(record.preferredLength),
    ctaStyle: record.ctaStyle,
    forbiddenClaims: asStringArray(record.forbiddenClaims),
    pricingPolicy: record.pricingPolicy,
    exampleMessages: Array.isArray(record.exampleMessages)
      ? asStringArray(record.exampleMessages)
      : [],
    objectionNotes: record.objectionNotes,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    campaignCount: record._count?.campaigns,
  };
}

// ---------------------------------------------------------------------------
// Retrieval & Resolution
// ---------------------------------------------------------------------------

export async function getCompanyProfileRecordById(
  profileId: string,
  userId: string,
): Promise<CompanyProfileRecord | null> {
  return (await getPrismaClient().companyProfile.findFirst({
    where: { id: profileId, userId },
    include: {
      _count: {
        select: { campaigns: true },
      },
    },
  })) as CompanyProfileRecord | null;
}

export async function getDefaultCompanyProfileRecord(
  userId: string,
): Promise<CompanyProfileRecord | null> {
  const prisma = getPrismaClient();
  const def = (await prisma.companyProfile.findFirst({
    where: { userId, isDefault: true },
    include: {
      _count: {
        select: { campaigns: true },
      },
    },
  })) as CompanyProfileRecord | null;
  if (def) return def;

  return (await prisma.companyProfile.findFirst({
    where: { userId },
    include: {
      _count: {
        select: { campaigns: true },
      },
    },
    orderBy: { createdAt: "asc" },
  })) as CompanyProfileRecord | null;
}

export async function getCompanyProfileRecord(
  userId: string,
): Promise<CompanyProfileRecord | null> {
  return getDefaultCompanyProfileRecord(userId);
}

export async function getCompanyProfile(
  userId: string,
  profileId?: string,
): Promise<CompanyProfileDto | null> {
  const record = profileId
    ? await getCompanyProfileRecordById(profileId, userId)
    : await getDefaultCompanyProfileRecord(userId);
  return record ? toCompanyProfileDto(record) : null;
}

export async function listCompanyProfiles(userId: string): Promise<
  Array<{
    profile: CompanyProfileDto;
    completeness: CompanyProfileCompleteness;
    campaignCount: number;
  }>
> {
  const records = (await getPrismaClient().companyProfile.findMany({
    where: { userId },
    include: {
      _count: {
        select: { campaigns: true },
      },
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  })) as CompanyProfileRecord[];

  return records.map((record) => ({
    profile: toCompanyProfileDto(record),
    completeness: getCompanyProfileCompleteness(record),
    campaignCount: record._count?.campaigns ?? 0,
  }));
}

export async function getCompanyProfileCompletenessForUser(
  userId: string,
): Promise<CompanyProfileCompleteness> {
  return getCompanyProfileCompleteness(await getDefaultCompanyProfileRecord(userId));
}

/**
 * Resolves the profile attached to a campaign.
 * Must load through campaign.companyProfileId; returns null when campaign or profile not found.
 */
export async function resolveCompanyProfileForCampaign(
  campaignId: string,
  userId: string,
): Promise<CompanyProfileRecord | null> {
  const prisma = getPrismaClient();
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
    select: {
      companyProfileId: true,
      companyProfile: true,
    },
  });
  if (!campaign || !campaign.companyProfile) return null;
  return campaign.companyProfile as CompanyProfileRecord;
}

/**
 * Gate used by every Gemini entry point. Throws COMPANY_PROFILE_INCOMPLETE
 * (422) with `details.missingFields`; callers must not call Gemini or write a
 * UsageLog row before this succeeds.
 */
export async function requireCompleteCompanyProfile(
  target: { campaignId: string; userId: string } | { profileId: string; userId: string } | string,
): Promise<CompanyProfileRecord> {
  let profile: CompanyProfileRecord | null = null;
  if (typeof target === "string") {
    profile = await getDefaultCompanyProfileRecord(target);
  } else if ("campaignId" in target) {
    profile = await resolveCompanyProfileForCampaign(target.campaignId, target.userId);
  } else if ("profileId" in target) {
    profile = await getCompanyProfileRecordById(target.profileId, target.userId);
  }

  const completeness = getCompanyProfileCompleteness(profile);
  if (!completeness.complete) {
    throw new CompanyProfileIncompleteError(
      completeness.missingFields,
      completeness.warnings,
    );
  }
  return profile as CompanyProfileRecord;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const LIMITS = {
  name: 200,
  description: 2000,
  services: 50,
  serviceText: 300,
  industries: 50,
  industryText: 100,
  countries: 50,
  countryText: 100,
  brandTone: 300,
  messageLanguage: 20,
  ctaStyle: 300,
  pricingPolicy: 500,
  forbiddenClaims: 50,
  forbiddenText: 100,
  exampleMessages: 10,
  exampleText: 1000,
  objectionNotes: 2000,
  idealCustomerProfile: 1000,
} as const;

function optionalString(record: Record<string, unknown>, key: string, max: number): string | null | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new BadRequestError("INVALID_FIELD", `"${key}" must be a string or null.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new BadRequestError("FIELD_TOO_LONG", `"${key}" exceeds ${max} characters.`);
  }
  return trimmed.length > 0 ? trimmed : null;
}

function stringList(record: Record<string, unknown>, key: string, max: number, itemMax: number): string[] | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestError("INVALID_FIELD", `"${key}" must be an array of strings.`);
  }
  const list = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (list.length > max) {
    throw new BadRequestError("TOO_MANY_ITEMS", `"${key}" cannot have more than ${max} entries.`);
  }
  if (list.some((entry) => entry.length > itemMax)) {
    throw new BadRequestError("ITEM_TOO_LONG", `Each "${key}" entry must be <= ${itemMax} characters.`);
  }
  return list;
}

function parseAndValidateFields(input: unknown, isCreate = false) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }
  const record = input as Record<string, unknown>;

  const allowed = new Set([
    "name", "isDefault", "description", "services", "targetIndustries", "targetCountries",
    "idealCustomerProfile", "brandTone", "messageLanguage", "preferredLength",
    "ctaStyle", "forbiddenClaims", "pricingPolicy", "exampleMessages", "objectionNotes",
  ]);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new BadRequestError("UNALLOWED_FIELDS", `Cannot set fields: ${unexpected.join(", ")}.`);
  }

  const nameVal = optionalString(record, "name", LIMITS.name);
  if (isCreate && (!nameVal || nameVal.trim().length === 0)) {
    throw new BadRequestError("MISSING_NAME", '"name" is required.');
  }

  const servicesRaw = record.services;
  if (servicesRaw !== undefined) {
    if (!Array.isArray(servicesRaw)) {
      throw new BadRequestError("INVALID_FIELD", '"services" must be an array.');
    }
    if (normalizeServiceEntries(servicesRaw).length > LIMITS.services) {
      throw new BadRequestError("TOO_MANY_ITEMS", `"services" cannot have more than ${LIMITS.services} entries.`);
    }
    for (const service of normalizeServiceEntries(servicesRaw)) {
      if (service.name.length > LIMITS.serviceText) {
        throw new BadRequestError("ITEM_TOO_LONG", `Each service name must be <= ${LIMITS.serviceText} characters.`);
      }
    }
  }

  const preferred = record.preferredLength === undefined ? undefined : normalizePreferredLength(record.preferredLength);
  if (record.preferredLength !== undefined && record.preferredLength !== null && !preferred) {
    throw new BadRequestError("INVALID_FIELD", '"preferredLength" must be { minWords, maxWords }.');
  }
  if (preferred && (preferred.minWords <= 0 || preferred.maxWords <= preferred.minWords)) {
    throw new BadRequestError("INVALID_FIELD", '"preferredLength" requires 0 < minWords < maxWords.');
  }

  const data: Record<string, unknown> = {};
  if (nameVal !== undefined) data.name = nameVal;
  if ("description" in record) data.description = optionalString(record, "description", LIMITS.description) ?? "";
  if ("services" in record) data.services = normalizeServiceEntries(record.services);
  if ("targetIndustries" in record) data.targetIndustries = stringList(record, "targetIndustries", LIMITS.industries, LIMITS.industryText) ?? [];
  if ("targetCountries" in record) data.targetCountries = stringList(record, "targetCountries", LIMITS.countries, LIMITS.countryText) ?? [];
  if ("idealCustomerProfile" in record) data.idealCustomerProfile = optionalString(record, "idealCustomerProfile", LIMITS.idealCustomerProfile) ?? null;
  if ("brandTone" in record) data.brandTone = optionalString(record, "brandTone", LIMITS.brandTone) ?? null;
  if ("messageLanguage" in record) data.messageLanguage = optionalString(record, "messageLanguage", LIMITS.messageLanguage) ?? "en";
  if ("preferredLength" in record) data.preferredLength = preferred ?? null;
  if ("ctaStyle" in record) data.ctaStyle = optionalString(record, "ctaStyle", LIMITS.ctaStyle) ?? null;
  if ("forbiddenClaims" in record) data.forbiddenClaims = stringList(record, "forbiddenClaims", LIMITS.forbiddenClaims, LIMITS.forbiddenText) ?? [];
  if ("pricingPolicy" in record) data.pricingPolicy = optionalString(record, "pricingPolicy", LIMITS.pricingPolicy) ?? null;
  if ("exampleMessages" in record) data.exampleMessages = stringList(record, "exampleMessages", LIMITS.exampleMessages, LIMITS.exampleText) ?? [];
  if ("objectionNotes" in record) data.objectionNotes = optionalString(record, "objectionNotes", LIMITS.objectionNotes) ?? null;
  if ("isDefault" in record && typeof record.isDefault === "boolean") data.isDefault = record.isDefault;

  return data;
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

export async function createCompanyProfile(
  userId: string,
  input: unknown,
): Promise<CompanyProfileDto> {
  const prisma = getPrismaClient();
  const data = parseAndValidateFields(input, true);

  const existingCount = await prisma.companyProfile.count({ where: { userId } });
  const isDefault = data.isDefault !== undefined ? Boolean(data.isDefault) : existingCount === 0;

  if (isDefault) {
    await prisma.companyProfile.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });
  }

  const created = await prisma.companyProfile.create({
    data: {
      userId,
      name: data.name as string,
      isDefault,
      description: (data.description as string) ?? "",
      services: (data.services ?? []) as unknown as Prisma.InputJsonValue,
      targetIndustries: (data.targetIndustries as string[]) ?? [],
      targetCountries: (data.targetCountries as string[]) ?? [],
      idealCustomerProfile: (data.idealCustomerProfile as string | null) ?? null,
      brandTone: (data.brandTone as string | null) ?? null,
      messageLanguage: (data.messageLanguage as string) ?? "en",
      preferredLength: (data.preferredLength ?? null) as unknown as Prisma.InputJsonValue,
      ctaStyle: (data.ctaStyle as string | null) ?? null,
      forbiddenClaims: (data.forbiddenClaims as string[]) ?? [],
      pricingPolicy: (data.pricingPolicy as string | null) ?? null,
      exampleMessages: ((data.exampleMessages as string[]) ?? []) as unknown as Prisma.InputJsonValue,
      objectionNotes: (data.objectionNotes as string | null) ?? null,
    },
    include: {
      _count: {
        select: { campaigns: true },
      },
    },
  });

  return toCompanyProfileDto(created as CompanyProfileRecord);
}

export async function updateCompanyProfile(
  userId: string,
  profileId: string,
  input: unknown,
): Promise<CompanyProfileDto> {
  const prisma = getPrismaClient();
  const existing = await getCompanyProfileRecordById(profileId, userId);
  if (!existing) {
    throw new NotFoundError("PROFILE_NOT_FOUND", `Company profile "${profileId}" was not found.`);
  }

  const data = parseAndValidateFields(input, false);

  if (data.isDefault === true) {
    await prisma.companyProfile.updateMany({
      where: { userId, isDefault: true, id: { not: profileId } },
      data: { isDefault: false },
    });
  }

  const updated = await prisma.companyProfile.update({
    where: { id: profileId },
    data: {
      ...data,
      services: data.services ? (data.services as unknown as Prisma.InputJsonValue) : undefined,
      preferredLength: "preferredLength" in data ? (data.preferredLength as unknown as Prisma.InputJsonValue) : undefined,
      exampleMessages: data.exampleMessages ? (data.exampleMessages as unknown as Prisma.InputJsonValue) : undefined,
    } as Prisma.CompanyProfileUpdateInput,
    include: {
      _count: {
        select: { campaigns: true },
      },
    },
  });

  return toCompanyProfileDto(updated as CompanyProfileRecord);
}

export async function deleteCompanyProfile(
  userId: string,
  profileId: string,
): Promise<{ success: true; deletedId: string }> {
  const prisma = getPrismaClient();
  const existing = await getCompanyProfileRecordById(profileId, userId);
  if (!existing) {
    throw new NotFoundError("PROFILE_NOT_FOUND", `Company profile "${profileId}" was not found.`);
  }

  const inUse = await prisma.campaign.findMany({
    where: { companyProfileId: profileId },
    select: { id: true, name: true },
  });

  if (inUse.length > 0) {
    const names = inUse.map((c) => `"${c.name}"`).join(", ");
    throw new BadRequestError(
      "PROFILE_IN_USE",
      `Cannot delete profile because it is currently used by ${inUse.length} campaign(s): ${names}. Reassign those campaigns before deleting this profile.`,
    );
  }

  await prisma.companyProfile.delete({
    where: { id: profileId },
  });

  if (existing.isDefault) {
    const remaining = await prisma.companyProfile.findFirst({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    if (remaining) {
      await prisma.companyProfile.update({
        where: { id: remaining.id },
        data: { isDefault: true },
      });
    }
  }

  return { success: true, deletedId: profileId };
}

/**
 * Backward-compatible upsert: updates default profile if exists, else creates new.
 */
export async function upsertCompanyProfile(
  userId: string,
  input: unknown,
): Promise<CompanyProfileDto> {
  const existingDefault = await getDefaultCompanyProfileRecord(userId);
  if (existingDefault) {
    return updateCompanyProfile(userId, existingDefault.id, input);
  }
  return createCompanyProfile(userId, input);
}
