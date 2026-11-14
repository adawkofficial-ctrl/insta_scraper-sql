import type {
  LeadLatestPost,
  LeadProfile,
  LeadRelatedProfile,
  SkippedScrapeProfile,
} from "@/lib/types";
import {
  extractContactFromBio,
  normalizePhone,
  computeAvailableChannels,
} from "../contact/contact-parser";
import { getEnrichmentProviderName } from "@/lib/env";
import { MAX_CAMPAIGN_LEAD_LIMIT } from "@/lib/constants/campaign-limits";

export const INSTAGRAM_PROFILE_ACTOR_ID = "apify/instagram-profile-scraper";

export type IgEnrichmentActorMode = "profile_scraper" | "instagram_scraper_details";

export const DEFAULT_IG_ENRICHMENT_ACTOR: IgEnrichmentActorMode = "instagram_scraper_details";

export function getIgEnrichmentActorMode(): IgEnrichmentActorMode {
  const explicit = process.env.IG_ENRICHMENT_ACTOR?.trim().toLowerCase();
  if (explicit === "instagram_scraper_details") {
    return "instagram_scraper_details";
  }
  if (explicit === "profile_scraper") {
    return "profile_scraper";
  }
  return getEnrichmentProviderName() === "instagram_scraper"
    ? "instagram_scraper_details"
    : "profile_scraper";
}

export function getActiveEnrichmentActorId(): string {
  const mode = getIgEnrichmentActorMode();
  if (mode === "instagram_scraper_details") {
    const custom = process.env.APIFY_IG_SCRAPER_ACTOR_ID?.trim();
    return custom && custom.length > 0 && custom !== "undefined"
      ? custom
      : "apify/instagram-scraper";
  }
  const custom = process.env.APIFY_PROFILE_ACTOR_ID?.trim();
  return custom && custom.length > 0 && custom !== "undefined"
    ? custom
    : INSTAGRAM_PROFILE_ACTOR_ID;
}

export function buildInstagramProfileUrls(usernames: string[]): string[] {
  return usernames.map((u) => {
    const clean = normalizeInstagramUsername(u) ?? u.trim();
    return clean.startsWith("http://") || clean.startsWith("https://")
      ? clean
      : `https://www.instagram.com/${clean}/`;
  });
}

// The Actor's input schema only accepts a `usernames` array (verified against
// apify/instagram-profile-scraper): there is no resultsLimit/resultsType field.
export function getMaxLeadLimit(): number {
  if (process.env.DISCOVERY_STAGE === "pilot_small") {
    return 10;
  }
  // Campaign lead limits have no product cap. The value is only bounded by the
  // 32-bit database integer. Do not read MAX_LEAD_LIMIT here: the old 100 cap
  // must stay removed permanently.
  return MAX_CAMPAIGN_LEAD_LIMIT;
}

export function getMaxProfileBatchSize(): number {
  const envVal = process.env.MAX_PROFILE_BATCH_SIZE;
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 1000;
}

export const MIN_LEAD_LIMIT = 1;
export const MAX_LEAD_LIMIT = getMaxLeadLimit();
export const MAX_PROFILE_BATCH_SIZE = getMaxProfileBatchSize();
export const DEFAULT_LEAD_LIMIT = 10;

const MAX_RELATED_PROFILES = 12;
const MAX_LATEST_POSTS = 12;
const MAX_CAPTION_LENGTH = 1000;

const USERNAME_PATTERN = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/;

const RESERVED_PATH_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "stories",
  "explore",
  "accounts",
  "direct",
  "developer",
  "about",
  "legal",
  "api",
  "oauth",
  "challenge",
  "graphql",
  "name",
  "directory",
]);

export class ScrapeInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ScrapeInputError";
    this.code = code;
  }
}

/**
 * Validates the "Maximum Leads" value on the server. Never trusts the client.
 * Normalizes numeric strings, rejects non-integers, floats, NaN, and out-of-range (1-100).
 */
