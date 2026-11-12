/**
 * Builds the `search` value sent to `apify/instagram-search-scraper`.
 *
 * The Actor only supports a generic free-text `search` field (plus `searchType`
 * and `searchLimit`); it has NO dedicated location/category/place-user inputs.
 * The campaign intent, category, and location are therefore merged into a single
 * keyword string.
 *
 * Root cause guarded here: passing the raw intent
 * "fitness gyms and fitness businesses" let the Actor match the stop-word "and"
 * and return users like @andien / @andersoncooper. Stop-words and duplicate
 * tokens are removed so location/category keywords survive.
 *
 * This module is pure (no DB / provider / server-only imports) so the query
 * construction is unit-testable in isolation.
 */

// The discovery Actor rejects these characters in `search`; replace with spaces.
const DISALLOWED_SEARCH_CHARS = /[!?.,:;\-+=*&%$#@/~^|<>()[\]{}"']/g;

// Tokens that carry no discovery signal and cause spurious Actor matches.
const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export const MAX_DISCOVERY_SEARCH_LENGTH = 200;

export function sanitizeSearchTerm(value: string): string {
  return value
    .replace(DISALLOWED_SEARCH_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeSearchQuery(value: string): string[] {
  const sanitized = sanitizeSearchTerm(value);
  if (sanitized.length === 0) {
    return [];
  }

  return sanitized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => !SEARCH_STOPWORDS.has(token.toLowerCase()));
}

/**
 * Merges intent + category + location into the Actor's `search` field:
 * de-duplicated (case-insensitive), stop-words removed, length-capped.
 *
 * Example:
 *   query="fitness gyms and fitness businesses", category="Fitness",
 *   location="Rawalpindi" -> "fitness gyms businesses Rawalpindi"
 */
export function buildDiscoverySearchTerm(input: {
  query: string;
  category?: string | null;
  location?: string | null;
}): string {
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const part of [input.query, input.category, input.location]) {
    if (typeof part !== "string" || part.trim().length === 0) {
      continue;
    }
    for (const token of tokenizeSearchQuery(part)) {
      const key = token.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      tokens.push(token);
    }
  }

  return sanitizeSearchTerm(tokens.join(" ")).slice(
    0,
    MAX_DISCOVERY_SEARCH_LENGTH,
  );
}

// Generic intent nouns that carry no niche signal when standalone or trailing in multi-word phrases
export const GENERIC_INTENT_STOPWORDS = new Set([
  "products",
  "product",
  "practices",
  "practice",
  "services",
  "service",
  "patients",
  "patient",
  "clients",
  "customers",
  "recommend",
  "sell",
  "selling",
  "offer",
  "businesses",
]);

/**
 * Strips pitch/purpose clauses from conversational intent strings before keyword extraction.
 *
 * Example:
 * "dental clinics, dentists and cosmetic dentistry practices that could sell or recommend teeth whitening products to patients"
 * -> "dental clinics, dentists and cosmetic dentistry practices"
 */
export function stripPitchClauses(query: string): string {
  if (!query || typeof query !== "string") return "";

  const PITCH_PATTERN =
    /\b(?:that\s+(?:could|can|sell|offer)|who\s+(?:could|can|sell|offer)|which\s+(?:could|can|sell|offer)|to\s+(?:sell|recommend)|sell\s+or\s+recommend|looking\s+to|interested\s+in|for\s+selling)\b[^,;\n\r|/]*/gi;

  return query.replace(PITCH_PATTERN, " ").replace(/\s+/g, " ").trim();
}

/**
 * Splits campaign query / intent into distinct keyword phrases.
 * Delimiters can be:
 *   - commas (,), semicolons (;), newlines (\n), pipes (|), slashes (/)
 *   - conjunctions: " and ", " or ", " & " (always split)
 * Strips pitch clauses, trims generic trailing nouns, deduplicates, and caps at 6 keywords.
 */
export function extractDiscoveryKeywords(input: {
  query: string;
  category?: string | null;
}): string[] {
  const { query, category } = input;
  const rawQuery = typeof query === "string" ? query : "";
  const rawCat = typeof category === "string" ? category : "";

  if (!rawQuery.trim() && !rawCat.trim()) {
    return [];
  }

  const keywords: string[] = [];
  const seen = new Set<string>();

  const addKeyword = (kw: string) => {
    const clean = sanitizeSearchTerm(kw);
    let words = clean.split(/\s+/).filter(Boolean);
    while (words.length > 0 && SEARCH_STOPWORDS.has(words[0].toLowerCase())) {
      words.shift();
    }
    while (
      words.length > 0 &&
      SEARCH_STOPWORDS.has(words[words.length - 1].toLowerCase())
    ) {
      words.pop();
    }

    // Strip trailing generic intent noun if phrase > 2 words (e.g. "cosmetic dentistry practices" -> "cosmetic dentistry")
    // Keep 2-word phrases intact (e.g. "dental practice")
    if (words.length > 2) {
      const lastWordLower = words[words.length - 1].toLowerCase();
      if (
        lastWordLower === "practices" ||
        lastWordLower === "practice" ||
        lastWordLower === "products" ||
        lastWordLower === "product" ||
        lastWordLower === "services" ||
        lastWordLower === "service" ||
        lastWordLower === "patients" ||
        lastWordLower === "patient" ||
        lastWordLower === "businesses"
      ) {
        words.pop();
      }
    }

    // If standalone word is generic intent stopword (e.g. "practice", "products", "patients"), drop it
    if (words.length === 1 && GENERIC_INTENT_STOPWORDS.has(words[0].toLowerCase())) {
      return;
    }

    // Cap each keyword at 4 words
    if (words.length > 4) {
      words = words.slice(0, 4);
    }

    const phrase = words.join(" ").trim();
    if (phrase.length > 0) {
      const key = phrase.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        keywords.push(phrase);
      }
    }
  };

  // 1. Strip pitch/purpose clauses
  const cleanedQuery = stripPitchClauses(rawQuery);

  // 2. Split on punctuation delimiters: , ; \n | /
  const punctParts = cleanedQuery.split(/[,;\n\r|/]+/);

  // 3. Split each part on conjunctions: " and ", " & ", " or "
  for (const part of punctParts) {
    const subparts = part.split(/\s+(?:and|&|or)\s+/i);
    for (const sp of subparts) {
      const trimmed = sp.trim();
      if (trimmed.length > 0) {
        addKeyword(trimmed);
      }
    }
  }

  // 4. Include category if provided and not already seen, keeping all query keywords
  if (category && typeof category === "string" && category.trim().length > 0) {
    const cleanCat = sanitizeSearchTerm(category);
    const catLower = cleanCat.toLowerCase();
    if (cleanCat.length > 0 && !seen.has(catLower)) {
      addKeyword(cleanCat);
    }
  }

  // 5. Cap total keywords at 6
  return keywords.slice(0, 6);
}

