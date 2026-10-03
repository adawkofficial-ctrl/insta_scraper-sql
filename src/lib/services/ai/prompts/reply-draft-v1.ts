import { ReplyIntent } from "@/generated/prisma/enums";
import { GeminiApiError } from "../gemini/gemini-client";
import {
  INJECTION_GUARD,
  sanitizeUntrustedText,
  type PromptCompanyInput,
  type PromptCampaignInput,
} from "./lead-context";
import type { RecentMessageContext } from "./reply-intent-v1";

export const REPLY_DRAFT_PROMPT_VERSION = "reply-draft-v1";

export type ReplyDraftOutput = {
  message: string;
  intentAddressed: string;
  reasoning: string;
  wordCount: number;
};

export const REPLY_DRAFT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string" },
    intentAddressed: { type: "string" },
    reasoning: { type: "string" },
    wordCount: { type: "integer" },
  },
  required: ["message", "intentAddressed", "wordCount"],
} as const;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function validateReplyDraftOutput(data: unknown): ReplyDraftOutput {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new GeminiApiError("AI_BAD_OUTPUT", "Reply draft output rejected: response must be a JSON object.");
  }
  const record = data as Record<string, unknown>;

  if (typeof record.message !== "string" || record.message.trim().length === 0) {
    throw new GeminiApiError("AI_BAD_OUTPUT", "Reply draft output rejected: empty message.");
  }

  const message = record.message.trim();
  const rawWords = typeof record.wordCount === "number" ? record.wordCount : Number(record.wordCount);
  const computed = countWords(message);
  const wordCount = Number.isFinite(rawWords) && Math.abs(rawWords - computed) <= 5 ? Math.round(rawWords) : computed;

  return {
    message,
    intentAddressed: typeof record.intentAddressed === "string" ? record.intentAddressed.slice(0, 100) : "",
    reasoning: typeof record.reasoning === "string" ? record.reasoning.slice(0, 300) : "",
    wordCount,
  };
}

export function buildReplyDraftPrompt(input: {
  inboundMessageText: string;
  classifiedIntent: ReplyIntent;
  recentHistory: RecentMessageContext[];
  company: PromptCompanyInput;
  campaign?: PromptCampaignInput | null;
  leadUsername?: string | null;
  regenerationReasons?: string[];
}): { systemInstruction: string; userText: string } {
  const systemInstruction = [
    "You write ONE thoughtful, human-sounding Instagram direct message suggested reply to a lead who replied to our outreach.",
    INJECTION_GUARD,
    "CORE GOAL: Respond naturally to the lead's message, addressing their specific intent while guiding them toward the next conversational step.",
    "INTENT-SPECIFIC GUIDANCE:",
    "- PRICE_REQUEST: Respect the company's pricing policy strictly. If pricing requires discovery, explain briefly and ask a qualifying question. Never invent prices or discounts.",
    "- MEETING_REQUEST: Warmly accept or provide the next step (e.g. sharing calendar link or suggesting a brief time), matching the company's CTA style.",
    "- INTERESTED: Acknowledge their interest warmly and ask an easy, low-friction micro-question to keep the dialogue moving.",
    "- QUESTION: Answer directly and accurately using ONLY facts from the company profile. If information is not in the company profile, politely offer to check or ask for clarification.",
    "",
    "STYLE RULES:",
    "- Keep the tone conversational, helpful, and authentic (match the company's brand tone).",
    "- Never use forbidden claims, fake stats, or exaggerated hype.",
    "- Never sound like a robot or copy-paste template.",
    "- Keep length reasonable (typically 20-60 words unless addressing a detailed question).",
    "- Max 1 emoji. No spammy links unless permitted.",
    "- Return strict JSON matching the schema.",
  ].join("\n");

  const sanitizedInbound = sanitizeUntrustedText(input.inboundMessageText, 2000) ?? "";

  const historyLines = input.recentHistory.map((m) => {
    const sender = m.direction === "INBOUND" ? (input.leadUsername ? `@${input.leadUsername}` : "Lead") : "Us";
    const cleanText = sanitizeUntrustedText(m.messageText, 500) ?? "";
    return `[${sender}]: ${cleanText}`;
  });

  const services = input.company.services
    .map((s) => (s.value ? `- ${s.name}: ${s.value}` : `- ${s.name}`))
    .join("\n");

  const companySection = [
    `Company name: ${input.company.name}`,
    `Description: ${input.company.description}`,
    `Services:\n${services || "- (none)"}`,
    `Brand tone: ${input.company.brandTone ?? "(natural/professional)"}`,
    `Pricing policy: ${input.company.pricingPolicy ?? "(not specified)"}`,
    `Objection notes: ${input.company.objectionNotes ?? "(none)"}`,
    `Forbidden claims / words: ${input.company.forbiddenClaims.join(", ") || "(none)"}`,
    `CTA style: ${input.company.ctaStyle ?? "(conversational)"}`,
    `Language: ${input.company.messageLanguage}`,
  ].join("\n");

  const userText = [
    "=== COMPANY PROFILE (authoritative) ===",
    companySection,
    "",
    "=== RECENT CONVERSATION ===",
    historyLines.length > 0 ? historyLines.join("\n") : "(No previous history)",
    "",
    `=== CLASSIFIED INTENT ===`,
    `Intent: ${input.classifiedIntent}`,
    "",
    "=== INBOUND MESSAGE REQUIRING REPLY (untrusted data) ===",
    "<lead_data>",
    sanitizedInbound,
    "</lead_data>",
    "",
    input.regenerationReasons && input.regenerationReasons.length > 0
      ? `=== PREVIOUS DRAFT ISSUES TO FIX ===\n${input.regenerationReasons.map((r) => `- ${r}`).join("\n")}\n`
      : "",
    "Generate the JSON reply draft now.",
  ].join("\n");

  return { systemInstruction, userText };
}