export function parseLeadLimit(value: unknown, allowDefault = true): number {
  const maxLimit = getMaxLeadLimit();
  if (value === undefined || value === null) {
    if (allowDefault) {
      return DEFAULT_LEAD_LIMIT;
    }
    throw new ScrapeInputError(
      "INVALID_LEAD_LIMIT",
      `"maxLeads" is required and must be an integer between ${MIN_LEAD_LIMIT} and ${maxLimit}.`,
    );
  }

  let numValue: number;

  if (typeof value === "number") {
    numValue = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new ScrapeInputError(
        "INVALID_LEAD_LIMIT",
        `"maxLeads" must be an integer between ${MIN_LEAD_LIMIT} and ${maxLimit}.`,
      );
    }
    numValue = Number.parseInt(trimmed, 10);
  } else {
    throw new ScrapeInputError(
      "INVALID_LEAD_LIMIT",
      `"maxLeads" must be an integer between ${MIN_LEAD_LIMIT} and ${maxLimit}.`,
    );
  }

  if (!Number.isInteger(numValue) || Number.isNaN(numValue)) {
    throw new ScrapeInputError(
      "INVALID_LEAD_LIMIT",
      `"maxLeads" must be an integer between ${MIN_LEAD_LIMIT} and ${maxLimit}.`,
    );
  }

  if (numValue < MIN_LEAD_LIMIT || numValue > maxLimit) {
    throw new ScrapeInputError(
      "LEAD_LIMIT_OUT_OF_RANGE",
      `"maxLeads" must be between ${MIN_LEAD_LIMIT} and ${maxLimit}.`,
    );
  }

  return numValue;
}

export function parseScrapeRequest(body: unknown): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ScrapeInputError(
      "INVALID_BODY",
      "Request body must be a JSON object.",
    );
  }

  const raw = (body as Record<string, unknown>).usernames;
  if (raw === undefined) {
    throw new ScrapeInputError(
      "MISSING_USERNAMES",
      '"usernames" is required.',
    );
  }
  if (!Array.isArray(raw)) {
    throw new ScrapeInputError(
      "INVALID_USERNAMES",
      '"usernames" must be an array of strings.',
    );
  }
  if (raw.length === 0) {
    throw new ScrapeInputError(
      "EMPTY_USERNAMES",
      "At least one username is required.",
    );
  }
  const maxBatch = getMaxProfileBatchSize();
  if (raw.length > maxBatch) {
    throw new ScrapeInputError(
      "BATCH_TOO_LARGE",
      `Too many usernames: ${raw.length}. The maximum for this batch is ${maxBatch}.`,
    );
  }

  const seen = new Set<string>();
  const usernames: string[] = [];

  for (const value of raw) {
    if (typeof value !== "string") {
      throw new ScrapeInputError(
        "INVALID_USERNAME",
        "Each username must be a string.",
      );
    }

    const username = normalizeInstagramUsername(value);
    if (username === null) {
      throw new ScrapeInputError(
        "INVALID_USERNAME",
        `Invalid Instagram username or profile URL: "${preview(value)}".`,
      );
    }

    if (seen.has(username)) {
      continue;
    }

    seen.add(username);
    usernames.push(username);
  }

  if (usernames.length === 0) {
    throw new ScrapeInputError(
      "EMPTY_USERNAMES",
      "At least one valid username is required.",
    );
  }

  return usernames;
}

export function normalizeInstagramUsername(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) {
    return null;
  }

  const withoutAt = value.startsWith("@") ? value.slice(1) : value;

  if (looksLikeUrl(withoutAt)) {
    return extractUsernameFromUrl(withoutAt);
  }

  const candidate = withoutAt.toLowerCase();
  return USERNAME_PATTERN.test(candidate) ? candidate : null;
}

