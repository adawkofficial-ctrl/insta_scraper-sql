/**
 * Pure contact parsing and normalization utilities for Instagram profiles and web pages.
 * Supports email, international and Pakistani phone numbers (+92, 03XX-XXXXXXX), and websites.
 */

import { detectSocialPlatform } from "@/lib/constants/social-platforms";

// Matches standard email addresses. Trailing punctuation is stripped.
const EMAIL_REGEX =
  /(?:^|[\s,;:<>()"'[\]])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:$|[\s,;:?()<>"'[\]])/;

const EMAIL_GLOBAL_REGEX =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;

const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|css|js|woff2?)$/i;

const JUNK_EMAIL_DOMAINS = [
  "sentry.io",
  "sentry",
  "wixpress.com",
  "wixpress",
  "wix.com",
  "wordpress.com",
  "wordpress.org",
  "domain.com",
  "example.org",
  "example.net",
  "yoursite.com",
  "mywebsite.com",
  "sitename.com",
];

/**
 * Checks if an email is obvious junk:
 * - Image/asset file names (.png, .jpg, etc.)
 * - Example/test/noreply prefixes (example@, noreply@, test@, sample@, user@, do-not-reply@)
 * - Sentry / Wixpress / generic mock domains
 */
export function isJunkEmail(email: string | null | undefined): boolean {
  if (!email || typeof email !== "string") {
    return true;
  }
  const clean = email.trim().toLowerCase();
  if (clean.length < 6 || !clean.includes("@")) {
    return true;
  }

  // Image/asset file extensions
  if (IMAGE_EXTENSION_REGEX.test(clean)) {
    return true;
  }

  const parts = clean.split("@");
  if (parts.length !== 2) {
    return true;
  }
  const [localPart, domainPart] = parts;
  if (!localPart || !domainPart || !domainPart.includes(".")) {
    return true;
  }

  // Junk prefixes
  if (
    localPart === "example" ||
    localPart === "test" ||
    localPart === "sample" ||
    localPart === "user" ||
    localPart === "noreply" ||
    localPart === "no-reply" ||
    localPart === "donotreply" ||
    localPart === "do-not-reply" ||
    localPart.startsWith("noreply") ||
    localPart.startsWith("no-reply") ||
    localPart.startsWith("donotreply") ||
    localPart.startsWith("do-not-reply")
  ) {
    return true;
  }

  // Sentry / Wixpress / generic dummy domains
  for (const junkDomain of JUNK_EMAIL_DOMAINS) {
    if (domainPart === junkDomain || domainPart.includes(junkDomain)) {
      return true;
    }
  }

  return false;
}

/**
 * Common phone patterns:
 * 1. International with '+': e.g. +92 300 1234567, +1-800-555-0199, +44 20 7946 0991
 * 2. International with '00': e.g. 0092 300 1234567
 * 3. North American standard: (416) 555-0199, 416-555-0199, 1-800-555-0199
 * 4. Pakistani mobile: 03XX-XXXXXXX, 03XXXXXXXXX (11 digits)
 * 5. Pakistani landline: 051-XXXXXXX, 042-XXXXXXX (area code + 7-8 digits)
 * 6. General formatted phone with words like 'call', 'tel', 'phone', 'ph', 'whatsapp', 'wa':
 */
const PHONE_LOOKUP_REGEXES = [
  // Explicit marker prefix: "WA: 03001234567", "Call: +92...", "Contact: 0321-1234567"
  /(?:whatsapp|wa|ph(?:one)?|call|tel|contact|cell|mobile|cel)[\s:.-]*([+]?[\d\s().-]{7,20}\d)/i,
  // North American standard with optional 1 prefix: 1-416-555-0199, (416) 555-0199, 416.555.0199
  /(?:^|[\s,;:(])(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})(?:$|[\s,;:?)])/i,
  // International format with '+' or '00': +92 300 1234567, +1 (555) 123-4567, 0092-300-1234567
  /(?:\+|00)\d{1,4}[\s().-]?\(?\d{1,5}\)?[\s().-]?\d{2,5}[\s().-]?\d{3,6}/,
  // Pakistani mobile: 03\d{2}[-.\s]?\d{7}
  /(?:^|[\s,;:(])(03\d{2}[-.\s]?\d{7})(?:$|[\s,;:?)])/i,
  // Pakistani landline (021, 042, 051, etc.): 0\d{2,3}[-.\s]?\d{6,8}
  /(?:^|[\s,;:(])(0(?:21|42|51|91|81|61|71)\d?[-.\s]?\d{6,8})(?:$|[\s,;:?)])/i,
];

