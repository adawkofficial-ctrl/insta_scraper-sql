import {
  extractEmail,
  extractPhone,
  normalizeEmail,
  normalizePhone,
  normalizeWebsite,
  computeAvailableChannels,
} from "../contact/contact-parser";
import { isSocialOrSharedPlatform } from "@/lib/constants/social-platforms";
import type { LeadProfile } from "@/lib/types";

export type WebsiteContactResult = {
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  website: string;
  websiteDomain: string | null;
  contactSource: "website_fallback" | null;
};

const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Strips HTML tags and script/style content to extract visible text.
 */
export function extractTextFromHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds contact or about subpage links within HTML matching the target domain.
 */
export function findContactSubpageUrls(html: string, baseUrl: string): string[] {
  const subpages: string[] = [];
  const linkRegex = /href=["']([^"'#\s]+)["']/gi;
  let match: RegExpExecArray | null;

  let baseObj: URL;
  try {
    baseObj = new URL(baseUrl);
  } catch {
    return [];
  }

  const seen = new Set<string>();

  while ((match = linkRegex.exec(html)) !== null) {
    const rawHref = match[1];
    if (
      !/(?:contact|about|touch|reach|location)/i.test(rawHref) ||
      /\.(pdf|zip|png|jpe?g|gif|mp4|css|js)$/i.test(rawHref)
    ) {
      continue;
    }

    try {
      const resolved = new URL(rawHref, baseObj.origin);
      // Ensure same domain (avoid external social links or partners)
      const resolvedDomain = resolved.hostname.toLowerCase().replace(/^www\./, "");
      const baseDomain = baseObj.hostname.toLowerCase().replace(/^www\./, "");
      if (resolvedDomain === baseDomain && !seen.has(resolved.href)) {
        seen.add(resolved.href);
        subpages.push(resolved.href);
        if (subpages.length >= 2) break; // max 2 candidate subpages
      }
    } catch {
      // ignore malformed URLs
    }
  }

  return subpages;
}

/**
 * Extracts contacts from raw HTML content.
 */
export function extractContactsFromHtml(html: string): {
  email: string | null;
  phone: string | null;
} {
  // 1. Look for mailto: links in HTML
  let email = extractEmail(html);
  // 2. Look for tel: links in HTML
  let phone = extractPhone(html);

  // If not found in raw markup, try visible text
  if (!email || !phone) {
    const visibleText = extractTextFromHtml(html);
    if (!email) {
      email = extractEmail(visibleText);
    }
    if (!phone) {
      phone = extractPhone(visibleText);
    }
  }

  return { email, phone };
}

/**
 * Lightweight, reusable fallback contact scraper for external websites.
 * Bounded with short timeout (8-10s) and at most 1 homepage + 1 contact/about subpage fetch.
 */
