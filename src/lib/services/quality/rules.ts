/**
 * Step 6 quality gate — rule data, thresholds and weights.
 *
 * Rule ids are stored in the DB and shown in review stats. Do not rename them
 * lightly. All lists here are plain data and easy to extend.
 *
 * ## Scoring
 * `score = max(0, 100 - sum(penalty(failed checks)))` where a failed BLOCKER
 * contributes its `blocker` weight (100 by default -> a blocker forces 0) and a
 * failed WARNING contributes its `warning` weight (10–20). `passed` is true when
 * no BLOCKER failed (warnings do not fail the gate).
 *
 * ## Regeneration
 * Only these BLOCKER ids are considered fixable and trigger regeneration:
 * GENERIC_WORDING, MISSING_PERSONALIZATION, NEAR_DUPLICATE_MESSAGE,
 * EXACT_DUPLICATE_MESSAGE, EXCESSIVE_SALES_LANGUAGE, FORBIDDEN_CLAIMS,
 * COMPANY_FACTS, UNVERIFIABLE_CLAIMS, LENGTH, UNRESOLVED_PLACEHOLDERS.
 * Non-fixable blockers (DNC_SUPPRESSED, DUPLICATE_LEAD, ALREADY_CONTACTED,
 * LEAD_ELIGIBILITY) block immediately without regeneration.
 */
import type { QualityCheckId } from "./types";

export const QUALITY_VERSION = "quality-v1";

/** Mirrors MAX_MESSAGE_LENGTH in messaging-service.ts (kept local so this module stays pure). */
export const MAX_MESSAGE_LENGTH = 1000;

export const NEAR_DUPLICATE_BLOCKER = 0.85;
export const NEAR_DUPLICATE_WARNING = 0.65;
export const NEAR_DUPLICATE_COMPARISON_LIMIT = 300;
export const EXACT_DUPLICATE_WINDOW_DAYS = 90;

export const REPEATED_OPENER_WORDS = 6;
export const REPEATED_OPENER_MIN_HITS = 3;
export const REPEATED_OPENER_COMPARISON_LIMIT = 50;

export const GENERIC_WORDING_BLOCKER_HITS = 3;
export const SALES_LANGUAGE_BLOCKER_SCORE = 4;
export const SALES_LANGUAGE_WARNING_SCORE = 1;

export const WORD_COUNT_TOLERANCE_MIN = 0.8;
export const WORD_COUNT_TOLERANCE_MAX = 1.2;

export const MISSING_PERSONALIZATION_MIN_TOKEN_LENGTH = 4;

export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "for", "from", "had", "has",
  "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i",
  "if", "in", "into", "is", "it", "its", "just", "me", "more", "most", "my",
  "no", "nor", "not", "of", "off", "on", "or", "our", "ours", "out", "over",
  "own", "she", "should", "so", "some", "such", "than", "that", "the", "their",
  "theirs", "them", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "under", "until", "up", "very", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "whom", "why", "will", "with",
  "would", "you", "your", "yours", "hi", "hello", "hey", "dear", "thanks",
  "thank", "regards", "best", "looking", "forward",
]);

export const GENERIC_PHRASES: readonly string[] = [
  "i hope this message finds you well",
  "i came across your profile",
  "i was impressed by your profile",
  "i love what you're doing",
  "i love what you are doing",
  "reaching out because",
  "quick question",
  "hope you're doing well",
  "hope you are doing well",
  "i'd love to connect",
  "i would love to connect",
  "game changer",
  "take your business to the next level",
  "unlock your potential",
  "revolutionary",
  "cutting-edge",
  "synergy",
];

export const UNVERIFIABLE_CLAIM_PHRASES: readonly string[] = [
  "i watched your video",
  "i saw your latest post",
  "i saw your recent post",
  "loved your reel",
  "love your reel",
  "i've been following you",
  "i have been following you",
  "we spoke",
  "as discussed",
  "as a fellow",
];

export const SALES_WORDS: readonly string[] = [
  "guaranteed",
  "limited time",
  "act now",
  "don't miss",
  "dont miss",
  "exclusive offer",
  "100%",
  "risk-free",
  "risk free",
  "skyrocket",
  "explode",
  "10x",
  "double your",
  "no-brainer",
  "no brainer",
  "last chance",
  "today only",
];

export const SENSITIVE_INFERENCE_TERMS: readonly string[] = [
  "diabetes", "cancer", "depression", "anxiety", "therapy", "medication",
  "religion", "religious", "muslim", "christian", "hindu", "jewish",
  "ethnicity", "racial", "racist", "gay", "lesbian", "lgbt", "sexual orientation",
  "politics", "political", "democrat", "republican", "election",
  "debt", "bankrupt", "bankruptcy", "loan", "salary", "your income",
  "disability", "disabled", "pregnant", "pregnancy",
];

export const PROFANITY_TERMS: readonly string[] = [
  "fuck", "fucking", "shit", "bitch", "asshole", "bastard", "dick", "slut", "whore",
];

/** Rule ids that trigger regeneration when they fail as blockers. */
export const FIXABLE_BLOCKER_IDS: ReadonlySet<QualityCheckId> = new Set<QualityCheckId>([
  "GENERIC_WORDING",
  "MISSING_PERSONALIZATION",
  "NEAR_DUPLICATE_MESSAGE",
  "EXACT_DUPLICATE_MESSAGE",
  "EXCESSIVE_SALES_LANGUAGE",
  "FORBIDDEN_CLAIMS",
  "COMPANY_FACTS",
  "UNVERIFIABLE_CLAIMS",
  "LENGTH",
  "UNRESOLVED_PLACEHOLDERS",
]);

export const CHECK_WEIGHTS: Record<QualityCheckId, { blocker: number; warning: number }> = {
  LENGTH: { blocker: 100, warning: 15 },
  UNRESOLVED_PLACEHOLDERS: { blocker: 100, warning: 10 },
  DNC_SUPPRESSED: { blocker: 100, warning: 10 },
  DUPLICATE_LEAD: { blocker: 100, warning: 10 },
  ALREADY_CONTACTED: { blocker: 100, warning: 10 },
  LEAD_ELIGIBILITY: { blocker: 100, warning: 10 },
  EXACT_DUPLICATE_MESSAGE: { blocker: 100, warning: 10 },
  NEAR_DUPLICATE_MESSAGE: { blocker: 100, warning: 20 },
  REPEATED_OPENER: { blocker: 100, warning: 10 },
  GENERIC_WORDING: { blocker: 100, warning: 15 },
  MISSING_PERSONALIZATION: { blocker: 100, warning: 15 },
  UNVERIFIABLE_CLAIMS: { blocker: 100, warning: 10 },
  EXCESSIVE_SALES_LANGUAGE: { blocker: 100, warning: 15 },
  FORBIDDEN_CLAIMS: { blocker: 100, warning: 10 },
  COMPANY_FACTS: { blocker: 100, warning: 15 },
  LANGUAGE: { blocker: 100, warning: 10 },
  SENSITIVE_INFERENCE: { blocker: 100, warning: 10 },
  PROFANITY_OR_HARASSMENT: { blocker: 100, warning: 10 },
};
