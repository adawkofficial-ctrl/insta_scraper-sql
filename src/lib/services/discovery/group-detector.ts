/**
 * Pure Multi-Location Group Detector and Group Key resolver.
 * Detects practices/businesses belonging to the same group by:
 * - Shared website domain
 * - Shared Instagram handle
 * - Shared non-generic email domain
 * - Location-suffixed emails (e.g. ajax@bythelakedental.com, oshawa@...)
 */

import { extractDomainParts } from "./name-website-matcher";

export const GENERIC_EMAIL_DOMAINS = new Set<string>([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "live.com",
  "msn.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "mail.com",
  "gmx.com",
  "ymail.com",
]);

/**
 * Common city/suburb/location indicators found as email prefixes in multi-location businesses.
 */
export const LOCATION_EMAIL_PREFIXES = new Set<string>([
  "ajax",
  "oshawa",
  "whitby",
  "pickering",
  "toronto",
  "scarborough",
  "northyork",
  "etobicoke",
  "markham",
  "vaughan",
  "richmondhill",
  "mississauga",
  "brampton",
  "oakville",
  "burlington",
  "milton",
  "hamilton",
  "london",
  "ottawa",
  "waterloo",
  "kitchener",
  "cambridge",
  "guelph",
  "barrie",
  "calgary",
  "edmonton",
  "vancouver",
  "burnaby",
  "richmond",
  "surrey",
  "downtown",
  "uptown",
  "midtown",
  "east",
  "west",
  "north",
  "south",
  "central",
]);

export type GroupDetectInput = {
  id?: string;
  website?: string | null;
  username?: string | null;
  instagramUsername?: string | null;
  email?: string | null;
  fullName?: string | null;
};

export type GroupDetectionOutcome = {
  isGroup: boolean;
  groupKey: string | null;
  matchedBy?: "domain" | "handle" | "email_domain" | "location_email";
};

/**
 * Normalizes email and extracts user prefix and host domain.
 */
export function parseEmailParts(email?: string | null): {
  prefix: string;
  domain: string;
} | null {
  if (!email || typeof email !== "string" || !email.includes("@")) return null;
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return null;
  const prefix = parts[0].trim();
  const domain = parts[1].trim();
  if (!prefix || !domain) return null;
  return { prefix, domain };
}

/**
 * Checks if an email prefix indicates a location-specific branch.
 */
export function isLocationEmailPrefix(prefix: string): boolean {
  const clean = prefix.toLowerCase().replace(/[^a-z]/g, "");
  if (LOCATION_EMAIL_PREFIXES.has(clean)) return true;
  for (const loc of LOCATION_EMAIL_PREFIXES) {
    if (clean.startsWith(loc) || clean.endsWith(loc)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the candidate group key for a single entity.
 */
export function resolveSingleGroupKey(input: GroupDetectInput): {
  groupKey: string | null;
  hasLocationEmail: boolean;
} {
  const domainParts = extractDomainParts(input.website);
  const handle = (input.username || input.instagramUsername || "").trim().toLowerCase();
  const emailParts = parseEmailParts(input.email);

  let hasLocationEmail = false;
  if (emailParts && isLocationEmailPrefix(emailParts.prefix)) {
    hasLocationEmail = true;
  }

  if (domainParts?.domain) {
    return { groupKey: `domain:${domainParts.domain}`, hasLocationEmail };
  }

  if (handle) {
    return { groupKey: `handle:${handle}`, hasLocationEmail };
  }

  if (emailParts && !GENERIC_EMAIL_DOMAINS.has(emailParts.domain)) {
    return { groupKey: `email_domain:${emailParts.domain}`, hasLocationEmail };
  }

  return { groupKey: null, hasLocationEmail };
}

/**
 * Clusters a batch of leads/places into multi-location groups.
 * Marks isGroup = true and assigns groupKey if:
 * 1) More than one lead shares the same groupKey, OR
 * 2) A lead has a location-suffixed email (e.g. ajax@bythelakedental.com)
 */
export function clusterMultiLocationGroups<T extends GroupDetectInput>(
  items: T[],
): Map<T, GroupDetectionOutcome> {
  const resultMap = new Map<T, GroupDetectionOutcome>();

  // Count occurrences of each group key
  const keyToItems = new Map<string, T[]>();

  for (const item of items) {
    const { groupKey } = resolveSingleGroupKey(item);
    if (groupKey) {
      const list = keyToItems.get(groupKey) ?? [];
      list.push(item);
      keyToItems.set(groupKey, list);
    }
  }

  for (const item of items) {
    const { groupKey, hasLocationEmail } = resolveSingleGroupKey(item);
    const sharedCount = groupKey ? (keyToItems.get(groupKey)?.length ?? 0) : 0;

    if (sharedCount > 1) {
      resultMap.set(item, {
        isGroup: true,
        groupKey: groupKey!,
        matchedBy: groupKey?.startsWith("domain:")
          ? "domain"
          : groupKey?.startsWith("handle:")
            ? "handle"
            : "email_domain",
      });
    } else if (hasLocationEmail && groupKey) {
      resultMap.set(item, {
        isGroup: true,
        groupKey,
        matchedBy: "location_email",
      });
    } else {
      resultMap.set(item, {
        isGroup: false,
        groupKey: groupKey ?? null,
      });
    }
  }

  return resultMap;
}

