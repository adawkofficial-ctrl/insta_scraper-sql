import { createHash } from "node:crypto";

import { renderTemplateDetailed, type TemplateLeadContext } from "../template/template-renderer";

const BUSINESS_HINTS = [
  "clinic",
  "dental",
  "dentist",
  "orthodont",
  "studio",
  "agency",
  "company",
  "inc",
  "llc",
  "ltd",
  "group",
  "center",
  "centre",
  "salon",
  "spa",
  "shop",
  "store",
  "restaurant",
  "cafe",
  "bar",
  "hotel",
  "gym",
  "fitness",
  "realty",
  "real estate",
  "consulting",
  "solutions",
  "services",
  "academy",
  "school",
  "practice",
  "foundation",
  "official",
  "holdings",
  "partners",
  "ventures",
  "capital",
  "enterprises",
  "labs",
  "systems",
  "technologies",
];

export type ResolvedContactName =
  | { kind: "person"; firstName: string; displayName: string }
  | { kind: "business"; businessName: string; displayName: string }
  | { kind: "none"; reason: string };

function looksLikeBusiness(text: string | null | undefined): boolean {
  const value = (text ?? "").toLowerCase();
  return BUSINESS_HINTS.some((hint) => value.includes(hint));
}

/** Only returns a person name when the profile evidence says it is a person. */
export function resolveContactName(lead: {
  fullName?: string | null;
  biography?: string | null;
  category?: string | null;
  isBusinessAccount?: boolean | null;
}): ResolvedContactName {
  const fullName = lead.fullName?.trim() ?? "";
  if (!fullName) return { kind: "none", reason: "NO_NAME" };

  const businessByFlag = lead.isBusinessAccount === true;
  const businessByText =
    looksLikeBusiness(fullName) ||
    looksLikeBusiness(lead.category) ||
    looksLikeBusiness(lead.biography);
  const words = fullName.split(/\s+/).filter(Boolean);
  const personShape = words.length >= 2 && words.length <= 4 && !/\d|@|http/i.test(fullName);

  if (!businessByFlag && !businessByText && personShape) {
    const firstName = words[0];
    return { kind: "person", firstName, displayName: firstName };
  }

  if (businessByFlag || businessByText) {
    return { kind: "business", businessName: fullName, displayName: fullName };
  }

  return { kind: "none", reason: "AMBIGUOUS_NAME" };
}

export type PersonalizedMessageInput = {
  template: string;
  lead: TemplateLeadContext & { isBusinessAccount?: boolean | null };
  campaign?: { name?: string | null; description?: string | null; category?: string | null };
  senderName?: string | null;
  requireName?: boolean;
  allowNeutralGreeting?: boolean;
};

export type PersonalizedMessageResult =
  | {
      ok: true;
      text: string;
      nameKind: "person" | "business";
      resolvedName: string;
      renderedTextHash: string;
      usedVariables: string[];
    }
  | { ok: false; code: string; reason: string; missingVariables: string[] };

export function renderPersonalizedFirstMessage(
  input: PersonalizedMessageInput,
): PersonalizedMessageResult {
  const name = resolveContactName(input.lead);
  const requireName = input.requireName !== false;

  if (name.kind === "none") {
    return {
      ok: false,
      code: requireName ? "NAME_REQUIRED" : "NEUTRAL_GREETING_UNAVAILABLE",
      reason:
        "A verified person or business name is required; neutral greeting also requires an existing business name.",
      missingVariables: [],
    };
  }

  const rendered = renderTemplateDetailed(
    input.template,
    {
      ...input.lead,
      fullName:
        name.kind === "person"
          ? input.lead.fullName
          : name.kind === "business"
            ? name.businessName
            : input.lead.fullName,
    },
    input.campaign,
    input.senderName,
  );

  if (rendered.missingVariables.length > 0) {
    return {
      ok: false,
      code: "UNRESOLVED_PLACEHOLDER",
      reason: `Unresolved placeholder(s): ${rendered.missingVariables.join(", ")}`,
      missingVariables: rendered.missingVariables,
    };
  }

  const text = rendered.text.trim();
  if (!text || /^(hi|hello|hey)\s*[,!.]?\s*$/i.test(text) || /\b(hi|hello|hey)\s*,/i.test(text)) {
    return {
      ok: false,
      code: "EMPTY_GREETING",
      reason: "The first message has an empty or malformed greeting.",
      missingVariables: [],
    };
  }
  if (/\{[^}]+\}/.test(text)) {
    return {
      ok: false,
      code: "UNRESOLVED_PLACEHOLDER",
      reason: "The first message still contains an unresolved placeholder.",
      missingVariables: [],
    };
  }
  const links = text.match(/https?:\/\/\S+/gi) ?? [];
  if (links.length > 1) {
    return {
      ok: false,
      code: "TOO_MANY_LINKS",
      reason: "The first message may contain at most one link.",
      missingVariables: [],
    };
  }

  return {
    ok: true,
    text,
    nameKind: name.kind === "person" ? "person" : "business",
    resolvedName: name.kind === "person" ? name.firstName : name.businessName,
    renderedTextHash: createHash("sha256").update(text).digest("hex"),
    usedVariables: rendered.usedVariables,
  };
}

