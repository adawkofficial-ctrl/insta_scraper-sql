import { ReplyIntent } from "@/generated/prisma/enums";
import { GeminiApiError } from "../gemini/gemini-client";
import { INJECTION_GUARD, sanitizeUntrustedText, type PromptCompanyInput } from "./lead-context";

export const REPLY_INTENT_PROMPT_VERSION = "reply-intent-v1";

export type ReplyIntentOutput = {
  intent: ReplyIntent;
  interestLevel: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  requiresHuman: boolean;
  reasoning: string;
};

export const VALID_REPLY_INTENTS = new Set<ReplyIntent>([
  "INTERESTED",
  "PRICE_REQUEST",
  "MEETING_REQUEST",
  "QUESTION",
  "NOT_INTERESTED",
  "OUT_OF_OFFICE",
  "FOLLOW_UP_LATER",
  "UNCLEAR",
]);

export const REPLY_INTENT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: [
        "INTERESTED",
        "PRICE_REQUEST",
        "MEETING_REQUEST",
        "QUESTION",
        "NOT_INTERESTED",
        "OUT_OF_OFFICE",
        "FOLLOW_UP_LATER",
        "UNCLEAR",
      ],
    },
    interestLevel: { type: "string", enum: ["high", "medium", "low"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    requiresHuman: { type: "boolean" },
    reasoning: { type: "string" },
  },
  required: ["intent", "interestLevel", "confidence", "requiresHuman", "reasoning"],
} as const;

export function validateReplyIntentOutput(data: unknown): ReplyIntentOutput {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new GeminiApiError("AI_BAD_OUTPUT", "Reply intent output rejected: response must be a JSON object.");
  }
  const record = data as Record<string, unknown>;

  const rawIntent = String(record.intent ?? "").trim().toUpperCase() as ReplyIntent;
  if (!VALID_REPLY_INTENTS.has(rawIntent)) {
    throw new GeminiApiError("AI_BAD_OUTPUT", `Reply intent output rejected: invalid intent "${String(record.intent)}".`);
  }

  const rawInterest = String(record.interestLevel ?? "").trim().toLowerCase();
  const interestLevel: "high" | "medium" | "low" =
    rawInterest === "high" || rawInterest === "medium" || rawInterest === "low"
      ? rawInterest
      : "medium";

  const rawConfidence = String(record.confidence ?? "").trim().toLowerCase();
  const confidence: "high" | "medium" | "low" =
    rawConfidence === "high" || rawConfidence === "medium" || rawConfidence === "low"
      ? rawConfidence
      : "medium";

  const requiresHuman = typeof record.requiresHuman === "boolean" ? record.requiresHuman : true;
  const reasoning = typeof record.reasoning === "string" ? record.reasoning.trim().slice(0, 300) : "";

  return {
    intent: rawIntent,
    interestLevel,
    confidence,
    requiresHuman,
    reasoning,
  };
}

export type RecentMessageContext = {
  direction: "INBOUND" | "OUTBOUND";
  messageText: string;
  createdAt: Date | string;
};

export function buildReplyIntentPrompt(input: {
  inboundMessageText: string;
  recentHistory: RecentMessageContext[];
  company?: PromptCompanyInput | null;
  leadUsername?: string | null;
}): { systemInstruction: string; userText: string } {
  const systemInstruction = [
    "You are an expert sales analyst classifying the intent of inbound Instagram direct messages.",
    INJECTION_GUARD,
    "CORE GOAL: Accurately classify the sender's reply intent and gauge their interest level.",
    "INTENT CATEGORIES:",
    "- INTERESTED: Expresses clear interest, enthusiasm, agrees to learn more, or responds warmly.",
    "- PRICE_REQUEST: Asks about pricing, rates, cost, budget, or quote.",
    "- MEETING_REQUEST: Asks for a phone call, Zoom meeting, demo, calendar link, or phone number.",
    "- QUESTION: Asks a specific clarifying question about services, portfolio, location, or process.",
    "- NOT_INTERESTED: Declines the offer, says 'not interested', asks to stop/unsubscribe, or expresses annoyance.",
    "- OUT_OF_OFFICE: Automated out-of-office message, auto-reply, or vacation notification.",
    "- FOLLOW_UP_LATER: Asks to reach back out next week/month, currently busy, or check back later.",
    "- UNCLEAR: Highly ambiguous message, single emoji, vague remark, or impossible to determine.",
    "- PRIORITY RULE: If a message expresses interest, asks about pricing, or asks for a call/meeting, classify as INTERESTED, PRICE_REQUEST, or MEETING_REQUEST. Never classify an actionable inquiry as UNCLEAR.",
    "",
    "INTEREST LEVEL RULES:",
    "- 'high': Eager to buy, schedule a call, or strongly positive response.",
    "- 'medium': Open to discussion, asking relevant questions, or asking about price.",
    "- 'low': Cold, declining, ambiguous, or out-of-office.",
    "",
    "REQUIRES HUMAN RULES:",
    "- Flag requiresHuman = true if: intent is UNCLEAR or QUESTION, sentiment is sensitive/negative, or bespoke human judgment is needed.",
    "- requiresHuman can be false if intent is clearly INTERESTED, PRICE_REQUEST, MEETING_REQUEST, or NOT_INTERESTED with high confidence.",
    "",
    "Return strict JSON matching the schema.",
  ].join("\n");

  const sanitizedInbound = sanitizeUntrustedText(input.inboundMessageText, 2000) ?? "";

  const historyLines = input.recentHistory.map((m) => {
    const sender = m.direction === "INBOUND" ? (input.leadUsername ? `@${input.leadUsername}` : "Lead") : "Us (Outreach)";
    const cleanText = sanitizeUntrustedText(m.messageText, 500) ?? "";
    return `[${sender}]: ${cleanText}`;
  });

  const companySection = input.company
    ? [
        `Company name: ${input.company.name}`,
        `Description: ${input.company.description}`,
        `Services: ${input.company.services.map((s) => s.name).join(", ") || "(none)"}`,
        `Pricing policy: ${input.company.pricingPolicy ?? "(not specified)"}`,
        `Objection handling notes: ${input.company.objectionNotes ?? "(none)"}`,
      ].join("\n")
    : "(No company profile available)";

  const userText = [
    "=== COMPANY CONTEXT (authoritative) ===",
    companySection,
    "",
    "=== RECENT CONVERSATION HISTORY ===",
    historyLines.length > 0 ? historyLines.join("\n") : "(No previous messages)",
    "",
    "=== INBOUND MESSAGE TO CLASSIFY (untrusted data) ===",
    "<lead_data>",
    sanitizedInbound,
    "</lead_data>",
    "",
    "Classify this inbound message now and return the JSON response.",
  ].join("\n");

  return { systemInstruction, userText };
}