export function extractEmail(text: string | null | undefined): string | null {
  if (!text || typeof text !== "string") {
    return null;
  }

  // Look for mailto: links first
  const mailtoMatch = text.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  if (mailtoMatch && mailtoMatch[1]) {
    const candidate = mailtoMatch[1].trim();
    if (!isJunkEmail(candidate)) {
      return candidate.toLowerCase();
    }
  }

  const match = text.match(EMAIL_REGEX);
  if (!match || !match[1]) {
    return null;
  }

  const candidate = match[1].trim().replace(/[.,;:]+$/, "");
  if (isJunkEmail(candidate)) {
    return null;
  }

  return candidate.length >= 6 ? candidate.toLowerCase() : null;
}

/**
 * Extracts and deduplicates all non-junk lowercase emails from raw text or HTML.
 */
export function extractAllEmails(text: string | null | undefined): string[] {
  if (!text || typeof text !== "string") {
    return [];
  }

  const emails: string[] = [];
  const seen = new Set<string>();

  // 1. Mailto links
  const mailtoRegex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let mMatch: RegExpExecArray | null;
  while ((mMatch = mailtoRegex.exec(text)) !== null) {
    const clean = mMatch[1].trim().toLowerCase();
    if (!isJunkEmail(clean) && !seen.has(clean)) {
      seen.add(clean);
      emails.push(clean);
    }
  }

  // 2. All text email matches
  let match: RegExpExecArray | null;
  while ((match = EMAIL_GLOBAL_REGEX.exec(text)) !== null) {
    const clean = match[0].trim().replace(/[.,;:]+$/, "").toLowerCase();
    if (!isJunkEmail(clean) && !seen.has(clean)) {
      seen.add(clean);
      emails.push(clean);
    }
  }

  return emails;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") {
    return null;
  }
  const clean = email.trim().toLowerCase();
  if (isJunkEmail(clean)) {
    return null;
  }
  return clean;
}

export function extractPhone(text: string | null | undefined): string | null {
  if (!text || typeof text !== "string") {
    return null;
  }

  // Check tel: links first
  const telMatch = text.match(/tel:([+]?[\d\s().-]{7,20})/i);
  if (telMatch && telMatch[1]) {
    const normalized = normalizePhone(telMatch[1]);
    if (normalized) {
      return telMatch[1].trim();
    }
  }

  for (const regex of PHONE_LOOKUP_REGEXES) {
    const match = text.match(regex);
    if (match) {
      const rawCandidate = (match[1] ?? match[0]).trim();
      const normalized = normalizePhone(rawCandidate);
      if (normalized) {
        return rawCandidate;
      }
    }
  }

  return null;
}

/**
 * Normalizes phone numbers to E.164 using the campaign country code (default 'CA').
 * E.g., for CA/US: (416) 555-0199 -> +14165550199
 * E.g., for PK: 03001234567 -> +923001234567
 * E.g., for GB: 07123456789 -> +447123456789
 */
