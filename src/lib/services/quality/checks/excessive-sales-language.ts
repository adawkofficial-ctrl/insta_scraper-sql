import {
  SALES_LANGUAGE_BLOCKER_SCORE,
  SALES_LANGUAGE_WARNING_SCORE,
  SALES_WORDS,
} from "../rules";
import { findPhrases, normalizeForComparison } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

const EMOJI_PATTERN = /\p{Extended_Pictographic}/gu;
const ALL_CAPS_PATTERN = /\b[A-Z]{2,}\b/g;
const PRICE_MENTION_PATTERN = /\$\s?\d|(?:\bprice|\bpricing|\bdiscount|\boffer\b)/i;
const NO_PRICE_POLICY_PATTERN =
  /(?:do not|don'?t|never|not)\s+(?:share|mention|discuss|include|quote)[^.]*\b(?:price|pricing|cost)/i;

function countMatches(text: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const matches = text.match(global);
  return matches ? matches.length : 0;
}

/**
 * EXCESSIVE_SALES_LANGUAGE (WARNING, BLOCKER when the score is high).
 * Score = distinct hype-word hits + exclamation/ALL-CAPS/emoji/CTA-extra signals
 * + price mentions when the company policy forbids quoting price in a first DM.
 */
export const excessiveSalesLanguageCheck: QualityCheck = (ctx) => {
  const raw = ctx.draft.body;
  const normalized = normalizeForComparison(raw);
  const salesHits = findPhrases(normalized, SALES_WORDS).length;
  const extras: string[] = [];

  if (countMatches(raw, /!/g) > 1) extras.push("exclamations");
  if (countMatches(raw, ALL_CAPS_PATTERN) >= 2) extras.push("all_caps");
  if (countMatches(raw, EMOJI_PATTERN) > 1) extras.push("emoji");
  if (countMatches(raw, /\?/g) > 1) extras.push("multiple_questions");

  const policy = ctx.company.pricingPolicy ?? "";
  if (policy.length > 0 && NO_PRICE_POLICY_PATTERN.test(policy) && PRICE_MENTION_PATTERN.test(raw)) {
    extras.push("price_mention");
    extras.push("price_mention_extra");
  }
  const priceExtra = extras.includes("price_mention") ? 1 : 0;
  const score = salesHits + extras.length - priceExtra + (extras.includes("price_mention") ? 2 : 0);

  const data = { score, salesHits, signals: extras };
  if (score >= SALES_LANGUAGE_BLOCKER_SCORE) {
    return fail("EXCESSIVE_SALES_LANGUAGE", "BLOCKER", "excessive_sales_language", data);
  }
  if (score >= SALES_LANGUAGE_WARNING_SCORE) {
    return fail("EXCESSIVE_SALES_LANGUAGE", "WARNING", "sales_language", data);
  }
  return pass("EXCESSIVE_SALES_LANGUAGE", "BLOCKER", "ok", data);
};
