/**
 * Single-file tolerant mapper for `apify/instagram-scraper` output.
 *
 * The actor's dataset schema changes over time, so every field is optional and
 * every read is defensive: a missing value stays `null` (unknown) and is never
 * coerced to 0, `""`, or a guessed value. When a real console sample arrives,
 * add aliases only in this file (see FIELD_ALIASES) and the rest of the
 * pipeline picks them up automatically.
 */

import type { DiscoveredProfile } from "./discovery-provider";
import type { LeadLatestPost } from "@/lib/types";

export type MappedInstagramProfile = DiscoveredProfile & {
  followsCount: number | null;
  postsCount: number | null;
  lastPostAt: string | null;
  recentLikesAvg: number | null;
  recentCommentsAvg: number | null;
  engagementRate: number | null;
  presentFields: string[];
  missingFields: string[];
};

export type MappedPlaceSignal = {
  kind: "place";
  name: string | null;
  address: string | null;
  city: string | null;
  category: string | null;
  latitude: number | null;
  longitude: number | null;
  username: string | null;
  presentFields: string[];
};

const FIELD_ALIASES = {
  username: ["username", "ownerUsername", "userName"],
  fullName: ["fullName", "full_name", "name"],
  followersCount: ["followersCount", "followers", "followerCount"],
  followsCount: ["followsCount", "following", "followingCount"],
  postsCount: ["postsCount", "mediaCount", "posts"],
  biography: ["biography", "bio"],
  externalUrl: ["externalUrl", "external_url", "website"],
  externalUrls: ["externalUrls", "external_urls"],
  isBusinessAccount: ["isBusinessAccount", "is_business_account", "isBusiness"],
  businessCategoryName: ["businessCategoryName", "business_category_name", "categoryName", "category"],
  email: ["public_email", "publicEmail", "email", "businessEmail"],
  phone: ["public_phone_number", "publicPhoneNumber", "contact_phone_number", "phoneNumber", "phone"],
  city: ["city_name", "cityName", "city"],
  address: ["business_address_json", "businessAddress", "address", "location_address"],
  location: ["locationName", "location"],
  verified: ["verified", "isVerified", "is_verified"],
  isPrivate: ["private", "isPrivate", "is_private"],
  latestPosts: ["latestPosts", "posts", "latestIgs", "recentPosts"],
  latitude: ["latitude", "lat"],
  longitude: ["longitude", "lng", "lon"],
} as const;

export const MAPPED_PROFILE_FIELDS = Object.keys(FIELD_ALIASES) as Array<
  keyof typeof FIELD_ALIASES
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const key of aliases) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeUsernameFromRaw(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const withoutAt = raw.startsWith("@") ? raw.slice(1) : raw;
  if (withoutAt.includes("instagram.com")) {
    try {
      const url = new URL(withoutAt.startsWith("http") ? withoutAt : `https://${withoutAt}`);
      const segment = url.pathname.split("/").filter(Boolean)[0];
      return segment ? segment.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  return /^[a-z0-9._]{1,30}$/i.test(withoutAt) ? withoutAt.toLowerCase() : null;
}

function readExternalUrls(record: Record<string, unknown>): string[] {
  const raw = pick(record, FIELD_ALIASES.externalUrls);
  const urls: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") {
        urls.push(entry);
      } else if (isRecord(entry)) {
        const url = asString(entry.url) ?? asString(entry.link) ?? asString(entry.href);
        if (url) urls.push(url);
      }
    }
  }
  const single = asString(pick(record, FIELD_ALIASES.externalUrl));
  if (single) urls.unshift(single);
  return Array.from(new Set(urls));
}

function readBusinessAddress(record: Record<string, unknown>): {
  city: string | null;
  address: string | null;
} {
  const raw = pick(record, FIELD_ALIASES.address);
  const obj = asObject(raw);
  if (obj) {
    const city =
      asString(obj.city_name) ??
      asString(obj.cityName) ??
      asString(obj.city) ??
      asString(pick(record, FIELD_ALIASES.city));
    const parts = [
      asString(obj.street_address),
      asString(obj.address),
      asString(obj.zip_code),
    ].filter((v): v is string => Boolean(v));
    return {
      city,
      address: parts.length > 0 ? parts.join(", ") : asString(raw),
    };
  }
  return {
    city: asString(pick(record, FIELD_ALIASES.city)),
    address: asString(raw),
  };
}

function readLatestPosts(record: Record<string, unknown>): {
  posts: DiscoveredProfile["latestPosts"];
  lastPostAt: string | null;
  likeAvg: number | null;
  commentAvg: number | null;
} {
  const raw = pick(record, FIELD_ALIASES.latestPosts);
  if (!Array.isArray(raw) || raw.length === 0) {
    return { posts: null, lastPostAt: null, likeAvg: null, commentAvg: null };
  }

  const posts: LeadLatestPost[] = [];
  const likes: number[] = [];
  const comments: number[] = [];
  let latestMs = -1;

  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const caption = asString(entry.caption);
    const locationName = asString(entry.locationName) ?? asString(entry.location);
    const likesCount = asNumber(entry.likesCount ?? entry.likes);
    const commentsCount = asNumber(entry.commentsCount ?? entry.comments);
    if (likesCount !== null) likes.push(likesCount);
    if (commentsCount !== null) comments.push(commentsCount);

    const timestamp = entry.timestamp ?? entry.takenAt;
    let iso: string | null = null;
    if (typeof timestamp === "string") {
      const date = new Date(timestamp);
      if (!Number.isNaN(date.getTime())) {
        iso = date.toISOString();
        latestMs = Math.max(latestMs, date.getTime());
      }
    } else if (typeof timestamp === "number") {
      const ms = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
      iso = new Date(ms).toISOString();
      latestMs = Math.max(latestMs, ms);
    }

    posts.push({
      id: asString(entry.id),
      shortCode: asString(entry.shortCode),
      url: asString(entry.url),
      type: asString(entry.type),
      caption,
      likesCount,
      commentsCount,
      displayUrl: asString(entry.displayUrl),
      timestamp: iso,
      locationName,
    });
  }

  const avg = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

  return {
    posts,
    lastPostAt: latestMs >= 0 ? new Date(latestMs).toISOString() : null,
    likeAvg: avg(likes),
    commentAvg: avg(comments),
  };
}

