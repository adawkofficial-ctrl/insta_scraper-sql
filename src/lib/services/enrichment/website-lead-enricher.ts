import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { LeadStatus, Prisma } from "@/generated/prisma/client";
import {
  computeAvailableChannels,
  extractAllEmails,
  extractAllPhones,
  normalizeEmail,
  normalizePhoneToE164,
  normalizeWebsite,
} from "../contact/contact-parser";
import {
  getSocialPlatformLabel,
  isSocialOrSharedPlatform,
} from "@/lib/constants/social-platforms";
import { resolveCountryCode } from "../discovery/country-cities";
import { safeFetchHtml } from "../discovery/handle-discovery-waterfall";
import { checkNameWebsiteMismatch } from "../discovery/name-website-matcher";
import { computeLeadScore } from "../discovery/lead-quality-score";
import { scoreFlagReplace, withLeadChannelFlags } from "../lead/lead-channels";

// ============================================================================
// Types
// ============================================================================

export type WebsiteFetchResult = {
  ok: boolean;
  html?: string;
  finalUrl?: string;
  status?: number | null;
  error?: string;
};

export type WebsiteFetchFn = (
  url: string,
  timeoutMs: number,
) => Promise<WebsiteFetchResult>;

export type WebsiteSocialLinks = {
  instagram?: string | null;
  facebook?: string | null;
  tiktok?: string | null;
  youtube?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
  pinterest?: string | null;
  whatsapp?: string | null;
  googleBusiness?: string | null;
  yelp?: string | null;
};

export type WebsiteEmail = {
  value: string;
  normalized: string;
  source: "mailto" | "text" | "jsonld" | "cloudflare" | "obfuscated";
  sourceUrl: string;
  generic: boolean;
};

export type WebsitePhone = {
  value: string;
  normalized: string;
  source: "tel" | "text" | "jsonld";
  sourceUrl: string;
};

export type WebsitePageDiagnostic = {
  url: string;
  requestedUrl: string;
  ok: boolean;
  status: number | null;
  finalUrl: string | null;
  anchors: number;
  instagramProfiles: string[];
  ignoredInstagramPaths: string[];
  emails: string[];
  phones: string[];
  socials: string[];
  error?: string;
};

export type WebsiteScrapeResult = {
  website: string;
  domain: string | null;
  pages: WebsitePageDiagnostic[];
  handle: string | null;
  handleConfidence: "high" | "medium" | "low" | null;
  alternates: string[];
  socialLinks: WebsiteSocialLinks;
  emails: WebsiteEmail[];
  phones: WebsitePhone[];
  whatsapp: string | null;
  socialOnly: boolean;
  fetchedAt: string;
  homepageHtml: string | null;
  homepageTitle: string | null;
  homepageH1: string | null;
  ogSiteName: string | null;
};

export type WebsiteEnrichmentOptions = {
  fetchFn?: WebsiteFetchFn;
  timeoutMs?: number;
  maxSubpages?: number;
  countryCode?: string;
  businessName?: string | null;
  allowLinkHub?: boolean;
};

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_SUBPAGES = 4;

const NON_PROFILE_IG_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "stories",
  "story",
  "highlights",
  "explore",
  "accounts",
  "direct",
  "share",
  "sharer",
  "developer",
  "developers",
  "legal",
  "about",
  "api",
  "oauth",
  "session",
  "challenge",
  "invite",
  "web",
  "static",
  "emojis",
  "ar",
  "s",
  "audio",
  "music",
  "locations",
  "directory",
  "catalog",
]);

const GENERIC_EMAIL_LOCALS = new Set([
  "info",
  "contact",
  "hello",
  "office",
  "admin",
  "support",
  "sales",
  "team",
  "enquiries",
  "inquiries",
  "reception",
  "frontdesk",
  "appointments",
  "booking",
  "clinic",
]);

const JUNK_EMAIL_LOCALS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "postmaster",
  "abuse",
  "privacy",
  "unsubscribe",
]);

const JUNK_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "domain.com",
  "email.com",
  "yourdomain.com",
  "sentry.io",
  "wixpress.com",
  "sentry-next.wixpress.com",
  "wordpress.com",
  "placeholder.com",
]);

const IMAGE_FILE_EMAIL = /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i;

const CONTACT_SUBPAGE_PATHS = [
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
] as const;

const SUBPAGE_KEYWORD = /contact|about|team|location|follow/i;

// ============================================================================
// Rate limiting (2 requests/second per host) + concurrency helper
// ============================================================================

const hostLastRequestAt = new Map<string, number>();
const HOST_MIN_GAP_MS = 500;

export function __resetWebsiteRateLimiterForTesting(): void {
  hostLastRequestAt.clear();
}

type WebsiteScraperMock = (input: {
  website: string;
  businessName?: string | null;
  countryCode?: string;
}) => Promise<Partial<WebsiteScrapeResult>>;

let mockScraper: WebsiteScraperMock | null = null;

export function setMockWebsiteScraperForTesting(
  mock: WebsiteScraperMock | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "setMockWebsiteScraperForTesting is test-only and requires NODE_ENV=test.",
    );
  }
  mockScraper = mock;
}

async function waitForHostSlot(hostname: string): Promise<void> {
  const now = Date.now();
  const last = hostLastRequestAt.get(hostname) ?? 0;
  const wait = Math.max(0, HOST_MIN_GAP_MS - (now - last));
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  hostLastRequestAt.set(hostname, Date.now());
}

export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ============================================================================
// Fetch with retry + SSRF-safe redirects
// ============================================================================