/**
 * Builds per-keyword search queries with optional location appended.
 *
 * Example:
 *   query="hospitals, medical centers, diagnostic technology",
 *   location="Rawalpindi"
 *   -> ["hospitals Rawalpindi", "medical centers Rawalpindi", "diagnostic technology Rawalpindi"]
 */
export function buildPerKeywordSearchQueries(input: {
  query: string;
  category?: string | null;
  location?: string | null;
  appendLocation?: boolean;
}): string[] {
  const keywords = extractDiscoveryKeywords({
    query: input.query,
    category: input.category,
  });

  const shouldAppendLocation = input.appendLocation !== false;
  const location =
    shouldAppendLocation && typeof input.location === "string" && input.location.trim().length > 0
      ? sanitizeSearchTerm(input.location)
      : null;

  const queries: string[] = [];
  const seenQueries = new Set<string>();

  for (const kw of keywords) {
    let fullQuery: string;
    if (location && location.length > 0) {
      if (kw.toLowerCase().includes(location.toLowerCase())) {
        fullQuery = kw;
      } else {
        fullQuery = `${kw} ${location}`;
      }
    } else {
      fullQuery = kw;
    }

    const sanitized = sanitizeSearchTerm(fullQuery).slice(
      0,
      MAX_DISCOVERY_SEARCH_LENGTH,
    );

    const key = sanitized.toLowerCase();
    if (sanitized.length > 0 && !seenQueries.has(key)) {
      seenQueries.add(key);
      queries.push(sanitized);
    }
  }

  return queries;
}

