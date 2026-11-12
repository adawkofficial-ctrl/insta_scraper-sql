/**
 * Step 6 quality gate — shared types.
 *
 * The quality engine is pure and deterministic: every check is a function of a
 * pre-loaded {@link QualityContext}. Nothing here imports `server-only`, Prisma,
 * or any provider, so the whole engine is unit-testable without a database.
 */

export type QualitySeverity = "BLOCKER" | "WARNING";

/** Stable rule ids. Stored in DB + stats; do not rename lightly. */
export type QualityCheckId =
  | "LENGTH"
  | "UNRESOLVED_PLACEHOLDERS"
  | "DNC_SUPPRESSED"
  | "DUPLICATE_LEAD"
  | "ALREADY_CONTACTED"
  | "LEAD_ELIGIBILITY"
  | "EXACT_DUPLICATE_MESSAGE"
  | "NEAR_DUPLICATE_MESSAGE"
  | "REPEATED_OPENER"
  | "GENERIC_WORDING"
  | "MISSING_PERSONALIZATION"
  | "UNVERIFIABLE_CLAIMS"
  | "EXCESSIVE_SALES_LANGUAGE"
  | "FORBIDDEN_CLAIMS"
  | "COMPANY_FACTS"
  | "LANGUAGE"
  | "SENSITIVE_INFERENCE"
  | "PROFANITY_OR_HARASSMENT";

export type QualityCheckResult = {
  id: QualityCheckId;
  /** Severity that applies when `passed` is false. */
  severity: QualitySeverity;
  passed: boolean;
  /** Short, PII-free explanation. Never contains the message body. */
  detail: string;
  data?: Record<string, unknown>;
};

export type QualityCheck = (ctx: QualityContext) => QualityCheckResult;

export type QualityHistory = {
  /** Normalized bodies of other outbound messages/drafts by the same user (90d window). */
  exactDuplicateBodies: string[];
  /** Last N outbound message texts (raw) used for near-duplicate shingles. */
  recentOutboundTexts: string[];
  /** Normalized first-6-word openers of the campaign's last N messages/drafts. */
  recentCampaignOpeners: string[];
};

export type QualityCompany = {
  name: string;
  description: string;
  services: string[];
  forbiddenClaims: string[];
  preferredLength: { minWords: number; maxWords: number } | null;
  pricingPolicy: string | null;
  brandTone: string | null;
  messageLanguage: string;
  /** Concatenated company text used for factual verification (never logged). */
  rawText: string;
};

export type QualityContext = {
  draft: {
    id: string;
    /** Final body under review (editedBody ?? generated body). */
    body: string;
    /** Last generated body (used for edit distance elsewhere). */
    generatedBody: string;
    promptVersion: string;
    personalizationPointsUsed: string[];
    kind?: "OUTREACH" | "REPLY";
  };
  lead: {
    id: string;
    campaignId: string;
    username: string | null;
    fullName: string | null;
    biography: string | null;
    businessCategoryName: string | null;
    category: string | null;
    location: string | null;
    aiStatus: string;
    status: string;
    duplicateOfLeadId: string | null;
    leadScore: number | null;
    targetNiche: string | null;
    personalizationPoints: string[];
    hasPostContext: boolean;
  };
  campaign: {
    id: string;
    aiQualificationEnabled: boolean;
    messageLanguage: string | null;
  };
  company: QualityCompany;
  suppression: { suppressed: boolean; matchedIdentifierTypes: string[] };
  previouslyContacted: boolean;
  history: QualityHistory;
};

export type QualityGateResult = {
  passed: boolean;
  score: number;
  qualityVersion: string;
  bodyHash: string;
  blockers: QualityCheckResult[];
  warnings: QualityCheckResult[];
  checks: QualityCheckResult[];
};