function canonicalWithoutQuery(rawUrl: string): string | null {
  try {
    const parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    if (!parsed.search) return null;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

async function defaultFetch(
  url: string,
  timeoutMs: number,
): Promise<WebsiteFetchResult> {
  const result = await safeFetchHtml(url, timeoutMs, 3);
  return {
    ok: result.ok,
    html: result.html,
    finalUrl: result.finalUrl,
    error: result.error,
    status: result.ok ? 200 : null,
  };
}

export async function fetchWebsitePage(
  rawUrl: string,
  options?: {
    fetchFn?: WebsiteFetchFn;
    timeoutMs?: number;
  },
): Promise<WebsiteFetchResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options?.fetchFn ?? defaultFetch;

  let url = rawUrl;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  try {
    const host = new URL(url).hostname.toLowerCase();
    await waitForHostSlot(host);
  } catch {
    return { ok: false, error: "Malformed URL", status: null };
  }

  const first = await fetcher(url, timeoutMs);
  if (first.ok && first.html) return first;

  // Exactly one retry: prefer the query-less URL (utm_* params often trigger
  // WAFs), otherwise retry the same URL on a timeout/transient network error.
  const canonical = canonicalWithoutQuery(url);
  const isTimeout =
    Boolean(first.error) &&
    /timeout|abort|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up/i.test(first.error ?? "");
  const retryUrl = canonical && canonical !== url ? canonical : isTimeout ? url : null;
  if (!retryUrl) return first;

  try {
    const host = new URL(retryUrl).hostname.toLowerCase();
    await waitForHostSlot(host);
  } catch {
    // ignore
  }
  const retry = await fetcher(retryUrl, timeoutMs);
  return retry.ok && retry.html ? retry : retry.error ? retry : first;
}

// ============================================================================
// HTML decoding helpers
// ============================================================================

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#64;/gi, "@")
    .replace(/&#46;/gi, ".");
}

export function decodeCloudflareEmail(encoded: string): string | null {
  try {
    const bytes = encoded.match(/.{2}/g);
    if (!bytes || bytes.length < 2) return null;
    const key = parseInt(bytes[0], 16);
    const decoded = bytes
      .slice(1)
      .map((byte) => String.fromCharCode(parseInt(byte, 16) ^ key))
      .join("");
    return decoded.includes("@") ? decoded.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function decodeObfuscatedEmails(text: string): string[] {
  const results: string[] = [];
  const normalizedText = decodeHtmlEntities(text);
  const patterns = [
    /([a-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\}|\sat\s)\s*([a-z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s)\s*([a-z]{2,})/gi,
    /([a-z0-9._%+-]+)\s*@\s*([a-z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s)\s*([a-z]{2,})/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalizedText)) !== null) {
      const candidate = `${match[1]}@${match[2]}.${match[3]}`.toLowerCase();
      const normalized = normalizeEmail(candidate);
      if (normalized) results.push(normalized);
    }
  }
  return results;
}

export function isJunkWebsiteEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return true;
  const [local, domain] = normalized.split("@");
  if (!local || !domain) return true;
  if (IMAGE_FILE_EMAIL.test(normalized)) return true;
  if (JUNK_EMAIL_LOCALS.has(local)) return true;
  if (JUNK_EMAIL_DOMAINS.has(domain)) return true;
  if (domain.endsWith(".wixpress.com") || domain.endsWith(".sentry.io")) return true;
  return false;
}

function isGenericEmail(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return GENERIC_EMAIL_LOCALS.has(local);
}

function extractVisibleText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/www\.\S+/gi, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function extractPageMeta(html: string): {
  title: string | null;
  h1: string | null;
  ogSiteName: string | null;
} {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, " ").trim() ?? null;
  const ogSiteName =
    /<meta\b[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1]?.trim() ??
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i.exec(html)?.[1]?.trim() ??
    null;
  return { title, h1, ogSiteName };
}

// ============================================================================
// Extraction
// ============================================================================

type Anchor = { href: string; text: string; tag: string; inHeaderFooter: boolean };

export function extractAnchors(html: string): Anchor[] {
  const headerMatch = /<header[\s\S]*?<\/header>/i.exec(html);
  const footerMatch = /<footer[\s\S]*?<\/footer>/i.exec(html);
  const navMatch = /<nav[\s\S]*?<\/nav>/i.exec(html);
  const prominent = `${headerMatch?.[0] ?? ""}${footerMatch?.[0] ?? ""}${navMatch?.[0] ?? ""}`;

  const anchors: Anchor[] = [];
  const anchorRegex =
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!hrefMatch) continue;
    const href = decodeHtmlEntities((hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "").trim());
    if (!href) continue;
    const text = body
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const tag = match[0];
    anchors.push({
      href,
      text,
      tag,
      inHeaderFooter:
        prominent.includes(tag) ||
        /class=["'][^"']*(?:social|footer|header|nav)[^"']*["']/i.test(tag) ||
        /id=["'][^"']*(?:social|footer|header|nav)[^"']*["']/i.test(tag),
    });
  }
  return anchors;
}

