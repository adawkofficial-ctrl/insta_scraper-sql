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

/**
 * Splits campaign query / intent into distinct keyword phrases.
 * Delimiters can be:
 *   - commas (,), semicolons (;), newlines (\n), pipes (|)
 *   - conjunctions: " and ", " or ", " & "
 * If no delimiters exist, and the string has > 3 words, each individual word/token
 * is treated as a keyword. If <= 3 words, it's treated as a single cohesive phrase.
 */
export function extractDiscoveryKeywords(input: {
  query: string;
  category?: string | null;
}): string[] {
  const { query, category } = input;
  if (!query || typeof query !== "string") {
    return [];
  }

  const keywords: string[] = [];
  const seen = new Set<string>();

  const addKeyword = (kw: string) => {
    const clean = sanitizeSearchTerm(kw);
    const words = clean.split(/\s+/).filter(Boolean);
    while (words.length > 0 && SEARCH_STOPWORDS.has(words[0].toLowerCase())) {
      words.shift();
    }
    while (
      words.length > 0 &&
      SEARCH_STOPWORDS.has(words[words.length - 1].toLowerCase())
    ) {
      words.pop();
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

  const hasPunctDelimiters = /[,;\n\r|/]/.test(query);

  if (hasPunctDelimiters) {
    const parts = query.split(/[,;\n\r|/]+/);
    for (const part of parts) {
      const subparts = part.split(/\s+(?:and|&)\s+/i);
      for (const sp of subparts) {
        addKeyword(sp);
      }
    }
  } else {
    const hasConjunctions = /\s+(?:and|or|&)\s+/i.test(query);
    if (hasConjunctions) {
      const parts = query.split(/\s+(?:and|or|&)\s+/i);
      for (const part of parts) {
        addKeyword(part);
      }
    } else {
      const clean = sanitizeSearchTerm(query);
      const words = clean.split(/\s+/).filter(Boolean);
      if (words.length <= 3) {
        addKeyword(clean);
      } else {
        for (const token of tokenizeSearchQuery(query)) {
          addKeyword(token);
        }
      }
    }
  }

  if (category && typeof category === "string" && category.trim().length > 0) {
    const cleanCat = sanitizeSearchTerm(category);
    const catLower = cleanCat.toLowerCase();
    const alreadyCovered = keywords.some((k) => {
      const kLower = k.toLowerCase();
      return (
        kLower === catLower ||
        kLower.includes(catLower) ||
        catLower.includes(kLower)
      );
    });
    if (!alreadyCovered && cleanCat.length > 0 && !seen.has(catLower)) {
      addKeyword(cleanCat);
    }
  }

  return keywords;
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
}): string[] {
  const keywords = extractDiscoveryKeywords({
    query: input.query,
    category: input.category,
  });

  const location =
    typeof input.location === "string" && input.location.trim().length > 0
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

