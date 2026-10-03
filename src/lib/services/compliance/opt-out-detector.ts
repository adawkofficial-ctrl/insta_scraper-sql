import {
  HIGH_CONFIDENCE_PHRASES,
  HIGH_CONFIDENCE_EXACT_WORDS,
  MEDIUM_CONFIDENCE_PHRASES,
  MULTILINGUAL_OPT_OUT_PHRASES,
  STOP_FALSE_POSITIVE_PATTERNS,
} from "./opt-out-constants";

export type OptOutDetectionResult = {
  optOut: boolean;
  confidence: "high" | "medium" | "low";
  matchedRule?: string;
};

/**
 * Normalizes text for opt-out phrase scanning:
 * - Lowercases
 * - Converts newlines to spaces
 * - Strips emojis and decorative Unicode symbols
 * - Collapses consecutive spaces
 */
export function normalizeOptOutText(rawText: string): string {
  if (!rawText) return "";
  return rawText
    .toLowerCase()
    // Strip emojis and non-alphanumeric chars except basic punctuation
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, " ")
    .replace(/[^\w\s',.?!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detects whether an inbound message contains an opt-out or suppression instruction.
 * Pure function: deterministic, side-effect free.
 */
export function detectOptOut(rawText: string | null | undefined): OptOutDetectionResult {
  if (!rawText || typeof rawText !== "string") {
    return { optOut: false, confidence: "low" };
  }

  const normalized = normalizeOptOutText(rawText);
  if (!normalized) {
    return { optOut: false, confidence: "low" };
  }

  // 1. Check for negative false-positive phrases (e.g., "can't stop", "bus stop", "non-stop")
  const hasFalsePositive = STOP_FALSE_POSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));

  // 2. "Not interested" alone is NOT an opt-out (intent is NOT_INTERESTED, not DNC)
  // Check if text is just an expression of disinterest without an explicit stop/opt-out command
  const pureNotInterestedRegex = /^(i am |i'm )?not interested( at all| right now| thanks| thank you)?\.?!?$/i;
  if (pureNotInterestedRegex.test(normalized)) {
    return { optOut: false, confidence: "low" };
  }

  // 3. Multilingual rules (Urdu/Hindi, etc.) -> HIGH confidence
  for (const phrase of MULTILINGUAL_OPT_OUT_PHRASES) {
    if (normalized.includes(phrase)) {
      return {
        optOut: true,
        confidence: "high",
        matchedRule: `multilingual:${phrase}`,
      };
    }
  }

  // 4. HIGH confidence explicit phrases
  for (const phrase of HIGH_CONFIDENCE_PHRASES) {
    if (hasFalsePositive && phrase.includes("stop")) {
      continue;
    }
    // Regex boundary check for words, or direct substring if compound
    const regex = new RegExp(`(^|\\b)${phrase.replace("-", "[- ]?")}(\\b|$)`, "i");
    if (regex.test(normalized)) {
      return {
        optOut: true,
        confidence: "high",
        matchedRule: `high_phrase:${phrase}`,
      };
    }
  }

  // 5. Standalone single-word opt-outs (e.g. "stop", "unsubscribe")
  // Only trigger if no false-positive phrase matched (e.g. not "bus stop")
  if (!hasFalsePositive) {
    // Strip trailing punctuation for whole-message check
    const singleWord = normalized.replace(/[.?!]+$/, "").trim();
    if (HIGH_CONFIDENCE_EXACT_WORDS.includes(singleWord)) {
      return {
        optOut: true,
        confidence: "high",
        matchedRule: `exact_word:${singleWord}`,
      };
    }

    // Check if the message starts with "stop" as a standalone command (e.g. "Stop. Leave me alone" or "Stop! Please")
    if (/^stop\b/i.test(normalized)) {
      return {
        optOut: true,
        confidence: "high",
        matchedRule: "exact_word:stop_prefix",
      };
    }
  }

  // 6. MEDIUM confidence phrases
  for (const phrase of MEDIUM_CONFIDENCE_PHRASES) {
    if (hasFalsePositive && phrase.includes("stop")) {
      continue;
    }
    const regex = new RegExp(`(^|\\b)${phrase.replace("-", "[- ]?")}(\\b|$)`, "i");
    if (regex.test(normalized)) {
      return {
        optOut: true,
        confidence: "medium",
        matchedRule: `medium_phrase:${phrase}`,
      };
    }
  }

  return { optOut: false, confidence: "low" };
}
