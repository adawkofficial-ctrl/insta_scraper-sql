import type { QualityCheck } from "../types";
import { fail, pass } from "./_shared";

const PLACEHOLDER_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "double_brace", re: /\{\{[^}]*\}\}/ },
  { label: "single_brace", re: /\{[a-zA-Z_][a-zA-Z0-9_]*\}/ },
  { label: "square_name", re: /\[[A-Za-z][A-Za-z ]*\]/ },
  { label: "angle_name", re: /<[a-zA-Z_][a-zA-Z0-9_]*>/ },
  { label: "insert_marker", re: /\[\s*insert/i },
  { label: "todo_marker", re: /\bTODO\b/i },
  { label: "lorem_ipsum", re: /lorem ipsum/i },
];

/** UNRESOLVED_PLACEHOLDERS (BLOCKER): literal template leftovers. */
export const unresolvedPlaceholdersCheck: QualityCheck = (ctx) => {
  const body = ctx.draft.body;
  for (const { label, re } of PLACEHOLDER_PATTERNS) {
    if (re.test(body)) {
      return fail("UNRESOLVED_PLACEHOLDERS", "BLOCKER", "unresolved_placeholder", { pattern: label });
    }
  }
  return pass("UNRESOLVED_PLACEHOLDERS", "BLOCKER", "ok");
};
