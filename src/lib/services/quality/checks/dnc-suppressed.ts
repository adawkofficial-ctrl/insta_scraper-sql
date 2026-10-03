import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** DNC_SUPPRESSED (BLOCKER): suppression list match or lead marked Do Not Contact. */
export const dncSuppressedCheck: QualityCheck = (ctx) => {
  if (ctx.lead.status === "DO_NOT_CONTACT") {
    return fail("DNC_SUPPRESSED", "BLOCKER", "lead_marked_do_not_contact");
  }
  if (ctx.suppression.suppressed) {
    return fail("DNC_SUPPRESSED", "BLOCKER", "suppression_match", {
      identifierTypes: ctx.suppression.matchedIdentifierTypes,
    });
  }
  return pass("DNC_SUPPRESSED", "BLOCKER", "ok");
};