export function normalizePhoneToE164(
  raw: string | null | undefined,
  countryCode = "CA",
): string | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  let cleaned = raw.trim();

  // Guard against years (e.g. 2024, 2025, 2026), prices, or short numbers
  if (/^\d{4}$/.test(cleaned) || /^(19|20)\d{2}$/.test(cleaned)) {
    return null;
  }

  // Convert leading 00 to +
  if (cleaned.startsWith("00")) {
    cleaned = "+" + cleaned.slice(2);
  }

  const hasPlus = cleaned.startsWith("+");
  const digits = cleaned.replace(/\D/g, "");

  // Must have 7 to 15 digits according to E.164 standard
  if (digits.length < 7 || digits.length > 15) {
    return null;
  }

  if (hasPlus) {
    return `+${digits}`;
  }

  // Pakistani mobile standard: 03XXXXXXXXX (11 digits) -> +923XXXXXXXXX
  if (!hasPlus && digits.length === 11 && digits.startsWith("03")) {
    return `+92${digits.slice(1)}`;
  }

  // Pakistani landline: 051XXXXXXX (10 digits) -> +9251XXXXXXX
  if (!hasPlus && digits.length === 10 && digits.startsWith("051")) {
    return `+9251${digits.slice(3)}`;
  }

  const code = (countryCode || "CA").toUpperCase();

  // North America (US / CA) -> Country code +1
  if (code === "CA" || code === "US") {
    if (digits.length === 10) {
      return `+1${digits}`;
    }
    if (digits.length === 11 && digits.startsWith("1")) {
      return `+${digits}`;
    }
  }

  // Pakistan (PK) -> Country code +92
  if (code === "PK") {
    if (digits.length === 11 && digits.startsWith("03")) {
      return `+92${digits.slice(1)}`;
    }
    if (digits.length === 10 && digits.startsWith("0")) {
      return `+92${digits.slice(1)}`;
    }
    if (digits.length === 10 && digits.startsWith("3")) {
      return `+92${digits}`;
    }
    if (digits.length === 12 && digits.startsWith("92")) {
      return `+${digits}`;
    }
  }

  // United Kingdom (GB / UK) -> Country code +44
  if (code === "GB" || code === "UK") {
    if (digits.startsWith("0")) {
      return `+44${digits.slice(1)}`;
    }
    if (digits.startsWith("44")) {
      return `+${digits}`;
    }
  }

  // Australia (AU) -> Country code +61
  if (code === "AU") {
    if (digits.startsWith("0")) {
      return `+61${digits.slice(1)}`;
    }
    if (digits.startsWith("61")) {
      return `+${digits}`;
    }
  }

  // Default fallback for 10 digits in North American context
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  return `+${digits}`;
}

/**
 * Extracts and deduplicates all phone numbers normalized to E.164 from raw text or HTML.
 */
export function extractAllPhones(
  text: string | null | undefined,
  countryCode = "CA",
): Array<{ raw: string; normalized: string }> {
  if (!text || typeof text !== "string") {
    return [];
  }

  const results: Array<{ raw: string; normalized: string }> = [];
  const seenNormalized = new Set<string>();

  // 1. Tel links
  const telRegex = /tel:([+]?[\d\s().-]{7,20})/gi;
  let tMatch: RegExpExecArray | null;
  while ((tMatch = telRegex.exec(text)) !== null) {
    const raw = tMatch[1].trim();
    const normalized = normalizePhoneToE164(raw, countryCode);
    if (normalized && !seenNormalized.has(normalized)) {
      seenNormalized.add(normalized);
      results.push({ raw, normalized });
    }
  }

  // 2. North American formatted phones
  const naRegex = /(?:^|[\s,;:(])(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})(?:$|[\s,;:?)])/gi;
  let naMatch: RegExpExecArray | null;
  while ((naMatch = naRegex.exec(text)) !== null) {
    const raw = naMatch[0].trim();
    const normalized = normalizePhoneToE164(raw, countryCode);
    if (normalized && !seenNormalized.has(normalized)) {
      seenNormalized.add(normalized);
      results.push({ raw, normalized });
    }
  }

  // 3. Fallback regexes
  for (const regex of PHONE_LOOKUP_REGEXES) {
    const pMatch = text.match(regex);
    if (pMatch) {
      const raw = (pMatch[1] ?? pMatch[0]).trim();
      const normalized = normalizePhoneToE164(raw, countryCode);
      if (normalized && !seenNormalized.has(normalized)) {
        seenNormalized.add(normalized);
        results.push({ raw, normalized });
      }
    }
  }

  return results;
}

