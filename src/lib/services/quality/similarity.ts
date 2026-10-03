/**
 * Step 6 quality gate — deterministic text similarity helpers.
 * Pure functions only (no I/O).
 */

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
export function normalizeForComparison(text: string | null | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Aggressive normalization used for exact-duplicate message detection. */
export function normalizeForExactDuplicate(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function tokenize(text: string | null | undefined): string[] {
  const normalized = normalizeForComparison(text);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/** Word-boundary aware phrase containment against already-normalized text. */
export function textContainsPhrase(normalizedText: string, phrase: string): boolean {
  const p = normalizeForComparison(phrase);
  if (p.length === 0) return false;
  return ` ${normalizedText} `.includes(` ${p} `);
}

/** Normalized phrases from `phrases` present in `normalizedText` (word-boundary aware). */
export function findPhrases(normalizedText: string, phrases: readonly string[]): string[] {
  const hits: string[] = [];
  for (const phrase of phrases) {
    if (textContainsPhrase(normalizedText, phrase)) hits.push(phrase);
  }
  return hits;
}

export function wordShingles(normalizedText: string, n = 3): Set<string> {
  const tokens = normalizedText.length === 0 ? [] : normalizedText.split(" ");
  const set = new Set<string>();
  if (tokens.length === 0) return set;
  if (tokens.length < n) {
    set.add(tokens.join(" "));
    return set;
  }
  for (let i = 0; i + n <= tokens.length; i += 1) {
    set.add(tokens.slice(i, i + n).join(" "));
  }
  return set;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Max 3-shingle Jaccard similarity between `candidate` and each of `others`. */
export function maxShingleSimilarity(
  candidate: string,
  others: readonly string[],
  n = 3,
): number {
  const candidateShingles = wordShingles(normalizeForComparison(candidate), n);
  if (candidateShingles.size === 0) return 0;
  let max = 0;
  for (const other of others) {
    const similarity = jaccard(candidateShingles, wordShingles(normalizeForComparison(other), n));
    if (similarity > max) max = similarity;
    if (max >= 1) break;
  }
  return max;
}

export function firstNWords(text: string | null | undefined, n: number): string {
  return tokenize(text).slice(0, n).join(" ");
}

function tokenLevenshtein(a: string, b: string, cap: number): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const n = ta.length;
  const m = tb.length;
  if (n === 0) return Math.min(m, cap + 1);
  if (m === 0) return Math.min(n, cap + 1);
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j += 1) prev[j] = j;
  for (let i = 1; i <= n; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= m; j += 1) {
      const cost = ta[i - 1] === tb[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > cap) return cap + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[m] > cap ? cap + 1 : prev[m];
}

/** Capped Levenshtein (character-level, with a token-level fallback for long text). */
export function editDistance(a: string, b: string, cap = 2000): number {
  const s = a ?? "";
  const t = b ?? "";
  if (s === t) return 0;
  const n = s.length;
  const m = t.length;
  if (n === 0) return Math.min(m, cap + 1);
  if (m === 0) return Math.min(n, cap + 1);
  if (Math.abs(n - m) > cap) return cap + 1;
  if (n > 4000 || m > 4000) return tokenLevenshtein(s, t, cap);

  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j += 1) prev[j] = j;
  for (let i = 1; i <= n; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    const sourceCode = s.charCodeAt(i - 1);
    for (let j = 1; j <= m; j += 1) {
      const cost = sourceCode === t.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > cap) return cap + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[m] > cap ? cap + 1 : prev[m];
}

export function wordCount(text: string | null | undefined): number {
  return tokenize(text).length;
}
