/**
 * Pure contact parsing and normalization utilities for Instagram profiles and web pages.
 * Supports email, international and Pakistani phone numbers (+92, 03XX-XXXXXXX), and websites.
 */

import { detectSocialPlatform } from "@/lib/constants/social-platforms";

// Matches standard email addresses. Trailing punctuation is stripped.
const EMAIL_REGEX =
  /(?:^|[\s,;:<>()"'[\]])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:$|[\s,;:?()<>"'[\]])/;

const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

/**
 * Common phone patterns:
 * 1. International with '+': e.g. +92 300 1234567, +1-800-555-0199, +44 20 7946 0991
 * 2. International with '00': e.g. 0092 300 1234567
 * 3. Pakistani mobile: 03XX-XXXXXXX, 03XXXXXXXXX (11 digits)
 * 4. Pakistani landline: 051-XXXXXXX, 042-XXXXXXX (area code + 7-8 digits)
 * 5. General formatted phone with words like 'call', 'tel', 'phone', 'ph', 'whatsapp', 'wa':
 */
const PHONE_LOOKUP_REGEXES = [
  // Explicit marker prefix: "WA: 03001234567", "Call: +92...", "Contact: 0321-1234567"
  /(?:whatsapp|wa|ph(?:one)?|call|tel|contact|cell|mobile|cel)[\s:.-]*([+]?[\d\s().-]{7,20}\d)/i,
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
    if (!IMAGE_EXTENSION_REGEX.test(candidate)) {
      return candidate;
    }
  }

  const match = text.match(EMAIL_REGEX);
  if (!match || !match[1]) {
    return null;
  }

  const candidate = match[1].trim().replace(/[.,;:]+$/, "");
  if (IMAGE_EXTENSION_REGEX.test(candidate)) {
    return null;
  }

  return candidate.length >= 6 ? candidate : null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") {
    return null;
  }
  const clean = email.trim().toLowerCase();
  if (!clean.includes("@") || clean.length < 6) {
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
 * Normalizes phone numbers:
 * - Strips punctuation, spaces, dashes, brackets
 * - Converts 00 prefix to +
 * - Converts Pakistani local mobile 03XX... (11 digits) to +923XX...
 * - Converts Pakistani local landline 051... (10 digits) to +9251...
 * - Keeps leading + and country code
 * - Validates length (7-15 digits)
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  let cleaned = raw.trim();

  // Guard against years (e.g. 2024, 2025, 2026), prices, follower counts
  if (/^\d{4}$/.test(cleaned) || /^(19|20)\d{2}$/.test(cleaned)) {
    return null;
  }

  // Convert leading 00 to +
  if (cleaned.startsWith("00")) {
    cleaned = "+" + cleaned.slice(2);
  }

  const hasPlus = cleaned.startsWith("+");
  // Keep only digits (and leading + if present)
  const digitsOnly = cleaned.replace(/\D/g, "");

  // Must have between 7 and 15 digits
  if (digitsOnly.length < 7 || digitsOnly.length > 15) {
    return null;
  }

  // Pakistani mobile standard: 03XXXXXXXXX (11 digits) -> +923XXXXXXXXX
  if (!hasPlus && digitsOnly.length === 11 && digitsOnly.startsWith("03")) {
    return `+92${digitsOnly.slice(1)}`;
  }

  // Pakistani landline: 051XXXXXXX (10 digits) -> +9251XXXXXXX
  if (!hasPlus && digitsOnly.length === 10 && digitsOnly.startsWith("051")) {
    return `+92${digitsOnly.slice(1)}`;
  }

  if (hasPlus) {
    return `+${digitsOnly}`;
  }

  return digitsOnly;
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
}): string[] {
  const channels: string[] = [];

  if (input.hasInstagram !== false) {
    channels.push("INSTAGRAM");
  }

  if (input.email && input.email.trim().length > 0) {
    channels.push("EMAIL");
  }

  if (input.phone && input.phone.trim().length > 0) {
    channels.push("PHONE");
  }

  return channels;
}