/**
 * Extracts WhatsApp links (wa.me / api.whatsapp.com) from text or HTML.
 */
export function extractWhatsappLinks(
  text: string | null | undefined,
): Array<{ url: string; phone?: string }> {
  if (!text || typeof text !== "string") {
    return [];
  }

  const results: Array<{ url: string; phone?: string }> = [];
  const seen = new Set<string>();

  // Regex matching wa.me/... and api.whatsapp.com/send...
  const waRegex =
    /(?:https?:\/\/)?(?:wa\.me\/|api\.whatsapp\.com\/send\?(?:[^"'#\s<>]*&)?phone=)([0-9+]+)[^"'#\s<>]*/gi;

  let match: RegExpExecArray | null;
  while ((match = waRegex.exec(text)) !== null) {
    let rawUrl = match[0].trim();
    if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
      rawUrl = `https://${rawUrl}`;
    }
    const phoneDigits = match[1] ? match[1].replace(/\D/g, "") : undefined;
    const phone = phoneDigits && phoneDigits.length >= 7 ? `+${phoneDigits}` : undefined;

    if (!seen.has(rawUrl)) {
      seen.add(rawUrl);
      results.push({ url: rawUrl, phone });
    }
  }

  return results;
}

/**
 * Normalizes phone numbers (legacy helper).
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  return normalizePhoneToE164(raw, "CA");
}

export function normalizeWebsite(raw: string | null | undefined): {
  url: string;
  domain: string;
  rootUrl: string;
} | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  let trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  try {
    const parsed = new URL(trimmed);
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!domain || !domain.includes(".")) {
      return null;
    }
    const rootUrl = `https://${domain}`;
    return {
      url: parsed.href,
      domain,
      rootUrl,
    };
  } catch {
    return null;
  }
}

export type ExtractedContact = {
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  website: string | null;
  websiteDomain: string | null;
  socialLink: string | null;
  socialPlatform: string | null;
  contactSource: "instagram_bio" | null;
};

/**
 * Extracts and normalizes email, phone, website, and social links from bio text and externalUrl.
 */
export function extractContactFromBio(
  bio: string | null | undefined,
  externalUrl?: string | null | undefined,
): ExtractedContact {
  const emailRaw = extractEmail(bio);
  const emailNormalized = normalizeEmail(emailRaw);

  const phoneRaw = extractPhone(bio);
  const phoneNormalized = normalizePhone(phoneRaw);

  const websiteInfo = normalizeWebsite(externalUrl);
  const detectedSocial = detectSocialPlatform(externalUrl);
  const isSocial = Boolean(detectedSocial);

  const hasBioContact = Boolean(emailNormalized || phoneNormalized);

  const website = isSocial ? null : websiteInfo?.rootUrl ?? null;
  const websiteDomain = isSocial ? null : websiteInfo?.domain ?? null;
  const socialLink = isSocial ? detectedSocial?.url ?? externalUrl?.trim() ?? null : null;
  const socialPlatform = isSocial ? detectedSocial?.platform ?? null : null;

  return {
    email: emailRaw,
    emailNormalized,
    phone: phoneRaw,
    phoneNormalized,
    website,
    websiteDomain,
    socialLink,
    socialPlatform,
    contactSource: hasBioContact ? "instagram_bio" : null,
  };
}

export function computeAvailableChannels(input: {
  hasInstagram?: boolean;
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  website?: string | null;
}): string[] {
  const channels: string[] = [];

  if (input.hasInstagram !== false && (input.hasInstagram === true || input.hasInstagram === undefined)) {
    channels.push("INSTAGRAM");
  }

  if (input.email && input.email.trim().length > 0) {
    channels.push("EMAIL");
  }

  if (input.phone && input.phone.trim().length > 0) {
    channels.push("PHONE");
  }

  if (input.whatsapp && input.whatsapp.trim().length > 0) {
    channels.push("WHATSAPP");
  }

  if (input.website && input.website.trim().length > 0) {
    channels.push("WEBSITE");
  }

  return channels;
}
