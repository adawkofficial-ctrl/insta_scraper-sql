/**
 * Chain / franchise / national-account detection from Google Maps data.
 * Identifies corporate chains, multi-location franchises, and national brands
 * to protect campaigns from wasting outreach on non-decision-maker locations.
 */

export type ChainCandidateInput = {
  businessName?: string | null;
  fullName?: string | null;
  name?: string | null;
  website?: string | null;
  websiteDomain?: string | null;
  address?: string | null;
  gmapsAddress?: string | null;
  biography?: string | null;
  bio?: string | null;
  phone?: string | null;
};

export type ChainDetectionResult = {
  isChain: boolean;
  reason?: string;
  matchedPattern?: string;
  locationCount?: number;
};

/**
 * Curated list of known national chains, corporate DSOs, healthcare networks,
 * and franchise brands across dental, medical, aesthetics, and retail.
 */
export const KNOWN_CHAIN_PATTERNS: string[] = [
  // Dental Service Organizations (DSOs) & Dental Chains
  "aspen dental",
  "heartland dental",
  "pacific dental",
  "western dental",
  "smile brands",
  "affordable dentures",
  "gentle dental",
  "great expressions",
  "clearchoice",
  "dental care alliance",
  "coast dental",
  "mortenson dental",
  "midwest dental",
  "bupa dental",
  "mydentist",
  "colosseum dental",
  "tend dental",
  "ideal dental",
  "monarch dental",
  "castle dental",
  "bright now dental",
  "dental dreams",
  "decadental",
  "sage dental",
  "riccobene associates",
  "mb2 dental",
  "marquee dental",

  // Medical, Diagnostic, & Veterinary Chains
  "quest diagnostics",
  "labcorp",
  "banfield",
  "vca animal hospital",
  "bluepearl",
  "the joint chiropractic",
  "citymd",
  "carenow",
  "concentra",
  "medexpress",
  "nextcare",
  "patient first",
  "afc urgent care",
  "fastmed",
  "carbon health",
  "one medical",

  // Optical & Hearing Chains
  "lenscrafters",
  "pearle vision",
  "visionworks",
  "americas best",
  "america's best",
  "target optical",
  "miracle-ear",
  "beltone",

  // Aesthetics, Wellness & Fitness Franchises
  "massage envy",
  "european wax center",
  "hydrafacial",
  "laseraway",
  "ideal image",
  "orangetheory",
  "planet fitness",
  "anytime fitness",
  "f45 training",
  "pure barre",
  "club pilates",
  "solidcore",
  "supercuts",
  "great clips",
  "sport clips",
  "regis salon",
];

/**
 * Multi-location indicator phrases that strongly suggest national/corporate accounts.
 */
export const MULTI_LOCATION_PHRASES: string[] = [
  "corporate office",
  "corporate headquarters",
  "national headquarters",
  "regional headquarters",
  "regional office",
  "locations nationwide",
  "nationwide locations",
  "our locations",
  "find a location",
  "store #",
  "location #",
  "branch #",
  "unit #",
  "suite #",
  "franchise of",
  "locations",
  "branches",
];

/**
 * Normalizes a brand name for frequency counting (removes punctuation, extra spaces, city suffixes).
 */
export function normalizeBrandName(name?: string | null): string {
  if (!name) return "";
  let clean = name.toLowerCase().trim();
  // Strip common business entities
  clean = clean.replace(/\b(inc|corp|corporation|llc|ltd|plc|group|holdings|pc|pllc)\b/gi, "");
  // Strip punctuation
  clean = clean.replace(/[^a-z0-9\s]/g, " ");
  // Collapse whitespace
  clean = clean.replace(/\s+/g, " ").trim();
  return clean;
}

/**
 * Normalizes a domain name (strips protocol, www, subdomains, trailing path).
 */
export function extractRootDomain(rawUrlOrDomain?: string | null): string {
  if (!rawUrlOrDomain) return "";
  let str = rawUrlOrDomain.toLowerCase().trim();
  // Remove protocol
  str = str.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "");
  // Take hostname portion before slash
  str = str.split("/")[0].split("?")[0].split("#")[0].trim();
  // Remove port
  str = str.split(":")[0];
  return str;
}

/**
 * Analyzes a collection of candidate places discovered in a search run to identify chains.
 * A candidate is marked as a chain if:
 * 1. Its domain or brand name appears >= 3 times in the discovered dataset.
 * 2. It matches a known chain list entry.
 * 3. It contains multi-location corporate phrases.
 */
