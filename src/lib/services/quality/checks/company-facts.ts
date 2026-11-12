import { normalizeForComparison, tokenize } from "../similarity";
import type { QualityCheck, QualityContext } from "../types";
import { fail, pass } from "./_shared";

const NUMBER_CLAIM_PATTERNS: readonly RegExp[] = [
  /\d+(?:\.\d+)?\s*%/g,
  /\$\s?\d[\d,]*(?:\.\d+)?/g,
  /\b\d[\d,]*\+?\s*(?:years|yrs)\b/gi,
  /\b\d[\d,]*\+?\s*(?:clients|customers|businesses|brands|projects|companies)\b/gi,
];

const AWARD_PATTERNS: readonly RegExp[] = [
  /\baward[- ]winning\b/gi,
  /\bawards?\b/gi,
  // "certified" is only a COMPANY claim when explicitly attributed to the company.
  /\b(?:we(?:'re| are)|our\s+(?:company|team|agency|business|firm))\s+certified\b/gi,
  /\branked\s*#?\d+/gi,
  /\bnumber one\b/gi,
  /\b#1\b/g,
];

const URL_PATTERN = /(?:https?:\/\/[^\s]+|www\.[^\s]+)/gi;
const HANDLE_PATTERN = /@[a-zA-Z0-9._]{2,30}/g;
const COMPANY_NAME_PATTERN =
  /\bour\s+(?:company|team|agency|business|brand)\s+is\s+(?:called|named)\s+([A-Za-z0-9&.'\- ]{2,40})/i;
const SERVICE_CLAIM_PATTERN =
  /(?:we\s+(?:offer|provide|specialize\s+in)|our\s+services?\s+(?:include|are))\s+([^.;!?]+)/i;

function matches(text: string, pattern: RegExp): string[] {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return text.match(global) ?? [];
}

function companyTextHasToken(companyNormalized: string, token: string): boolean {
  const normalized = normalizeForComparison(token);
  if (normalized.length === 0) return true;
  return ` ${companyNormalized} `.includes(` ${normalized} `);
}

function fuzzyServiceMatch(candidate: string, services: readonly string[]): boolean {
  const candidateTokens = new Set(tokenize(candidate));
  if (candidateTokens.size === 0) return true;
  for (const service of services) {
    const serviceTokens = tokenize(service);
    if (serviceTokens.length === 0) continue;
    let overlap = 0;
    for (const token of serviceTokens) if (candidateTokens.has(token)) overlap += 1;
    if (overlap / serviceTokens.length >= 0.5) return true;
  }
  return false;
}

/**
 * COMPANY_FACTS (BLOCKER for fabricated numbers/awards/links/company name,
 * WARNING for a service not listed in the company profile).
 * Only claims absent from the CompanyProfile are treated as fabricated.
 */
export const companyFactsCheck: QualityCheck = (ctx) => {
  const body = ctx.draft.body;
  const companyNormalized = normalizeForComparison(ctx.company.rawText);
  const reasons: string[] = [];
  const warningReasons: string[] = [];
  const normalizeHandle = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

  for (const pattern of NUMBER_CLAIM_PATTERNS) {
    for (const match of matches(body, pattern)) {
      const digits = (match.match(/\d[\d,]*(?:\.\d+)?/) ?? [""])[0];
      if (digits.length > 0 && !ctx.company.rawText.includes(digits)) {
        reasons.push("unverified_number");
      }
    }
  }

  for (const pattern of AWARD_PATTERNS) {
    for (const match of matches(body, pattern)) {
      if (!companyTextHasToken(companyNormalized, match)) reasons.push("unverified_award");
    }
  }

  for (const url of matches(body, URL_PATTERN)) {
    if (!ctx.company.rawText.toLowerCase().includes(url.toLowerCase())) reasons.push("unallowed_url");
  }

  const handleMatches = matches(body, HANDLE_PATTERN);
  const allowedHandles = new Set<string>([
    ...(ctx.lead.username ? [normalizeHandle(ctx.lead.username)] : []),
    ...matches(ctx.company.rawText, HANDLE_PATTERN).map(normalizeHandle),
  ]);
  for (const handle of handleMatches) {
    if (!allowedHandles.has(normalizeHandle(handle))) reasons.push("unallowed_handle");
  }

  if (ctx.company.name.trim().length > 0) {
    const nameMatch = COMPANY_NAME_PATTERN.exec(body);
    if (nameMatch) {
      const claimed = normalizeForComparison(nameMatch[1]);
      const actual = normalizeForComparison(ctx.company.name);
      if (claimed.length > 0 && claimed !== actual) reasons.push("company_name_mismatch");
    }
  }

  const serviceMatch = SERVICE_CLAIM_PATTERN.exec(body);
  if (serviceMatch) {
    const candidates = serviceMatch[1]
      .split(/,|\band\b|\//i)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    for (const candidate of candidates) {
      if (!fuzzyServiceMatch(candidate, ctx.company.services)) {
        warningReasons.push("unlisted_service");
      }
    }
  }

  if (reasons.length > 0) {
    return fail("COMPANY_FACTS", "BLOCKER", "company_fact_mismatch", {
      reasons: Array.from(new Set(reasons)),
    });
  }
  if (warningReasons.length > 0) {
    return fail("COMPANY_FACTS", "WARNING", "unlisted_service", {
      reasons: Array.from(new Set(warningReasons)),
    });
  }
  return pass("COMPANY_FACTS", "BLOCKER", "ok");
};

export type { QualityContext };
