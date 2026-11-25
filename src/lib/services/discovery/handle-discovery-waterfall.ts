import "server-only";

import dns from "node:dns/promises";
import {
  extractTitleAndH1,
  isSocialOrAggregatorUrl,
} from "./name-website-matcher";

// ============================================================================
// Types
// ============================================================================

export type HandleSource = "maps" | "homepage" | "contact_page" | "linkhub";
export type HandleConfidence = "high" | "medium" | "low";

export type WaterfallInput = {
  businessName?: string | null;
  websiteUrl?: string | null;
  mapsHandles?: string[];
  mapsSocial?: Record<string, string | null>;
  fetchFn?: (url: string, timeoutMs?: number) => Promise<{ ok: boolean; html?: string; status?: number }>;
  timeoutPerFetchMs?: number;
  totalSiteBudgetMs?: number;
};

export type WaterfallCandidate = {
  handle: string;
  source: HandleSource;
  confidence: HandleConfidence;
  frequency: number;
  inHeaderFooter: boolean;
  matchScore: number;
};

export type WaterfallResult = {
  handle: string | null;
  handleSource: HandleSource | null;
  handleConfidence: HandleConfidence | null;
  stepsAttempted: HandleSource[];
  candidates: WaterfallCandidate[];
  socialLinks?: Record<string, string | null>;
  linkHubUrl?: string | null;
  homepageHtml?: string | null;
  homepageTitle?: string | null;
  homepageH1?: string | null;
  ogSiteName?: string | null;
};

// ============================================================================
// Reserved Handles and Site Builder Badges
// ============================================================================

export const RESERVED_HANDLES = new Set<string>([
  // Core Instagram & Social platforms
  "instagram",
  "facebook",
  "fb",
  "twitter",
  "x",
  "tiktok",
  "linkedin",
  "youtube",
  "pinterest",
  "threads",
  "snapchat",
  "whatsapp",
  "telegram",
  // Common navigational paths
  "p",
  "reel",
  "reels",
  "explore",
  "accounts",
  "share",
  "stories",
  "direct",
  "developer",
  "about",
  "legal",
  "terms",
  "privacy",
  "help",
  "press",
  "api",
  "jobs",
  "settings",
  "login",
  "signin",
  "signup",
  "register",
  "support",
  "contact",
  "contactus",
  "home",
  "admin",
  "blog",
  "feed",
  "channel",
  "tv",
  "directory",
  "locations",
  "tags",
  // Site builders, agencies, badges
  "squarespace",
  "wix",
  "wordpress",
  "shopify",
  "webflow",
  "godaddy",
  "elementor",
  "weebly",
  "canva",
  "hubspot",
  "mailchimp",
  "hootsuite",
  "buffer",
  "sproutsocial",
  "yelp",
  "tripadvisor",
  "opentable",
  "resy",
]);

// Non-profile path prefixes to reject immediately
const NON_PROFILE_PATH_SEGMENTS = new Set<string>([
  "p",
  "reel",
  "reels",
  "explore",
  "accounts",
  "share",
  "stories",
  "direct",
  "tv",
  "channel",
  "developer",
  "about",
  "legal",
  "terms",
  "privacy",
  "help",
  "press",
  "api",
  "jobs",
  "settings",
  "login",
  "signup",
  "support",
  "tags",
  "directory",
  "locations",
]);

// ============================================================================
// SSRF Guard (Hardened with DNS Resolution & Manual Redirect Following)
// ============================================================================

/**
 * Checks if an IPv4 address belongs to a private, loopback, link-local, or reserved subnet.
 */
export function isIpv4PrivateOrBlocked(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IP is blocked
  }
  const [b0, b1, b2] = parts;

  // 0.0.0.0/8 (Current network)
  if (b0 === 0) return true;
  // 10.0.0.0/8 (Private network)
  if (b0 === 10) return true;
  // 100.64.0.0/10 (Shared address space / Carrier-Grade NAT: 100.64.0.0 - 100.127.255.255)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;
  // 169.254.0.0/16 (Link-local, AWS/GCP/Azure instance metadata at 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;
  // 172.16.0.0/12 (Private network: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;
  // 192.88.99.0/24 (6to4 Relay Anycast)
  if (b0 === 192 && b1 === 88 && b2 === 99) return true;
  // 192.168.0.0/16 (Private network)
  if (b0 === 192 && b1 === 168) return true;
  // 198.18.0.0/15 (Network benchmark tests: 198.18.0.0 - 198.19.255.255)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  // 224.0.0.0/4 (Multicast) + 240.0.0.0/4 (Reserved) + 255.255.255.255 (Broadcast)
  if (b0 >= 224) return true;

  return false;
}

/**
 * Checks if an IPv6 address belongs to a loopback, unique local, link-local, or multicast subnet.
 */
