import { REPEATED_OPENER_MIN_HITS, REPEATED_OPENER_WORDS } from "../rules";
import { firstNWords } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** REPEATED_OPENER (WARNING): same first 6 words as >= 3 recent campaign messages/drafts. */
export const repeatedOpenerCheck: QualityCheck = (ctx) => {
  if (ctx.draft.kind === "REPLY") {
    return pass("REPEATED_OPENER", "WARNING", "reply_draft_exempt");
  }
  const opener = firstNWords(ctx.draft.body, REPEATED_OPENER_WORDS);
  if (opener.length === 0) {
    return pass("REPEATED_OPENER", "WARNING", "ok_empty", { hits: 0 });
  }
  let hits = 0;
  for (const candidate of ctx.history.recentCampaignOpeners) {
    if (candidate === opener) hits += 1;
  }
  if (hits >= REPEATED_OPENER_MIN_HITS) {
    return fail("REPEATED_OPENER", "WARNING", "repeated_opener", { hits });
  }
  return pass("REPEATED_OPENER", "WARNING", "ok", { hits });
};