export async function extractContactsFromWebsite(
  rawUrl: string,
  options?: { timeoutMs?: number },
): Promise<WebsiteContactResult> {
  if (!rawUrl || isSocialOrSharedPlatform(rawUrl)) {
    return {
      email: null,
      emailNormalized: null,
      phone: null,
      phoneNormalized: null,
      website: rawUrl ?? "",
      websiteDomain: null,
      contactSource: null,
    };
  }

  const norm = normalizeWebsite(rawUrl);
  if (!norm || isSocialOrSharedPlatform(norm.domain)) {
    return {
      email: null,
      emailNormalized: null,
      phone: null,
      phoneNormalized: null,
      website: norm?.rootUrl ?? rawUrl,
      websiteDomain: norm?.domain ?? null,
      contactSource: null,
    };
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  let email: string | null = null;
  let phone: string | null = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(norm.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    clearTimeout(timer);

    if (res.ok) {
      const html = await res.text();
      const extracted = extractContactsFromHtml(html);
      email = extracted.email;
      phone = extracted.phone;

      // If either email or phone is missing, try 1 linked contact/about page
      if (!email || !phone) {
        const subpages = findContactSubpageUrls(html, norm.url);
        if (subpages.length > 0) {
          const subpageUrl = subpages[0];
          try {
            const subController = new AbortController();
            const subTimer = setTimeout(() => subController.abort(), timeoutMs);
            const subRes = await fetch(subpageUrl, {
              signal: subController.signal,
              headers: {
                "User-Agent": USER_AGENT,
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              },
              redirect: "follow",
            });
            clearTimeout(subTimer);

            if (subRes.ok) {
              const subHtml = await subRes.text();
              const subExtracted = extractContactsFromHtml(subHtml);
              if (!email && subExtracted.email) email = subExtracted.email;
              if (!phone && subExtracted.phone) phone = subExtracted.phone;
            }
          } catch {
            // subpage failure is non-fatal
          }
        }
      }
    }
  } catch (err) {
    // Non-fatal: website might be unreachable, timed out, or blocked
    if (process.env.NODE_ENV !== "production") {
      console.log(`[WebsiteFallback] fetch failed for ${norm.url}:`, (err as Error).message);
    }
  }

  const emailNormalized = normalizeEmail(email);
  const phoneNormalized = normalizePhone(phone);
  const foundAny = Boolean(emailNormalized || phoneNormalized);

  return {
    email: email ?? null,
    emailNormalized,
    phone: phone ?? null,
    phoneNormalized,
    website: norm.rootUrl ?? norm.url,
    websiteDomain: norm.domain,
    contactSource: foundAny ? "website_fallback" : null,
  };
}

/**
 * Bounded orchestration for enriching a list of lead profiles with website fallback.
 * Only attempts fetch for leads that have a website but NO email and NO phone.
 * Enforces per-run cap (env WEBSITE_FALLBACK_MAX_PER_RUN or requestedLimit + buffer).
 */
export async function enrichProfilesWithWebsiteFallback(
  profiles: LeadProfile[],
  options?: {
    maxFetches?: number;
    timeoutMs?: number;
  },
): Promise<{
  enrichedProfiles: LeadProfile[];
  fetchesAttempted: number;
  contactsFound: number;
}> {
  const envCap = process.env.WEBSITE_FALLBACK_MAX_PER_RUN
    ? Number.parseInt(process.env.WEBSITE_FALLBACK_MAX_PER_RUN, 10)
    : undefined;
  const maxFetches = options?.maxFetches ?? envCap ?? 15;

  let fetchesAttempted = 0;
  let contactsFound = 0;

  for (const profile of profiles) {
    const hasEmail = Boolean(profile.email && profile.email.trim().length > 0);
    const hasPhone = Boolean(profile.phone && profile.phone.trim().length > 0);
    const targetUrl =
      profile.website && !isSocialOrSharedPlatform(profile.website)
        ? profile.website
        : !profile.website && profile.externalUrl && !isSocialOrSharedPlatform(profile.externalUrl)
          ? profile.externalUrl
          : null;

    // Only attempt website fallback if candidate has a genuine website but NO contact info yet
    if (!hasEmail && !hasPhone && targetUrl && targetUrl.trim().length > 0) {
      if (fetchesAttempted >= maxFetches) {
        if (process.env.NODE_ENV !== "production") {
          console.log(`[WebsiteFallback] reached maxFetches cap (${maxFetches}), stopping fallback`);
        }
        break;
      }

      fetchesAttempted++;
      try {
        const result = await extractContactsFromWebsite(targetUrl, {
          timeoutMs: options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        });

        if (result.emailNormalized || result.phoneNormalized) {
          contactsFound++;
          if (result.email && !profile.email) {
            profile.email = result.email;
          }
          if (result.phone && !profile.phone) {
            profile.phone = result.phone;
          }
          if (result.phoneNormalized) {
            profile.phoneNormalized = result.phoneNormalized;
          }
          profile.contactSource = "website_fallback";
        }
      } catch {
        // Non-fatal
      }
    }

    // Always ensure availableChannels is computed
    profile.availableChannels = computeAvailableChannels({
      hasInstagram: true,
      email: profile.email,
      phone: profile.phone,
    });
  }

  return {
    enrichedProfiles: profiles,
    fetchesAttempted,
    contactsFound,
  };
}
