import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { MessageDirection, MessageStatus } from "@/generated/prisma/enums";

import {
  canonicalProfileUrl,
  normalizeEmail,
  normalizeUsername,
  normalizeWebsite,
} from "./identity";
import { normalizePhone, computeAvailableChannels } from "../contact/contact-parser";
import {
  detectSocialPlatform,
  cleanBusinessWebsite,
} from "@/lib/constants/social-platforms";

const KEY_CHUNK_SIZE = 500;

export type DedupKey =
  | "GMAPS_PLACE_ID"
  | "INSTAGRAM_ID"
  | "USERNAME"
  | "PROFILE_URL"
  | "EMAIL"
  | "PHONE"
  | "WEBSITE_DOMAIN"
  | "WEBSITE_KEY";

export type NormalizedProfile = {
  username: string | null;
  usernameNormalized: string | null;
  profileUrlCanonical: string | null;
  instagramUserId: string | null;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  gmapsPlaceId: string | null;
  website: string | null;
  websiteDomain: string | null;
  websiteKey: string | null;
  socialLink: string | null;
  socialPlatform: string | null;
};

export type DedupProfileInput = {
  username?: string | null;
  instagramUsername?: string | null;
  profileUrl?: string | null;
  gmapsPlaceId?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  city?: string | null;
  handleSource?: string | null;
  handleConfidence?: string | null;
  instagramUserId?: string | null;
  instagramId?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneNormalized?: string | null;
  contactSource?: string | null;
  availableChannels?: string[] | null;
  website?: string | null;
  externalUrl?: string | null;
  socialLink?: string | null;
  socialPlatform?: string | null;
  fullName?: string | null;
  biography?: string | null;
  bio?: string | null;
  category?: string | null;
  businessCategoryName?: string | null;
  location?: string | null;
  followersCount?: number | null;
  followers?: number | null;
  followsCount?: number | null;
  following?: number | null;
  postsCount?: number | null;
  source?: string | null;
  scrapeJobId?: string | null;
  discoveryKeyword?: string | null;
  discoveryCity?: string | null;
  acquisitionCostUsd?: number | null;
  acquisitionCostBreakdown?: unknown | null;
  messageVariant?: string | null;
};

export type DedupClassification =
  | { kind: "NEW"; normalized: NormalizedProfile }
  | {
      kind: "HARD_DUPLICATE";
      leadId: string;
      matchedBy: DedupKey[];
      matchedLeadIds: string[];
      intraBatchWinnerIndex?: number;
      normalized: NormalizedProfile;
    }
  | {
      kind: "SOFT_DUPLICATE";
      leadId: string;
      reason: "WEBSITE_KEY";
      normalized: NormalizedProfile;
    };

export type DedupStats = {
  new: number;
  hardDuplicates: number;
  softDuplicates: number;
  enriched: number;
  intraBatchDuplicates: number;
  byKey: Record<DedupKey, number>;
};

export function emptyDedupStats(): DedupStats {
  return {
    new: 0,
    hardDuplicates: 0,
    softDuplicates: 0,
    enriched: 0,
    intraBatchDuplicates: 0,
    byKey: {
      GMAPS_PLACE_ID: 0,
      INSTAGRAM_ID: 0,
      USERNAME: 0,
      PROFILE_URL: 0,
      EMAIL: 0,
      PHONE: 0,
      WEBSITE_DOMAIN: 0,
      WEBSITE_KEY: 0,
    },
  };
}

export function normalizeProfile(profile: DedupProfileInput): NormalizedProfile {
  const usernameNormalized = profile.username ? normalizeUsername(profile.username) : null;
  const emailNormalized = normalizeEmail(profile.email);
  const phoneNormalized = profile.phoneNormalized ?? (profile.phone ? normalizePhone(profile.phone) : null);
  const rawUrl =
    typeof profile.website === "string" && profile.website.length > 0
      ? profile.website.trim()
      : typeof profile.externalUrl === "string" && profile.externalUrl.length > 0
        ? profile.externalUrl.trim()
        : null;
  const detectedSocial = detectSocialPlatform(rawUrl);
  const isSocial = Boolean(detectedSocial);
  const websiteNormalized = rawUrl ? normalizeWebsite(rawUrl) : null;
  const cleanWebsite = isSocial ? null : cleanBusinessWebsite(rawUrl);

  const socialLink = isSocial
    ? detectedSocial?.url ?? rawUrl
    : profile.socialLink ?? null;
  const socialPlatform = isSocial
    ? detectedSocial?.platform ?? null
    : profile.socialPlatform ?? null;
  const website = isSocial ? null : cleanWebsite?.url ?? null;
  const websiteDomain = isSocial ? null : cleanWebsite?.domain ?? websiteNormalized?.domain ?? null;
  const websiteKey = websiteNormalized?.key ?? null;

  const instagramUserId = profile.instagramUserId ?? profile.instagramId ?? null;

  return {
    username: profile.username ?? null,
    usernameNormalized:
      usernameNormalized ??
      (typeof profile.username === "string" && profile.username.trim().length > 0
        ? profile.username.trim().toLowerCase()
        : null),
    profileUrlCanonical: usernameNormalized ? canonicalProfileUrl(usernameNormalized) : null,
    instagramUserId: instagramUserId ? String(instagramUserId) : null,
    email: profile.email ?? null,
    emailNormalized,
    phone: profile.phone ?? null,
    phoneNormalized,
    gmapsPlaceId: profile.gmapsPlaceId ?? null,
    website,
    websiteDomain,
    websiteKey,
    socialLink,
    socialPlatform,
  };
}

