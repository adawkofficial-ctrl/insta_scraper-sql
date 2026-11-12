/**
 * Pure name / website domain and title matching service.
 * Detects mismatched business websites (e.g. "Mantra Dental" vs everbrightsmiles.ca).
 */

export const GENERIC_BUSINESS_STOP_WORDS = new Set<string>([
  "dental",
  "dentistry",
  "dentist",
  "dentists",
  "clinic",
  "clinics",
  "care",
  "centre",
  "center",
  "the",
  "and",
  "of",
  "dr",
  "inc",
  "llc",
  "ltd",
  "corp",
  "group",
  "practice",
  "studio",
  "associates",
  "family",
  "office",
  "services",
  "solutions",
  "healthcare",
  "health",
  "medical",
  "wellness",
  "oral",
  "surgery",
]);

export const SOCIAL_DOMAINS = new Set<string>([
  "facebook.com",
  "m.facebook.com",
  "fb.com",
  "fb.me",
  "instagram.com",
  "m.instagram.com",
  "instagr.am",
  "linktr.ee",
  "beacons.ai",
  "linkin.bio",
  "campsite.bio",
  "taplink.cc",
  "bio.site",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "linkedin.com",
  "youtube.com",
  "youtu.be",
  "pinterest.com",
  "yelp.com",
  "yelp.ca",
]);

/**
 * Checks whether a given URL is a known social media or link-hub aggregator URL.
 */
export function isSocialOrAggregatorUrl(websiteUrl?: string | null): {
  isSocial: boolean;
  platform?: "facebook" | "instagram" | "twitter" | "tiktok" | "linkedin" | "youtube" | "linkhub" | "other";
  cleanHandle?: string | null;
} {
  if (!websiteUrl || typeof websiteUrl !== "string") {
    return { isSocial: false };
  }

  try {
    let clean = websiteUrl.trim().toLowerCase();
    if (clean.startsWith("//")) clean = `https:${clean}`;
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = `https://${clean}`;
    }
    const url = new URL(clean);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);

    if (
      host === "facebook.com" ||
      host === "m.facebook.com" ||
      host === "fb.com" ||
      host === "fb.me" ||
      host.endsWith(".facebook.com")
    ) {
      return { isSocial: true, platform: "facebook" };
    }

    if (host === "instagram.com" || host === "m.instagram.com" || host === "instagr.am") {
      const parts = url.pathname.split("/").filter(Boolean);
      const handle = parts.length > 0 ? parts[0] : null;
      return { isSocial: true, platform: "instagram", cleanHandle: handle };
    }

    if (
      host === "linktr.ee" ||
      host === "beacons.ai" ||
      host === "linkin.bio" ||
      host === "campsite.bio" ||
      host === "taplink.cc" ||
      host === "bio.site"
    ) {
      return { isSocial: true, platform: "linkhub" };
    }

    if (host === "twitter.com" || host === "x.com") {
      return { isSocial: true, platform: "twitter" };
    }

    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
      return { isSocial: true, platform: "tiktok" };
    }

    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      return { isSocial: true, platform: "linkedin" };
    }

    if (host === "youtube.com" || host === "youtu.be") {
      return { isSocial: true, platform: "youtube" };
    }

    return { isSocial: false };
  } catch {
    return { isSocial: false };
  }
}

/**
 * Normalizes URL into clean domain host and root domain name (without TLD).
 * e.g. "https://www.everbrightsmiles.ca/contact" -> { domain: "everbrightsmiles.ca", domainRoot: "everbrightsmiles" }
 */
export function extractDomainParts(websiteUrl?: string | null): {
  domain: string;
  domainRoot: string;
} | null {
  if (!websiteUrl || typeof websiteUrl !== "string") return null;

  try {
    let clean = websiteUrl.trim().toLowerCase();
    if (clean.startsWith("//")) clean = `https:${clean}`;
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = `https://${clean}`;
    }
    const url = new URL(clean);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) {
      host = host.slice(4);
    }
    if (!host) return null;

    // Strip common compound and single TLDs (e.g. .ca, .com, .co.uk, .org, .dental, etc.)
    const domainRoot = host
      .replace(/\.(co\.uk|org\.uk|com\.au|net\.au|qc\.ca|on\.ca|co\.nz)$/i, "")
      .replace(/\.[a-z]{2,}$/i, "");

    return { domain: host, domainRoot };
  } catch {
    return null;
  }
}

/**
 * Tokenizes business name into lowercase significant tokens (excluding stop words and pure numbers).
 */
export function extractSignificantNameTokens(businessName?: string | null): string[] {
  if (!businessName || typeof businessName !== "string") return [];

  // Normalize accents and punctuation
  const clean = businessName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ");

  const words = clean.split(/\s+/).filter(Boolean);
  return words.filter((w) => {
    // Exclude pure numbers (e.g. "88", "123")
    if (/^\d+$/.test(w)) return false;
    // Exclude short words <= 2 chars and generic stop words
    return w.length > 2 && !GENERIC_BUSINESS_STOP_WORDS.has(w);
  });
}

