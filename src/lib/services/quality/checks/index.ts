import type { QualityCheck } from "../types";
import { alreadyContactedCheck } from "./already-contacted";
import { companyFactsCheck } from "./company-facts";
import { dncSuppressedCheck } from "./dnc-suppressed";
import { duplicateLeadCheck } from "./duplicate-lead";
import { exactDuplicateMessageCheck } from "./exact-duplicate-message";
import { excessiveSalesLanguageCheck } from "./excessive-sales-language";
import { forbiddenClaimsCheck } from "./forbidden-claims";
import { genericWordingCheck } from "./generic-wording";
import { languageCheck } from "./language";
import { leadEligibilityCheck } from "./lead-eligibility";
import { lengthCheck } from "./length";
import { missingPersonalizationCheck } from "./missing-personalization";
import { nearDuplicateMessageCheck } from "./near-duplicate-message";
import { profanityCheck } from "./profanity";
import { repeatedOpenerCheck } from "./repeated-opener";
import { sensitiveInferenceCheck } from "./sensitive-inference";
import { unresolvedPlaceholdersCheck } from "./unresolved-placeholders";
import { unverifiableClaimsCheck } from "./unverifiable-claims";

/** All checks in canonical rule-id order (see rules.ts header). */
export const QUALITY_CHECKS: readonly QualityCheck[] = [
  lengthCheck,
  unresolvedPlaceholdersCheck,
  dncSuppressedCheck,
  duplicateLeadCheck,
  alreadyContactedCheck,
  leadEligibilityCheck,
  exactDuplicateMessageCheck,
  nearDuplicateMessageCheck,
  repeatedOpenerCheck,
  genericWordingCheck,
  missingPersonalizationCheck,
  unverifiableClaimsCheck,
  excessiveSalesLanguageCheck,
  forbiddenClaimsCheck,
  companyFactsCheck,
  languageCheck,
  sensitiveInferenceCheck,
  profanityCheck,
];

/** Checks that can produce a BLOCKER (warning-only checks are excluded). */
export const BLOCKER_CHECKS: readonly QualityCheck[] = QUALITY_CHECKS.filter(
  (check) =>
    check !== repeatedOpenerCheck && check !== languageCheck,
);
