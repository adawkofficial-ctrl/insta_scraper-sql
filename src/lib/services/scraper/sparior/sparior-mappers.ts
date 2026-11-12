import type { LeadProfile } from "@/lib/types";
import type { DiscoveredProfile } from "@/lib/services/discovery/discovery-provider";
import type { SpariorRawProfile, SpariorRawSearchItem } from "./sparior-types";
import {
  detectSocialPlatform,
  cleanBusinessWebsite,
} from "@/lib/constants/social-platforms";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-zA-Z0-9._]{1,30}$/;

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const cleaned = String(raw).trim().replace(/^@+/, "").toLowerCase();
  if (cleaned.length === 0 || !USERNAME_REGEX.test(cleaned)) {
    return null;
  }
  return cleaned;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw.trim().toLowerCase();
  if (!EMAIL_REGEX.test(cleaned)) {
    return null;
  }
  return cleaned;
}

export function normalizeWebsite(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export function parseNumber(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.round(raw) : null;
  }
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim().toUpperCase().replace(/,/g, "");
  if (trimmed.length === 0) {
    return null;
  }

  const multiplierMatch = trimmed.match(/^([\d.]+)\s*([KMGT]?)$/);
  if (!multiplierMatch) {
    const parsed = parseFloat(trimmed);
    return isNaN(parsed) ? null : Math.round(parsed);
  }

  const base = parseFloat(multiplierMatch[1]);
  if (isNaN(base)) {
    return null;
  }

  const unit = multiplierMatch[2];
  let multiplier = 1;
  if (unit === "K") multiplier = 1_000;
  else if (unit === "M") multiplier = 1_000_000;
  else if (unit === "G") multiplier = 1_000_000_000;
  else if (unit === "T") multiplier = 1_000_000_000_000;

  return Math.round(base * multiplier);
}

export function mapSpariorProfileToLeadProfile(
  raw: unknown,
): LeadProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as SpariorRawProfile;
  const username = normalizeUsername(record.username);
  if (!username) {
    return null;
  }

  const instagramId =
    record.id !== undefined && record.id !== null
      ? String(record.id)
      : record.pk !== undefined && record.pk !== null
      ? String(record.pk)
      : null;

  const fullName =
    typeof record.full_name === "string"
      ? record.full_name.trim() || null
      : typeof record.fullName === "string"
      ? record.fullName.trim() || null
      : null;

  const biography =
    typeof record.biography === "string"
      ? record.biography.trim() || null
      : typeof record.bio === "string"
      ? record.bio.trim() || null
      : null;

  let followersCandidate: unknown =
    record.followers ?? record.follower_count ?? record.followers_count;
  if (
    followersCandidate === undefined &&
    typeof record.social_context === "string"
  ) {
    const scMatch = record.social_context.match(/([\d.]+\s*[KMGT]?)\s*followers/i);
    if (scMatch) {
      followersCandidate = scMatch[1];
    }
  }
  const followers = parseNumber(followersCandidate);
  const following = parseNumber(
    record.following ?? record.following_count,
  );
  const postsCount = parseNumber(
    record.posts_count ?? record.media_count,
  );

  const profilePictureUrl =
    typeof record.profile_pic_url_hd === "string" && record.profile_pic_url_hd.trim()
      ? record.profile_pic_url_hd.trim()
      : typeof record.profile_pic_url === "string" && record.profile_pic_url.trim()
      ? record.profile_pic_url.trim()
      : typeof record.profile_pic === "string" && record.profile_pic.trim()
      ? record.profile_pic.trim()
      : typeof record.profilePicUrl === "string" && record.profilePicUrl.trim()
      ? record.profilePicUrl.trim()
      : null;

  const isVerified =
    typeof record.is_verified === "boolean"
      ? record.is_verified
      : typeof record.verified === "boolean"
      ? record.verified
      : null;

  const isBusiness =
    typeof record.is_business === "boolean"
      ? record.is_business
      : typeof record.is_business_account === "boolean"
      ? record.is_business_account
      : null;

  const isPrivate =
    typeof record.is_private === "boolean" ? record.is_private : null;

  const category =
    typeof record.category === "string" && record.category.trim()
      ? record.category.trim()
      : typeof record.category_name === "string" && record.category_name.trim()
      ? record.category_name.trim()
      : typeof record.business_category_name === "string" &&
        record.business_category_name.trim()
      ? record.business_category_name.trim()
      : null;

  const externalUrl = normalizeWebsite(
    record.external_url ?? record.website,
  );
  const detectedSocial = detectSocialPlatform(externalUrl);
  const isSocial = Boolean(detectedSocial);
  const cleanWebsite = isSocial ? null : cleanBusinessWebsite(externalUrl);

  const email = normalizeEmail(record.email ?? record.public_email);
  const phone =
    typeof record.phone === "string" && record.phone.trim()
      ? record.phone.trim()
      : typeof record.public_phone_number === "string" &&
        record.public_phone_number.trim()
      ? record.public_phone_number.trim()
      : null;

  const location =
    typeof record.location === "string" && record.location.trim()
      ? record.location.trim()
      : typeof record.city_name === "string" && record.city_name.trim()
      ? record.city_name.trim()
      : typeof record.address_street === "string" && record.address_street.trim()
      ? record.address_street.trim()
      : null;

  return {
    username,
    profileUrl: `https://www.instagram.com/${username}/`,
    instagramId,
    instagramUserId: instagramId,
    fullName,
    biography,
    bio: biography,
    followers,
    following,
    followersCount: followers,
    followsCount: following,
    postsCount,
    profilePictureUrl,
    profilePicUrl: profilePictureUrl,
    profilePicUrlHD: profilePictureUrl,
    isVerified,
    verified: isVerified,
    isBusiness,
    isBusinessAccount: isBusiness,
    isPrivate,
    category,
    businessCategoryName: category,
    externalUrl,
    website: isSocial ? null : cleanWebsite?.url ?? null,
    socialLink: isSocial ? detectedSocial?.url ?? externalUrl : null,
    socialPlatform: isSocial ? detectedSocial?.platform ?? null : null,
    email,
    phone,
    location,
    relatedProfiles: null,
    latestPosts: null,
    rawProfileData: null,
    raw: record as Record<string, unknown>, // Kept in memory only
    source: "sparior",
    scrapedAt: new Date().toISOString(),
  };
}