function resolveHref(href: string, pageUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(?:mailto|tel|sms|javascript|data):/i.test(trimmed)) return null;
  if (trimmed.startsWith("#")) return null;
  try {
    const base = new URL(pageUrl);
    if (trimmed.startsWith("//")) {
      return new URL(`https:${trimmed}`).toString();
    }
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

function cleanInstagramHandle(raw: string): string | null {
  let candidate = raw.trim();
  if (!candidate) return null;
  if (candidate.startsWith("instagram://")) {
    try {
      const parsed = new URL(candidate);
      candidate = parsed.searchParams.get("username") ?? "";
    } catch {
      return null;
    }
  }
  candidate = candidate.replace(/^@+/, "").toLowerCase();
  candidate = candidate.replace(/[/?#].*$/, "");
  if (!/^[a-z0-9._]{1,30}$/.test(candidate)) return null;
  if (candidate.startsWith(".") || candidate.endsWith(".") || candidate.includes("..")) return null;
  if (NON_PROFILE_IG_SEGMENTS.has(candidate)) return null;
  return candidate;
}

function parseInstagramFromUrl(rawUrl: string): { handle: string | null; ignored: boolean } {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith("instagram.com") && !host.endsWith("instagr.am")) {
      return { handle: null, ignored: false };
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return { handle: null, ignored: true };
    const first = decodeURIComponent(segments[0]).toLowerCase();
    if (NON_PROFILE_IG_SEGMENTS.has(first)) return { handle: null, ignored: true };
    if (segments.length > 1 && !["", "profile"].includes(segments[1].toLowerCase())) {
      // /handle/p/... is a post, not a profile link.
      return { handle: null, ignored: true };
    }
    return { handle: cleanInstagramHandle(first), ignored: false };
  } catch {
    return { handle: null, ignored: false };
  }
}

export function canonicalizeSocialUrl(
  rawUrl: string,
  platform: string,
): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    switch (platform) {
      case "facebook": {
        if (!["facebook.com", "fb.com", "fb.me", "m.facebook.com", "web.facebook.com"].includes(host)) {
          return null;
        }
        if (/^\/(?:sharer|share|dialog|plugins|tr|login|help)/i.test(path)) return null;
        if (!path || path === "") return null;
        return `https://www.facebook.com${path}`;
      }
      case "instagram":
        return `https://www.instagram.com/${path.split("/").filter(Boolean)[0] ?? ""}/`;
      case "tiktok": {
        const match = /^\/@([a-z0-9._]+)/i.exec(path);
        return match ? `https://www.tiktok.com/@${match[1].toLowerCase()}` : null;
      }
      case "youtube": {
        if (/\/(?:watch|embed|shorts)\b/i.test(path)) return null;
        return `https://www.youtube.com${path}`;
      }
      case "linkedin": {
        const match = /^\/(company|in|school)\/([^/]+)/i.exec(path);
        return match ? `https://www.linkedin.com/${match[1].toLowerCase()}/${match[2]}` : null;
      }
      case "twitter": {
        const handle = path.split("/").filter(Boolean)[0];
        return handle ? `https://x.com/${handle}` : null;
      }
      case "pinterest": {
        const handle = path.split("/").filter(Boolean)[0];
        if (!handle || handle === "pin") return null;
        return `https://www.pinterest.com/${handle}`;
      }
      case "whatsapp": {
        if (host === "wa.me") {
          const digits = path.replace(/\D/g, "");
          return digits ? `https://wa.me/${digits}` : null;
        }
        if (host.endsWith("whatsapp.com")) {
          const phone = parsed.searchParams.get("phone");
          const digits = (phone ?? path).replace(/\D/g, "");
          return digits ? `https://wa.me/${digits}` : null;
        }
        return null;
      }
      case "googleBusiness": {
        if (host === "g.page" || host === "maps.app.goo.gl") return rawUrl;
        if (host.endsWith("google.com") && /\/maps/i.test(path)) return rawUrl;
        return null;
      }
      case "yelp": {
        if (!host.endsWith("yelp.com") && !host.endsWith("yelp.ca")) return null;
        return `https://www.yelp.com${path}`;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function platformForUrl(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    if (host.endsWith("instagram.com") || host.endsWith("instagr.am")) return "instagram";
    if (["facebook.com", "fb.com", "fb.me", "m.facebook.com", "web.facebook.com"].includes(host)) return "facebook";
    if (host.endsWith("tiktok.com")) return "tiktok";
    if (host.endsWith("youtube.com") || host === "youtu.be") return "youtube";
    if (host.endsWith("linkedin.com")) return "linkedin";
    if (host === "twitter.com" || host === "x.com") return "twitter";
    if (host.endsWith("pinterest.com") || host === "pin.it") return "pinterest";
    if (host === "wa.me" || host.endsWith("whatsapp.com")) return "whatsapp";
    if (host === "g.page" || host === "maps.app.goo.gl" || (host.endsWith("google.com") && rawUrl.includes("/maps"))) {
      return "googleBusiness";
    }
    if (host.endsWith("yelp.com") || host.endsWith("yelp.ca")) return "yelp";
    return null;
  } catch {
    return null;
  }
}

export type WebsiteExtraction = {
  anchors: number;
  instagramProfiles: string[];
  ignoredInstagramPaths: string[];
  handle: string | null;
  alternates: string[];
  socialLinks: WebsiteSocialLinks;
  emails: WebsiteEmail[];
  phones: WebsitePhone[];
  whatsapp: string | null;
  linkHubUrl: string | null;
};

export function extractWebsiteData(
  html: string,
  pageUrl: string,
  options?: {
    businessName?: string | null;
    countryCode?: string;
    domain?: string | null;
  },
): WebsiteExtraction {
  const countryCode = (options?.countryCode || "CA").toUpperCase();
  const anchors = extractAnchors(html);

  const igStats = new Map<string, { frequency: number; prominent: boolean }>();
  const ignoredInstagramPaths: string[] = [];
  const socials: WebsiteSocialLinks = {};

  const recordSocial = (platform: string, rawUrl: string, fromMeta = false) => {
    if (platform === "instagram") {
      const { handle, ignored } = parseInstagramFromUrl(rawUrl);
      if (!handle) {
        if (ignored) ignoredInstagramPaths.push(rawUrl);
        return;
      }
      const existing = igStats.get(handle) ?? { frequency: 0, prominent: false };
      existing.frequency += 1;
      if (fromMeta) existing.prominent = true;
      igStats.set(handle, existing);
      return;
    }
    const canonical = canonicalizeSocialUrl(rawUrl, platform);
    if (!canonical) return;
    const key = platform as keyof WebsiteSocialLinks;
    if (!socials[key]) {
      socials[key] = canonical;
    }
  };

  for (const anchor of anchors) {
    const resolved = resolveHref(anchor.href, pageUrl);
    if (!resolved) continue;
    const platform = platformForUrl(resolved);
    if (!platform) continue;
    if (platform === "instagram") {
      const { handle, ignored } = parseInstagramFromUrl(resolved);
      if (!handle) {
        if (ignored) ignoredInstagramPaths.push(resolved);
        continue;
      }
      const existing = igStats.get(handle) ?? { frequency: 0, prominent: false };
      existing.frequency += 1;
      if (anchor.inHeaderFooter) existing.prominent = true;
      igStats.set(handle, existing);
    } else {
      recordSocial(platform, resolved);
    }
  }

  // Meta tags (og/twitter/article:publisher + instagram creator/deep links)
  const metaRegex = /<meta\b[^>]*>/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const tag = metaMatch[0];
    const contentMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!contentMatch) continue;
    const content = decodeHtmlEntities((contentMatch[1] ?? contentMatch[2] ?? "").trim());
    if (!content) continue;

    const isSocialMeta =
      /(?:property|name)\s*=\s*["'](?:og:see_also|article:publisher|twitter:site|twitter:creator|instagram:creator|al:ios:url|al:android:url)["']/i.test(tag);
    if (!isSocialMeta) continue;

    if (content.startsWith("@")) {
      const platform = /twitter/i.test(tag) ? "twitter" : /instagram/i.test(tag) ? "instagram" : null;
      if (platform === "twitter") {
        recordSocial("twitter", `https://x.com/${content.slice(1)}`, true);
      } else if (platform === "instagram") {
        recordSocial("instagram", content, true);
      }
      continue;
    }

    if (/instagram:\/\//i.test(content)) {
      recordSocial("instagram", content, true);
      continue;
    }

    const platform = platformForUrl(content);
    if (platform) {
      recordSocial(platform, content, true);
    }
  }

  // JSON-LD sameAs/email/telephone
  const jsonLdEmails: string[] = [];
  const jsonLdPhones: string[] = [];
  const jsonLdRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonMatch: RegExpExecArray | null;
  while ((jsonMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const walk = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        const record = value as Record<string, unknown>;
        const sameAs = record.sameAs;
        if (typeof sameAs === "string") {
          const platform = platformForUrl(sameAs);
          if (platform) recordSocial(platform, sameAs, true);
        } else if (Array.isArray(sameAs)) {
          for (const item of sameAs) {
            if (typeof item !== "string") continue;
            const platform = platformForUrl(item);
            if (platform) recordSocial(platform, item, true);
          }
        }
        if (typeof record.email === "string") jsonLdEmails.push(record.email.replace(/^mailto:/i, ""));
        if (typeof record.telephone === "string") jsonLdPhones.push(record.telephone);
        for (const child of Object.values(record)) {
          if (typeof child === "object" && child !== null) walk(child);
        }
      };
      walk(parsed);
    } catch {
      // ignore malformed JSON-LD
    }
  }

  // Emails: mailto + text + JSON-LD + Cloudflare + obfuscated
  const emails = new Map<string, WebsiteEmail>();
  const addEmail = (raw: string, source: WebsiteEmail["source"]) => {
    const cleaned = raw.trim().replace(/^mailto:/i, "").split("?")[0];
    const normalized = normalizeEmail(cleaned);
    if (!normalized || isJunkWebsiteEmail(normalized)) return;
    if (emails.has(normalized)) return;
    emails.set(normalized, {
      value: normalized,
      normalized,
      source,
      sourceUrl: pageUrl,
      generic: isGenericEmail(normalized),
    });
  };

  const mailtoRegex = /mailto:([^"'\s<>?]+)/gi;
  let mailtoMatch: RegExpExecArray | null;
  while ((mailtoMatch = mailtoRegex.exec(html)) !== null) {
    try {
      addEmail(decodeURIComponent(mailtoMatch[1]), "mailto");
    } catch {
      addEmail(mailtoMatch[1], "mailto");
    }
  }
  for (const email of extractAllEmails(html)) addEmail(email, "text");
  for (const email of jsonLdEmails) addEmail(email, "jsonld");

  const cfRegex = /data-cfemail=["']([0-9a-f]+)["']/gi;
  let cfMatch: RegExpExecArray | null;
  while ((cfMatch = cfRegex.exec(html)) !== null) {
    const decoded = decodeCloudflareEmail(cfMatch[1]);
    if (decoded) addEmail(decoded, "cloudflare");
  }
  for (const email of decodeObfuscatedEmails(html)) addEmail(email, "obfuscated");

  // Phones
  const phones = new Map<string, WebsitePhone>();
  const addPhone = (raw: string, source: WebsitePhone["source"]) => {
    const normalized = normalizePhoneToE164(raw, countryCode);
    if (!normalized || phones.has(normalized)) return;
    phones.set(normalized, { value: raw.trim(), normalized, source, sourceUrl: pageUrl });
  };
  const telRegex = /tel:([+]?[\d\s().-]{7,20})/gi;
  let telMatch: RegExpExecArray | null;
  while ((telMatch = telRegex.exec(html)) !== null) {
    addPhone(telMatch[1], "tel");
  }
  const visibleText = extractVisibleText(html);
  for (const phone of extractAllPhones(visibleText, countryCode)) addPhone(phone.raw, "text");
  for (const phone of jsonLdPhones) addPhone(phone, "jsonld");

  // Link-in-bio hubs
  const linkHubMatch =
    /href=["'](https?:\/\/(?:www\.)?(?:linktr\.ee|beacons\.ai|linkin\.bio)\/[a-zA-Z0-9._-]+)["']/i.exec(html);
  const linkHubUrl = linkHubMatch ? linkHubMatch[1].trim() : null;

  // Rank Instagram handles: frequency + prominence + business/domain match.
  const businessName = options?.businessName ?? "";
  const domain = options?.domain ?? null;
  const scoreHandle = (handle: string, prominent: boolean, frequency: number): number => {
    const cleanName = businessName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const cleanHandle = handle.replace(/[^a-z0-9]/g, "");
    let match = 0;
    if (cleanName && cleanHandle) {
      if (cleanName === cleanHandle) match = 1;
      else if (cleanName.includes(cleanHandle) || cleanHandle.includes(cleanName)) match = 0.85;
      else {
        const tokens = businessName.toLowerCase().split(/[\s,._-]+/).filter((t) => t.length >= 3);
        const matched = tokens.filter((t) => cleanHandle.includes(t.replace(/[^a-z0-9]/g, ""))).length;
        match = tokens.length > 0 && matched > 0 ? 0.4 + (0.5 * matched) / tokens.length : 0.1;
      }
    }
    const domainRoot = domain?.split(".")[0]?.replace(/[^a-z0-9]/g, "") ?? "";
    const domainMatch = domainRoot && cleanHandle.includes(domainRoot) ? 0.5 : 0;
    return frequency * 3 + (prominent ? 6 : 0) + Math.max(match, domainMatch) * 10;
  };

  const ranked = Array.from(igStats.entries()).sort(
    (a, b) => scoreHandle(b[0], b[1].prominent, b[1].frequency) - scoreHandle(a[0], a[1].prominent, a[1].frequency),
  );
  const handle = ranked[0]?.[0] ?? null;
  const alternates = ranked.slice(1).map(([value]) => value);

  if (handle) {
    socials.instagram = `https://www.instagram.com/${handle}/`;
  }

  return {
    anchors: anchors.length,
    instagramProfiles: ranked.map(([value]) => value),
    ignoredInstagramPaths: Array.from(new Set(ignoredInstagramPaths)),
    handle,
    alternates,
    socialLinks: socials,
    emails: Array.from(emails.values()),
    phones: Array.from(phones.values()),
    whatsapp: socials.whatsapp ?? null,
    linkHubUrl,
  };
}

// ============================================================================
// Page discovery
// ============================================================================

export function findSameDomainSubpages(
  html: string,
  pageUrl: string,
  maxSubpages = DEFAULT_MAX_SUBPAGES,
): string[] {
  const base = new URL(pageUrl);
  const baseHost = base.hostname.toLowerCase().replace(/^www\./, "");
  const origin = base.origin;
  const results: string[] = [];
  const seen = new Set<string>([pageUrl]);

  const push = (url: string) => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== baseHost) return;
      if (!/^https?:$/i.test(parsed.protocol)) return;
      if (/\.(pdf|zip|png|jpe?g|gif|webp|svg|mp4|mov|css|js|ico)$/i.test(parsed.pathname)) return;
      const clean = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") || parsed.origin;
      if (seen.has(clean)) return;
      seen.add(clean);
      results.push(clean);
    } catch {
      // ignore
    }
  };

  for (const anchor of extractAnchors(html)) {
    if (!SUBPAGE_KEYWORD.test(anchor.href) && !SUBPAGE_KEYWORD.test(anchor.text)) continue;
    const resolved = resolveHref(anchor.href, pageUrl);
    if (resolved) push(resolved);
  }
  for (const path of CONTACT_SUBPAGE_PATHS) {
    push(`${origin}${path}`);
  }

  return results.slice(0, maxSubpages);
}

// ============================================================================
// Main scraper
// ============================================================================

export async function scrapeLeadWebsite(
  input: {
    website: string;
    businessName?: string | null;
    countryCode?: string;
  },
  options?: WebsiteEnrichmentOptions,
): Promise<WebsiteScrapeResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSubpages = options?.maxSubpages ?? DEFAULT_MAX_SUBPAGES;
  const fetchedAt = new Date().toISOString();
  const norm = normalizeWebsite(input.website);

  if (mockScraper) {
    const mocked = await mockScraper(input);
    return {
      website: norm?.url ?? input.website,
      domain: norm?.domain ?? null,
      pages: [],
      handle: null,
      handleConfidence: null,
      alternates: [],
      socialLinks: {},
      emails: [],
      phones: [],
      whatsapp: null,
      socialOnly: false,
      fetchedAt,
      homepageHtml: null,
      homepageTitle: null,
      homepageH1: null,
      ogSiteName: null,
      ...mocked,
    };
  }
  if (!norm) {
    return {
      website: input.website,
      domain: null,
      pages: [],
      handle: null,
      handleConfidence: null,
      alternates: [],
      socialLinks: {},
      emails: [],
      phones: [],
      whatsapp: null,
      socialOnly: false,
      fetchedAt,
      homepageHtml: null,
      homepageTitle: null,
      homepageH1: null,
      ogSiteName: null,
    };
  }

  // Facebook/social-only "website": store as social link, never fetch.
  if (isSocialOrSharedPlatform(norm.domain)) {
    const platform = platformForUrl(norm.url);
    const socialLinks: WebsiteSocialLinks = {};
    if (platform && platform !== "instagram") {
      const canonical = canonicalizeSocialUrl(norm.url, platform);
      if (canonical) {
        (socialLinks as Record<string, string | null | undefined>)[platform] = canonical;
      }
    } else if (platform === "instagram") {
      const { handle } = parseInstagramFromUrl(norm.url);
      if (handle) socialLinks.instagram = `https://www.instagram.com/${handle}/`;
    }
    return {
      website: norm.url,
      domain: norm.domain,
      pages: [],
      handle: socialLinks.instagram ? parseInstagramFromUrl(socialLinks.instagram).handle : null,
      handleConfidence: socialLinks.instagram ? "high" : null,
      alternates: [],
      socialLinks,
      emails: [],
      phones: [],
      whatsapp: socialLinks.whatsapp ?? null,
      socialOnly: true,
      fetchedAt,
      homepageHtml: null,
      homepageTitle: null,
      homepageH1: null,
      ogSiteName: null,
    };
  }

  const countryCode = (input.countryCode || resolveCountryCode(input.website) || "CA").toUpperCase();
  const pages: WebsitePageDiagnostic[] = [];
  const merged: {
    handles: Map<string, number>;
    socialLinks: WebsiteSocialLinks;
    emails: Map<string, WebsiteEmail>;
    phones: Map<string, WebsitePhone>;
  } = {
    handles: new Map(),
    socialLinks: {},
    emails: new Map(),
    phones: new Map(),
  };

  const processPage = (
    html: string,
    pageUrl: string,
    status: number | null,
    requestedUrl: string = pageUrl,
  ): WebsiteExtraction => {
    const extraction = extractWebsiteData(html, pageUrl, {
      businessName: input.businessName,
      countryCode,
      domain: norm.domain,
    });
    for (const handle of extraction.instagramProfiles) {
      merged.handles.set(handle, (merged.handles.get(handle) ?? 0) + 1);
    }
    for (const [key, value] of Object.entries(extraction.socialLinks)) {
      if (value && !merged.socialLinks[key as keyof WebsiteSocialLinks]) {
        merged.socialLinks[key as keyof WebsiteSocialLinks] = value;
      }
    }
    for (const email of extraction.emails) {
      if (!merged.emails.has(email.normalized)) merged.emails.set(email.normalized, email);
    }
    for (const phone of extraction.phones) {
      if (!merged.phones.has(phone.normalized)) merged.phones.set(phone.normalized, phone);
    }
    pages.push({
      url: pageUrl,
      requestedUrl,
      ok: true,
      status,
      finalUrl: pageUrl,
      anchors: extraction.anchors,
      instagramProfiles: extraction.instagramProfiles,
      ignoredInstagramPaths: extraction.ignoredInstagramPaths,
      emails: extraction.emails.map((e) => e.value),
      phones: extraction.phones.map((p) => p.normalized),
      socials: Object.entries(extraction.socialLinks)
        .filter(([, value]) => Boolean(value))
        .map(([key, value]) => `${getSocialPlatformLabel(key)}: ${value}`),
    });
    return extraction;
  };

  const homeUrl = norm.url;
  const home = await fetchWebsitePage(homeUrl, { fetchFn: options?.fetchFn, timeoutMs });
  const homeHtml = home.html;
  if (!home.ok || !homeHtml) {
    pages.push({
      url: homeUrl,
      requestedUrl: homeUrl,
      ok: false,
      status: home.status ?? null,
      finalUrl: home.finalUrl ?? null,
      anchors: 0,
      instagramProfiles: [],
      ignoredInstagramPaths: [],
      emails: [],
      phones: [],
      socials: [],
      error: home.error ?? "Fetch failed",
    });
    const failedHtml = homeHtml ?? null;
    return {
      website: norm.url,
      domain: norm.domain,
      pages,
      handle: null,
      handleConfidence: null,
      alternates: [],
      socialLinks: {},
      emails: [],
      phones: [],
      whatsapp: null,
      socialOnly: false,
      fetchedAt,
      homepageHtml: failedHtml,
      homepageTitle: failedHtml ? extractPageMeta(failedHtml).title : null,
      homepageH1: failedHtml ? extractPageMeta(failedHtml).h1 : null,
      ogSiteName: failedHtml ? extractPageMeta(failedHtml).ogSiteName : null,
    };
  }

  const homeExtraction = processPage(homeHtml, home.finalUrl ?? homeUrl, home.status ?? 200, homeUrl);
  const subpages = findSameDomainSubpages(homeHtml, home.finalUrl ?? homeUrl, maxSubpages);

  // If the homepage already yields everything, do not spend more fetches.
  const needsMore =
    subpages.length > 0 &&
    (!merged.handles.size || merged.emails.size === 0 || Object.keys(merged.socialLinks).length === 0);

  if (needsMore) {
    for (const subpageUrl of subpages) {
      const sub = await fetchWebsitePage(subpageUrl, { fetchFn: options?.fetchFn, timeoutMs });
      const subHtml = sub.html;
      if (!sub.ok || !subHtml) {
        pages.push({
          url: subpageUrl,
          requestedUrl: subpageUrl,
          ok: false,
          status: sub.status ?? null,
          finalUrl: sub.finalUrl ?? null,
          anchors: 0,
          instagramProfiles: [],
          ignoredInstagramPaths: [],
          emails: [],
          phones: [],
          socials: [],
          error: sub.error ?? "Fetch failed",
        });
        continue;
      }
      processPage(subHtml, sub.finalUrl ?? subpageUrl, sub.status ?? 200, subpageUrl);
    }
  }

  const rankedHandles = Array.from(merged.handles.entries()).sort((a, b) => b[1] - a[1]);
  const handle = rankedHandles[0]?.[0] ?? homeExtraction.handle;
  const alternates = rankedHandles
    .map(([value]) => value)
    .filter((value) => value !== handle);
  if (handle) merged.socialLinks.instagram = `https://www.instagram.com/${handle}/`;

  const emails = Array.from(merged.emails.values()).sort(
    (a, b) => Number(a.generic) - Number(b.generic) || a.value.localeCompare(b.value),
  );
  const phones = Array.from(merged.phones.values());
  const homeMeta = extractPageMeta(homeHtml);

  return {
    website: norm.url,
    domain: norm.domain,
    pages,
    handle,
    handleConfidence: handle ? "high" : null,
    alternates,
    socialLinks: merged.socialLinks,
    emails,
    phones,
    whatsapp: merged.socialLinks.whatsapp ?? null,
    socialOnly: false,
    fetchedAt,
    homepageHtml: homeHtml,
    homepageTitle: homeMeta.title,
    homepageH1: homeMeta.h1,
    ogSiteName: homeMeta.ogSiteName,
  };
}

// ============================================================================
// Persistence
// ============================================================================

type LeadForWebsiteEnrichment = {
  id: string;
  username?: string | null;
  instagramUsername?: string | null;
  profileUrl?: string | null;
  fullName?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  contactSource?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  isClaimed?: boolean | null;
  isChain?: boolean | null;
  availableChannels?: string[] | null;
  rawProfileData?: unknown;
  handleSource?: string | null;
  handleConfidence?: string | null;
  status?: LeadStatus;
  city?: string | null;
  campaign?: { location?: string | null } | null;
};

export type WebsiteApplyResult = {
  leadId: string;
  handleFound: string | null;
  handleStored: boolean;
  emailFound: string | null;
  phoneFound: string | null;
  socialsFound: string[];
  newSocials: string[];
  newEmailCount: number;
  newPhoneCount: number;
  newSocialCount: number;
  pagesTried: number;
  changed: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function applyWebsiteEnrichmentToLead(
  lead: LeadForWebsiteEnrichment,
  extraction: WebsiteScrapeResult,
  options?: { force?: boolean },
): Promise<WebsiteApplyResult> {
  const prisma = getPrismaClient();
  const raw = asRecord(lead.rawProfileData);
  const existingContacts = asRecord(raw.contacts);
  const existingEmails = Array.isArray(existingContacts.emails) ? existingContacts.emails : [];
  const existingPhones = Array.isArray(existingContacts.phones) ? existingContacts.phones : [];
  const existingWhatsapps = Array.isArray(existingContacts.whatsapps) ? existingContacts.whatsapps : [];
  const existingSocials = asRecord(existingContacts.socialLinks);

  const incomingSocials = Object.entries(extraction.socialLinks).filter(
    ([, value]) => typeof value === "string" && Boolean(value),
  );
  const newSocials = incomingSocials
    .filter(([platform, value]) => existingSocials[platform] !== value)
    .map(([platform, value]) => `${platform}:${String(value)}`);
  const socialLinks = {
    ...existingSocials,
    ...Object.fromEntries(incomingSocials),
  };
  const socialEntries = Object.entries(socialLinks).filter(([, value]) => typeof value === "string" && value);

  const emails = [...existingEmails];
  for (const email of extraction.emails) {
    if (!emails.some((e) => asRecord(e).normalized === email.normalized || asRecord(e).value === email.value)) {
      emails.push({
        value: email.value,
        normalized: email.normalized,
        source: "website",
        sourceUrl: email.sourceUrl,
        generic: email.generic,
      });
    }
  }
  const phones = [...existingPhones];
  for (const phone of extraction.phones) {
    if (!phones.some((p) => asRecord(p).normalized === phone.normalized)) {
      phones.push({
        value: phone.value,
        normalized: phone.normalized,
        source: "website",
        sourceUrl: phone.sourceUrl,
      });
    }
  }
  const whatsapps = [...existingWhatsapps];
  if (extraction.whatsapp && !whatsapps.some((w) => asRecord(w).url === extraction.whatsapp)) {
    whatsapps.push({ url: extraction.whatsapp, source: "website" });
  }

  const existingHandle = lead.username?.trim() || lead.instagramUsername?.trim() || null;
  const handleToStore = !existingHandle && extraction.handle ? extraction.handle : null;

  const primaryEmail =
    lead.email ||
    emails.find((e) => !asRecord(e).generic)?.value ||
    emails[0]?.value ||
    null;
  const primaryPhone = lead.phone || phones[0]?.value || null;
  const primarySocial =
    (socialLinks.facebook as string | undefined) ||
    (lead.username ? undefined : (socialLinks.instagram as string | undefined)) ||
    (socialLinks.tiktok as string | undefined) ||
    (socialLinks.linkedin as string | undefined) ||
    (socialLinks.youtube as string | undefined) ||
    (socialLinks.twitter as string | undefined) ||
    (socialLinks.pinterest as string | undefined) ||
    (socialLinks.googleBusiness as string | undefined) ||
    (socialLinks.yelp as string | undefined) ||
    null;
  const primaryPlatform = primarySocial
    ? Object.entries(socialLinks).find(([, value]) => value === primarySocial)?.[0] ?? null
    : null;

  const channels = computeAvailableChannels({
    hasInstagram: Boolean(existingHandle || handleToStore),
    email: primaryEmail,
    phone: primaryPhone,
    whatsapp: extraction.whatsapp,
    website: lead.website,
  });
  if (socialEntries.length > 0 && !channels.includes("SOCIAL")) {
    channels.push("SOCIAL");
  }

  const mismatch = extraction.handle
    ? checkNameWebsiteMismatch({
        businessName: lead.fullName,
        websiteUrl: lead.website,
        homepageTitle: extraction.homepageTitle,
        homepageH1: extraction.homepageH1,
        ogSiteName: extraction.ogSiteName,
        homepageHtml: extraction.homepageHtml ?? undefined,
      })
    : { isMismatch: false };
  let confidence = extraction.handleConfidence;
  const flags = new Set<string>();
  if (mismatch.isMismatch) {
    flags.add("NAME_WEBSITE_MISMATCH");
    if (confidence === "high") confidence = "medium";
  }

  const score = computeLeadScore({
    rating: lead.rating,
    reviewCount: lead.reviewCount,
    website: lead.website,
    phone: primaryPhone,
    isClaimed: lead.isClaimed,
    isChain: lead.isChain,
    hasInstagram: Boolean(existingHandle || handleToStore),
    email: primaryEmail,
    availableChannels: channels,
    handleConfidence: confidence,
    handleSource: handleToStore ? "website" : lead.handleSource,
    websiteMismatch: mismatch.isMismatch,
  });

  const updatedRaw = {
    ...raw,
    contacts: {
      emails,
      phones,
      whatsapps,
      socialLinks,
      extractedAt: extraction.fetchedAt,
    },
    websiteEnrichment: {
      fetchedAt: extraction.fetchedAt,
      website: extraction.website,
      domain: extraction.domain,
      handle: extraction.handle,
      alternates: extraction.alternates,
      pages: extraction.pages,
      socialOnly: extraction.socialOnly,
    },
    handleAlternates: Array.from(
      new Set([
        ...(Array.isArray(raw.handleAlternates) ? (raw.handleAlternates as string[]) : []),
        ...extraction.alternates,
        ...(existingHandle && extraction.handle && existingHandle !== extraction.handle
          ? [extraction.handle]
          : []),
      ]),
    ),
  };

  const data: Prisma.LeadUpdateInput = {
    rawProfileData: updatedRaw as Prisma.InputJsonValue,
    ...withLeadChannelFlags(channels),
    lastHandleEnrichmentAt: new Date(),
    email: primaryEmail,
    phone: primaryPhone,
    phoneNormalized: primaryPhone ? normalizePhoneToE164(primaryPhone, "CA") : null,
    socialLink: primarySocial,
    socialPlatform: primaryPlatform,
    contactSource:
      lead.contactSource ??
      (extraction.emails.length > 0 || extraction.phones.length > 0 || socialEntries.length > 0
        ? "website"
        : "maps"),
    qualityScore: score.score,
    qualityTier: score.tier,
    scoreBreakdown: score.breakdown as Prisma.InputJsonValue,
    scoreFlags: scoreFlagReplace([...flags]),
  };

  if (!lead.email && primaryEmail) {
    data.emailSourceUrl = extraction.pages.find((p) => p.emails.includes(primaryEmail))?.url ?? extraction.website;
    data.emailFoundAt = new Date();
    data.emailConfidence = 0.9;
    data.emailRole = isGenericEmail(primaryEmail) ? "generic" : "named";
  }

  if (handleToStore) {
    const canonicalHandle = handleToStore.toLowerCase();
    data.username = handleToStore;
    data.instagramUsername = handleToStore;
    data.usernameNormalized = canonicalHandle;
    data.profileUrl = `https://www.instagram.com/${handleToStore}/`;
    data.profileUrlCanonical = `https://www.instagram.com/${canonicalHandle}/`;
    data.handleSource = "website";
    data.handleConfidence = confidence;
    if (lead.status === LeadStatus.NEW) {
      data.status = LeadStatus.ENRICH_PENDING;
    }
  } else {
    const existingHandle = lead.username || lead.instagramUsername;
    if (existingHandle) {
      // Repair leads whose handle was stored without a profile URL so the
      // send gates and list links have a usable Instagram URL.
      const canonicalHandle = existingHandle.toLowerCase();
      if (!lead.profileUrl || !lead.profileUrl.trim()) {
        data.profileUrl = `https://www.instagram.com/${existingHandle}/`;
      }
      if (!lead.username) {
        data.username = existingHandle;
        data.usernameNormalized = canonicalHandle;
        data.instagramUsername = existingHandle;
      }
    }
  }

  const newEmailCount = emails.length - existingEmails.length;
  const newPhoneCount = phones.length - existingPhones.length;
  const newSocialCount = newSocials.length;
  const changed =
    Boolean(handleToStore) ||
    (!lead.email && Boolean(primaryEmail)) ||
    (!lead.phone && Boolean(primaryPhone)) ||
    newEmailCount > 0 ||
    newPhoneCount > 0 ||
    newSocialCount > 0;

  if (changed || options?.force) {
    await prisma.lead.update({ where: { id: lead.id }, data });
  }

  return {
    leadId: lead.id,
    handleFound: extraction.handle,
    handleStored: Boolean(handleToStore),
    emailFound: primaryEmail,
    phoneFound: primaryPhone,
    socialsFound: socialEntries.map(([key, value]) => `${key}:${String(value)}`),
    newSocials,
    newEmailCount,
    newPhoneCount,
    newSocialCount,
    pagesTried: extraction.pages.length,
    changed,
  };
}

export async function enrichLeadWebsiteById(
  leadId: string,
  options?: WebsiteEnrichmentOptions & { force?: boolean },
): Promise<WebsiteApplyResult | null> {
  const prisma = getPrismaClient();
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { campaign: { select: { location: true } } },
  });
  if (!lead || !lead.website) return null;

  const extraction = await scrapeLeadWebsite(
    {
      website: lead.website,
      businessName: lead.fullName,
      countryCode: lead.campaign?.location ? resolveCountryCode(lead.campaign.location) ?? undefined : undefined,
    },
    options,
  );
  return applyWebsiteEnrichmentToLead(lead, extraction, { force: true });
}

