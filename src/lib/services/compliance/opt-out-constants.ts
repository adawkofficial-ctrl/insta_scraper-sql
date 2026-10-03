/**
 * Configurable opt-out phrase definitions and patterns.
 */

// Phrases that indicate explicit opt-out with HIGH confidence
export const HIGH_CONFIDENCE_PHRASES: readonly string[] = [
  "unsubscribe",
  "unsubscibe", // common typo
  "unsubcribe",  // common typo
  "unsub",
  "un-subscribe",
  "remove me",
  "take me off your list",
  "take me off this list",
  "take me off the list",
  "remove me from your list",
  "remove me from this list",
  "do not contact",
  "don't contact",
  "dont contact",
  "do not message",
  "don't message me",
  "dont message me",
  "stop messaging",
  "stop sending",
  "leave me alone",
  "opt out",
  "opt-out",
];

// Single whole-message opt-out tokens (when trimmed message equals this or contains standard boundary)
export const HIGH_CONFIDENCE_EXACT_WORDS: readonly string[] = [
  "stop",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
];

// Phrases that indicate opt-out with MEDIUM confidence
export const MEDIUM_CONFIDENCE_PHRASES: readonly string[] = [
  "not interested, please don't",
  "not interested please dont",
  "not interested, please dont",
  "please stop",
  "quit messaging",
  "stop contacting me",
  "stop dm-ing me",
  "stop dming me",
  "stop texting me",
  "stop writing to me",
  "please remove",
];

// Configurable Roman Urdu / Hindi phrases
export const MULTILINGUAL_OPT_OUT_PHRASES: readonly string[] = [
  "mujhe message mat karo",
  "mujhe msg mat karo",
  "message mat karo",
  "msg mat karo",
  "band karo",
  "mat bhejo",
  "ab message mat karna",
  "pareshan mat karo",
];

// False-positive phrases where words like 'stop' appear in harmless contexts
export const STOP_FALSE_POSITIVE_PATTERNS: readonly RegExp[] = [
  /\bcan'?t\s+stop\b/i,
  /\bcouldn'?t\s+stop\b/i,
  /\bwon'?t\s+stop\b/i,
  /\bdon'?t\s+stop\b/i,
  /\bnever\s+stop\b/i,
  /\bnon[- ]?stop\b/i,
  /\bbus\s+stop\b/i,
  /\btrain\s+stop\b/i,
  /\bdoor\s+stop\b/i,
  /\bpit\s+stop\b/i,
  /\bhard\s+to\s+stop\b/i,
];
