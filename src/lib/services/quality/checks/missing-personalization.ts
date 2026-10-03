import { MISSING_PERSONALIZATION_MIN_TOKEN_LENGTH, STOPWORDS } from "../rules";
import { normalizeForComparison, tokenize } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** Light stemming so "trainers" matches "trainer". */
function lightStem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 3 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function significantTokens(text: string | null | undefined): string[] {
  return tokenize(text)
    .filter((t) => t.length >= MISSING_PERSONALIZATION_MIN_TOKEN_LENGTH && !STOPWORDS.has(t))
    .map(lightStem);
}

/**
 * MISSING_PERSONALIZATION:
 * - BLOCKER when the body shares no grounded token with lead bio/category/niche/location/AI points.
 * - WARNING when the draft's own `personalizationPointsUsed` include an ungrounded point.
 */
export const missingPersonalizationCheck: QualityCheck = (ctx) => {
  if (ctx.draft.kind === "REPLY") {
    return pass("MISSING_PERSONALIZATION", "BLOCKER", "reply_draft_exempt");
  }
  const leadDataText = [
    ctx.lead.biography,
    ctx.lead.businessCategoryName,
    ctx.lead.category,
    ctx.lead.location,
    ctx.lead.targetNiche,
    ...ctx.lead.personalizationPoints,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  const leadDataNormalized = normalizeForComparison(leadDataText);
  const grounded = new Set(significantTokens(leadDataText));

  if (grounded.size === 0) {
    // No grounded data available: cannot verify, do not block legitimate leads.
    return pass("MISSING_PERSONALIZATION", "BLOCKER", "no_grounded_data", { overlap: 0 });
  }

  const bodyTokens = new Set(significantTokens(ctx.draft.body));
  let overlap = 0;
  for (const token of bodyTokens) {
    if (grounded.has(token)) overlap += 1;
  }

  const ungrounded: string[] = [];
  for (const point of ctx.draft.personalizationPointsUsed) {
    const tokens = significantTokens(point);
    if (tokens.length === 0) continue;
    const groundedPoint = tokens.every(
      (token) => grounded.has(token) || leadDataNormalized.includes(token),
    );
    if (!groundedPoint) ungrounded.push(point);
  }

  if (overlap === 0) {
    return fail("MISSING_PERSONALIZATION", "BLOCKER", "no_grounded_personalization", {
      groundedTerms: grounded.size,
    });
  }
  if (ungrounded.length > 0) {
    // Store only the count (never the point text, which may contain lead data).
    return fail("MISSING_PERSONALIZATION", "WARNING", "ungrounded_point", {
      count: ungrounded.length,
    });
  }
  return pass("MISSING_PERSONALIZATION", "BLOCKER", "ok", { overlap });
};
