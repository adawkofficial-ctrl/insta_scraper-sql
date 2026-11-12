/**
 * Negative keyword filtering for Instagram discovery.
 *
 * Prevents non-clinic accounts (staffing, consultants, education, community/nonprofit,
 * regulators, car washes, etc.) from polluting clinic outreach campaigns.
 */

export const DEFAULT_NEGATIVE_KEYWORDS: readonly string[] = [
  "staffing",
  "recruiting",
  "recruitment",
  "association",
  "college of",
  "royal college",
  "consultancy",
  "consulting",
  "immigration",
  "immigrate",
  "ndaeb",
  "nonprofit",
  "non-profit",
  "trainer",
  "student",
  "university",
  "course",
  "mentorship",
  "job board",
  "car wash",
  "automotive",
  "estetica automotiva",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripAccents(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalizes text for word-boundary matching:
 * - strips accents (e.g. "Estética" -> "estetica")
 * - converts punctuation, underscores, dashes, dots to spaces
 * - collapses multiple spaces
 */
export function normalizeForBoundaryCheck(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Checks whether any of the negative keywords match within the candidate texts.
 * Word-boundary aware: "dentist" is NEVER blocked by substrings.
 * Accent-insensitive: "Estética Automotiva" matches "estetica automotiva".
 *
 * Returns the matched negative keyword string, or null if clean.
 */
export function findMatchedNegativeKeyword(
  texts: Array<string | null | undefined> | string | null | undefined,
  extraNegativeKeywords?: string[] | null,
  allowedCampaignTerms?: Iterable<string> | null,
): string | null {
  if (!texts) {
    return null;
  }

  const allowedSet = new Set<string>();
  if (allowedCampaignTerms) {
    for (const term of allowedCampaignTerms) {
      if (typeof term === "string") {
        allowedSet.add(normalizeForBoundaryCheck(term));
      }
    }
  }

  const combinedKeywords = [
    ...DEFAULT_NEGATIVE_KEYWORDS,
    ...(extraNegativeKeywords ?? []),
  ];

  const textList = Array.isArray(texts) ? texts : [texts];
  const haystacks = textList
    .map((t) => normalizeForBoundaryCheck(t))
    .filter((t) => t.length > 0);

  if (haystacks.length === 0) {
    return null;
  }

  for (const rawKw of combinedKeywords) {
    const kw = normalizeForBoundaryCheck(rawKw);
    if (kw.length === 0) continue;

    // Do not block if this term is an explicitly targeted campaign concept (e.g. "trainer" in a Fitness campaign)
    if (allowedSet.has(kw)) {
      continue;
    }

    // Word boundary check, allowing optional plural suffix (s/es)
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(kw)}(s|es)?(\\s|$)`, "i");

    for (const haystack of haystacks) {
      if (pattern.test(haystack)) {
        return rawKw;
      }
    }
  }

  return null;
}