export type NameWebsiteMatchInput = {
  businessName?: string | null;
  websiteUrl?: string | null;
  homepageTitle?: string | null;
  homepageH1?: string | null;
  ogSiteName?: string | null;
  homepageHtml?: string | null;
};

export type NameWebsiteMatchResult = {
  isMismatch: boolean;
  flag: string | null; // "NAME_WEBSITE_MISMATCH" when mismatched
  domainRoot: string | null;
  tokens: string[];
  overlapFound: boolean;
  titleContainsName: boolean;
  reason: string;
};

/**
 * Extracts <title>, <h1>, and og:site_name content from raw HTML if available.
 */
export function extractTitleAndH1(html?: string | null): {
  title: string | null;
  h1: string | null;
  ogSiteName: string | null;
} {
  if (!html || typeof html !== "string") {
    return { title: null, h1: null, ogSiteName: null };
  }

  let title: string | null = null;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    title = titleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  let h1: string | null = null;
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match && h1Match[1]) {
    h1 = h1Match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  let ogSiteName: string | null = null;
  const ogSiteNameMatch =
    html.match(/<meta\b[^>]*\b(?:property|name)=["']og:site_name["'][^>]*\bcontent=["']([^"']+)["']/i) ||
    html.match(/<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\b(?:property|name)=["']og:site_name["']/i);
  if (ogSiteNameMatch && ogSiteNameMatch[1]) {
    ogSiteName = ogSiteNameMatch[1].trim();
  }

  return { title, h1, ogSiteName };
}

/**
 * Pure evaluation of business name vs website domain & title/H1/og:site_name.
 */
export function checkNameWebsiteMismatch(
  input: NameWebsiteMatchInput,
): NameWebsiteMatchResult {
  // If it's a social or aggregator URL (e.g. facebook.com, instagram.com, linktr.ee), do not flag mismatch
  if (isSocialOrAggregatorUrl(input.websiteUrl).isSocial) {
    return {
      isMismatch: false,
      flag: null,
      domainRoot: null,
      tokens: extractSignificantNameTokens(input.businessName),
      overlapFound: true,
      titleContainsName: false,
      reason: "Social or aggregator URL; website mismatch check skipped",
    };
  }

  const domainParts = extractDomainParts(input.websiteUrl);
  const tokens = extractSignificantNameTokens(input.businessName);

  if (!domainParts || tokens.length === 0) {
    return {
      isMismatch: false,
      flag: null,
      domainRoot: domainParts?.domainRoot ?? null,
      tokens,
      overlapFound: true,
      titleContainsName: false,
      reason: "Insufficient information to evaluate website mismatch",
    };
  }

  const { domainRoot } = domainParts;

  // 1. Check if any significant token is in domainRoot or domainRoot is in tokens
  let overlapFound = false;
  for (const token of tokens) {
    if (domainRoot.includes(token) || (token.length >= 4 && token.includes(domainRoot))) {
      overlapFound = true;
      break;
    }
  }

  if (overlapFound) {
    return {
      isMismatch: false,
      flag: null,
      domainRoot,
      tokens,
      overlapFound: true,
      titleContainsName: false,
      reason: `Domain "${domainRoot}" matches business token(s): ${tokens.join(", ")}`,
    };
  }

  // 2. No domain overlap: check homepage title / H1 / og:site_name if available
  let title = input.homepageTitle ?? null;
  let h1 = input.homepageH1 ?? null;
  let ogSiteName = input.ogSiteName ?? null;

  if ((!title || !h1 || !ogSiteName) && input.homepageHtml) {
    const extracted = extractTitleAndH1(input.homepageHtml);
    title = title ?? extracted.title;
    h1 = h1 ?? extracted.h1;
    ogSiteName = ogSiteName ?? extracted.ogSiteName;
  }

  const combinedHeader = `${title ?? ""} ${h1 ?? ""} ${ogSiteName ?? ""}`.toLowerCase();
  let titleContainsName = false;

  if (combinedHeader.trim().length > 0) {
    for (const token of tokens) {
      if (combinedHeader.includes(token)) {
        titleContainsName = true;
        break;
      }
    }
  }

  if (titleContainsName) {
    return {
      isMismatch: false,
      flag: null,
      domainRoot,
      tokens,
      overlapFound: false,
      titleContainsName: true,
      reason: `Domain "${domainRoot}" has no token overlap, but homepage header/title/og:site_name contains name token(s): ${tokens.join(", ")}`,
    };
  }

  // Mismatch detected!
  return {
    isMismatch: true,
    flag: "NAME_WEBSITE_MISMATCH",
    domainRoot,
    tokens,
    overlapFound: false,
    titleContainsName: false,
    reason: `Business name "${input.businessName}" tokens [${tokens.join(", ")}] have no overlap with domain "${domainRoot}" and homepage title/H1/og:site_name does not contain business name`,
  };
}
