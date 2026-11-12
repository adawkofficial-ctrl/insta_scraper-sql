import "server-only";

import crypto from "node:crypto";

export type EmailTemplateContext = {
  businessName: string | null;
  city: string | null;
  firstName: string | null;
};

export type RenderedEmail = {
  subject: string;
  body: string;
  unresolvedPlaceholders: string[];
};

const ALLOWED_PLACEHOLDERS = new Set(["businessName", "city", "firstName"]);

export function getAppPublicUrl(): string | null {
  const raw = process.env.APP_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function generateUnsubscribeToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function buildUnsubscribeUrl(token: string): string {
  const base = getAppPublicUrl();
  if (!base) throw new Error("APP_PUBLIC_URL is required for email sending.");
  return `${base}/unsubscribe/${token}`;
}

export function renderEmailTemplate(
  template: string,
  context: EmailTemplateContext,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const values: Record<string, string | null> = {
    businessName: context.businessName,
    city: context.city,
    firstName: context.firstName,
  };
  const text = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    if (!ALLOWED_PLACEHOLDERS.has(key)) {
      unresolved.push(key);
      return `{${key}}`;
    }
    const value = values[key];
    if (value === null || value === undefined || value.trim() === "") {
      unresolved.push(key);
      return `{${key}}`;
    }
    return value.trim();
  });
  return { text, unresolved: Array.from(new Set(unresolved)) };
}

export function buildEmailGreeting(businessName: string | null): string {
  const name = businessName?.trim();
  return name ? `Hello ${name} team,` : "Hello team,";
}

export function lintEmailContent(subject: string, body: string): string[] {
  const problems: string[] = [];
  const combined = `${subject}\n${body}`;
  const upperRatio =
    subject.length > 0
      ? subject.replace(/[^A-Z]/g, "").length / Math.max(1, subject.replace(/\s/g, "").length)
      : 0;
  if (subject === subject.toUpperCase() && /[A-Z]{4,}/.test(subject)) {
    problems.push("Subject is ALL CAPS");
  } else if (upperRatio > 0.7 && subject.replace(/\s/g, "").length > 8) {
    problems.push("Subject is mostly uppercase");
  }
  if (/[!?]{2,}/.test(combined)) {
    problems.push("Excessive punctuation");
  }
  const spammy = [
    "free",
    "act now",
    "limited time",
    "guarantee",
    "risk-free",
    "urgent",
    "winner",
    "cash",
    "100%",
    "no obligation",
  ];
  for (const word of spammy) {
    if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(combined)) {
      problems.push(`Spammy phrase: "${word}"`);
    }
  }
  const linkCount = (combined.match(/https?:\/\/[^\s]+/gi) ?? []).length;
  if (linkCount > 1) {
    problems.push("More than one link");
  }
  return problems;
}

export type ComplianceFooterInput = {
  senderName: string;
  companyName: string;
  postalAddress: string;
  unsubscribeUrl: string;
};

export function buildComplianceFooter(input: ComplianceFooterInput): string {
  return [
    "",
    "--",
    `${input.senderName}, ${input.companyName}`,
    input.postalAddress,
    `Unsubscribe: ${input.unsubscribeUrl}`,
    "You can also reply STOP and we will not contact you again.",
  ].join("\n");
}

export function buildListUnsubscribeHeaders(input: {
  mailto: string;
  unsubscribeUrl: string;
}): Record<string, string> {
  return {
    "List-Unsubscribe": `<mailto:${input.mailto}?subject=unsubscribe>, <${input.unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export function countLinks(text: string): number {
  return (text.match(/https?:\/\/[^\s]+/gi) ?? []).length;
}