export function detectChains<T extends ChainCandidateInput>(
  candidates: T[],
  options?: {
    minOccurrencesForChain?: number;
    additionalKnownChains?: string[];
  },
): Map<T, ChainDetectionResult> {
  const minOccurrences = options?.minOccurrencesForChain ?? 3;
  const knownChains = [
    ...KNOWN_CHAIN_PATTERNS,
    ...(options?.additionalKnownChains?.map((c) => c.toLowerCase().trim()) ?? []),
  ];

  // 1. Build frequency maps across the dataset
  const domainCounts = new Map<string, number>();
  const brandCounts = new Map<string, number>();

  for (const c of candidates) {
    const domain = extractRootDomain(c.websiteDomain || c.website);
    if (domain && domain.length > 3 && !isPublicPlatformDomain(domain)) {
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    }

    const brand = normalizeBrandName(c.businessName ?? c.fullName ?? c.name);
    if (brand && brand.length > 3 && !isGenericCategoryName(brand)) {
      brandCounts.set(brand, (brandCounts.get(brand) ?? 0) + 1);
    }
  }

  // 2. Evaluate each candidate
  const results = new Map<T, ChainDetectionResult>();

  for (const c of candidates) {
    const domain = extractRootDomain(c.websiteDomain || c.website);
    const domainCount = domain ? (domainCounts.get(domain) ?? 1) : 1;

    const brand = normalizeBrandName(c.businessName ?? c.fullName ?? c.name);
    const brandCount = brand ? (brandCounts.get(brand) ?? 1) : 1;

    const rawName = (c.businessName ?? c.fullName ?? c.name ?? "").toLowerCase();
    const rawAddress = (c.address ?? c.gmapsAddress ?? "").toLowerCase();
    const rawBio = (c.biography ?? c.bio ?? "").toLowerCase();

    // Check dataset frequency (>= minOccurrences)
    if (domain && domainCount >= minOccurrences) {
      results.set(c, {
        isChain: true,
        reason: `Website domain "${domain}" appears ${domainCount} times across locations`,
        matchedPattern: domain,
        locationCount: domainCount,
      });
      continue;
    }

    if (brand && brandCount >= minOccurrences) {
      results.set(c, {
        isChain: true,
        reason: `Brand name "${brand}" appears ${brandCount} times across locations`,
        matchedPattern: brand,
        locationCount: brandCount,
      });
      continue;
    }

    // Check known chains list
    let matchedChain: string | undefined;
    for (const kc of knownChains) {
      if (rawName.includes(kc) || (domain && domain.includes(kc.replace(/\s+/g, "")))) {
        matchedChain = kc;
        break;
      }
    }
    if (matchedChain) {
      results.set(c, {
        isChain: true,
        reason: `Matches known corporate chain "${matchedChain}"`,
        matchedPattern: matchedChain,
        locationCount: Math.max(domainCount, brandCount, 5),
      });
      continue;
    }

    // Check multi-location phrases
    let matchedPhrase: string | undefined;
    for (const phrase of MULTI_LOCATION_PHRASES) {
      if (rawName.includes(phrase) || rawAddress.includes(phrase) || rawBio.includes(phrase)) {
        matchedPhrase = phrase;
        break;
      }
    }
    if (matchedPhrase) {
      results.set(c, {
        isChain: true,
        reason: `Contains multi-location identifier "${matchedPhrase}"`,
        matchedPattern: matchedPhrase,
        locationCount: Math.max(domainCount, brandCount, 2),
      });
      continue;
    }

    // Not a chain: single location or independent
    results.set(c, {
      isChain: false,
      locationCount: Math.max(domainCount, brandCount, 1),
    });
  }

  return results;
}

/**
 * Check if a domain is a public hosting platform, directory, or social site
 * where repetition does NOT mean same business.
 */
function isPublicPlatformDomain(domain: string): boolean {
  const genericDomains = new Set([
    "instagram.com",
    "facebook.com",
    "linktr.ee",
    "wixsite.com",
    "squarespace.com",
    "wordpress.com",
    "weebly.com",
    "google.com",
    "yelp.com",
    "yellowpages.com",
    "linkedin.com",
    "twitter.com",
    "x.com",
  ]);
  return genericDomains.has(domain);
}

/**
 * Generic terms that shouldn't trigger chain detection on name alone.
 */
function isGenericCategoryName(name: string): boolean {
  const generic = new Set([
    "dentist",
    "dental clinic",
    "dental practice",
    "dental care",
    "orthodontics",
    "family dentistry",
    "cosmetic dentistry",
    "doctor",
    "medical clinic",
    "wellness center",
    "health center",
    "chiropractor",
    "optometrist",
    "spa",
  ]);
  return generic.has(name);
}
