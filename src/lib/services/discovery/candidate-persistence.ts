import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { LeadStatus, Prisma } from "@/generated/prisma/client";
import { computeLeadScore } from "./lead-quality-score";

export type WebsiteEmailInput = {
  value: string;
  normalized: string;
  generic?: boolean;
  sourceUrl?: string | null;
};

export type WebsitePhoneInput = {
  value: string;
  normalized: string;
  sourceUrl?: string | null;
};

export type LeadWebsiteFields = {
  category?: string | null;
  address?: string | null;
  state?: string | null;
  countryCode?: string | null;
  mapsUrl?: string | null;
  rawPlaceData?: Record<string, unknown> | null;
  fieldSources?: Record<string, string> | null;
  email?: string | null;
  socialLinks?: Record<string, unknown> | null;
  websiteEmails?: WebsiteEmailInput[];
  websitePhones?: WebsitePhoneInput[];
  websiteDiagnostics?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildMapsRaw(params: {
  placeId: string;
  name: string;
  website?: string | null;
  phone?: string | null;
  city?: string | null;
  rating?: number | null;
  reviewsCount?: number | null;
  fields?: LeadWebsiteFields;
}): Record<string, unknown> {
  const fields = params.fields ?? {};
  return {
    placeId: params.placeId,
    name: params.name,
    category: fields.category ?? null,
    address: fields.address ?? null,
    city: params.city ?? null,
    state: fields.state ?? null,
    countryCode: fields.countryCode ?? null,
    phone: params.phone ?? null,
    website: params.website ?? null,
    rating: params.rating ?? null,
    reviewsCount: params.reviewsCount ?? null,
    mapsUrl: fields.mapsUrl ?? null,
    fieldSources: fields.fieldSources ?? {
      category: fields.category ? "maps" : "none",
      address: fields.address ? "maps" : "none",
      city: params.city ? "maps" : "none",
      countryCode: fields.countryCode ? "maps" : "none",
      phone: params.phone ? "maps" : "none",
      website: params.website ? "maps" : "none",
      rating: params.rating !== null && params.rating !== undefined ? "maps" : "none",
      reviewsCount: params.reviewsCount !== null && params.reviewsCount !== undefined ? "maps" : "none",
      mapsUrl: fields.mapsUrl ? "maps" : "none",
      placeId: "maps",
    },
    rawPlaceData: fields.rawPlaceData ?? null,
  };
}

function buildContactsRaw(
  fields: LeadWebsiteFields | undefined,
  mapsPhone: string | null,
  countryCode: string | null,
): Record<string, unknown> | null {
  if (!fields) return null;
  const emails = (fields.websiteEmails ?? []).map((email) => ({
    value: email.value,
    normalized: email.normalized,
    source: "website",
    sourceUrl: email.sourceUrl ?? null,
    generic: Boolean(email.generic),
  }));
  if (emails.length === 0 && fields.email) {
    emails.push({
      value: fields.email,
      normalized: fields.email.toLowerCase(),
      source: "website",
      sourceUrl: null,
      generic: false,
    });
  }
  const phones: Array<Record<string, unknown>> = [];
  if (mapsPhone) {
    phones.push({ value: mapsPhone, normalized: mapsPhone, source: "maps" });
  }
  for (const phone of fields.websitePhones ?? []) {
    if (!phones.some((p) => p.normalized === phone.normalized)) {
      phones.push({
        value: phone.value,
        normalized: phone.normalized,
        source: "website",
        sourceUrl: phone.sourceUrl ?? null,
      });
    }
  }
  const socialLinks = fields.socialLinks ?? {};
  const hasSocial = Object.values(socialLinks).some((value) => typeof value === "string" && value);
  if (emails.length === 0 && phones.length === 0 && !hasSocial) return null;
  return {
    emails,
    phones,
    whatsapps: socialLinks.whatsapp
      ? [{ url: socialLinks.whatsapp, source: "website" }]
      : [],
    socialLinks,
    extractedAt: new Date().toISOString(),
    countryCode,
  };
}

function buildWebsiteChannels(input: {
  hasHandle: boolean;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  socialLinks?: Record<string, unknown> | null;
}): string[] {
  const channels: string[] = [];
  if (input.hasHandle) channels.push("INSTAGRAM");
  if (input.email) channels.push("EMAIL");
  if (input.phone) channels.push("PHONE");
  const socialValues = Object.values(input.socialLinks ?? {}).filter(
    (value) => typeof value === "string" && value,
  );
  if (socialValues.some((value) => String(value).includes("wa.me"))) channels.push("WHATSAPP");
  if (input.website) channels.push("WEBSITE");
  if (socialValues.length > 0) channels.push("SOCIAL");
  return channels;
}

function scoreFromFields(input: {
  rating?: number | null;
  reviewCount?: number | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  hasHandle: boolean;
  channels: string[];
  handleConfidence?: string | null;
  handleSource?: string | null;
}): { score: number; tier: string; breakdown: unknown; flags: string[] } {
  const result = computeLeadScore({
    rating: input.rating,
    reviewCount: input.reviewCount,
    website: input.website,
    phone: input.phone,
    hasInstagram: input.hasHandle,
    email: input.email,
    availableChannels: input.channels,
    handleConfidence: input.handleConfidence ?? null,
    handleSource: input.handleSource ?? null,
  });
  return {
    score: result.score,
    tier: result.tier,
    breakdown: result.breakdown,
    flags: result.flags,
  };
}

export interface CandidatePlaceInput {
  placeId: string;
  name: string;
  category?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  countryCode?: string | null;
  phone?: string | null;
  website?: string | null;
  rating?: number | null;
  reviewsCount?: number | null;
  mapsUrl?: string | null;
  rawPlaceData?: Record<string, unknown> | null;
}

export interface CandidateMetaInput {
  runId?: string | null;
  datasetId?: string | null;
  costUsd?: number | null;
}

/**
 * Persist every accepted place to the DB immediately as a Candidate with status DISCOVERED.
 * Runs inside the discovery loop, per run, never at the end of the job.
 */
export async function persistDiscoveredPlace(
  campaignId: string,
  scrapeJobId: string | null | undefined,
  place: CandidatePlaceInput,
  meta: CandidateMetaInput = {},
): Promise<void> {
  const prisma = getPrismaClient();

  try {
    await prisma.candidate.upsert({
      where: {
        campaignId_placeId: {
          campaignId,
          placeId: place.placeId,
        },
      },
      create: {
        campaignId,
        scrapeJobId: scrapeJobId ?? null,
        runId: meta.runId ?? null,
        datasetId: meta.datasetId ?? null,
        costUsd: meta.costUsd !== null && meta.costUsd !== undefined ? new Prisma.Decimal(meta.costUsd) : null,
        placeId: place.placeId,
        name: place.name || "Unknown",
        category: place.category ?? null,
        address: place.address ?? null,
        city: place.city ?? null,
        state: place.state ?? null,
        countryCode: place.countryCode ?? null,
        phone: place.phone ?? null,
        website: place.website ?? null,
        rating: place.rating ?? null,
        reviewsCount: place.reviewsCount ?? null,
        mapsUrl: place.mapsUrl ?? null,
        status: "DISCOVERED",
        rawPlaceData: (place.rawPlaceData ?? place) as unknown as Prisma.InputJsonValue,
      },
      update: {
        name: place.name || undefined,
        scrapeJobId: scrapeJobId ?? undefined,
        runId: meta.runId ?? undefined,
        datasetId: meta.datasetId ?? undefined,
        costUsd: meta.costUsd !== null && meta.costUsd !== undefined ? new Prisma.Decimal(meta.costUsd) : undefined,
      },
    });
  } catch (err: unknown) {
    console.warn(`[CANDIDATE-PERSIST] Failed to upsert candidate "${place.placeId}": ${String(err)}`);
  }
}

/**
 * Updates a candidate's status and handle waterfall extraction results.
 */
export async function updateCandidateHandleResult(
  campaignId: string,
  placeId: string,
  data: {
    handle?: string | null;
    handleSource?: string | null;
    handleConfidence?: string | null;
    socialLinks?: Record<string, unknown> | null;
    status: string;
    lastError?: string | null;
  },
): Promise<void> {
  const prisma = getPrismaClient();
  try {
    await prisma.candidate.updateMany({
      where: { campaignId, placeId },
      data: {
        status: data.status,
        handle: data.handle ?? null,
        handleSource: data.handleSource ?? null,
        handleConfidence: data.handleConfidence ?? null,
        socialLinks: (data.socialLinks ?? Prisma.DbNull) as Prisma.InputJsonValue,
        lastError: data.lastError ?? null,
      },
    });
  } catch (err: unknown) {
    console.warn(`[CANDIDATE-PERSIST] Failed to update handle for candidate "${placeId}": ${String(err)}`);
  }
}

/**
 * Saves a candidate that has a valid handle as a Lead with status ENRICH_PENDING.
 * This guarantees no place with a handle is silently dropped if enrichment fails later.
 */
function firstSocialLink(socialLinks: Record<string, unknown> | null | undefined): {
  link: string | null;
  platform: string | null;
} {
  if (!socialLinks) return { link: null, platform: null };
  const priority = [
    "facebook",
    "instagram",
    "linkedin",
    "tiktok",
    "youtube",
    "twitter",
    "pinterest",
    "googleBusiness",
    "yelp",
  ];
  for (const platform of priority) {
    const value = socialLinks[platform];
    if (typeof value === "string" && value) return { link: value, platform };
  }
  for (const [platform, value] of Object.entries(socialLinks)) {
    if (typeof value === "string" && value) return { link: value, platform };
  }
  return { link: null, platform: null };
}

function mergeRawProfileData(
  existingRaw: unknown,
  mapsRaw: Record<string, unknown>,
  contactsRaw: Record<string, unknown> | null,
  fieldSources: Record<string, string> | null,
): Record<string, unknown> {
  const raw = asRecord(existingRaw);
  const existingContacts = asRecord(raw.contacts);
  const merged = {
    ...raw,
    maps: { ...asRecord(raw.maps), ...mapsRaw },
    fieldSources: { ...asRecord(raw.fieldSources), ...(fieldSources ?? {}) },
  } as Record<string, unknown>;

  if (contactsRaw) {
    const mergeArray = (a: unknown, b: unknown, key: string): unknown[] => {
      const existing = Array.isArray(a) ? a : [];
      const incoming = Array.isArray(b) ? b : [];
      const out = [...existing];
      for (const item of incoming) {
        const itemKey = asRecord(item)[key];
        if (!out.some((x) => asRecord(x)[key] === itemKey)) out.push(item);
      }
      return out;
    };
    merged.contacts = {
      ...existingContacts,
      ...contactsRaw,
      emails: mergeArray(existingContacts.emails, contactsRaw.emails, "normalized"),
      phones: mergeArray(existingContacts.phones, contactsRaw.phones, "normalized"),
      whatsapps: mergeArray(existingContacts.whatsapps, contactsRaw.whatsapps, "url"),
      socialLinks: {
        ...asRecord(existingContacts.socialLinks),
        ...asRecord(contactsRaw.socialLinks),
      },
    };
  }
  return merged;
}

export async function saveLeadAsEnrichPending(params: {
  campaignId: string;
  scrapeJobId?: string | null;
  userId?: string | null;
  placeId: string;
  name: string;
  handle: string;
  website?: string | null;
  phone?: string | null;
  city?: string | null;
  rating?: number | null;
  reviewsCount?: number | null;
  handleSource?: string | null;
  handleConfidence?: string | null;
  isDryRun?: boolean;
  fields?: LeadWebsiteFields;
}): Promise<void> {
  const prisma = getPrismaClient();
  const normUsername = params.handle.replace(/^@/, "").trim().toLowerCase();
  if (!normUsername) return;
  const fields = params.fields ?? {};
  const countryCode = fields.countryCode ?? null;
  const socialLinks = fields.socialLinks ?? null;
  const primarySocial = firstSocialLink(socialLinks);
  const channels = buildWebsiteChannels({
    hasHandle: true,
    email: fields.email,
    phone: params.phone,
    website: params.website,
    socialLinks,
  });
  const score = scoreFromFields({
    rating: params.rating,
    reviewCount: params.reviewsCount,
    website: params.website,
    phone: params.phone,
    email: fields.email,
    hasHandle: true,
    channels,
    handleConfidence: params.handleConfidence,
    handleSource: params.handleSource,
  });

  try {
    // 1. Update Candidate to ENRICH_PENDING
    await prisma.candidate.updateMany({
      where: { campaignId: params.campaignId, placeId: params.placeId },
      data: {
        status: "ENRICH_PENDING",
        handle: normUsername,
        handleSource: params.handleSource ?? null,
        handleConfidence: params.handleConfidence ?? null,
      },
    });

    // 2. Extract website domain
    let domain: string | null = null;
    if (params.website) {
      try {
        const u = new URL(params.website.startsWith("http") ? params.website : `https://${params.website}`);
        domain = u.hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        // invalid URL ignored
      }
    }

    const mapsRaw = buildMapsRaw({
      placeId: params.placeId,
      name: params.name,
      website: params.website,
      phone: params.phone,
      city: params.city,
      rating: params.rating,
      reviewsCount: params.reviewsCount,
      fields,
    });
    const contactsRaw = buildContactsRaw(fields, params.phone ?? null, countryCode);

    // 3. Upsert Lead with status ENRICH_PENDING
    const existing = await prisma.lead.findFirst({
      where: {
        campaignId: params.campaignId,
        OR: [
          { usernameNormalized: normUsername },
          { gmapsPlaceId: params.placeId },
        ],
      },
    });

    if (existing) {
      const raw = mergeRawProfileData(
        existing.rawProfileData,
        mapsRaw,
        contactsRaw,
        fields.fieldSources ?? null,
      );
      await prisma.lead.update({
        where: { id: existing.id },
        data: {
          fullName: existing.fullName || params.name,
          username: existing.username || normUsername,
          instagramUsername: existing.instagramUsername || normUsername,
          usernameNormalized: existing.usernameNormalized || normUsername,
          website: existing.website || params.website || null,
          websiteDomain: existing.websiteDomain || domain,
          phone: existing.phone || params.phone || null,
          phoneNormalized: existing.phoneNormalized || params.phone || null,
          email: existing.email || fields.email || null,
          socialLink: existing.socialLink || primarySocial.link,
          socialPlatform: existing.socialPlatform || primarySocial.platform,
          gmapsPlaceId: existing.gmapsPlaceId || params.placeId,
          category: existing.category || fields.category || null,
          location: existing.location || fields.address || params.city || null,
          city: existing.city || params.city || null,
          rating: existing.rating ?? params.rating ?? null,
          reviewCount: existing.reviewCount ?? params.reviewsCount ?? null,
          handleSource: existing.handleSource || params.handleSource || null,
          handleConfidence: existing.handleConfidence || params.handleConfidence || null,
          availableChannels: Array.from(new Set([...(existing.availableChannels ?? []), ...channels])),
          qualityScore: existing.qualityScore ?? score.score,
          qualityTier: existing.qualityTier ?? score.tier,
          scoreBreakdown: (existing.scoreBreakdown as Prisma.InputJsonValue) ?? (score.breakdown as Prisma.InputJsonValue),
          scoreFlags: Array.from(new Set([...(existing.scoreFlags ?? []), ...score.flags])),
          rawProfileData: raw as Prisma.InputJsonValue,
          discoveryCity: existing.discoveryCity || params.city || null,
          contactSource:
            existing.contactSource || (fields.websiteEmails?.length || fields.email ? "website" : "maps"),
          status: existing.status === LeadStatus.NEW ? LeadStatus.ENRICH_PENDING : existing.status,
        },
      });
    } else {
      const userActiveExisting = params.userId
        ? await prisma.lead.findFirst({
            where: {
              userId: params.userId,
              usernameNormalized: normUsername,
              duplicateOfLeadId: null,
            },
            select: { id: true },
          })
        : null;

      await prisma.lead.create({
        data: {
          campaignId: params.campaignId,
          userId: params.userId ?? null,
          scrapeJobId: params.scrapeJobId ?? null,
          username: normUsername,
          instagramUsername: normUsername,
          usernameNormalized: normUsername,
          fullName: params.name,
          website: params.website || null,
          websiteDomain: domain,
          phone: params.phone || null,
          phoneNormalized: params.phone || null,
          email: fields.email || null,
          socialLink: primarySocial.link,
          socialPlatform: primarySocial.platform,
          gmapsPlaceId: params.placeId,
          category: fields.category || null,
          location: fields.address || params.city || null,
          city: params.city || null,
          rating: params.rating ?? null,
          reviewCount: params.reviewsCount ?? null,
          handleSource: params.handleSource || null,
          handleConfidence: params.handleConfidence || null,
          availableChannels: channels,
          qualityScore: score.score,
          qualityTier: score.tier,
          scoreBreakdown: score.breakdown as Prisma.InputJsonValue,
          scoreFlags: score.flags,
          rawProfileData: mergeRawProfileData(null, mapsRaw, contactsRaw, fields.fieldSources ?? null) as Prisma.InputJsonValue,
          status: LeadStatus.ENRICH_PENDING,
          source: "google_maps",
          discoveryCity: params.city || null,
          contactSource: fields.websiteEmails?.length || fields.email ? "website" : "maps",
          duplicateOfLeadId: userActiveExisting ? userActiveExisting.id : null,
          possibleDuplicateOfLeadId: userActiveExisting ? userActiveExisting.id : null,
          possibleDuplicateReason: userActiveExisting ? "same_user_account" : null,
          isDryRun: params.isDryRun ?? false,
        },
      });
    }
  } catch (err: unknown) {
    console.warn(`[CANDIDATE-PERSIST] Failed to save lead as ENRICH_PENDING for "${params.handle}": ${String(err)}`);
  }
}

/**
 * Saves a contact-only place (no Instagram handle, but has phone, email, website, or social)
 * as a Lead with status NEW and channel flags.
 */
export async function saveContactOnlyLead(params: {
  campaignId: string;
  scrapeJobId?: string | null;
  userId?: string | null;
  placeId: string;
  name: string;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  rating?: number | null;
  reviewsCount?: number | null;
  socialLinks?: Record<string, unknown> | null;
  isDryRun?: boolean;
  fields?: LeadWebsiteFields;
}): Promise<void> {
  const prisma = getPrismaClient();
  const fields = params.fields ?? {};
  const email = fields.email ?? params.email ?? null;
  const socialLinks = fields.socialLinks ?? params.socialLinks ?? null;
  const countryCode = fields.countryCode ?? null;

  try {
    let websiteUrl = params.website || null;
    let socialLink: string | null = null;
    let socialPlatform: string | null = null;

    if (websiteUrl && /(?:facebook\.com|fb\.me|fb\.com)/i.test(websiteUrl)) {
      socialLink = websiteUrl;
      socialPlatform = "facebook";
      websiteUrl = null;
    }
    const primarySocial = firstSocialLink(socialLinks);
    if (!socialLink) {
      socialLink = primarySocial.link;
      socialPlatform = primarySocial.platform;
    }

    const availableChannels = buildWebsiteChannels({
      hasHandle: false,
      email,
      phone: params.phone,
      website: websiteUrl,
      socialLinks,
    });

    if (availableChannels.length === 0) {
      await recordCandidateRejection(params.campaignId, params.placeId, "NO_CONTACT", "No contact channels available");
      return;
    }

    let domain: string | null = null;
    if (websiteUrl) {
      try {
        const u = new URL(websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`);
        domain = u.hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        // ignore invalid url
      }
    }

    const mapsRaw = buildMapsRaw({
      placeId: params.placeId,
      name: params.name,
      website: websiteUrl,
      phone: params.phone,
      city: params.city,
      rating: params.rating,
      reviewsCount: params.reviewsCount,
      fields,
    });
    const contactsRaw = buildContactsRaw(fields, params.phone ?? null, countryCode);
    const score = scoreFromFields({
      rating: params.rating,
      reviewCount: params.reviewsCount,
      website: websiteUrl,
      phone: params.phone,
      email,
      hasHandle: false,
      channels: availableChannels,
    });

    await prisma.candidate.updateMany({
      where: { campaignId: params.campaignId, placeId: params.placeId },
      data: {
        status: "LEAD_SAVED",
        socialLinks: (socialLinks ?? (socialLink ? { facebook: socialLink } : null)) as Prisma.InputJsonValue,
      },
    });

    const existing = await prisma.lead.findFirst({
      where: {
        campaignId: params.campaignId,
        gmapsPlaceId: params.placeId,
      },
    });

    if (existing) {
      const raw = mergeRawProfileData(
        existing.rawProfileData,
        mapsRaw,
        contactsRaw,
        fields.fieldSources ?? null,
      );
      await prisma.lead.update({
        where: { id: existing.id },
        data: {
          fullName: existing.fullName || params.name,
          website: existing.website || websiteUrl,
          websiteDomain: existing.websiteDomain || domain,
          phone: existing.phone || params.phone,
          phoneNormalized: existing.phoneNormalized || params.phone,
          email: existing.email || email,
          gmapsPlaceId: existing.gmapsPlaceId || params.placeId,
          category: existing.category || fields.category || null,
          location: existing.location || fields.address || params.city || null,
          city: existing.city || params.city,
          rating: existing.rating ?? params.rating,
          reviewCount: existing.reviewCount ?? params.reviewsCount,
          socialLink: existing.socialLink || socialLink,
          socialPlatform: existing.socialPlatform || socialPlatform,
          availableChannels: Array.from(new Set([...existing.availableChannels, ...availableChannels])),
          qualityScore: existing.qualityScore ?? score.score,
          qualityTier: existing.qualityTier ?? score.tier,
          scoreBreakdown: (existing.scoreBreakdown as Prisma.InputJsonValue) ?? (score.breakdown as Prisma.InputJsonValue),
          scoreFlags: Array.from(new Set([...(existing.scoreFlags ?? []), ...score.flags])),
          rawProfileData: raw as Prisma.InputJsonValue,
          discoveryCity: existing.discoveryCity || params.city || null,
          contactSource:
            existing.contactSource || (fields.websiteEmails?.length || fields.email ? "website" : "maps"),
        },
      });
    } else {
      await prisma.lead.create({
        data: {
          campaignId: params.campaignId,
          userId: params.userId ?? null,
          scrapeJobId: params.scrapeJobId ?? null,
          fullName: params.name,
          username: null,
          instagramUsername: null,
          usernameNormalized: null,
          website: websiteUrl,
          websiteDomain: domain,
          phone: params.phone || null,
          phoneNormalized: params.phone || null,
          email,
          gmapsPlaceId: params.placeId,
          category: fields.category || null,
          location: fields.address || params.city || null,
          city: params.city || null,
          rating: params.rating ?? null,
          reviewCount: params.reviewsCount ?? null,
          socialLink,
          socialPlatform,
          availableChannels,
          qualityScore: score.score,
          qualityTier: score.tier,
          scoreBreakdown: score.breakdown as Prisma.InputJsonValue,
          scoreFlags: score.flags,
          rawProfileData: mergeRawProfileData(null, mapsRaw, contactsRaw, fields.fieldSources ?? null) as Prisma.InputJsonValue,
          status: LeadStatus.NEW,
          source: "google_maps",
          discoveryCity: params.city || null,
          contactSource: fields.websiteEmails?.length || fields.email ? "website" : "maps",
          isDryRun: params.isDryRun ?? false,
        },
      });
    }
  } catch (err: unknown) {
    console.warn(`[CANDIDATE-PERSIST] Failed to save contact-only lead "${params.name}": ${String(err)}`);
  }
}

/**
 * Record candidate rejection reason.
 */
export async function recordCandidateRejection(
  campaignId: string,
  placeId: string,
  reason: string,
  detail?: string,
): Promise<void> {
  const prisma = getPrismaClient();
  try {
    await prisma.candidate.updateMany({
      where: { campaignId, placeId },
      data: {
        status: `REJECTED:${reason}`,
        rejectionReason: detail || reason,
      },
    });
  } catch (err: unknown) {
    console.warn(`[CANDIDATE-PERSIST] Failed to mark rejection for "${placeId}": ${String(err)}`);
  }
}