export function normalizeInstagramProfileItem(
  item: unknown,
  scrapedAt: string,
): LeadProfile | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const record = item as Record<string, unknown>;

  // The Actor returns error items (e.g. { username, error: "not_found" }) for
  // profiles it could not fetch. Never treat those as leads.
  if (readString(record.error) !== null || readString(record.errorDescription) !== null) {
    return null;
  }

  const itemUrl = readString(record.url) ?? readString(record.inputUrl);
  const username = (
    readString(record.username) ??
    readString(record.ownerUsername) ??
    (itemUrl === null ? null : extractUsernameFromUrl(itemUrl))
  )?.toLowerCase();

  if (username === undefined || username === null || username.length === 0) {
    return null;
  }

  const followersCount = readNumber(record.followersCount) ?? readNumber(record.followers);
  const followsCount = readNumber(record.followsCount) ?? readNumber(record.following);
  // Posts count: handle missing postsCount as null (never 0)
  const postsCount =
    record.postsCount !== undefined && record.postsCount !== null
      ? readNumber(record.postsCount)
      : record.mediaCount !== undefined && record.mediaCount !== null
        ? readNumber(record.mediaCount)
        : null;

  const verified = readBoolean(record.verified) ?? readBoolean(record.isVerified) ?? readBoolean(record.is_verified);
  const isBusinessAccount =
    readBoolean(record.isBusinessAccount) ??
    readBoolean(record.is_business_account) ??
    readBoolean(record.isBusiness);
  const businessCategoryName =
    readString(record.businessCategoryName) ??
    readString(record.categoryName) ??
    readString(record.category);
  const externalUrl = readString(record.externalUrl) ?? readString(record.external_url);
  const businessAddressRaw = record.businessAddress ?? record.business_address_json;
  const businessAddress =
    businessAddressRaw !== null && typeof businessAddressRaw === "object" && !Array.isArray(businessAddressRaw)
      ? (businessAddressRaw as Record<string, unknown>)
      : null;
  const businessCity =
    readString(businessAddress?.city_name) ??
    readString(businessAddress?.cityName) ??
    readString(businessAddress?.city) ??
    readString(record.city_name);
  const location =
    readString(record.locationName) ??
    readString(record.location) ??
    businessCity;
  const isPrivate =
    readBoolean(record.isPrivate) ??
    readBoolean(record.private) ??
    readBoolean(record.is_private);

  const biography = readString(record.biography) ?? readString(record.bio);
  const bioContact = extractContactFromBio(biography, externalUrl);
  const email =
    readString(record.email) ??
    readString(record.businessEmail) ??
    readString(record.public_email) ??
    readString(record.publicEmail) ??
    bioContact.email;
  const phone =
    readString(record.phoneNumber) ??
    readString(record.contactPhoneNumber) ??
    readString(record.public_phone_number) ??
    readString(record.publicPhoneNumber) ??
    readString(record.phone) ??
    bioContact.phone;
  const phoneNormalized = normalizePhone(phone);
  const contactSource = email || phone ? (bioContact.contactSource ?? "instagram_bio") : null;
  const availableChannels = computeAvailableChannels({
    hasInstagram: true,
    email,
    phone,
  });

  let lastPostAt: string | null = null;
  let recentLikesAvg: number | null = null;
  let recentCommentsAvg: number | null = null;
  const rawPosts = Array.isArray(record.latestPosts)
    ? record.latestPosts
    : Array.isArray(record.posts)
      ? record.posts
      : null;
  if (rawPosts && rawPosts.length > 0) {
    const likes: number[] = [];
    const comments: number[] = [];
    let latestMs = -1;
    for (const post of rawPosts) {
      if (post === null || typeof post !== "object" || Array.isArray(post)) continue;
      const p = post as Record<string, unknown>;
      const likesCount = readNumber(p.likesCount ?? p.likes);
      const commentsCount = readNumber(p.commentsCount ?? p.comments);
      if (likesCount !== null) likes.push(likesCount);
      if (commentsCount !== null) comments.push(commentsCount);
      const rawTs = p.timestamp ?? p.takenAt ?? p.date ?? p.takenAtTimestamp;
      if (typeof rawTs === "string") {
        const d = new Date(rawTs);
        if (!Number.isNaN(d.getTime())) latestMs = Math.max(latestMs, d.getTime());
      } else if (typeof rawTs === "number") {
        const ms = rawTs < 10000000000 ? rawTs * 1000 : rawTs;
        latestMs = Math.max(latestMs, ms);
      }
    }
    if (latestMs >= 0) lastPostAt = new Date(latestMs).toISOString();
    const avg = (values: number[]): number | null =>
      values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
    recentLikesAvg = avg(likes);
    recentCommentsAvg = avg(comments);
  }
  const engagementRate =
    followersCount !== null &&
    followersCount > 0 &&
    (recentLikesAvg !== null || recentCommentsAvg !== null)
      ? ((recentLikesAvg ?? 0) + (recentCommentsAvg ?? 0)) / followersCount
      : null;

  const rawProfileData: Record<string, unknown> = {
    username,
    fullName: readString(record.fullName) ?? readString(record.name),
    followersCount,
    followsCount,
    postsCount,
    lastPostAt,
    recentLikesAvg,
    recentCommentsAvg,
    engagementRate,
    biography,
    externalUrl,
    ...(record.externalUrls !== undefined ? { externalUrls: record.externalUrls } : {}),
    isBusinessAccount,
    businessCategoryName,
    isPrivate,
    private: isPrivate,
    verified,
    enrichmentStatus: "ENRICHED",
  };

  return {
    username,
    profileUrl: itemUrl ?? `https://www.instagram.com/${username}/`,
    instagramId: readId(record.id),
    fullName: readString(record.fullName) ?? readString(record.name),
    biography,
    email,
    phone,
    phoneNormalized,
    website: bioContact.website,
    socialLink: bioContact.socialLink,
    socialPlatform: bioContact.socialPlatform,
    contactSource,
    availableChannels,
    followers: followersCount,
    following: followsCount,
    followersCount,
    followsCount,
    postsCount,
    profilePictureUrl: null, // Dropped to minimize payload
    profilePicUrl: null,     // Dropped to minimize payload
    profilePicUrlHD: null,   // Dropped to minimize payload
    isVerified: verified,
    verified,
    isBusiness: isBusinessAccount,
    isBusinessAccount,
    category: businessCategoryName,
    businessCategoryName,
    externalUrl,
    location,
    isPrivate,
    relatedProfiles: null, // Dropped to minimize stored payload
    latestPosts: null,     // Dropped to minimize stored payload
    lastPostAt,
    rawProfileData,
    source: "apify",
    scrapedAt,
  };
}

