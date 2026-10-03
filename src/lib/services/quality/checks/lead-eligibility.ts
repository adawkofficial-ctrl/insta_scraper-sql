import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

// QUEUED is included because dispatch-time re-verification happens after the
// lead has been queued for the very job that is sending.
const BASE_ELIGIBLE = new Set(["NEW", "QUALIFIED", "READY_FOR_OUTREACH", "QUEUED"]);
const AI_ELIGIBLE = new Set(["QUALIFIED", "READY_FOR_OUTREACH", "QUEUED"]);
const REPLY_ELIGIBLE = new Set([
  "REPLIED",
  "INTERESTED",
  "FOLLOW_UP",
  "MEETING",
  "QUALIFIED",
  "READY_FOR_OUTREACH",
  "CONTACTED",
]);

/** LEAD_ELIGIBILITY (BLOCKER): status + analysis completeness for the campaign mode. */
export const leadEligibilityCheck: QualityCheck = (ctx) => {
  if (ctx.draft.kind === "REPLY") {
    if (!REPLY_ELIGIBLE.has(ctx.lead.status)) {
      return fail("LEAD_ELIGIBILITY", "BLOCKER", "lead_status_ineligible", { status: ctx.lead.status });
    }
    return pass("LEAD_ELIGIBILITY", "BLOCKER", "ok");
  }
  const eligible = ctx.campaign.aiQualificationEnabled ? AI_ELIGIBLE : BASE_ELIGIBLE;
  if (!eligible.has(ctx.lead.status)) {
    return fail("LEAD_ELIGIBILITY", "BLOCKER", "lead_status_ineligible", { status: ctx.lead.status });
  }
  if (ctx.campaign.aiQualificationEnabled && ctx.lead.aiStatus !== "DONE") {
    return fail("LEAD_ELIGIBILITY", "BLOCKER", "lead_not_analyzed", { aiStatus: ctx.lead.aiStatus });
  }
  return pass("LEAD_ELIGIBILITY", "BLOCKER", "ok");
};
