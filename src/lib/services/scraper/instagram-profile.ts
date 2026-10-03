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

export const INSTAGRAM_PROFILE_ACTOR_ID = "apify/instagram-profile-scraper";

// The Actor's input schema only accepts a `usernames` array (verified against
// apify/instagram-profile-scraper): there is no resultsLimit/resultsType field.
// Batch size and the "Maximum Leads" cap are therefore enforced by this app.
export const MAX_PROFILE_BATCH_SIZE = 100;

export const MIN_LEAD_LIMIT = 1;
export const MAX_LEAD_LIMIT = 100;
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
  if (value === undefined || value === null) {
    if (allowDefault) {
      return DEFAULT_LEAD_LIMIT;
    }
    throw new ScrapeInputError(
      "INVALID_LEAD_LIMIT",
      `"maxLeads" is required and must be an integer between ${MIN_LEAD_LIMIT} and ${MAX_LEAD_LIMIT}.`,
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
        `"maxLeads" must be an integer between ${MIN_LEAD_LIMIT} and ${MAX_LEAD_LIMIT}.`,
      );
    }
    numValue = Number.parseInt(trimmed, 10);
  } else {
    throw new ScrapeInputError(
      "INVALID_LEAD_LIMIT",
      `"maxLeads" must be an integer between ${MIN_LEAD_LIMIT} and ${MAX_LEAD_LIMIT}.`,
    );
  }

  if (!Number.isInteger(numValue) || Number.isNaN(numValue)) {
    throw new ScrapeInputError(
      "INVALID_LEAD_LIMIT",
      `"maxLeads" must be an integer between ${MIN_LEAD_LIMIT} and ${MAX_LEAD_LIMIT}.`,
    );
  }

  if (numValue < MIN_LEAD_LIMIT || numValue > MAX_LEAD_LIMIT) {
    throw new ScrapeInputError(
      "LEAD_LIMIT_OUT_OF_RANGE",
      `"maxLeads" must be between ${MIN_LEAD_LIMIT} and ${MAX_LEAD_LIMIT}.`,
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
  if (raw.length > MAX_PROFILE_BATCH_SIZE) {
    throw new ScrapeInputError(
      "BATCH_TOO_LARGE",
      `Too many usernames: ${raw.length}. The maximum for this batch is ${MAX_PROFILE_BATCH_SIZE}.`,
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

  const itemUrl = readString(record.url);
  const username = (
    readString(record.username) ??
    (itemUrl === null ? null : extractUsernameFromUrl(itemUrl))
  )?.toLowerCase();

  if (username === undefined || username === null || username.length === 0) {
    return null;
  }

  const profilePicUrl = readString(record.profilePicUrl);
  const profilePicUrlHD = readString(record.profilePicUrlHD);
  const preferredPic = profilePicUrlHD ?? profilePicUrl;

  const followersCount = readNumber(record.followersCount);
  const followsCount = readNumber(record.followsCount);
  const postsCount = readNumber(record.postsCount);
  const verified = readBoolean(record.verified);
  const isBusinessAccount = readBoolean(record.isBusinessAccount);
  const businessCategoryName = readString(record.businessCategoryName);
  const externalUrl = readString(record.externalUrl);
  const location = readString(record.locationName) ?? readString(record.location);

  const biography = readString(record.biography);
  const bioContact = extractContactFromBio(biography, externalUrl);
  const email = readString(record.email) ?? readString(record.businessEmail) ?? bioContact.email;
  const phone =
    readString(record.phoneNumber) ??
    readString(record.contactPhoneNumber) ??
    readString(record.phone) ??
    bioContact.phone;
  const phoneNormalized = normalizePhone(phone);
  const contactSource = email || phone ? (bioContact.contactSource ?? "instagram_bio") : null;
  const availableChannels = computeAvailableChannels({
    hasInstagram: true,
    email,
    phone,
  });

  const rawProfileData: Record<string, unknown> = {
    id: readId(record.id),
    username,
    fullName: readString(record.fullName),
    biography,
    email,
    phone,
    phoneNormalized,
    website: bioContact.website,
    socialLink: bioContact.socialLink,
    socialPlatform: bioContact.socialPlatform,
    contactSource,
    availableChannels,
    externalUrl,
    followersCount,
    followsCount,
    postsCount,
    isBusinessAccount,
    businessCategoryName,
    verified,
    profilePicUrl,
    profilePicUrlHD,
    highlightReelCount: readNumber(record.highlightReelCount),
    isPrivate: readBoolean(record.isPrivate),
    location,
    joinedRecently: readBoolean(record.joinedRecently),
    hasChannel: readBoolean(record.hasChannel),
  };

  return {
    username,
    profileUrl: itemUrl ?? `https://www.instagram.com/${username}/`,
    instagramId: readId(record.id),
    fullName: readString(record.fullName),
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
    profilePictureUrl: preferredPic,
    profilePicUrl,
    profilePicUrlHD,
    isVerified: verified,
    verified,
    isBusiness: isBusinessAccount,
    isBusinessAccount,
    category: businessCategoryName,
    businessCategoryName,
    externalUrl,
    // The Actor only returns a location-ish value when present; otherwise null.
    location,
    relatedProfiles: normalizeRelatedProfiles(record.relatedProfiles),
    latestPosts: normalizeLatestPosts(record.latestPosts),
    rawProfileData,
    source: "apify",
    scrapedAt,
  };
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

function normalizeRelatedProfiles(
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

function normalizeLatestPosts(value: unknown): LeadLatestPost[] | null {
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