export function isIpv6PrivateOrBlocked(ip: string): boolean {
  const lower = ip.toLowerCase().trim();
  // Loopback & Unspecified
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1" || lower === "::" || lower === "0:0:0:0:0:0:0:0") {
    return true;
  }
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(lower);
  if (mappedMatch) {
    return isIpv4PrivateOrBlocked(mappedMatch[1]);
  }
  // Link-local: fe80::/10 (fe8, fe9, fea, feb)
  if (/^fe[89ab]/i.test(lower)) return true;
  // Unique local / private: fc00::/7 (fc, fd)
  if (/^f[cd]/i.test(lower)) return true;
  // Multicast: ff00::/8
  if (/^ff/i.test(lower)) return true;

  return false;
}

/**
 * Dispatches IP check for either IPv4 or IPv6.
 */
export function isIpPrivateOrBlocked(ip: string): boolean {
  if (!ip) return true;
  const trimmed = ip.trim();
  if (trimmed.includes(":")) {
    return isIpv6PrivateOrBlocked(trimmed);
  }
  return isIpv4PrivateOrBlocked(trimmed);
}

/**
 * Validates a target URL against private/internal hostnames, IP literals, and resolves DNS to verify no private IP.
 */
export async function isUrlSafe(
  urlString: string,
): Promise<{ safe: boolean; reason?: string }> {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { safe: false, reason: "Unsupported protocol" };
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check banned domain suffixes and names
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".arpa") ||
      hostname === "0.0.0.0" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
      return { safe: false, reason: `Blocked local or internal hostname: ${hostname}` };
    }

    // Direct IP literal check
    const cleanHost = hostname.replace(/^\[|\]$/g, "");
    if (/^[\d.]+$/.test(cleanHost) || cleanHost.includes(":")) {
      if (isIpPrivateOrBlocked(cleanHost)) {
        return { safe: false, reason: `Direct IP ${cleanHost} is private or blocked` };
      }
      return { safe: true };
    }

    // Resolve DNS records before making network request
    try {
      const records = await dns.lookup(hostname, { all: true });
      if (!records || records.length === 0) {
        return { safe: false, reason: `DNS lookup returned no records for ${hostname}` };
      }
      for (const rec of records) {
        if (isIpPrivateOrBlocked(rec.address)) {
          return {
            safe: false,
            reason: `Resolved IP ${rec.address} for host ${hostname} is private or blocked`,
          };
        }
      }
    } catch (err: unknown) {
      // In dry-run / test environments with mocked fetch, fake test domains (e.g. torontosmilestudio.com)
      // do not resolve in public DNS. Allow mock domains to proceed to mocked fetch handlers.
      const nodeErr = err as { code?: string; syscall?: string } | null;
      if (
        (process.env.APIFY_DRY_RUN === "true" || process.env.NODE_ENV === "test") &&
        (nodeErr?.code === "ENOTFOUND" || nodeErr?.code === "EAI_AGAIN" || nodeErr?.syscall === "getaddrinfo")
      ) {
        return { safe: true };
      }
      return { safe: false, reason: `DNS lookup failed for ${hostname}: ${String(err)}` };
    }

    return { safe: true };
  } catch {
    return { safe: false, reason: "Malformed URL" };
  }
}

