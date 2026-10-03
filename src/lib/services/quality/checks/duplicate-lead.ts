import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

/** DUPLICATE_LEAD (BLOCKER): lead is linked to a canonical lead. */
export const duplicateLeadCheck: QualityCheck = (ctx) => {
  if (ctx.draft.kind === "REPLY") {
    return pass("DUPLICATE_LEAD", "BLOCKER", "reply_draft_exempt");
  }
  if (ctx.lead.duplicateOfLeadId) {
    return fail("DUPLICATE_LEAD", "BLOCKER", "duplicate_of_lead");
  }
  return pass("DUPLICATE_LEAD", "BLOCKER", "ok");
};