export type MappedSearchItem = {
  candidate: DiscoveredProfile | null;
  profile: LeadProfile | null;
  isMalformed: boolean;
  isPrivate: boolean;
};

export function mapSpariorSearchItem(raw: unknown): MappedSearchItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      candidate: null,
      profile: null,
      isMalformed: true,
      isPrivate: false,
    };
  }

  const record = raw as SpariorRawSearchItem;
  // Item can be { username } or { user: { username, ... } }
  const userObj =
    record.user && typeof record.user === "object" ? record.user : record;

  const username = normalizeUsername(userObj.username);
  if (!username) {
    return {
      candidate: null,
      profile: null,
      isMalformed: true,
      isPrivate: false,
    };
  }

  const isPrivate =
    typeof userObj.is_private === "boolean" ? userObj.is_private : false;

  const profile = mapSpariorProfileToLeadProfile(userObj);

  const candidate: DiscoveredProfile = {
    username,
    profileUrl:
      typeof userObj.profile_url === "string" && userObj.profile_url.startsWith("http")
        ? userObj.profile_url.trim()
        : `https://www.instagram.com/${username}/`,
    fullName: profile?.fullName ?? (typeof userObj.full_name === "string" ? userObj.full_name : null),
    biography: profile?.biography ?? (typeof userObj.biography === "string" ? userObj.biography : null),
    category: profile?.category ?? (typeof userObj.category === "string" ? userObj.category : null),
    businessCategoryName:
      profile?.businessCategoryName ??
      (typeof userObj.business_category_name === "string" ? userObj.business_category_name : null),
    location: profile?.location ?? null,
    followers: profile?.followers ?? null,
    followersCount:
      profile?.followersCount ??
      (typeof userObj.follower_count === "number" ? userObj.follower_count : null),
    externalUrl:
      profile?.externalUrl ??
      profile?.website ??
      (typeof userObj.external_url === "string" ? userObj.external_url : null),
    website: profile?.website ?? null,
    latestPosts: profile?.latestPosts ?? null,
  };

  return {
    candidate,
    profile,
    isMalformed: false,
    isPrivate,
  };
}
