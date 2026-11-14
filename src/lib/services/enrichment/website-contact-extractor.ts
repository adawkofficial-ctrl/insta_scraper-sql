import {
  normalizeWebsite,
  computeAvailableChannels,
  extractAllEmails,
  extractAllPhones,
  extractWhatsappLinks,
  normalizePhoneToE164,
} from "../contact/contact-parser";
import {
  isSocialOrSharedPlatform,
  detectSocialPlatform,
} from "@/lib/constants/social-platforms";
import { scrapeLeadWebsite } from "./website-lead-enricher";
import { resolveCountryCode } from "../discovery/country-cities";
import { getPrismaClient } from "@/lib/db/prisma";
import { withLeadChannelFlags } from "../lead/lead-channels";
import { Prisma } from "@/generated/prisma/client";
import type { LeadProfile } from "@/lib/types";

/**
 * Checks if a URL points to localhost or private IP ranges (SSRF protection).
 */
export function isPrivateOrBlockedUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
      return true;
    }

    // IPv4 private & loopback ranges:
    // 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16
    const ipv4Match = hostname.match(
      /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
    );
    if (ipv4Match) {
      const b0 = parseInt(ipv4Match[1], 10);
      const b1 = parseInt(ipv4Match[2], 10);
      if (b0 === 10 || b0 === 127 || b0 === 0) return true;
      if (b0 === 169 && b1 === 254) return true;
      if (b0 === 192 && b1 === 168) return true;
      if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Worker pool helper for bounded concurrency.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await fn(items[currentIndex]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

export type ExtractedSocialLinks = {
  instagram?: string | null;
  facebook?: string | null;
  tiktok?: string | null;
  linkedin?: string | null;
  youtube?: string | null;
  whatsapp?: string | null;
};

export function extractSocialLinksFromHtml(html: string): ExtractedSocialLinks {
  if (!html || typeof html !== "string") {
    return {};
  }

  const result: ExtractedSocialLinks = {};

  // Facebook
  const fbRegex =
    /href=["'](https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com|fb\.me)\/[^"'#\s<>]+)["']/i;
  const fbMatch = fbRegex.exec(html);
  if (fbMatch) {
    const raw = fbMatch[1].trim();
    if (!raw.includes("/sharer") && !raw.includes("/share") && !raw.includes("/dialog")) {
      result.facebook = raw;
    }
  }

  // TikTok
  const ttRegex =
    /href=["'](https?:\/\/(?:www\.)?tiktok\.com\/@[^"'#\s<>]+)["']/i;
  const ttMatch = ttRegex.exec(html);
  if (ttMatch) {
    result.tiktok = ttMatch[1].trim();
  }

  // LinkedIn
  const liRegex =
    /href=["'](https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^"'#\s<>]+)["']/i;
  const liMatch = liRegex.exec(html);
  if (liMatch) {
    result.linkedin = liMatch[1].trim();
  }

  // YouTube
  const ytRegex =
    /href=["'](https?:\/\/(?:www\.)?(?:youtube\.com\/(?:c\/|user\/|@)?|youtu\.be\/)[^"'#\s<>]+)["']/i;
  const ytMatch = ytRegex.exec(html);
  if (ytMatch) {
    const raw = ytMatch[1].trim();
    if (!raw.includes("/watch?") && !raw.includes("/embed/")) {
      result.youtube = raw;
    }
  }

  // WhatsApp
  const waRegex =
    /href=["'](https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)[^"'#\s<>]+)["']/i;
  const waMatch = waRegex.exec(html);
  if (waMatch) {
    result.whatsapp = waMatch[1].trim();
  }

  return result;
}

export type ContactSourceType = "bio" | "website" | "maps";

export type ExtractedEmailItem = {
  value: string;
  source: ContactSourceType;
};

export type ExtractedPhoneItem = {
  value: string;
  normalized: string;
  source: ContactSourceType;
};

export type ExtractedWhatsappItem = {
  url: string;
  phone?: string;
  source: ContactSourceType;
};

export type LeadContactsData = {
  emails: ExtractedEmailItem[];
  phones: ExtractedPhoneItem[];
  whatsapps: ExtractedWhatsappItem[];
  socialLinks: {
    facebook?: string | null;
    tiktok?: string | null;
    linkedin?: string | null;
    youtube?: string | null;
  };
  extractedAt: string;
};

export type WebsiteContactResult = {
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  website: string;
  websiteDomain: string | null;
  contactSource: "website_fallback" | null;
};

export const WEBSITE_EXTRACT_TIMEOUT_MS = 6000;
export const WEBSITE_EXTRACT_MAX_BYTES = 1024 * 1024; // 1 MB
export const WEBSITE_EXTRACT_CONCURRENCY = 5;

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
 * Safely fetches a single webpage with SSRF guard, 6s timeout, and 1 MB stream cap.
 */
export async function fetchPageSafe(
  url: string,
  timeoutMs = WEBSITE_EXTRACT_TIMEOUT_MS,
): Promise<string | null> {
  if (!url || isPrivateOrBlockedUrl(url)) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    if (!res.ok) {
      return null;
    }

    if (res.url && isPrivateOrBlockedUrl(res.url)) {
      return null;
    }

    const contentType = res.headers.get("content-type") || "";
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml") &&
      !contentType.includes("text/plain")
    ) {
      return null;
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > WEBSITE_EXTRACT_MAX_BYTES * 2) {
      return null;
    }

    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          totalBytes += value.length;
          if (totalBytes >= WEBSITE_EXTRACT_MAX_BYTES) {
            reader.cancel().catch(() => {});
            break;
          }
        }
      }

      const decoder = new TextDecoder("utf-8");
      return decoder.decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    } else {
      const text = await res.text();
      return text.slice(0, WEBSITE_EXTRACT_MAX_BYTES);
    }
  } catch {
    return null;
  }
}