type CandidateLead = {
  id: string;
  campaignId: string;
  status: string;
  createdAt: Date;
  lastContactedAt: Date | null;
  instagramUserId: string | null;
  usernameNormalized: string | null;
  profileUrlCanonical: string | null;
  emailNormalized: string | null;
  phoneNormalized: string | null;
  gmapsPlaceId: string | null;
  websiteDomain: string | null;
  websiteKey: string | null;
  duplicateOfLeadId: string | null;
  username: string | null;
};

const CANDIDATE_SELECT = {
  id: true,
  campaignId: true,
  status: true,
  createdAt: true,
  lastContactedAt: true,
  instagramUserId: true,
  usernameNormalized: true,
  profileUrlCanonical: true,
  emailNormalized: true,
  phoneNormalized: true,
  gmapsPlaceId: true,
  websiteDomain: true,
  websiteKey: true,
  duplicateOfLeadId: true,
  username: true,
} as const;

const CONTACTED_OR_LATER = new Set([
  "CONTACTED",
  "REPLIED",
  "INTERESTED",
  "FOLLOW_UP",
  "MEETING",
  "CONVERTED",
  "NOT_INTERESTED",
]);

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function uniq(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  );
}

/**
 * Runs `fn` inside a Postgres SAVEPOINT so a unique-violation (or any error)
 * does not abort the whole transaction. Without this, a P2002 inside a Prisma
 * interactive transaction makes every subsequent statement fail with 25P02
 * ("current transaction is aborted").
 */
