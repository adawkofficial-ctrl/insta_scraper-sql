/**
 * Central error/message sanitization (TASK 11). Used by API responses and
 * structured logs. Never lets secrets, connection strings, cookies, tokens,
 * filesystem paths or stack traces escape.
 */

const REDACTIONS: Array<[RegExp, string]> = [
  // Connection strings / credentials
  [/\b(postgres|postgresql|mysql|mongodb|redis|rediss):\/\/[^\s"']+/gi, "$1://***"],
  [/\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*[^\s"',;]+/gi, "$1=***"],
  [/\b(x-rapidapi-key|rapidapi[_-]?key|sparior[_-]?api[_-]?key)\s*[:=]\s*[^\s"',;]+/gi, "$1=***"],
  // Provider tokens
  [/apify_api_[a-zA-Z0-9_-]+/gi, "apify_api_***"],
  [/\b[0-9a-f]{50}\b/gi, "***rapidapi_key***"],
  [/\bsk-[a-zA-Z0-9_-]{16,}\b/g, "sk-***"],
  [/AIza[a-zA-Z0-9_-]{35}/g, "AIza***"],
  [/(\?|&)(key|token|api_key)=[^&\s"']+/gi, "$1$2=***"],
  // Auth headers / cookies
  [/(authorization\s*[:=]\s*)(bearer\s+)?[^\s"',;]+/gi, "$1***"],
  [/(bearer\s+)[a-zA-Z0-9._~+/-]+=*/gi, "$1***"],
  [/((?:set-)?cookie\s*[:=]\s*)[^\s"';]+/gi, "$1***"],
  [/\binsta_session=[^;\s"']+/gi, "insta_session=***"],
  // JWT-ish tokens
  [/\beyJ[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}\b/g, "***JWT***"],
  // Filesystem paths
  [/[A-Za-z]:\\[^\s"',;)\]}]+/g, "<path>"],
  [/\b\/(?:home|root|Users|var|etc|tmp)\/[^\s"',;)\]}]+/g, "<path>"],
  // Stack frames
  [/\n?\s+at\s+[^\n]+/g, ""],
];

/** Removes sensitive data from an arbitrary string. */
export function sanitizeMessage(raw: string): string {
  let output = raw;
  for (const [pattern, replacement] of REDACTIONS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function sanitizeForLog(value: string): string {
  return sanitizeMessage(value);
}