/**
 * Fetches homepage + contact page (at most 2 pages) for a clinic website.
 */
export async function fetchWebsiteContactPages(
  websiteUrl: string,
  timeoutMs = WEBSITE_EXTRACT_TIMEOUT_MS,
): Promise<{
  homeHtml: string | null;
  contactHtml: string | null;
  effectiveUrl: string | null;
}> {
  if (!websiteUrl || isSocialOrSharedPlatform(websiteUrl)) {
    return { homeHtml: null, contactHtml: null, effectiveUrl: null };
  }

  const norm = normalizeWebsite(websiteUrl);
  if (!norm || isSocialOrSharedPlatform(norm.domain)) {
    return { homeHtml: null, contactHtml: null, effectiveUrl: null };
  }

  // 1. Homepage
  const homeHtml = await fetchPageSafe(norm.url, timeoutMs);
  let contactHtml: string | null = null;

  if (homeHtml) {
    // 2. Discover subpage from homepage HTML or fallback to /contact
    const subpages = findContactSubpageUrls(homeHtml, norm.url);
    const candidateSubpage =
      subpages.length > 0
        ? subpages[0]
        : `${norm.rootUrl}/contact`;

    if (candidateSubpage && candidateSubpage !== norm.url && candidateSubpage !== `${norm.rootUrl}/`) {
      contactHtml = await fetchPageSafe(candidateSubpage, timeoutMs);
    }
  }

  return {
    homeHtml,
    contactHtml,
    effectiveUrl: norm.rootUrl ?? norm.url,
  };
}

/**
 * Pure contact extractor across Instagram bio, externalUrl, and clinic website pages.
 * Keeps source of each value: bio | website | maps.
 */
