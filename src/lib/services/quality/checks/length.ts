import {
  MAX_MESSAGE_LENGTH,
  WORD_COUNT_TOLERANCE_MAX,
  WORD_COUNT_TOLERANCE_MIN,
} from "../rules";
import { wordCount } from "../similarity";
import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** LENGTH (BLOCKER if empty or > MAX_MESSAGE_LENGTH; WARNING outside preferred range). */
export const lengthCheck: QualityCheck = (ctx) => {
  const body = ctx.draft.body.trim();
  const chars = body.length;
  if (chars === 0) {
    return fail("LENGTH", "BLOCKER", "empty_body", { chars });
  }
  if (chars > MAX_MESSAGE_LENGTH) {
    return fail("LENGTH", "BLOCKER", "too_long", { chars, max: MAX_MESSAGE_LENGTH });
  }
  const preferred = ctx.company.preferredLength;
  if (preferred && preferred.maxWords > 0) {
    const words = wordCount(body);
    const min = Math.floor(preferred.minWords * WORD_COUNT_TOLERANCE_MIN);
    const max = Math.ceil(preferred.maxWords * WORD_COUNT_TOLERANCE_MAX);
    if (words < min || words > max) {
      return fail("LENGTH", "WARNING", "length_out_of_range", { words, min, max });
    }
  }
  return pass("LENGTH", "WARNING", "ok", { chars });
};
