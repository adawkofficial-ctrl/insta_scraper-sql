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
]);

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
 * Tokenizes business name into lowercase significant tokens (excluding stop words).
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
  return words.filter((w) => w.length > 2 && !GENERIC_BUSINESS_STOP_WORDS.has(w));
}

export type NameWebsiteMatchInput = {
  businessName?: string | null;
  websiteUrl?: string | null;
  homepageTitle?: string | null;
  homepageH1?: string | null;
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
 * Extracts <title> and <h1> content from raw HTML if available.
 */
export function extractTitleAndH1(html?: string | null): {
  title: string | null;
  h1: string | null;
} {
  if (!html || typeof html !== "string") {
    return { title: null, h1: null };
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

  return { title, h1 };
}

/**
 * Pure evaluation of business name vs website domain & title/H1.
 */
export function checkNameWebsiteMismatch(
  input: NameWebsiteMatchInput,
): NameWebsiteMatchResult {
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

  // 2. No domain overlap: check homepage title / H1 if available
  let title = input.homepageTitle ?? null;
  let h1 = input.homepageH1 ?? null;

  if ((!title || !h1) && input.homepageHtml) {
    const extracted = extractTitleAndH1(input.homepageHtml);
    title = title ?? extracted.title;
    h1 = h1 ?? extracted.h1;
  }

  const combinedHeader = `${title ?? ""} ${h1 ?? ""}`.toLowerCase();
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
      reason: `Domain "${domainRoot}" has no token overlap, but homepage header/title contains name token(s)`,
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
    reason: `Business name "${input.businessName}" tokens [${tokens.join(", ")}] have no overlap with domain "${domainRoot}" and homepage title/H1 does not contain business name`,
  };
}