export async function extractLeadContacts(input: {
  bio?: string | null;
  externalUrl?: string | null;
  website?: string | null;
  mapsPhone?: string | null;
  mapsWebsite?: string | null;
  countryCode?: string;
  timeoutMs?: number;
}): Promise<LeadContactsData> {
  const country = (input.countryCode || "CA").toUpperCase();
  const timeoutMs = input.timeoutMs ?? WEBSITE_EXTRACT_TIMEOUT_MS;

  const emailsMap = new Map<string, ExtractedEmailItem>();
  const phonesMap = new Map<string, ExtractedPhoneItem>(); // keyed by normalized E.164
  const whatsappsMap = new Map<string, ExtractedWhatsappItem>(); // keyed by url
  const socialLinks: {
    facebook?: string | null;
    tiktok?: string | null;
    linkedin?: string | null;
    youtube?: string | null;
  } = {};

  // 1. Google Maps phone
  if (input.mapsPhone && typeof input.mapsPhone === "string" && input.mapsPhone.trim()) {
    const normPhone = normalizePhoneToE164(input.mapsPhone, country);
    if (normPhone) {
      phonesMap.set(normPhone, {
        value: input.mapsPhone.trim(),
        normalized: normPhone,
        source: "maps",
      });
    }
  }

  // 2. Instagram bio
  if (input.bio && typeof input.bio === "string" && input.bio.trim()) {
    const bioText = input.bio;

    // Emails from bio
    for (const em of extractAllEmails(bioText)) {
      if (!emailsMap.has(em)) {
        emailsMap.set(em, { value: em, source: "bio" });
      }
    }

    // Phones from bio
    for (const ph of extractAllPhones(bioText, country)) {
      if (!phonesMap.has(ph.normalized)) {
        phonesMap.set(ph.normalized, {
          value: ph.raw,
          normalized: ph.normalized,
          source: "bio",
        });
      }
    }

    // WhatsApp from bio
    for (const wa of extractWhatsappLinks(bioText)) {
      if (!whatsappsMap.has(wa.url)) {
        whatsappsMap.set(wa.url, {
          url: wa.url,
          phone: wa.phone,
          source: "bio",
        });
      }
    }
  }

  // 3. External URL (from bio or profile)
  if (input.externalUrl && typeof input.externalUrl === "string" && input.externalUrl.trim()) {
    const extUrl = input.externalUrl.trim();

    // Check WhatsApp link
    for (const wa of extractWhatsappLinks(extUrl)) {
      if (!whatsappsMap.has(wa.url)) {
        whatsappsMap.set(wa.url, {
          url: wa.url,
          phone: wa.phone,
          source: "bio",
        });
      }
    }

    // Check Social link
    const detectedSocial = detectSocialPlatform(extUrl);
    if (detectedSocial) {
      const plat = detectedSocial.platform as keyof typeof socialLinks;
      if (plat in socialLinks && !socialLinks[plat]) {
        socialLinks[plat] = detectedSocial.url;
      }
    }
  }

  // 4. Clinic website homepage + /contact page (max 2 pages)
  const candidateWebsite =
    input.website ||
    input.mapsWebsite ||
    (!isSocialOrSharedPlatform(input.externalUrl ?? "") ? input.externalUrl : null);

  if (candidateWebsite && typeof candidateWebsite === "string" && candidateWebsite.trim()) {
    const { homeHtml, contactHtml } = await fetchWebsiteContactPages(
      candidateWebsite.trim(),
      timeoutMs,
    );

    const pages = [homeHtml, contactHtml].filter((p): p is string => Boolean(p));

    for (const html of pages) {
      // Social links from HTML
      const socials = extractSocialLinksFromHtml(html);
      if (socials.facebook && !socialLinks.facebook) socialLinks.facebook = socials.facebook;
      if (socials.tiktok && !socialLinks.tiktok) socialLinks.tiktok = socials.tiktok;
      if (socials.linkedin && !socialLinks.linkedin) socialLinks.linkedin = socials.linkedin;
      if (socials.youtube && !socialLinks.youtube) socialLinks.youtube = socials.youtube;
      if (socials.whatsapp && !whatsappsMap.has(socials.whatsapp)) {
        whatsappsMap.set(socials.whatsapp, {
          url: socials.whatsapp,
          source: "website",
        });
      }

      // WhatsApp links
      for (const wa of extractWhatsappLinks(html)) {
        if (!whatsappsMap.has(wa.url)) {
          whatsappsMap.set(wa.url, {
            url: wa.url,
            phone: wa.phone,
            source: "website",
          });
        }
      }

      // Emails from HTML
      for (const em of extractAllEmails(html)) {
        if (!emailsMap.has(em)) {
          emailsMap.set(em, { value: em, source: "website" });
        }
      }

      // Phones from HTML
      for (const ph of extractAllPhones(html, country)) {
        if (!phonesMap.has(ph.normalized)) {
          phonesMap.set(ph.normalized, {
            value: ph.raw,
            normalized: ph.normalized,
            source: "website",
          });
        }
      }
    }
  }

  return {
    emails: Array.from(emailsMap.values()),
    phones: Array.from(phonesMap.values()),
    whatsapps: Array.from(whatsappsMap.values()),
    socialLinks,
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Stage 3 contact enrichment across accepted leads.
 * Uses bounded concurrency 5, 6s timeout, max 2 pages per lead.
 */
export async function enrichProfilesWithContacts(
  profiles: LeadProfile[],
  options?: {
    countryCode?: string;
    timeoutMs?: number;
    concurrency?: number;
  },
): Promise<{
  enrichedProfiles: LeadProfile[];
  contactsExtracted: {
    email: number;
    phone: number;
    whatsapp: number;
    other: number;
  };
  leadsWithAnyContact: number;
}> {
  const concurrency = options?.concurrency ?? WEBSITE_EXTRACT_CONCURRENCY;
  const timeoutMs = options?.timeoutMs ?? WEBSITE_EXTRACT_TIMEOUT_MS;
  const countryCode = options?.countryCode ?? "CA";

  const contactsExtracted = {
    email: 0,
    phone: 0,
    whatsapp: 0,
    other: 0,
  };
  let leadsWithAnyContact = 0;

  await runWithConcurrency(profiles, concurrency, async (profile) => {
    try {
      const rawObj =
        typeof profile.rawProfileData === "object" && profile.rawProfileData !== null
          ? (profile.rawProfileData as Record<string, unknown>)
          : {};

      const contacts = await extractLeadContacts({
        bio: profile.biography ?? profile.bio,
        externalUrl: profile.externalUrl,
        website: profile.website,
        mapsPhone: profile.phone ?? (rawObj.phone as string | undefined),
        mapsWebsite: (rawObj.website as string | undefined),
        countryCode,
        timeoutMs,
      });

      // Free website scraper: also discovers Instagram and other socials from
      // anchors (incl. image-only), meta tags, JSON-LD, header/footer blocks,
      // and up to 4 same-domain pages.
      const websiteForScrape =
        profile.website ||
        profile.externalUrl ||
        (typeof rawObj.website === "string" ? rawObj.website : null);
      let websiteScrape: Awaited<ReturnType<typeof scrapeLeadWebsite>> | null = null;
      if (websiteForScrape) {
        try {
          websiteScrape = await scrapeLeadWebsite({
            website: websiteForScrape,
            businessName: profile.fullName,
            countryCode,
          });
        } catch {
          // Non-fatal per-lead website failure
        }
      }

      // Update lead profile contact fields
      if (contacts.phones.length > 0) {
        profile.phone = contacts.phones[0].value;
        profile.phoneNormalized = contacts.phones[0].normalized;
      }
      if (contacts.emails.length > 0) {
        profile.email = contacts.emails[0].value;
        profile.emailNormalized = contacts.emails[0].value;
      }
      if (!profile.website && (profile.externalUrl || rawObj.website)) {
        const norm = normalizeWebsite(profile.website || (rawObj.website as string) || profile.externalUrl);
        if (norm && !isSocialOrSharedPlatform(norm.domain)) {
          profile.website = norm.rootUrl;
          profile.websiteDomain = norm.domain;
        }
      }

      if (websiteScrape) {
        if (!profile.username && websiteScrape.handle) {
          profile.username = websiteScrape.handle;
          profile.instagramUsername = websiteScrape.handle;
          profile.profileUrl = `https://www.instagram.com/${websiteScrape.handle}/`;
          profile.handleSource = "homepage";
          profile.handleConfidence = websiteScrape.handleConfidence;
        }
        if (websiteScrape.socialLinks) {
          profile.socialLinks = {
            ...(profile.socialLinks ?? {}),
            ...Object.fromEntries(
              Object.entries(websiteScrape.socialLinks).filter(([, value]) => Boolean(value)),
            ),
          };
        }
        if (!profile.email && websiteScrape.emails[0]) {
          profile.email = websiteScrape.emails[0].value;
          profile.emailNormalized = websiteScrape.emails[0].value.toLowerCase();
        }
        if (!profile.phone && websiteScrape.phones[0]) {
          profile.phone = websiteScrape.phones[0].value;
          profile.phoneNormalized = websiteScrape.phones[0].normalized;
        }
      }

      // Track primary contact source
      profile.contactSource =
        contacts.phones[0]?.source ??
        contacts.emails[0]?.source ??
        contacts.whatsapps[0]?.source ??
        profile.contactSource ??
        null;

      // Update availableChannels
      profile.availableChannels = computeAvailableChannels({
        hasInstagram: Boolean(profile.username),
        email: profile.email,
        phone: profile.phone,
        whatsapp: contacts.whatsapps[0]?.url ?? websiteScrape?.whatsapp ?? null,
        website: profile.website,
      });
      if (
        Object.values(profile.socialLinks ?? {}).some(
          (value) => typeof value === "string" && value,
        ) &&
        !profile.availableChannels.includes("SOCIAL")
      ) {
        profile.availableChannels.push("SOCIAL");
      }

      // Persist in rawProfileData.contacts
      profile.rawProfileData = {
        ...rawObj,
        contacts,
      };

      // Accumulate counts
      contactsExtracted.email += contacts.emails.length;
      contactsExtracted.phone += contacts.phones.length;
      contactsExtracted.whatsapp += contacts.whatsapps.length;
      const otherCount = Object.values(contacts.socialLinks).filter(Boolean).length;
      contactsExtracted.other += otherCount;

      if (
        contacts.emails.length > 0 ||
        contacts.phones.length > 0 ||
        contacts.whatsapps.length > 0
      ) {
        leadsWithAnyContact++;
      }
    } catch {
      // Non-fatal per-lead failure
    }
  });

  return {
    enrichedProfiles: profiles,
    contactsExtracted,
    leadsWithAnyContact,
  };
}

/**
 * On-demand manual contact extraction for single or bulk leads.
 */
export async function extractContactsForLeadsOnDemand(params: {
  leadIds: string[];
  userId: string;
}): Promise<{
  success: boolean;
  count: number;
  leads: Array<{
    id: string;
    phone: string | null;
    phoneNormalized: string | null;
    email: string | null;
    website: string | null;
    contacts: LeadContactsData;
  }>;
}> {
  const { leadIds, userId } = params;
  const prisma = getPrismaClient();

  const leads = await prisma.lead.findMany({
    where: {
      id: { in: leadIds },
      ...(userId ? { campaign: { userId } } : {}),
    },
    include: {
      campaign: {
        select: {
          id: true,
          location: true,
          userId: true,
        },
      },
    },
  });

  const updatedResults: Array<{
    id: string;
    phone: string | null;
    phoneNormalized: string | null;
    email: string | null;
    website: string | null;
    contacts: LeadContactsData;
  }> = [];

  await runWithConcurrency(leads, WEBSITE_EXTRACT_CONCURRENCY, async (lead) => {
    const countryCode =
      resolveCountryCode(lead.campaign?.location) ?? "CA";

    const rawObj =
      typeof lead.rawProfileData === "object" && lead.rawProfileData !== null
        ? (lead.rawProfileData as Record<string, unknown>)
        : {};

    const contacts = await extractLeadContacts({
      bio: lead.biography,
      externalUrl: lead.externalUrl,
      website: lead.website,
      mapsPhone: (rawObj.phone as string | undefined) ?? lead.phone,
      mapsWebsite: (rawObj.website as string | undefined),
      countryCode,
      timeoutMs: WEBSITE_EXTRACT_TIMEOUT_MS,
    });

    const bestPhone = contacts.phones[0]?.value ?? lead.phone;
    const bestPhoneNormalized = contacts.phones[0]?.normalized ?? lead.phoneNormalized;
    const bestEmail = contacts.emails[0]?.value ?? lead.email;
    const bestEmailNormalized = contacts.emails[0]?.value ?? lead.emailNormalized;

    let targetWebsite = lead.website;
    let targetDomain = lead.websiteDomain;
    if (!targetWebsite && (lead.externalUrl || rawObj.website)) {
      const norm = normalizeWebsite(lead.website || (rawObj.website as string) || lead.externalUrl);
      if (norm && !isSocialOrSharedPlatform(norm.domain)) {
        targetWebsite = norm.rootUrl;
        targetDomain = norm.domain;
      }
    }

    const contactSource =
      contacts.phones[0]?.source ??
      contacts.emails[0]?.source ??
      contacts.whatsapps[0]?.source ??
      lead.contactSource ??
      null;

    const availableChannels = computeAvailableChannels({
      hasInstagram: true,
      email: bestEmail,
      phone: bestPhone,
    });

    const updatedRaw = {
      ...rawObj,
      contacts,
    };

    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        phone: bestPhone,
        phoneNormalized: bestPhoneNormalized,
        email: bestEmail,
        emailNormalized: bestEmailNormalized,
        website: targetWebsite,
        websiteDomain: targetDomain,
        contactSource,
        ...withLeadChannelFlags(availableChannels),
        rawProfileData: updatedRaw as Prisma.InputJsonValue,
      },
    });

    updatedResults.push({
      id: lead.id,
      phone: bestPhone,
      phoneNormalized: bestPhoneNormalized,
      email: bestEmail,
      website: targetWebsite,
      contacts,
    });
  });

  return {
    success: true,
    count: updatedResults.length,
    leads: updatedResults,
  };
}