async function withSavepoint<T>(
  tx: Prisma.TransactionClient,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const value = await fn();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, value };
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`).catch(() => undefined);
    return { ok: false, error };
  }
}

/** Prefer CONTACTED-or-later, then oldest createdAt, then id for stability. */
function pickCanonical(leads: CandidateLead[]): CandidateLead {
  return [...leads].sort((a, b) => {
    const aContacted = a.lastContactedAt !== null || CONTACTED_OR_LATER.has(a.status);
    const bContacted = b.lastContactedAt !== null || CONTACTED_OR_LATER.has(b.status);
    if (aContacted !== bContacted) return aContacted ? -1 : 1;
    if (a.createdAt.getTime() !== b.createdAt.getTime()) {
      return a.createdAt.getTime() - b.createdAt.getTime();
    }
    return a.id < b.id ? -1 : 1;
  })[0];
}

/**
 * Classifies profiles against existing leads of the same user.
 * ONE query per key type (chunked at 500), never per profile. Duplicate rows are
 * followed to their canonical lead.
 */
export async function classifyProfiles(input: {
  userId: string;
  campaignId: string;
  profiles: DedupProfileInput[];
  isDryRun?: boolean;
  client?: Prisma.TransactionClient;
}): Promise<DedupClassification[]> {
  const prisma = input.client ?? getPrismaClient();
  const normalized = input.profiles.map((profile) => normalizeProfile(profile));
  if (normalized.length === 0) return [];

  // In real runs, completely ignore dry-run leads during dedup lookup
  const isDry = input.isDryRun === true;
  const dryRunFilter = !isDry ? { isDryRun: false } : {};

  const gmapsPlaceIds = uniq(normalized.map((n) => n.gmapsPlaceId));
  const instagramIds = uniq(normalized.map((n) => n.instagramUserId));
  const usernames = uniq(normalized.map((n) => n.usernameNormalized));
  const profileUrls = uniq(normalized.map((n) => n.profileUrlCanonical));
  const emails = uniq(normalized.map((n) => n.emailNormalized));
  const phones = uniq(normalized.map((n) => n.phoneNormalized));
  const websiteKeys = uniq(normalized.map((n) => n.websiteKey));
  const websiteDomains = uniq(normalized.map((n) => n.websiteDomain));

  const found = new Map<string, CandidateLead>();
  const collect = async (where: Prisma.LeadWhereInput): Promise<void> => {
    const rows = (await prisma.lead.findMany({
      where: { ...where, ...dryRunFilter },
      select: CANDIDATE_SELECT,
    })) as CandidateLead[];
    for (const row of rows) found.set(row.id, row);
  };

  for (const part of chunk(gmapsPlaceIds, KEY_CHUNK_SIZE)) {
    if (part.length) await collect({ userId: input.userId, gmapsPlaceId: { in: part } });
  }
  for (const part of chunk(instagramIds, KEY_CHUNK_SIZE)) {
    if (part.length) await collect({ userId: input.userId, instagramUserId: { in: part } });
  }
  for (const part of chunk(usernames, KEY_CHUNK_SIZE)) {
    if (part.length) await collect({ userId: input.userId, usernameNormalized: { in: part } });
  }
  for (const part of chunk(profileUrls, KEY_CHUNK_SIZE)) {
    if (part.length) await collect({ userId: input.userId, profileUrlCanonical: { in: part } });
  }
  for (const part of chunk(emails, KEY_CHUNK_SIZE)) {
    if (part.length) await collect({ userId: input.userId, emailNormalized: { in: part } });
  }
  for (const part of chunk(phones, KEY_CHUNK_SIZE)) {
    if (part.length) await collect({ userId: input.userId, phoneNormalized: { in: part } });
  }
  for (const part of chunk(websiteKeys, KEY_CHUNK_SIZE)) {
    if (part.length) await collect({ userId: input.userId, websiteKey: { in: part } });
  }
  for (const part of chunk(websiteDomains, KEY_CHUNK_SIZE)) {
    if (part.length) await collect({ userId: input.userId, websiteDomain: { in: part } });
  }

  const pointerIds = uniq([...found.values()].map((row) => row.duplicateOfLeadId));
  if (pointerIds.length > 0) {
    const canonicalRows = (await prisma.lead.findMany({
      where: { id: { in: pointerIds }, ...dryRunFilter },
      select: CANDIDATE_SELECT,
    })) as CandidateLead[];
    for (const row of canonicalRows) found.set(row.id, row);
  }

  const byGmapsPlaceId = new Map<string, CandidateLead[]>();
  const byInstagramId = new Map<string, CandidateLead[]>();
  const byUsername = new Map<string, CandidateLead[]>();
  const byProfileUrl = new Map<string, CandidateLead[]>();
  const byEmail = new Map<string, CandidateLead[]>();
  const byPhone = new Map<string, CandidateLead[]>();
  const byWebsiteKey = new Map<string, CandidateLead[]>();
  const byWebsiteDomain = new Map<string, CandidateLead[]>();

  const push = (map: Map<string, CandidateLead[]>, key: string | null, lead: CandidateLead) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    list.push(lead);
    map.set(key, list);
  };
  for (const lead of found.values()) {
    push(byGmapsPlaceId, lead.gmapsPlaceId, lead);
    push(byInstagramId, lead.instagramUserId, lead);
    push(byUsername, lead.usernameNormalized, lead);
    push(byProfileUrl, lead.profileUrlCanonical, lead);
    push(byEmail, lead.emailNormalized, lead);
    push(byPhone, lead.phoneNormalized, lead);
    push(byWebsiteKey, lead.websiteKey, lead);
    push(byWebsiteDomain, lead.websiteDomain, lead);
  }

  const batchSeen = new Map<string, number>();
  const results: DedupClassification[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const n = normalized[index];

    // Priority 1: Dedup by gmapsPlaceId first
    if (n.gmapsPlaceId) {
      const gmapsMatches = byGmapsPlaceId.get(n.gmapsPlaceId) ?? [];
      if (gmapsMatches.length > 0) {
        const canonical = pickCanonical(gmapsMatches);
        results.push({
          kind: "HARD_DUPLICATE",
          leadId: canonical.id,
          matchedBy: ["GMAPS_PLACE_ID"],
          matchedLeadIds: uniq(gmapsMatches.map((l) => l.id)),
          normalized: n,
        });
        continue;
      }
      if (batchSeen.has(`GMAPS:${n.gmapsPlaceId}`)) {
        results.push({
          kind: "HARD_DUPLICATE",
          leadId: "",
          matchedBy: ["GMAPS_PLACE_ID"],
          matchedLeadIds: [],
          intraBatchWinnerIndex: batchSeen.get(`GMAPS:${n.gmapsPlaceId}`),
          normalized: n,
        });
        continue;
      }
    }

    // Standard hard matches (Instagram ID, Username, Profile URL, Email)
    const matchLists: Array<{ key: DedupKey; leads: CandidateLead[] }> = [];
    if (n.instagramUserId) matchLists.push({ key: "INSTAGRAM_ID", leads: byInstagramId.get(n.instagramUserId) ?? [] });
    if (n.usernameNormalized) matchLists.push({ key: "USERNAME", leads: byUsername.get(n.usernameNormalized) ?? [] });
    if (n.profileUrlCanonical) matchLists.push({ key: "PROFILE_URL", leads: byProfileUrl.get(n.profileUrlCanonical) ?? [] });
    if (n.emailNormalized) matchLists.push({ key: "EMAIL", leads: byEmail.get(n.emailNormalized) ?? [] });

    const hardMatches = matchLists.filter((m) => m.leads.length > 0);
    if (hardMatches.length > 0) {
      const matchedLeadIds = uniq(hardMatches.flatMap((m) => m.leads.map((l) => l.id)));
      const canonicalCandidates = hardMatches.flatMap((m) =>
        m.leads.map((l) => (l.duplicateOfLeadId ? found.get(l.duplicateOfLeadId) ?? l : l)),
      );
      const canonical = pickCanonical(canonicalCandidates);
      results.push({
        kind: "HARD_DUPLICATE",
        leadId: canonical.id,
        matchedBy: hardMatches.map((m) => m.key),
        matchedLeadIds,
        normalized: n,
      });
      continue;
    }

    // Priority 2: Dedup by normalized website domain (especially for no-IG leads)
    const domainMatches = n.websiteDomain ? byWebsiteDomain.get(n.websiteDomain) ?? [] : [];
    if (domainMatches.length > 0) {
      const canonical = pickCanonical(domainMatches);
      if (!n.usernameNormalized) {
        results.push({
          kind: "HARD_DUPLICATE",
          leadId: canonical.id,
          matchedBy: ["WEBSITE_DOMAIN"],
          matchedLeadIds: uniq(domainMatches.map((l) => l.id)),
          normalized: n,
        });
        continue;
      }
    }
    if (n.websiteDomain && batchSeen.has(`DOMAIN:${n.websiteDomain}`) && !n.usernameNormalized) {
      results.push({
        kind: "HARD_DUPLICATE",
        leadId: "",
        matchedBy: ["WEBSITE_DOMAIN"],
        matchedLeadIds: [],
        intraBatchWinnerIndex: batchSeen.get(`DOMAIN:${n.websiteDomain}`),
        normalized: n,
      });
      continue;
    }

    // Priority 3: Dedup by normalized phone (E.164)
    if (n.phoneNormalized) {
      const phoneMatches = byPhone.get(n.phoneNormalized) ?? [];
      if (phoneMatches.length > 0) {
        const canonical = pickCanonical(phoneMatches);
        results.push({
          kind: "HARD_DUPLICATE",
          leadId: canonical.id,
          matchedBy: ["PHONE"],
          matchedLeadIds: uniq(phoneMatches.map((l) => l.id)),
          normalized: n,
        });
        continue;
      }
      if (batchSeen.has(`PHONE:${n.phoneNormalized}`)) {
        results.push({
          kind: "HARD_DUPLICATE",
          leadId: "",
          matchedBy: ["PHONE"],
          matchedLeadIds: [],
          intraBatchWinnerIndex: batchSeen.get(`PHONE:${n.phoneNormalized}`),
          normalized: n,
        });
        continue;
      }
    }

    const batchKey = n.instagramUserId
      ? `ID:${n.instagramUserId}`
      : n.usernameNormalized
        ? `U:${n.usernameNormalized}`
        : null;
    if (batchKey && batchSeen.has(batchKey)) {
      results.push({
        kind: "HARD_DUPLICATE",
        leadId: "",
        matchedBy: ["USERNAME"],
        matchedLeadIds: [],
        intraBatchWinnerIndex: batchSeen.get(batchKey),
        normalized: n,
      });
      continue;
    }

    const websiteMatches = n.websiteKey ? byWebsiteKey.get(n.websiteKey) ?? [] : [];
    if (websiteMatches.length > 0) {
      const canonical = pickCanonical(websiteMatches);
      results.push({
        kind: "SOFT_DUPLICATE",
        leadId: canonical.id,
        reason: "WEBSITE_KEY",
        normalized: n,
      });
      continue;
    }

    if (n.gmapsPlaceId) batchSeen.set(`GMAPS:${n.gmapsPlaceId}`, index);
    if (n.websiteDomain) batchSeen.set(`DOMAIN:${n.websiteDomain}`, index);
    if (n.phoneNormalized) batchSeen.set(`PHONE:${n.phoneNormalized}`, index);
    if (batchKey) batchSeen.set(batchKey, index);
    results.push({ kind: "NEW", normalized: n });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type ApplyClassifiedInput = {
  userId: string;
  campaignId: string;
  source: string;
  scrapeJobId?: string | null;
  profiles: DedupProfileInput[];
  classifications: DedupClassification[];
  maxTotalLimit?: number;
  currentTotal?: number;
  isDryRun?: boolean;
  /** Extra (enrichment) fields merged into new lead rows. */
  extraCreateFields?: (
    profile: DedupProfileInput,
    index: number,
  ) => Partial<Prisma.LeadUncheckedCreateInput>;
  /** Extra (enrichment) fields merged into hard-duplicate enrichment. */
  extraEnrichFields?: (
    profile: DedupProfileInput,
    index: number,
  ) => Prisma.LeadUpdateInput;
};

export type ApplyClassifiedResult = {
  stats: DedupStats;
  createdLeadIds: string[];
  createdByIndex: Map<number, string>;
};

const EXISTING_ENRICH_SELECT = {
  id: true,
  campaignId: true,
  username: true,
  usernameNormalized: true,
  previousUsernames: true,
  instagramUserId: true,
  instagramId: true,
  email: true,
  emailNormalized: true,
  website: true,
  websiteDomain: true,
  websiteKey: true,
  socialLink: true,
  socialPlatform: true,
  location: true,
  phone: true,
  phoneNormalized: true,
  contactSource: true,
  availableChannels: true,
} as const;

/**
 * Applies classifications inside the caller's transaction.
 * Hard duplicates are enriched fill-only; status / leadScore / aiAnalysis /
 * DNC state / lastContactedAt are never touched. No rows are deleted.
 */
export async function applyClassifiedProfiles(
  tx: Prisma.TransactionClient,
  input: ApplyClassifiedInput,
): Promise<ApplyClassifiedResult> {
  const stats = emptyDedupStats();
  const createdLeadIds: string[] = [];
  const createdByIndex = new Map<number, string>();
  let currentTotal = input.currentTotal ?? 0;

  for (let index = 0; index < input.classifications.length; index += 1) {
    const classification = input.classifications[index];
    const profile = input.profiles[index];
    const n = classification.normalized;

    if (classification.kind === "HARD_DUPLICATE") {
      stats.hardDuplicates += 1;
      for (const key of classification.matchedBy) stats.byKey[key] += 1;

      const winnerId =
        classification.intraBatchWinnerIndex !== undefined
          ? createdByIndex.get(classification.intraBatchWinnerIndex)
          : classification.leadId;
      if (!winnerId) continue;

      if (classification.intraBatchWinnerIndex !== undefined) {
        stats.intraBatchDuplicates += 1;
      }

      await tx.leadSighting.create({
        data: {
          leadId: winnerId,
          campaignId: input.campaignId,
          scrapeJobId: input.scrapeJobId ?? null,
          source: input.source,
          matchedBy: classification.matchedBy.join(","),
        },
      });

      if (classification.intraBatchWinnerIndex !== undefined) continue;

      const existing = await tx.lead.findUnique({
        where: { id: winnerId },
        select: EXISTING_ENRICH_SELECT,
      });
      if (!existing) continue;

      const data: Prisma.LeadUpdateInput = {};
      // Enrichment extras first (non-null only), then identity fill-only rules.
      const extras = input.extraEnrichFields?.(profile, index) ?? {};
      for (const [key, value] of Object.entries(extras)) {
        if (value !== null && value !== undefined) {
          (data as Record<string, unknown>)[key] = value;
        }
      }
      if (!existing.instagramUserId && n.instagramUserId) data.instagramUserId = n.instagramUserId;
      if (!existing.instagramId && n.instagramUserId) data.instagramId = n.instagramUserId;
      if (!existing.email && profile.email) data.email = profile.email;
      if (!existing.emailNormalized && n.emailNormalized) data.emailNormalized = n.emailNormalized;
      if (!existing.website && n.website) data.website = n.website;
      if (!existing.websiteDomain && n.websiteDomain) data.websiteDomain = n.websiteDomain;
      if (!existing.websiteKey && n.websiteKey) data.websiteKey = n.websiteKey;
      if (!existing.socialLink && n.socialLink) data.socialLink = n.socialLink;
      if (!existing.socialPlatform && n.socialPlatform) data.socialPlatform = n.socialPlatform;
      if (!existing.location && profile.location) data.location = profile.location;
      if (!existing.phone && profile.phone) data.phone = profile.phone;
      if (!existing.phoneNormalized && (profile.phoneNormalized || profile.phone)) {
        data.phoneNormalized = profile.phoneNormalized ?? normalizePhone(profile.phone);
      }
      if (!existing.contactSource && profile.contactSource) {
        data.contactSource = profile.contactSource;
      }
      const combinedEmail = (data.email as string | undefined) ?? existing.email;
      const combinedPhone = (data.phone as string | undefined) ?? existing.phone;
      data.availableChannels = computeAvailableChannels({
        hasInstagram: Boolean(
          profile.username ||
          profile.instagramUsername ||
          existing.username ||
          existing.instagramUserId,
        ),
        email: combinedEmail,
        phone: combinedPhone,
        website: n.website ?? existing.website,
      });

      // Username change: matched by instagramUserId but handle differs.
      const handleChanged =
        !!n.instagramUserId &&
        !!n.usernameNormalized &&
        existing.usernameNormalized !== n.usernameNormalized &&
        existing.username !== profile.username;

      if (handleChanged) {
        data.username = profile.username;
        data.usernameNormalized = n.usernameNormalized;
        data.profileUrlCanonical = n.profileUrlCanonical;
        data.previousUsernames = uniq([
          ...(existing.previousUsernames ?? []),
          existing.usernameNormalized ?? existing.username,
        ]);
      }

      if (Object.keys(data).length > 0) {
        const attempt = await withSavepoint(tx, () =>
          tx.lead.update({ where: { id: winnerId }, data }),
        );
        if (attempt.ok) {
          stats.enriched += 1;
        } else if ((attempt.error as { code?: string }).code === "P2002") {
          logger.warn("[DEDUP] username change skipped (unique conflict)", { leadId: winnerId });
          const fallback: Prisma.LeadUpdateInput = { ...data };
          delete fallback.username;
          delete fallback.usernameNormalized;
          delete fallback.profileUrlCanonical;
          delete fallback.previousUsernames;
          if (Object.keys(fallback).length > 0) {
            await tx.lead.update({ where: { id: winnerId }, data: fallback });
            stats.enriched += 1;
          }
        } else {
          throw attempt.error;
        }
      }
      continue;
    }

    if (input.maxTotalLimit !== undefined && currentTotal >= input.maxTotalLimit) {
      continue;
    }

    const isSoft = classification.kind === "SOFT_DUPLICATE";
    if (isSoft) {
      stats.softDuplicates += 1;
      stats.byKey.WEBSITE_KEY += 1;
    } else {
      stats.new += 1;
    }

    const createData: Prisma.LeadUncheckedCreateInput = {
      campaignId: input.campaignId,
      userId: input.userId,
      username: profile.username ?? null,
      instagramUsername: profile.instagramUsername ?? profile.username ?? null,
      profileUrl: profile.profileUrl ?? (n.profileUrlCanonical ? n.profileUrlCanonical : null),
      status: "NEW",
      source: profile.source ?? input.source,
      usernameNormalized: n.usernameNormalized,
      profileUrlCanonical: n.profileUrlCanonical,
      instagramUserId: n.instagramUserId,
      instagramId: profile.instagramId ?? n.instagramUserId,
      email: profile.email ?? null,
      emailNormalized: n.emailNormalized,
      phone: profile.phone ?? null,
      phoneNormalized: n.phoneNormalized,
      contactSource: profile.contactSource ?? null,
      availableChannels: profile.availableChannels ?? computeAvailableChannels({
        hasInstagram: Boolean(n.usernameNormalized),
        email: profile.email,
        phone: profile.phone,
        website: n.website,
      }),
      website: n.website,
      websiteDomain: n.websiteDomain,
      websiteKey: n.websiteKey,
      socialLink: n.socialLink,
      socialPlatform: n.socialPlatform,
      fullName: profile.fullName ?? null,
      biography: profile.biography ?? profile.bio ?? null,
      category: profile.category ?? profile.businessCategoryName ?? null,
      location: profile.location ?? null,
      followersCount: profile.followersCount ?? profile.followers ?? null,
      followsCount: profile.followsCount ?? profile.following ?? null,
      postsCount: profile.postsCount ?? null,
      gmapsPlaceId: profile.gmapsPlaceId ?? null,
      rating: profile.rating ?? null,
      reviewCount: profile.reviewCount ?? null,
      city: profile.city ?? null,
      handleSource: profile.handleSource ?? null,
      handleConfidence: profile.handleConfidence ?? null,
      scrapeJobId: profile.scrapeJobId ?? input.scrapeJobId ?? null,
      discoveryKeyword: profile.discoveryKeyword ?? null,
      discoveryCity: profile.discoveryCity ?? profile.city ?? null,
      acquisitionCostUsd: profile.acquisitionCostUsd != null ? profile.acquisitionCostUsd : null,
      acquisitionCostBreakdown: profile.acquisitionCostBreakdown ? (profile.acquisitionCostBreakdown as Prisma.InputJsonValue) : Prisma.DbNull,
      messageVariant: profile.messageVariant ?? null,
      possibleDuplicateOfLeadId: isSoft ? classification.leadId : null,
      possibleDuplicateReason: isSoft ? "WEBSITE_KEY" : null,
      dedupFlaggedAt: isSoft ? new Date() : null,
      isDryRun: input.isDryRun ?? false,
    };

    const extras = input.extraCreateFields?.(profile, index) ?? {};
    const attempt = await withSavepoint(tx, () =>
      tx.lead.create({
        data: { ...extras, ...createData } as Prisma.LeadUncheckedCreateInput,
        select: { id: true },
      }),
    );

    if (attempt.ok) {
      const created = attempt.value;
      createdLeadIds.push(created.id);
      createdByIndex.set(index, created.id);
      currentTotal += 1;
      await tx.leadSighting.create({
        data: {
          leadId: created.id,
          campaignId: input.campaignId,
          scrapeJobId: input.scrapeJobId ?? null,
          source: input.source,
          matchedBy: "NEW",
        },
      });
      continue;
    }

    if ((attempt.error as { code?: string }).code !== "P2002" || !n.usernameNormalized) {
      throw attempt.error;
    }

    // Race: another writer inserted the same person. The savepoint rolled back
    // the failed INSERT, so the transaction is usable again.
    const existing = (await tx.lead.findFirst({
      where: { userId: input.userId, usernameNormalized: n.usernameNormalized },
      select: CANDIDATE_SELECT,
    })) as CandidateLead | null;
    if (!existing) throw attempt.error;

    stats.hardDuplicates += 1;
    stats.byKey.USERNAME += 1;
    createdByIndex.set(index, existing.id);

    const fill: Prisma.LeadUpdateInput = {};
    if (!existing.instagramUserId && n.instagramUserId) fill.instagramUserId = n.instagramUserId;
    if (!existing.emailNormalized && n.emailNormalized) fill.emailNormalized = n.emailNormalized;
    if (!existing.websiteKey && n.websiteKey) fill.websiteKey = n.websiteKey;
    if (Object.keys(fill).length > 0) {
      await tx.lead.update({ where: { id: existing.id }, data: fill });
      stats.enriched += 1;
    }
    await tx.leadSighting.create({
      data: {
        leadId: existing.id,
        campaignId: input.campaignId,
        scrapeJobId: input.scrapeJobId ?? null,
        source: input.source,
        matchedBy: "USERNAME",
      },
    });
  }

  return { stats, createdLeadIds, createdByIndex };
}

// ---------------------------------------------------------------------------
// Contact history
// ---------------------------------------------------------------------------

/**
 * True when the lead (or its hard-duplicate group) is already contacted:
 * `lastContactedAt` set, or an OUTBOUND SENT message on any group member.
 */
export async function wasPreviouslyContacted(
  leadId: string,
  client?: Prisma.TransactionClient,
): Promise<boolean> {
  const prisma = client ?? getPrismaClient();
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, lastContactedAt: true, duplicateOfLeadId: true },
  });
  if (!lead) return false;
  if (lead.lastContactedAt) return true;

  const canonicalId = lead.duplicateOfLeadId ?? lead.id;
  const group = await prisma.lead.findMany({
    where: { OR: [{ id: canonicalId }, { duplicateOfLeadId: canonicalId }] },
    select: { id: true },
  });
  const ids = uniq(group.map((member) => member.id));
  if (ids.length === 0) return false;

  const sent = await prisma.message.findFirst({
    where: {
      leadId: { in: ids },
      direction: MessageDirection.OUTBOUND,
      status: MessageStatus.SENT,
    },
    select: { id: true },
  });
  return sent !== null;
}

/**
 * Batch "already contacted" check for a set of lead ids.
 *
 * A lead counts as contacted when ANY member of its identity group has
 * `lastContactedAt` set or an OUTBOUND SENT message. The group spans both the
 * duplicate-pointer group AND same-user + same-usernameNormalized siblings, so
 * a person contacted via another campaign is excluded even before links exist.
 * Bounded queries (≤4), never per lead.
 */
export async function findPreviouslyContactedLeadIds(
  leadIds: string[],
  client?: Prisma.TransactionClient,
): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();
  const prisma = client ?? getPrismaClient();

  const leads = await prisma.lead.findMany({
    where: { id: { in: leadIds } },
    select: {
      id: true,
      userId: true,
      usernameNormalized: true,
      lastContactedAt: true,
      duplicateOfLeadId: true,
    },
  });
  if (leads.length === 0) return new Set();

  const contacted = new Set<string>();
  const keys = new Map<string, string[]>(); // identity key -> lead ids

  const addKey = (key: string, id: string) => {
    const list = keys.get(key) ?? [];
    list.push(id);
    keys.set(key, list);
  };

  for (const lead of leads) {
    const canonical = lead.duplicateOfLeadId ?? lead.id;
    addKey(`C:${canonical}`, lead.id);
    if (lead.userId && lead.usernameNormalized) {
      addKey(`U:${lead.userId}:${lead.usernameNormalized}`, lead.id);
    }
  }

  const groupMemberIds = new Set<string>(leads.map((lead) => lead.id));

  // Duplicate-pointer siblings.
  const canonicalIds = uniq(leads.map((lead) => lead.duplicateOfLeadId ?? lead.id));
  const pointerSiblings = await prisma.lead.findMany({
    where: {
      OR: [{ id: { in: canonicalIds } }, { duplicateOfLeadId: { in: canonicalIds } }],
    },
    select: { id: true, lastContactedAt: true, duplicateOfLeadId: true },
  });

  // Same-user + username siblings (covers cross-campaign before linking).
  const usernameKeys = uniq(
    leads.map((lead) =>
      lead.userId && lead.usernameNormalized
        ? `${lead.userId}\u0000${lead.usernameNormalized}`
        : null,
    ),
  );
  const userSiblings = usernameKeys.length
    ? await prisma.lead.findMany({
        where: {
          OR: usernameKeys.map((key) => {
            const [userId, usernameNormalized] = key.split("\u0000");
            return { userId, usernameNormalized };
          }),
        },
        select: { id: true, lastContactedAt: true, userId: true, usernameNormalized: true },
      })
    : [];

  const allGroupIds = new Set<string>([
    ...groupMemberIds,
    ...pointerSiblings.map((lead) => lead.id),
    ...userSiblings.map((lead) => lead.id),
  ]);

  const contactedGroupIds = new Set<string>();
  for (const lead of [...pointerSiblings, ...userSiblings]) {
    if (lead.lastContactedAt) contactedGroupIds.add(lead.id);
  }
  for (const lead of leads) {
    if (lead.lastContactedAt) contactedGroupIds.add(lead.id);
  }

  if (allGroupIds.size > 0) {
    const sent = await prisma.message.findMany({
      where: {
        leadId: { in: [...allGroupIds] },
        direction: MessageDirection.OUTBOUND,
        status: MessageStatus.SENT,
      },
      select: { leadId: true },
    });
    for (const row of sent) contactedGroupIds.add(row.leadId);
  }

  // Also propagate contact through the duplicate pointer.
  const contactedCanonicals = new Set<string>();
  for (const lead of [...pointerSiblings, ...leads]) {
    if (contactedGroupIds.has(lead.id)) {
      contactedCanonicals.add(lead.duplicateOfLeadId ?? lead.id);
    }
  }

  for (const lead of leads) {
    const canonical = lead.duplicateOfLeadId ?? lead.id;
    if (
      contactedGroupIds.has(lead.id) ||
      contactedCanonicals.has(canonical) ||
      contactedGroupIds.has(canonical)
    ) {
      contacted.add(lead.id);
    }
  }

  return contacted;
}

/** Clears a possible-duplicate flag after explicit user review. */
export async function clearPossibleDuplicateFlag(
  leadId: string,
  userId: string,
): Promise<{ cleared: boolean }> {
  const updated = await getPrismaClient().lead.updateMany({
    where: { id: leadId, campaign: { userId }, possibleDuplicateOfLeadId: { not: null } },
    data: { possibleDuplicateOfLeadId: null, possibleDuplicateReason: null, dedupFlaggedAt: null },
  });
  return { cleared: updated.count > 0 };
}
