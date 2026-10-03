/**
 * Pure identity-normalization helpers for deduplication. No DB, no I/O.
 *
 * All functions are deterministic and side-effect free so they can be unit
 * tested in isolation and reused by ingestion, backfill and reporting.
 */

import {
  INSTAGRAM_HOST_SUFFIXES,
  MAILBOX_PROVIDER_DOMAINS,
  SHARED_PLATFORM_DOMAINS,
} from "./dedup-constants";

/** Instagram usernames: letters, digits, dot, underscore; 1-30 chars. */
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;
/** Pragmatic email shape check (not RFC-perfect; intentional). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalizes an Instagram username or profile URL to the canonical handle:
 * lowercase, no leading "@", no surrounding URL/query/trailing slash.
 * Returns null when the value cannot be a valid handle.
 */
export function normalizeUsername(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  let value = raw.trim();
  if (value.length === 0) return null;

  // Unwrap instagram.com URLs (with or without scheme).
  const urlMatch = value.match(
    /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/([^/?#\s]+)/i,
  );
  if (urlMatch) {
    value = urlMatch[1];
  }

  value = value
    .split(/[?#]/)[0]
    .replace(/^@+/, "")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();

  return USERNAME_PATTERN.test(value) ? value : null;
}

/** Canonical public profile URL for a normalized username. */
export function canonicalProfileUrl(usernameNormalized: string): string {
  return `https://www.instagram.com/${usernameNormalized}/`;
}

/**
 * Normalizes an email for EXACT matching. Lowercases and trims only; it does
 * NOT strip "+tags" or dots (that would over-merge distinct people).
 * Returns null when the shape is invalid.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 254) return null;
  return EMAIL_PATTERN.test(value) ? value : null;
}

export type NormalizedWebsite = {
  /** Registrable-ish hostname (www stripped), or null when unusable. */
  domain: string | null;
  /** Dedup key; null when the website must not be used for matching. */
  key: string | null;
};

function hostnameOf(raw: string): string | null {
  let value = raw.trim();
  if (value.length === 0) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * Normalizes a website URL to { domain, key }.
 *
 * - Shared platforms (linktr.ee, beacons.ai, …) key on `domain/firstSegment`;
 *   a bare shared domain yields key = null so unrelated people never merge.
 * - Mailbox providers (gmail.com, …) yield key = null (email matching only).
 * - Other domains key on the bare domain.
 */
export function normalizeWebsite(raw: string | null | undefined): NormalizedWebsite | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0) return null;

  const hostname = hostnameOf(value);
  if (!hostname) return null;

  // Extract the first path segment from the original (best-effort).
  let firstSegment: string | null = null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(withScheme);
    const segment = url.pathname.split("/").filter(Boolean)[0];
    if (segment) firstSegment = segment.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  } catch {
    firstSegment = null;
  }

  if (MAILBOX_PROVIDER_DOMAINS.has(hostname)) {
    return { domain: hostname, key: null };
  }

  if (SHARED_PLATFORM_DOMAINS.has(hostname)) {
    return {
      domain: hostname,
      key: firstSegment ? `${hostname}/${firstSegment}` : null,
    };
  }

  return { domain: hostname, key: hostname };
}

/** True when the website host is a shared platform (bare domain is unsafe). */
export function isSharedPlatform(domain: string | null): boolean {
  return domain !== null && SHARED_PLATFORM_DOMAINS.has(domain);
}

/** Extracts a normalized username from any profile URL, or null. */
export function usernameFromProfileUrl(profileUrl: string | null | undefined): string | null {
  if (typeof profileUrl !== "string") return null;
  const isInstagram = INSTAGRAM_HOST_SUFFIXES.some((host) =>
    profileUrl.toLowerCase().includes(host),
  );
  if (!isInstagram) return null;
  return normalizeUsername(profileUrl);
}
