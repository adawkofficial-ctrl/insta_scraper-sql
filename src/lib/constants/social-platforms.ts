/**
 * Shared constants for social, video, messaging, and link-aggregator platforms.
 * Single source of truth across discovery, scraping, dedup, contacts, and UI.
 */

export const SOCIAL_PLATFORM_MAP: Record<string, string> = {
  // Video & Social
  "youtube.com": "youtube",
  "youtu.be": "youtube",
  "facebook.com": "facebook",
  "fb.com": "facebook",
  "fb.me": "facebook",
  "m.facebook.com": "facebook",
  "tiktok.com": "tiktok",
  "twitter.com": "twitter",
  "x.com": "twitter",
  "linkedin.com": "linkedin",
  "instagram.com": "instagram",
  "instagr.am": "instagram",
  "threads.net": "threads",
  "snapchat.com": "snapchat",
  "pinterest.com": "pinterest",
  "pin.it": "pinterest",

  // Messaging
  "wa.me": "whatsapp",
  "whatsapp.com": "whatsapp",
  "api.whatsapp.com": "whatsapp",
  "t.me": "telegram",
  "telegram.me": "telegram",

  // Link aggregators & bio tools
  "linktr.ee": "linktree",
  "linkin.bio": "linkinbio",
  "beacons.ai": "beacons",
  "bio.link": "biolink",
  "lnk.bio": "lnkbio",
  "campsite.bio": "campsite",
  "stan.store": "stanstore",
  "carrd.co": "carrd",
  "taplink.cc": "taplink",
  "solo.to": "soloto",
  "hoo.be": "hoobe",
  "linkpop.com": "linkpop",
  "milkshake.app": "milkshake",
  "tap.bio": "tapbio",
  "allmylinks.com": "allmylinks",

  // Creator platforms & link shorteners
  "calendly.com": "calendly",
  "gumroad.com": "gumroad",
  "patreon.com": "patreon",
  "substack.com": "substack",
  "wixsite.com": "wixsite",
  "wordpress.com": "wordpress",
  "blogspot.com": "blogspot",
  "google.com": "google",
  "bit.ly": "bitly",
};

export const SOCIAL_PLATFORM_LABELS: Record<string, string> = {
  youtube: "YouTube",
  facebook: "Facebook",
  tiktok: "TikTok",
  twitter: "X (Twitter)",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  threads: "Threads",
  snapchat: "Snapchat",
  pinterest: "Pinterest",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  linktree: "Linktree",
  linkinbio: "Linkin.bio",
  beacons: "Beacons",
  biolink: "Bio.link",
  lnkbio: "Lnk.bio",
  campsite: "Campsite",
  stanstore: "Stan Store",
  carrd: "Carrd",
  taplink: "Taplink",
  soloto: "Solo.to",
  hoobe: "Hoo.be",
  linkpop: "Linkpop",
  milkshake: "Milkshake",
  tapbio: "Tap.bio",
  allmylinks: "AllMyLinks",
  calendly: "Calendly",
  gumroad: "Gumroad",
  patreon: "Patreon",
  substack: "Substack",
  wixsite: "Wixsite",
  wordpress: "WordPress",
  blogspot: "Blogspot",
  google: "Google",
  bitly: "Bitly",
};

/** Set of domain hostnames recognized as social / shared platforms */
export const SHARED_PLATFORM_DOMAINS: ReadonlySet<string> = new Set(
  Object.keys(SOCIAL_PLATFORM_MAP),
);

/** Mailbox providers (valid for email matches only, never a domain key) */
export const MAILBOX_PROVIDER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "qq.com",
  "163.com",
  "126.com",
]);

export const INSTAGRAM_HOST_SUFFIXES = ["instagram.com", "instagr.am"] as const;

/** Extracts clean lowercase domain (without www.) from a URL or domain string */
export function extractDomain(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const url = new URL(withScheme);
    const domain = url.hostname.toLowerCase().replace(/^www\./, "");
    return domain.includes(".") ? domain : null;
  } catch {
    return null;
  }
}

/** Returns true if the URL or domain belongs to a known social/shared platform */
export function isSocialOrSharedPlatform(
  rawUrlOrDomain: string | null | undefined,
): boolean {
  const domain = extractDomain(rawUrlOrDomain);
  if (!domain) return false;
  return (
    SHARED_PLATFORM_DOMAINS.has(domain) ||
    Object.keys(SOCIAL_PLATFORM_MAP).some(
      (p) => domain === p || domain.endsWith(`.${p}`),
    )
  );
}

export type DetectedSocialPlatform = {
  platform: string;
  domain: string;
  url: string;
  label: string;
};

/** Identifies social platform type from external URL if matched */
export function detectSocialPlatform(
  rawUrl: string | null | undefined,
): DetectedSocialPlatform | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;

  const domain = extractDomain(trimmed);
  if (!domain) return null;

  // Direct match or subdomain match
  let platformKey = SOCIAL_PLATFORM_MAP[domain];
  let matchedDomain = domain;

  if (!platformKey) {
    for (const [knownDomain, key] of Object.entries(SOCIAL_PLATFORM_MAP)) {
      if (domain === knownDomain || domain.endsWith(`.${knownDomain}`)) {
        platformKey = key;
        matchedDomain = knownDomain;
        break;
      }
    }
  }

  if (!platformKey) return null;

  const urlWithScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  return {
    platform: platformKey,
    domain: matchedDomain,
    url: urlWithScheme,
    label: SOCIAL_PLATFORM_LABELS[platformKey] ?? platformKey,
  };
}

/** Human-readable label for a social platform (e.g. "youtube" -> "YouTube") */
export function getSocialPlatformLabel(platform: string | null | undefined): string {
  if (!platform) return "Social Link";
  const key = platform.toLowerCase();
  return SOCIAL_PLATFORM_LABELS[key] ?? platform;
}

/**
 * Normalizes an external URL into a clean business website homepage URL and domain.
 * If the URL is a recognized social platform, returns null.
 * Never preserves deep article/post paths on the website field.
 */
export function cleanBusinessWebsite(
  rawUrl: string | null | undefined,
): { url: string; domain: string } | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;

  if (isSocialOrSharedPlatform(trimmed)) {
    return null;
  }

  const domain = extractDomain(trimmed);
  if (!domain) return null;

  return {
    url: `https://${domain}`,
    domain,
  };
}