export type WebsiteBulkEnrichmentResult = {
  success: boolean;
  totalEligible: number;
  processed: number;
  handlesFound: number;
  emailsFound: number;
  socialsFound: number;
  notFound: number;
  cooldownSkipped: number;
  results: Array<{
    id: string;
    name: string | null;
    website: string | null;
    outcome: "found" | "not_found" | "cooldown" | "error";
    handle: string | null;
    email: string | null;
    socials: string[];
    newHandle: boolean;
    newEmail: boolean;
    newSocialCount: number;
    message: string;
  }>;
};

export async function enrichLeadsFromWebsites(input: {
  campaignId?: string;
  leadIds?: string[];
  userId?: string;
  force?: boolean;
  /** Scan every lead with a website, even if it already has IG/email/socials. */
  scanAll?: boolean;
  limit?: number;
  concurrency?: number;
  fetchFn?: WebsiteFetchFn;
}): Promise<WebsiteBulkEnrichmentResult> {
  const prisma = getPrismaClient();
  const cooldownMs = 7 * 24 * 60 * 60 * 1000;
  const cooldownCutoff = new Date(Date.now() - cooldownMs);
  const scanAll = input.scanAll === true;

  const andConditions: Prisma.LeadWhereInput[] = [];
  if (!scanAll) {
    andConditions.push({
      OR: [
        { username: null },
        { username: "" },
        { email: null },
        { email: "" },
        { socialLink: null },
      ],
    });
    if (!input.force) {
      andConditions.push({
        OR: [
          { lastHandleEnrichmentAt: null },
          { lastHandleEnrichmentAt: { lt: cooldownCutoff } },
        ],
      });
    }
  }

  const where: Prisma.LeadWhereInput = {
    AND: [
      { website: { not: null } },
      { NOT: { website: "" } },
      ...andConditions,
    ],
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    ...(input.leadIds?.length ? { id: { in: input.leadIds } } : {}),
    ...(input.userId
      ? { OR: [{ userId: input.userId }, { campaign: { userId: input.userId } }] }
      : {}),
  };

  const leads = await prisma.lead.findMany({
    where,
    include: { campaign: { select: { location: true } } },
    take: input.limit ?? (scanAll ? 5000 : 500),
    orderBy: { createdAt: "desc" },
  });

  const results: WebsiteBulkEnrichmentResult["results"] = [];

  await runWithConcurrency(leads, input.concurrency ?? 15, async (lead) => {
    if (!lead.website) return;
    try {
      if (
        !scanAll &&
        !input.force &&
        lead.lastHandleEnrichmentAt &&
        lead.lastHandleEnrichmentAt > cooldownCutoff
      ) {
        results.push({
          id: lead.id,
          name: lead.fullName,
          website: lead.website,
          outcome: "cooldown",
          handle: lead.username,
          email: lead.email,
          socials: [],
          newHandle: false,
          newEmail: false,
          newSocialCount: 0,
          message: "Website enrichment already ran within the last 7 days.",
        });
        return;
      }

      const extraction = await scrapeLeadWebsite(
        {
          website: lead.website,
          businessName: lead.fullName,
          countryCode: lead.campaign?.location
            ? resolveCountryCode(lead.campaign.location) ?? undefined
            : undefined,
        },
        { fetchFn: input.fetchFn, force: input.force } as WebsiteEnrichmentOptions,
      );
      const applied = await applyWebsiteEnrichmentToLead(lead, extraction, { force: true });

      const found = Boolean(
        applied.handleStored ||
          applied.newEmailCount > 0 ||
          applied.newPhoneCount > 0 ||
          applied.newSocialCount > 0,
      );
      results.push({
        id: lead.id,
        name: lead.fullName,
        website: lead.website,
        outcome: found ? "found" : "not_found",
        handle: applied.handleStored ? applied.handleFound : lead.username,
        email: applied.emailFound,
        socials: applied.newSocials,
        newHandle: applied.handleStored,
        newEmail: applied.newEmailCount > 0,
        newSocialCount: applied.newSocialCount,
        message: found
          ? `Found new ${[
              applied.handleStored ? `IG @${applied.handleFound}` : null,
              applied.newEmailCount > 0 ? `${applied.newEmailCount} email(s)` : null,
              applied.newPhoneCount > 0 ? `${applied.newPhoneCount} phone(s)` : null,
              applied.newSocialCount > 0
                ? `${applied.newSocialCount} social link(s): ${applied.newSocials.join(", ")}`
                : null,
            ]
              .filter(Boolean)
              .join(", ")} across ${applied.pagesTried} page(s).`
          : `No new handle/email/phone/social found across ${applied.pagesTried} page(s).`,
      });
    } catch (err: unknown) {
      results.push({
        id: lead.id,
        name: lead.fullName,
        website: lead.website,
        outcome: "error",
        handle: null,
        email: null,
        socials: [],
        newHandle: false,
        newEmail: false,
        newSocialCount: 0,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const handlesFound = results.filter((r) => r.newHandle).length;
  const emailsFound = results.filter((r) => r.newEmail).length;
  const socialsFound = results.reduce((sum, r) => sum + r.newSocialCount, 0);
  const notFound = results.filter((r) => r.outcome === "not_found").length;
  const cooldownSkipped = results.filter((r) => r.outcome === "cooldown").length;

  return {
    success: true,
    totalEligible: leads.length,
    processed: results.length,
    handlesFound,
    emailsFound,
    socialsFound,
    notFound,
    cooldownSkipped,
    results,
  };
}

/**
 * Pure helper for tests/UI: extract the public contact summary from raw data.
 */
export function getWebsiteContactsFromLead(lead: {
  rawProfileData?: unknown;
}): {
  emails: string[];
  phones: string[];
  socialLinks: Record<string, string | null>;
} {
  const raw = asRecord(lead.rawProfileData);
  const contacts = asRecord(raw.contacts);
  const emails = Array.isArray(contacts.emails)
    ? contacts.emails.map((e) => String(asRecord(e).value ?? e)).filter(Boolean)
    : [];
  const phones = Array.isArray(contacts.phones)
    ? contacts.phones.map((p) => String(asRecord(p).normalized ?? asRecord(p).value ?? p)).filter(Boolean)
    : [];
  const socials = asRecord(contacts.socialLinks);
  const socialLinks: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(socials)) {
    if (typeof value === "string" && value) socialLinks[key] = value;
  }
  return { emails, phones, socialLinks };
}