/**
 * Backward compatibility wrapper.
 */
export function extractContactsFromHtml(html: string): {
  email: string | null;
  phone: string | null;
} {
  const emails = extractAllEmails(html);
  const phones = extractAllPhones(html);
  return {
    email: emails[0] ?? null,
    phone: phones[0]?.raw ?? null,
  };
}

export async function extractContactsFromWebsite(
  rawUrl: string,
  options?: { timeoutMs?: number },
): Promise<WebsiteContactResult> {
  const contacts = await extractLeadContacts({
    website: rawUrl,
    timeoutMs: options?.timeoutMs,
  });

  const norm = normalizeWebsite(rawUrl);
  return {
    email: contacts.emails[0]?.value ?? null,
    emailNormalized: contacts.emails[0]?.value ?? null,
    phone: contacts.phones[0]?.value ?? null,
    phoneNormalized: contacts.phones[0]?.normalized ?? null,
    website: norm?.rootUrl ?? rawUrl,
    websiteDomain: norm?.domain ?? null,
    contactSource:
      contacts.emails.length > 0 || contacts.phones.length > 0
        ? "website_fallback"
        : null,
  };
}

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

    if (!hasEmail && !hasPhone && targetUrl && targetUrl.trim().length > 0) {
      if (fetchesAttempted >= maxFetches) {
        break;
      }

      fetchesAttempted++;
      try {
        const result = await extractContactsFromWebsite(targetUrl, {
          timeoutMs: options?.timeoutMs ?? WEBSITE_EXTRACT_TIMEOUT_MS,
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