export const WHITELISTED_PROFILE_ENRICHMENT_FIELDS = [
  "username",
  "fullName",
  "followersCount",
  "followsCount",
  "postsCount",
  "biography",
  "externalUrl",
  "externalUrls",
  "isBusinessAccount",
  "businessCategoryName",
  "isPrivate",
  "private",
  "verified",
] as const;

/**
 * Strips all non-whitelisted profile-actor fields (posts, likes, comments, images, related profiles)
 * from an Apify profile scraper record.
 */
export function filterProfileActorPayload(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const key of WHITELISTED_PROFILE_ENRICHMENT_FIELDS) {
    if (key in record && record[key] !== undefined) {
      sanitized[key] = record[key];
    }
  }
  return sanitized;
}

/**
 * Detects an Apify Actor error item for an unfetchable profile, e.g.
 * { username: "x", error: "not_found", errorDescription: "Post does not exist" }.
 * Returns null when the item is not an error item.
 */
export function extractActorError(
  item: unknown,
): SkippedScrapeProfile | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const record = item as Record<string, unknown>;
  const error = readString(record.error) ?? readString(record.errorDescription);
  if (error === null) {
    return null;
  }

  const username = readString(record.username)?.toLowerCase() ?? "unknown";
  const description = readString(record.errorDescription);

  return {
    username,
    reason: description && description !== error ? `${error}: ${description}` : error,
  };
}

export function normalizeRelatedProfiles(
  value: unknown,
): LeadRelatedProfile[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const profiles: LeadRelatedProfile[] = [];

  for (const entry of value) {
    if (profiles.length >= MAX_RELATED_PROFILES) {
      break;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const username = readString(record.username);
    if (username === null) {
      continue;
    }

    profiles.push({
      username: username.toLowerCase(),
      fullName: readString(record.full_name),
      profilePictureUrl: readString(record.profile_pic_url),
      isVerified: readBoolean(record.is_verified),
      isPrivate: readBoolean(record.is_private),
    });
  }

  return profiles;
}

export function normalizeLatestPosts(value: unknown): LeadLatestPost[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const posts: LeadLatestPost[] = [];

  for (const entry of value) {
    if (posts.length >= MAX_LATEST_POSTS) {
      break;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const caption = readString(record.caption);

    posts.push({
      id: readId(record.id),
      shortCode: readString(record.shortCode),
      url: readString(record.url),
      type: readString(record.type),
      caption:
        caption === null
          ? null
          : caption.slice(0, MAX_CAPTION_LENGTH),
      likesCount: readNumber(record.likesCount),
      commentsCount: readNumber(record.commentsCount),
      displayUrl: readString(record.displayUrl),
      timestamp: readString(record.timestamp),
    });
  }

  return posts;
}

function looksLikeUrl(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    value.includes("/") ||
    /instagram\.com/i.test(value)
  );
}

function extractUsernameFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }

  const host = url.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/^m\./, "");
  if (host !== "instagram.com") {
    return null;
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .filter((segment) => segment.length > 0);

  if (segments.length !== 1) {
    return null;
  }

  const candidate = segments[0].toLowerCase();
  if (RESERVED_PATH_SEGMENTS.has(candidate)) {
    return null;
  }

  return USERNAME_PATTERN.test(candidate) ? candidate : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function preview(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 64 ? `${collapsed.slice(0, 64)}...` : collapsed;
}
