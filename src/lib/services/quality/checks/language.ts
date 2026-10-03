import { normalizeForComparison, textContainsPhrase } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

const ENGLISH_MARKERS = ["the", "and", "to", "of", "you", "your", "we", "for", "with", "is", "our"];

function asciiRatio(text: string): number {
  if (text.length === 0) return 1;
  let ascii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
  }
  return ascii / text.length;
}

/**
 * LANGUAGE (WARNING): heuristic script/stopword check that the message language
 * matches the campaign/company language. Never a blocker (heuristic).
 */
export const languageCheck: QualityCheck = (ctx) => {
  const expected = (ctx.campaign.messageLanguage || ctx.company.messageLanguage || "en").trim().toLowerCase();
  const body = ctx.draft.body;
  if (body.trim().length === 0) {
    return pass("LANGUAGE", "WARNING", "ok_empty");
  }
  const ratio = asciiRatio(body);
  if (expected.startsWith("en")) {
    const normalized = normalizeForComparison(body);
    const hasMarker = ENGLISH_MARKERS.some((marker) => textContainsPhrase(normalized, marker));
    if (ratio < 0.6 || !hasMarker) {
      return fail("LANGUAGE", "WARNING", "language_mismatch", { expected });
    }
    return pass("LANGUAGE", "WARNING", "ok", { expected });
  }
  if (ratio > 0.98) {
    return fail("LANGUAGE", "WARNING", "language_unverifiable", { expected });
  }
  return pass("LANGUAGE", "WARNING", "ok", { expected });
};
