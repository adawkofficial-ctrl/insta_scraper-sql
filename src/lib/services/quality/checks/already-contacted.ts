import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** ALREADY_CONTACTED (BLOCKER): contacted in any campaign / anywhere in the duplicate group. */
export const alreadyContactedCheck: QualityCheck = (ctx) => {
  if (ctx.draft.kind === "REPLY") {
    return pass("ALREADY_CONTACTED", "BLOCKER", "reply_draft_exempt");
  }
  if (ctx.previouslyContacted) {
    return fail("ALREADY_CONTACTED", "BLOCKER", "previously_contacted");
  }
  return pass("ALREADY_CONTACTED", "BLOCKER", "ok");
};