export function normalizeRenderedText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
}

export type TemplateVariant = { id: string; body: string };

/** Round-robin variant picker that never repeats the previous variant per account. */
export function selectTemplateVariant(input: {
  variants: TemplateVariant[];
  accountSendCount: number;
  leadSeed: string;
  lastVariant?: string | null;
}): TemplateVariant | null {
  if (input.variants.length === 0) return null;
  const seed = createHash("sha256").update(input.leadSeed).digest().readUInt32BE(0);
  let index = Math.abs(input.accountSendCount + seed) % input.variants.length;
  if (
    input.variants.length > 1 &&
    input.lastVariant &&
    input.variants[index]?.id === input.lastVariant
  ) {
    index = (index + 1) % input.variants.length;
  }
  return input.variants[index];
}

export type FirstMessageValidation =
  | { ok: true; nameKind: "person" | "business"; resolvedName: string }
  | { ok: false; code: string; reason: string };

/** Validates an already-rendered first message (single/bulk/execution paths). */
export function validateFirstMessageText(input: {
  text: string;
  lead: {
    fullName?: string | null;
    biography?: string | null;
    category?: string | null;
    isBusinessAccount?: boolean | null;
    username?: string | null;
  };
  requireName?: boolean;
  allowNeutralGreeting?: boolean;
}): FirstMessageValidation {
  const text = input.text.trim();
  if (!text) return { ok: false, code: "EMPTY_MESSAGE", reason: "The first message is empty." };
  if (/\{[^}]+\}/.test(text)) {
    return {
      ok: false,
      code: "UNRESOLVED_PLACEHOLDER",
      reason: "The first message still contains an unresolved placeholder.",
    };
  }
  if (/\b(hi|hello|hey)\s*,/i.test(text)) {
    return { ok: false, code: "EMPTY_GREETING", reason: "The first message has an empty greeting." };
  }
  const links = text.match(/https?:\/\/\S+/gi) ?? [];
  if (links.length > 1) {
    return {
      ok: false,
      code: "TOO_MANY_LINKS",
      reason: "The first message may contain at most one link.",
    };
  }

  const name = resolveContactName(input.lead);
  if (name.kind === "none") {
    return {
      ok: false,
      code: input.requireName === false ? "NEUTRAL_GREETING_UNAVAILABLE" : "NAME_REQUIRED",
      reason: "No verified person or business name could be resolved for this lead.",
    };
  }

  const lowered = text.toLowerCase();
  const expected = (name.kind === "person" ? name.firstName : name.businessName).toLowerCase();
  const mentionsName = expected.length > 0 && lowered.includes(expected);
  const neutralTeam =
    input.allowNeutralGreeting === true &&
    name.kind === "business" &&
    /hello\b[\s\S]*\bteam\b/i.test(text);
  if (input.requireName !== false && !mentionsName && !neutralTeam) {
    return {
      ok: false,
      code: "NEEDS_EDIT",
      reason: `The first message must mention ${name.kind === "person" ? "the contact" : "the business"} by name.`,
    };
  }
  return {
    ok: true,
    nameKind: name.kind === "person" ? "person" : "business",
    resolvedName: name.kind === "person" ? name.firstName : name.businessName,
  };
}