function computeEngagementRate(
  followers: number | null,
  likeAvg: number | null,
  commentAvg: number | null,
): number | null {
  if (!followers || followers <= 0) return null;
  if (likeAvg === null && commentAvg === null) return null;
  return ((likeAvg ?? 0) + (commentAvg ?? 0)) / followers;
}

/**
 * Maps one search/details dataset item to our candidate model.
 * Returns null when the item is an actor error item or has no usable handle.
 */
export function mapInstagramScraperItem(item: unknown): MappedInstagramProfile | null {
  if (!isRecord(item)) return null;
  if (asString(item.error) !== null || asString(item.errorDescription) !== null) {
    return null;
  }

  const username = normalizeUsernameFromRaw(pick(item, FIELD_ALIASES.username));
  if (!username) return null;

  const presentFields: string[] = [];
  const missingFields: string[] = [];
  for (const field of MAPPED_PROFILE_FIELDS) {
    const value = pick(item, FIELD_ALIASES[field]);
    if (value === undefined || value === null || value === "") {
      missingFields.push(field);
    } else {
      presentFields.push(field);
    }
  }

  const followersCount = asNumber(pick(item, FIELD_ALIASES.followersCount));
  const followsCount = asNumber(pick(item, FIELD_ALIASES.followsCount));
  const postsCount = asNumber(pick(item, FIELD_ALIASES.postsCount));
  const biography = asString(pick(item, FIELD_ALIASES.biography));
  const externalUrls = readExternalUrls(item);
  const externalUrl = externalUrls[0] ?? null;
  const businessAddress = readBusinessAddress(item);
  const location = asString(pick(item, FIELD_ALIASES.location)) ?? businessAddress.city;
  const postsInfo = readLatestPosts(item);

  return {
    username,
    instagramUsername: username,
    profileUrl: `https://www.instagram.com/${username}/`,
    fullName: asString(pick(item, FIELD_ALIASES.fullName)),
    biography,
    category: asString(pick(item, FIELD_ALIASES.businessCategoryName)),
    businessCategoryName: asString(pick(item, FIELD_ALIASES.businessCategoryName)),
    location,
    followers: followersCount,
    followersCount,
    followsCount,
    postsCount,
    externalUrl,
    website: externalUrl,
    email: asString(pick(item, FIELD_ALIASES.email)),
    phone: asString(pick(item, FIELD_ALIASES.phone)),
    businessAddress: businessAddress.city || businessAddress.address
      ? {
          city_name: businessAddress.city ?? undefined,
          street_address: businessAddress.address ?? undefined,
        }
      : null,
    latestPosts: postsInfo.posts,
    lastPostAt: postsInfo.lastPostAt,
    recentLikesAvg: postsInfo.likeAvg,
    recentCommentsAvg: postsInfo.commentAvg,
    engagementRate: computeEngagementRate(followersCount, postsInfo.likeAvg, postsInfo.commentAvg),
    isBusinessAccount: asBoolean(pick(item, FIELD_ALIASES.isBusinessAccount)),
    verified: asBoolean(pick(item, FIELD_ALIASES.verified)),
    isPrivate: asBoolean(pick(item, FIELD_ALIASES.isPrivate)),
    sourceProvider: "instagram_scraper",
    handleSource: "instagram_search",
    handleConfidence: "high",
    presentFields,
    missingFields,
  } as MappedInstagramProfile;
}

/**
 * Place search results are used as a location signal only; they are NOT
 * business listings and never carry Maps phone/rating/review semantics.
 */
export function mapInstagramPlaceSignal(item: unknown): MappedPlaceSignal | null {
  if (!isRecord(item)) return null;
  const name = asString(item.name) ?? asString(item.title) ?? asString(item.fullName);
  const address = asString(item.address) ?? asString(item.location_address);
  const city = asString(item.city);
  const category = asString(item.category) ?? asString(item.categoryName);
  const latitude = asNumber(pick(item, FIELD_ALIASES.latitude));
  const longitude = asNumber(pick(item, FIELD_ALIASES.longitude));
  const username = normalizeUsernameFromRaw(item.username ?? item.instagram);

  if (!name && !address && !city && !username) return null;

  const presentFields = Object.entries({ name, address, city, category, latitude, longitude, username })
    .filter(([, value]) => value !== null)
    .map(([key]) => key);

  return {
    kind: "place",
    name,
    address,
    city,
    category,
    latitude,
    longitude,
    username,
    presentFields,
  };
}

/**
 * Development-only diagnostic: which expected fields were absent in a real run.
 * Logs field NAMES only (never values, URLs, tokens, or credentials).
 */
export function summarizeMissingFields(profiles: MappedInstagramProfile[]): void {
  if (process.env.NODE_ENV === "production" || profiles.length === 0) return;
  const counts = new Map<string, number>();
  for (const profile of profiles) {
    for (const field of profile.missingFields) {
      counts.set(field, (counts.get(field) ?? 0) + 1);
    }
  }
  const summary = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([field, count]) => `${field}:${count}`)
    .join(" ");
  if (summary) {
    console.log(`[IG-ALL-IN-ONE] absent expected fields (${profiles.length} items): ${summary}`);
  }
}