const MAX_HTML_BYTES = 2 * 1024 * 1024;

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total >= maxBytes) {
    await reader.cancel().catch(() => undefined);
  }
  const buffer = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.max(0, buffer.length - offset));
    buffer.set(slice, offset);
    offset += slice.length;
    if (offset >= buffer.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

/**
 * Safely fetches HTML text with hardened SSRF protection:
 * - Checks target URL BEFORE fetching (including DNS resolution).
 * - Uses redirect: "manual" and re-checks every redirect hop (max 3 hops).
 * - Enforces timeout.
 */
type SafeFetchResult = { ok: boolean; html?: string; finalUrl?: string; error?: string; status?: number | null };

// Header profiles tried in order. Many small-business sites sit behind WAFs
// that 403 an outdated/partial browser fingerprint, while others drop the
// socket for any "Chrome" UA whose TLS fingerprint isn't a real browser but
// accept a plain client. Try a complete modern browser profile first, then a
// minimal one.
const FETCH_HEADER_PROFILES: Record<string, string>[] = [
  {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  },
  {
    Accept: "text/html,*/*;q=0.8",
  },
];

function isBotBlock(result: SafeFetchResult): boolean {
  if (result.ok) return false;
  if (result.status === 403 || result.status === 429 || result.status === 503 || result.status === 406) return true;
  return /other side closed|socket|ECONNRESET|fetch failed|terminated/i.test(result.error ?? "");
}

export async function safeFetchHtml(
  initialUrl: string,
  timeoutMs: number = 6000,
  maxHops: number = 3,
): Promise<SafeFetchResult> {
  let last: SafeFetchResult = { ok: false, error: "No fetch attempted" };
  for (const headers of FETCH_HEADER_PROFILES) {
    last = await safeFetchHtmlWithHeaders(initialUrl, timeoutMs, maxHops, headers);
    if (last.ok || !isBotBlock(last) || /SSRF blocked/.test(last.error ?? "")) return last;
  }
  return last;
}

async function safeFetchHtmlWithHeaders(
  initialUrl: string,
  timeoutMs: number,
  maxHops: number,
  headers: Record<string, string>,
): Promise<SafeFetchResult> {
  let currentUrl = initialUrl;
  const visited = new Set<string>();

  for (let hop = 0; hop <= maxHops; hop++) {
    if (visited.has(currentUrl)) {
      return { ok: false, error: "Redirect loop detected" };
    }
    visited.add(currentUrl);

    // Validate URL and resolve DNS before connection
    const check = await isUrlSafe(currentUrl);
    if (!check.safe) {
      return { ok: false, error: `SSRF blocked: ${check.reason}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers,
      });

      // Handle redirect manually
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        clearTimeout(timer);
        if (hop >= maxHops) {
          return { ok: false, error: "Max redirect hops (3) exceeded" };
        }
        const locationHeader = res.headers.get("location");
        if (!locationHeader) {
          return { ok: false, error: "Redirect without Location header" };
        }
        currentUrl = new URL(locationHeader, currentUrl).toString();
        continue;
      }

      if (!res.ok) {
        clearTimeout(timer);
        return { ok: false, error: `HTTP status ${res.status}`, status: res.status, finalUrl: currentUrl };
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
        clearTimeout(timer);
        return { ok: false, error: `Not an HTML page (${contentType.split(";")[0]})`, status: res.status, finalUrl: currentUrl };
      }

      // Read at most MAX_HTML_BYTES so a huge page cannot exhaust memory. The
      // abort timer stays armed while the body streams in.
      const text = await readBodyCapped(res, MAX_HTML_BYTES);
      clearTimeout(timer);
      return { ok: true, html: text, finalUrl: currentUrl, status: res.status };
    } catch (err: unknown) {
      clearTimeout(timer);
      const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: cause?.message ? `${msg}: ${cause.message}` : msg };
    }
  }

  return { ok: false, error: "Max redirect hops exceeded" };
}

// ============================================================================
// Handle Normalization & Validation
// ============================================================================

/**
 * Cleans, parses, and validates an Instagram URL or handle string.
 * Returns normalized handle (lowercase, no @, 1-30 chars) or null if invalid/rejected.
 */
export function cleanAndValidateHandle(rawUrlOrHandle: string): string | null {
  if (!rawUrlOrHandle || typeof rawUrlOrHandle !== "string") {
    return null;
  }

  let candidate = rawUrlOrHandle.trim();
  if (!candidate) return null;

  // Handle protocol-relative URL (e.g. //www.instagram.com/myhandle)
  if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  }

  // Handle leading / before domain
  if (candidate.startsWith("/") && (candidate.includes("instagram.com") || candidate.includes("instagr.am"))) {
    candidate = `https://${candidate.replace(/^\/+/, "")}`;
  }

  // If it's a URL, parse path
  if (candidate.startsWith("http://") || candidate.startsWith("https://") || candidate.includes("instagram.com/") || candidate.includes("instagr.am/")) {
    try {
      const normalizedUrl = candidate.startsWith("http") ? candidate : `https://${candidate}`;
      const parsed = new URL(normalizedUrl);
      const host = parsed.hostname.toLowerCase();
      if (!host.includes("instagram.com") && !host.includes("instagr.am")) {
        return null;
      }

      const pathname = parsed.pathname;
      const segments = pathname
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);

      if (segments.length === 0) return null;

      const firstSeg = segments[0].toLowerCase();
      if (NON_PROFILE_PATH_SEGMENTS.has(firstSeg)) {
        return null;
      }

      candidate = segments[0];
    } catch {
      return null;
    }
  }

  // Strip leading '@' and lowercase
  candidate = candidate.replace(/^@+/, "").trim().toLowerCase();

  // Strip any trailing punctuation (dots, slashes, query residues)
  candidate = candidate.replace(/[/?#].*$/, "");
  candidate = candidate.replace(/[.,:;!?]+$/, "");

  // Basic Instagram handle regex: 1-30 alphanumeric, dots, underscores
  if (!/^[a-z0-9._]{1,30}$/.test(candidate)) {
    return null;
  }

  // Cannot start or end with a dot
  if (candidate.startsWith(".") || candidate.endsWith(".")) {
    return null;
  }

  // Cannot contain consecutive dots
  if (candidate.includes("..")) {
    return null;
  }

  // Check reserved handles list
  if (RESERVED_HANDLES.has(candidate)) {
    return null;
  }

  return candidate;
}

// ============================================================================
// HTML Parsing & Ranking
// ============================================================================

/**
 * Computes a string similarity ratio between handle and business name.
 */
function computeBusinessNameMatch(handle: string, businessName?: string | null): number {
  if (!businessName) return 0;
  const cleanName = businessName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cleanHandle = handle.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (!cleanName || !cleanHandle) return 0;
  if (cleanName === cleanHandle) return 1.0;
  if (cleanName.includes(cleanHandle) || cleanHandle.includes(cleanName)) return 0.85;

  // Check token overlap
  const nameTokens = businessName
    .toLowerCase()
    .split(/[\s,._-]+/)
    .filter((t) => t.length >= 3);

  let matchedTokens = 0;
  for (const t of nameTokens) {
    if (cleanHandle.includes(t)) matchedTokens++;
  }

  if (nameTokens.length > 0 && matchedTokens > 0) {
    return Number((0.4 + (0.5 * matchedTokens) / nameTokens.length).toFixed(2));
  }

  return 0.1;
}

export type ExtractedHtmlHandles = {
  candidates: WaterfallCandidate[];
  socialLinks: Record<string, string | null>;
  linkHubUrl: string | null;
};

/**
 * Parses raw HTML extracting:
 * 1. <a href> tags containing instagram.com
 * 2. <header> and <footer> context tags
 * 3. <meta> tags (og:see_also, al:ios:url, instagram:creator)
 * 4. JSON-LD scripts with sameAs
 * 5. Link-in-bio hub links (linktr.ee, beacons.ai, linkin.bio)
 * 6. Other social platform links (facebook, tiktok, linkedin, youtube, whatsapp)
 */
export function parseHtmlForHandles(
  html: string,
  businessName?: string | null,
  source: HandleSource = "homepage",
): ExtractedHtmlHandles {
  if (!html || typeof html !== "string") {
    return { candidates: [], socialLinks: {}, linkHubUrl: null };
  }

  const handleStats = new Map<
    string,
    { frequency: number; inHeaderFooter: boolean; score: number }
  >();

  const recordHandle = (raw: string, weight: number, inHeaderFooter: boolean = false) => {
    const valid = cleanAndValidateHandle(raw);
    if (!valid) return;

    const existing = handleStats.get(valid);
    if (existing) {
      existing.frequency += 1;
      existing.score += weight;
      if (inHeaderFooter) existing.inHeaderFooter = true;
    } else {
      handleStats.set(valid, {
        frequency: 1,
        inHeaderFooter,
        score: weight,
      });
    }
  };

  // 1. Separate header, footer, and navigation sections for prominence weighting
  const socialLinks: Record<string, string | null> = {};
  const headerMatch = /<header[\s\S]*?<\/header>/i.exec(html);
  const footerMatch = /<footer[\s\S]*?<\/footer>/i.exec(html);
  const navMatch = /<nav[\s\S]*?<\/nav>/i.exec(html);
  const headerHtml = headerMatch ? headerMatch[0] : "";
  const footerHtml = footerMatch ? footerMatch[0] : "";
  const navHtml = navMatch ? navMatch[0] : "";

  // 2. Parse <a href="..."> links (including image/svg-only anchors, uppercase href, unquoted href)
  const anchorRegex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRegex.exec(html)) !== null) {
    let href = match[1] || match[2] || match[3] || "";
    if (href.startsWith("//")) {
      href = `https:${href}`;
    }
    if (href.includes("instagram.com/") || href.includes("instagr.am/")) {
      const tagStr = match[0];
      const inHf =
        headerHtml.includes(href) ||
        footerHtml.includes(href) ||
        navHtml.includes(href) ||
        /class=["'][^"']*(?:social|footer|header|nav)[^"']*["']/i.test(tagStr) ||
        /id=["'][^"']*(?:social|footer|header|nav)[^"']*["']/i.test(tagStr);
      const weight = inHf ? 5 : 3;
      recordHandle(href, weight, inHf);
    }
  }

  // 3. Parse <meta> tags
  const metaRegex = /<meta\b[^>]*>/gi;
  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const contentMatch = /\bcontent=["']([^"']+)["']/i.exec(tag);
    if (contentMatch) {
      const content = contentMatch[1];
      if (
        /property=["'](?:og:see_also|al:ios:url|al:android:url)["']/i.test(tag) ||
        /name=["'](?:instagram:creator|twitter:creator)["']/i.test(tag)
      ) {
        if (content.includes("instagram.com/") || content.startsWith("instagram://") || content.startsWith("@")) {
          const raw = content.replace("instagram://user?username=", "");
          recordHandle(raw, 4, false);
        }
      }
    }
  }

  // 4. Parse JSON-LD <script type="application/ld+json">
  const jsonLdRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const extractSameAs = (obj: unknown) => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          obj.forEach(extractSameAs);
          return;
        }
        const record = obj as Record<string, unknown>;
        if (record.sameAs) {
          const sameAsList = Array.isArray(record.sameAs)
            ? record.sameAs
            : [record.sameAs];
          for (const item of sameAsList) {
            if (typeof item === "string") {
              if (item.includes("instagram.com/") || item.includes("instagr.am/")) {
                recordHandle(item, 5, false);
              } else if (item.includes("facebook.com/") || item.includes("fb.com/")) {
                socialLinks.facebook = item.trim();
              } else if (item.includes("tiktok.com/")) {
                socialLinks.tiktok = item.trim();
              } else if (item.includes("linkedin.com/")) {
                socialLinks.linkedin = item.trim();
              } else if (item.includes("youtube.com/")) {
                socialLinks.youtube = item.trim();
              }
            }
          }
        }
        for (const key of Object.keys(record)) {
          if (typeof record[key] === "object" && record[key] !== null) {
            extractSameAs(record[key]);
          }
        }
      };
      extractSameAs(parsed);
    } catch {
      // Ignore JSON parse errors in malformed script tags
    }
  }

  // 5. Look for link-in-bio hubs (linktr.ee, beacons.ai, linkin.bio)
  let linkHubUrl: string | null = null;
  const linkHubMatch =
    /href=["'](https?:\/\/(?:www\.)?(?:linktr\.ee|beacons\.ai|linkin\.bio)\/[a-zA-Z0-9._-]+)["']/i.exec(
      html,
    );
  if (linkHubMatch) {
    linkHubUrl = linkHubMatch[1].trim();
  }

  // 6. Extract other social links
  const fb = /href=["'](https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com|fb\.me)\/[^"'#\s<>]+)["']/i.exec(html);
  if (fb && !fb[1].includes("/sharer") && !fb[1].includes("/share")) socialLinks.facebook = fb[1].trim();

  const tt = /href=["'](https?:\/\/(?:www\.)?tiktok\.com\/@[^"'#\s<>]+)["']/i.exec(html);
  if (tt) socialLinks.tiktok = tt[1].trim();

  const li = /href=["'](https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^"'#\s<>]+)["']/i.exec(html);
  if (li) socialLinks.linkedin = li[1].trim();

  const yt = /href=["'](https?:\/\/(?:www\.)?(?:youtube\.com\/(?:c\/|user\/|@)?|youtu\.be\/)[^"'#\s<>]+)["']/i.exec(html);
  if (yt && !yt[1].includes("/watch?") && !yt[1].includes("/embed/")) socialLinks.youtube = yt[1].trim();

  const wa = /href=["'](https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)[^"'#\s<>]+)["']/i.exec(html);
  if (wa) socialLinks.whatsapp = wa[1].trim();

  // 7. Score and format candidates
  const candidates: WaterfallCandidate[] = [];
  const entries = Array.from(handleStats.entries());

  // Rank entries: prefer repeated most, in header/footer, and best matching name
  entries.sort((a, b) => {
    const scoreA =
      a[1].frequency * 3 +
      (a[1].inHeaderFooter ? 6 : 0) +
      computeBusinessNameMatch(a[0], businessName) * 10;
    const scoreB =
      b[1].frequency * 3 +
      (b[1].inHeaderFooter ? 6 : 0) +
      computeBusinessNameMatch(b[0], businessName) * 10;
    return scoreB - scoreA;
  });

  for (let i = 0; i < entries.length; i++) {
    const [handle, stats] = entries[i];
    const matchScore = computeBusinessNameMatch(handle, businessName);

    // Lead's own website link: top candidate in header/footer or matching name is high confidence.
    let confidence: HandleConfidence = "medium";
    if (i === 0) {
      if (stats.inHeaderFooter || matchScore >= 0.3) {
        confidence = "high";
      } else {
        confidence = "low";
      }
    } else if (stats.inHeaderFooter || matchScore >= 0.5) {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    candidates.push({
      handle,
      source,
      confidence,
      frequency: stats.frequency,
      inHeaderFooter: stats.inHeaderFooter,
      matchScore,
    });
  }

  // Sort candidates by:
  // 1. matchScore * 10 + score
  candidates.sort((a, b) => {
    const scoreA = a.matchScore * 10 + (a.inHeaderFooter ? 5 : 0) + a.frequency;
    const scoreB = b.matchScore * 10 + (b.inHeaderFooter ? 5 : 0) + b.frequency;
    return scoreB - scoreA;
  });

  return { candidates, socialLinks, linkHubUrl };
}

// ============================================================================
// Contact Page Fallback & Linkhub
// ============================================================================

const CONTACT_PAGE_PATHS = [
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
  "/team",
];

// ============================================================================
// Main Handle Discovery Waterfall
// ============================================================================

let mockWaterfallRunner: ((input: WaterfallInput) => Promise<WaterfallResult>) | null = null;

export function setMockWaterfallRunnerForTesting(
  runner: ((input: WaterfallInput) => Promise<WaterfallResult>) | null,
): void {
  mockWaterfallRunner = runner;
}

/**
 * Runs the 4-step discovery waterfall for a place:
 * 1. Maps actor data (including social/contacts fields when the flag is on).
 * 2. Website homepage: parse <a href>, meta tags, JSON-LD sameAs, footer.
 * 3. Same-domain pages only: /contact, /contact-us, /about, /about-us, /team (max 3 extra fetches, 6s timeout each, total budget 12s).
 * 4. Link-in-bio hubs found on the page (linktr.ee, beacons.ai, linkin.bio).
 *
 * Stops at the first confident hit.
 */
export async function runHandleDiscoveryWaterfall(
  input: WaterfallInput,
): Promise<WaterfallResult> {
  if (mockWaterfallRunner) {
    return await mockWaterfallRunner(input);
  }
  const stepsAttempted: HandleSource[] = [];
  const allCandidates: WaterfallCandidate[] = [];
  let discoveredSocialLinks: Record<string, string | null> = {};
  let discoveredLinkHubUrl: string | null = null;

  // -------------------------------------------------------------
  // STEP 1: Maps Actor Data & Social URL Interception
  // -------------------------------------------------------------
  stepsAttempted.push("maps");

  // Check mapsHandles
  if (input.mapsHandles && input.mapsHandles.length > 0) {
    for (const h of input.mapsHandles) {
      const valid = cleanAndValidateHandle(h);
      if (valid) {
        const candidate: WaterfallCandidate = {
          handle: valid,
          source: "maps",
          confidence: "high",
          frequency: 1,
          inHeaderFooter: true,
          matchScore: computeBusinessNameMatch(valid, input.businessName),
        };
        allCandidates.push(candidate);
        return {
          handle: valid,
          handleSource: "maps",
          handleConfidence: "high",
          stepsAttempted,
          candidates: allCandidates,
          socialLinks: input.mapsSocial ?? {},
        };
      }
    }
  }

  // Check mapsSocial
  if (input.mapsSocial?.instagram) {
    const valid = cleanAndValidateHandle(input.mapsSocial.instagram);
    if (valid) {
      const candidate: WaterfallCandidate = {
        handle: valid,
        source: "maps",
        confidence: "high",
        frequency: 1,
        inHeaderFooter: true,
        matchScore: computeBusinessNameMatch(valid, input.businessName),
      };
      allCandidates.push(candidate);
      return {
        handle: valid,
        handleSource: "maps",
        handleConfidence: "high",
        stepsAttempted,
        candidates: allCandidates,
        socialLinks: input.mapsSocial,
      };
    }
  }

  // Intercept social URLs given as website
  if (input.websiteUrl) {
    const socialCheck = isSocialOrAggregatorUrl(input.websiteUrl);
    if (socialCheck.isSocial) {
      // Facebook pages are stored as social links, never fetched as business websites
      if (socialCheck.platform === "facebook") {
        discoveredSocialLinks.facebook = input.websiteUrl;
        return {
          handle: null,
          handleSource: null,
          handleConfidence: null,
          stepsAttempted,
          candidates: allCandidates,
          socialLinks: { ...(input.mapsSocial ?? {}), ...discoveredSocialLinks },
          linkHubUrl: null,
        };
      }

      // Instagram profile URL is directly the handle
      if (socialCheck.platform === "instagram") {
        const parsed = socialCheck.cleanHandle ? cleanAndValidateHandle(socialCheck.cleanHandle) : null;
        if (parsed) {
          const candidate: WaterfallCandidate = {
            handle: parsed,
            source: "maps",
            confidence: "high",
            frequency: 1,
            inHeaderFooter: true,
            matchScore: 1.0,
          };
          allCandidates.push(candidate);
          discoveredSocialLinks.instagram = input.websiteUrl;
          return {
            handle: parsed,
            handleSource: "maps",
            handleConfidence: "high",
            stepsAttempted,
            candidates: allCandidates,
            socialLinks: { ...(input.mapsSocial ?? {}), ...discoveredSocialLinks },
            linkHubUrl: null,
          };
        }
      }

      // Link-in-bio hub (linktr.ee, beacons.ai, etc.): proceed directly to link hub step
      if (socialCheck.platform === "linkhub") {
        discoveredLinkHubUrl = input.websiteUrl;
      }
    }
  }

  // If no website URL, waterfall ends here
  if (!input.websiteUrl || typeof input.websiteUrl !== "string" || !input.websiteUrl.trim()) {
    return {
      handle: null,
      handleSource: null,
      handleConfidence: null,
      stepsAttempted,
      candidates: allCandidates,
      socialLinks: input.mapsSocial ?? {},
    };
  }

  const startTime = Date.now();
  const PER_SITE_BUDGET_MS = input.totalSiteBudgetMs ?? 15000;
  // 12s timeout for homepage, one retry on timeout; keep /contact & linkhub fallbacks
  const homepageTimeoutMs = input.timeoutPerFetchMs ?? 12000;
  const subpageTimeoutMs = Math.min(homepageTimeoutMs, 6000);

  const fetchWithRetries = async (
    rawUrl: string,
    timeout: number,
  ): Promise<{ ok: boolean; html?: string; finalUrl?: string; error?: string }> => {
    const first = await safeFetchHtml(rawUrl, timeout, 3);
    if (first.ok && first.html) return first;

    // Retry 1: Canonical URL without query string (strip ?utm_campaign=...)
    try {
      const parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      if (parsed.search) {
        const canonical = `${parsed.origin}${parsed.pathname}`;
        const canRes = await safeFetchHtml(canonical, timeout, 3);
        if (canRes.ok && canRes.html) return canRes;
      }
    } catch {
      // ignore
    }

    // Retry 2: Timeout retry
    if (first.error && /timeout|abort|ETIMEDOUT/i.test(first.error)) {
      const retryTimeout = await safeFetchHtml(rawUrl, timeout, 3);
      if (retryTimeout.ok && retryTimeout.html) return retryTimeout;
    }

    // Retry 3: Toggle www / non-www
    try {
      const parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      if (parsed.hostname.startsWith("www.")) {
        parsed.hostname = parsed.hostname.slice(4);
      } else {
        parsed.hostname = `www.${parsed.hostname}`;
      }
      if (parsed.hostname !== new URL(rawUrl).hostname) {
        const altRes = await safeFetchHtml(parsed.toString(), timeout, 3);
        if (altRes.ok && altRes.html) return altRes;
      }
    } catch {
      // ignore
    }

    return first;
  };

  const doFetch = async (url: string, toMs?: number) => {
    const timeout = toMs ?? homepageTimeoutMs;
    if (input.fetchFn) {
      const res = await input.fetchFn(url, timeout);
      if (res.ok && res.html) return res;
      // Also retry with canonical URL without query string in fetchFn (for tests/mocks)
      try {
        const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
        if (parsed.search) {
          const canonical = `${parsed.origin}${parsed.pathname}`;
          const retryRes = await input.fetchFn(canonical, timeout);
          if (retryRes.ok && retryRes.html) return retryRes;
        }
      } catch {
        // ignore
      }
      return res;
    }
    return await fetchWithRetries(url, timeout);
  };

  let pageMeta: { title: string | null; h1: string | null; ogSiteName: string | null } | null = null;
  let homepageHtmlContent: string | null = null;

  // -------------------------------------------------------------
  // STEP 2: Website Homepage (skipped if URL was a link hub)
  // -------------------------------------------------------------
  let homepageFetch: { ok: boolean; html?: string; finalUrl?: string; error?: string } = { ok: false };
  if (!discoveredLinkHubUrl) {
    stepsAttempted.push("homepage");
    homepageFetch = await doFetch(input.websiteUrl, homepageTimeoutMs);

    if (homepageFetch.ok && homepageFetch.html) {
      homepageHtmlContent = homepageFetch.html;
      pageMeta = extractTitleAndH1(homepageFetch.html);
      const parsed = parseHtmlForHandles(homepageFetch.html, input.businessName, "homepage");
      discoveredSocialLinks = { ...discoveredSocialLinks, ...parsed.socialLinks };
      discoveredLinkHubUrl = parsed.linkHubUrl;

      if (parsed.candidates.length > 0) {
        allCandidates.push(...parsed.candidates);
        const top = parsed.candidates[0];

        // Stop rule: if high confidence or clear match, return immediately
        if (top.confidence === "high" || (top.confidence === "medium" && top.matchScore >= 0.5)) {
          return {
            handle: top.handle,
            handleSource: "homepage",
            handleConfidence: top.confidence,
            stepsAttempted,
            candidates: allCandidates,
            socialLinks: { ...(input.mapsSocial ?? {}), ...discoveredSocialLinks },
            linkHubUrl: discoveredLinkHubUrl,
            homepageHtml: homepageHtmlContent,
            homepageTitle: pageMeta?.title ?? null,
            homepageH1: pageMeta?.h1 ?? null,
            ogSiteName: pageMeta?.ogSiteName ?? null,
          };
        }
      }
    }
  }

  // -------------------------------------------------------------
  // STEP 3: Same-Domain Subpages (/contact, /about, etc.)
  // Max 3 extra fetches, 6s timeout each, total budget 15s
  // -------------------------------------------------------------
  let baseUrl: URL | null = null;
  try {
    const raw = input.websiteUrl.startsWith("http")
      ? input.websiteUrl
      : `https://${input.websiteUrl}`;
    baseUrl = new URL(raw);
  } catch {
    baseUrl = null;
  }

  if (baseUrl && !discoveredLinkHubUrl) {
    stepsAttempted.push("contact_page");

    // Prioritize paths referenced on homepage HTML
    const foundPathsInHtml = new Set<string>();
    if (homepageFetch.html) {
      for (const p of CONTACT_PAGE_PATHS) {
        if (homepageFetch.html.includes(p)) {
          foundPathsInHtml.add(p);
        }
      }
    }

    const prioritizedPaths = [
      ...Array.from(foundPathsInHtml),
      ...CONTACT_PAGE_PATHS.filter((p) => !foundPathsInHtml.has(p)),
    ].slice(0, 3);

    const subpagesToFetch = prioritizedPaths.map((path) => {
      const u = new URL(path, baseUrl!.origin);
      return u.toString();
    });

    for (const subpageUrl of subpagesToFetch) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= PER_SITE_BUDGET_MS - 1500) {
        break; // Out of budget
      }

      const remainingBudget = Math.max(1000, Math.min(subpageTimeoutMs, PER_SITE_BUDGET_MS - elapsed));
      const subFetch = await doFetch(subpageUrl, remainingBudget);

      if (subFetch.ok && subFetch.html) {
        const parsed = parseHtmlForHandles(subFetch.html, input.businessName, "contact_page");
        if (parsed.linkHubUrl && !discoveredLinkHubUrl) {
          discoveredLinkHubUrl = parsed.linkHubUrl;
        }

        if (parsed.candidates.length > 0) {
          allCandidates.push(...parsed.candidates);
          const top = parsed.candidates[0];

          // Stop at first confident hit
          if (top.confidence === "high" || (top.confidence === "medium" && top.matchScore >= 0.5)) {
            return {
              handle: top.handle,
              handleSource: "contact_page",
              handleConfidence: top.confidence,
              stepsAttempted,
              candidates: allCandidates,
              socialLinks: { ...(input.mapsSocial ?? {}), ...discoveredSocialLinks, ...parsed.socialLinks },
              linkHubUrl: discoveredLinkHubUrl,
              homepageHtml: homepageHtmlContent,
              homepageTitle: pageMeta?.title ?? null,
              homepageH1: pageMeta?.h1 ?? null,
              ogSiteName: pageMeta?.ogSiteName ?? null,
            };
          }
        }
      }
    }
  }

  // -------------------------------------------------------------
  // STEP 4: Link-in-Bio Hubs (linktr.ee, beacons.ai, linkin.bio)
  // -------------------------------------------------------------
  if (discoveredLinkHubUrl) {
    const elapsed = Date.now() - startTime;
    if (elapsed < PER_SITE_BUDGET_MS - 2000) {
      stepsAttempted.push("linkhub");
      const remainingBudget = Math.max(1000, Math.min(subpageTimeoutMs, PER_SITE_BUDGET_MS - elapsed));
      const hubFetch = await doFetch(discoveredLinkHubUrl, remainingBudget);

      if (hubFetch.ok && hubFetch.html) {
        const parsed = parseHtmlForHandles(hubFetch.html, input.businessName, "linkhub");
        if (parsed.candidates.length > 0) {
          allCandidates.push(...parsed.candidates);
          const top = parsed.candidates[0];
          return {
            handle: top.handle,
            handleSource: "linkhub",
            handleConfidence: top.confidence === "low" ? "medium" : top.confidence,
            stepsAttempted,
            candidates: allCandidates,
            socialLinks: { ...(input.mapsSocial ?? {}), ...discoveredSocialLinks },
            linkHubUrl: discoveredLinkHubUrl,
            homepageHtml: homepageHtmlContent,
            homepageTitle: pageMeta?.title ?? null,
            homepageH1: pageMeta?.h1 ?? null,
            ogSiteName: pageMeta?.ogSiteName ?? null,
          };
        }
      }
    }
  }

  // If we collected candidates across any step, return the best candidate
  if (allCandidates.length > 0) {
    allCandidates.sort((a, b) => {
      const scoreA = a.matchScore * 10 + (a.inHeaderFooter ? 5 : 0) + a.frequency;
      const scoreB = b.matchScore * 10 + (b.inHeaderFooter ? 5 : 0) + b.frequency;
      return scoreB - scoreA;
    });

    const best = allCandidates[0];
    return {
      handle: best.handle,
      handleSource: best.source,
      handleConfidence: best.confidence,
      stepsAttempted,
      candidates: allCandidates,
      socialLinks: { ...(input.mapsSocial ?? {}), ...discoveredSocialLinks },
      linkHubUrl: discoveredLinkHubUrl,
      homepageHtml: homepageHtmlContent,
      homepageTitle: pageMeta?.title ?? null,
      homepageH1: pageMeta?.h1 ?? null,
      ogSiteName: pageMeta?.ogSiteName ?? null,
    };
  }

  return {
    handle: null,
    handleSource: null,
    handleConfidence: null,
    stepsAttempted,
    candidates: [],
    socialLinks: { ...(input.mapsSocial ?? {}), ...discoveredSocialLinks },
    linkHubUrl: discoveredLinkHubUrl,
    homepageHtml: homepageHtmlContent,
    homepageTitle: pageMeta?.title ?? null,
    homepageH1: pageMeta?.h1 ?? null,
    ogSiteName: pageMeta?.ogSiteName ?? null,
  };
}
