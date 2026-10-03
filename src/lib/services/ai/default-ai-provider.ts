import "server-only";

import {
  AIProvider,
  AIPersonalizeRequest,
  AIPersonalizeResponse,
} from "./ai-provider";
import { BadRequestError, AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

const SYSTEM_PROMPT = `You are a world-class Instagram outreach copywriter specializing in high-converting cold direct messages that convince leads to reply.

Core Objectives & Response Psychology:
1. Maximize Response Rate: Write like an authentic, observant industry peer—never like an automated marketing bot or aggressive salesperson.
2. Hook Instantly: Open by naturally acknowledging something real about their specific niche, work, or bio angle. Never use generic spam clichés like "I came across your profile and wanted to connect", "Hope you're having a good week", or "I stumbled upon your account".
3. Align with Campaign Intent: Seamlessly connect the lead's niche, specialty, or audience to the campaign intent (e.g. collaboration, specialized service, sharing a quick idea or resource).
4. Low-Friction Call-To-Action (CTA): End with a low-pressure, frictionless micro-question that takes less than 5 seconds to reply to (e.g., "Mind if I send over a 30-sec breakdown?", "Are you currently taking on new clients this month?", "Open to a quick collaboration idea?"). Avoid asking for 30-minute phone calls or pitching upfront.
5. Tone & Structure:
   - Concise & punchy: Keep it easy to read on mobile screens (under 75 words).
   - Polite, casual yet professional peer-to-peer tone.
   - Max 1 emoji or none.
   - Produce ONLY the final direct message body with no greeting prefixes like "Subject:", quotes, or meta-commentary.
6. Guardrails:
   - Personalize using ONLY the provided lead information (name, username, biography, category). Never invent facts or hallucinate details.
   - Do NOT pretend to already know the person or claim previous interactions.
   - If the lead has limited bio details, stay conversational and authentic rather than fabricating specifics.`;

export class LocalAIProvider implements AIProvider {
  readonly name = "local-ai";

  async generatePersonalizedMessage(
    request: AIPersonalizeRequest,
  ): Promise<AIPersonalizeResponse> {
    const { lead, template, campaignContext } = request;

    let firstName = "there";
    if (lead.fullName && lead.fullName.trim().length > 0) {
      const parts = lead.fullName.trim().split(/[\s|•\-,]+/);
      if (parts[0]) firstName = parts[0];
    } else if (lead.username) {
      firstName = lead.username;
    }

    const category = lead.category?.trim() || "";
    const bio = lead.biography?.trim() || "";
    const campaignName = campaignContext?.trim() || "our collaboration";

    // Replace template variables first (supporting canonical and legacy names)
    let result = template
      .replace(/{{\s*firstname\s*}}/gi, firstName)
      .replace(/{{\s*fullname\s*}}/gi, lead.fullName?.trim() || lead.username)
      .replace(/{{\s*username\s*}}/gi, lead.username)
      .replace(/{{\s*businesscategory\s*}}/gi, category || "content")
      .replace(/{{\s*category\s*}}/gi, category || "content")
      .replace(/{{\s*biography\s*}}/gi, bio)
      .replace(/{{\s*bio\s*}}/gi, bio)
      .replace(/{{\s*campaignname\s*}}/gi, campaignName)
      .replace(/{{\s*followerscount\s*}}/gi, lead.followers != null ? String(lead.followers) : "")
      .replace(/{{\s*followers\s*}}/gi, lead.followers != null ? String(lead.followers) : "");

    // Apply thoughtful contextual refinement without inventing facts
    // If the template still contains a generic opening, enhance it to sound authentic and convincing
    if (/^Hi there[,!.]?\s*I came across your/i.test(result)) {
      if (category) {
        result = result.replace(
          /^Hi there[,!.]?\s*I came across your [^a-z]*profile/i,
          `Hey ${firstName}, really impressed by your work in ${category}`,
        );
      } else {
        result = result.replace(
          /^Hi there[,!.]?\s*I came across your/i,
          `Hey ${firstName}, saw your content`,
        );
      }
    }

    result = result.replace(/[ \t]+/g, " ").trim();

    if (!result) {
      throw new BadRequestError(
        "EMPTY_AI_RESULT",
        "Generated message content is empty.",
      );
    }

    if (result.length > 2000) {
      result = result.slice(0, 1997) + "...";
    }

    return {
      text: result,
      provider: this.name,
    };
  }
}

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = "gpt-4o-mini") {
    this.apiKey = apiKey;
    this.model = process.env.OPENAI_MODEL || model;
  }

  async generatePersonalizedMessage(
    request: AIPersonalizeRequest,
  ): Promise<AIPersonalizeResponse> {
    const { lead, template, campaignContext } = request;

    const userPrompt = `Campaign Context & Intent: ${campaignContext || "Direct Outreach"}
Lead Profile:
- Username: ${lead.username}
- Full Name: ${lead.fullName || "Not provided"}
- Category/Niche: ${lead.category || "Not provided"}
- Biography: ${lead.biography || "Not provided"}
- Is Business Account: ${lead.isBusiness ? "Yes" : "No"}
- Followers: ${lead.followers ?? "Unknown"}

Base Template:
"${template}"

Instruction:
Generate a high-converting personalized Instagram direct message for this lead based on the template.
- Seamlessly blend the lead's niche/bio with the campaign intent.
- Ensure the opening is engaging, natural, and relevant (avoid robotic greetings).
- Conclude with an irresistible, low-friction micro-question that convinces the lead to reply.
- Return ONLY the final direct message text.`;

    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.7,
            max_tokens: 500,
          }),
          signal: AbortSignal.timeout(30000),
        },
      );

      if (!response.ok) {
        logger.error("NETWORK_ERROR", new Error("AI provider request failed"), {
          provider: "openai",
          operation: "ai_generate",
          status: response.status,
        });
        throw new AppError(
          502,
          "AI_PROVIDER_ERROR",
          `AI provider responded with status ${response.status}.`,
          {
            userMessage: "The AI provider is temporarily unavailable.",
            retryable: true,
            severity: "error",
          },
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new BadRequestError(
          "EMPTY_AI_RESULT",
          "AI returned an empty response.",
        );
      }

      const cleaned = content.replace(/^["']|["']$/g, "").trim();

      if (cleaned.length > 2000) {
        throw new BadRequestError(
          "EXCESSIVE_MESSAGE_LENGTH",
          "Generated message exceeds the maximum allowed length of 2000 characters.",
        );
      }

      return {
        text: cleaned,
        provider: this.name,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new AppError(504, "AI_TIMEOUT", "OpenAI request timed out after 30 seconds.");
      }
      throw new AppError(
        502,
        "AI_PROVIDER_ERROR",
        "Failed to communicate with OpenAI provider.",
      );
    }
  }
}

export class GeminiAIProvider implements AIProvider {
  readonly name = "gemini";
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = "gemini-1.5-flash") {
    this.apiKey = apiKey;
    this.model = process.env.GEMINI_MODEL || model;
  }

  async generatePersonalizedMessage(
    request: AIPersonalizeRequest,
  ): Promise<AIPersonalizeResponse> {
    const { lead, template, campaignContext } = request;

    const promptText = `${SYSTEM_PROMPT}

Campaign Context & Intent: ${campaignContext || "Direct Outreach"}
Lead Profile:
- Username: ${lead.username}
- Full Name: ${lead.fullName || "Not provided"}
- Category/Niche: ${lead.category || "Not provided"}
- Biography: ${lead.biography || "Not provided"}
- Is Business Account: ${lead.isBusiness ? "Yes" : "No"}
- Followers: ${lead.followers ?? "Unknown"}

Base Template:
"${template}"

Instruction:
Generate a high-converting personalized Instagram direct message for this lead based on the template.
- Seamlessly blend the lead's niche/bio with the campaign intent.
- Ensure the opening is engaging, natural, and relevant (avoid robotic greetings).
- Conclude with an irresistible, low-friction micro-question that convinces the lead to reply.
- Return ONLY the final direct message text.`;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: promptText }],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 500,
          },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        logger.warn("[GEMINI] provider API call returned non-200, falling back to local reply generator", {
          status: response.status,
        });
        return new LocalAIProvider().generatePersonalizedMessage(request);
      }

      const data = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!content) {
        throw new BadRequestError(
          "EMPTY_AI_RESULT",
          "AI returned an empty response.",
        );
      }

      const cleaned = content.replace(/^["']|["']$/g, "").trim();

      if (cleaned.length > 2000) {
        throw new BadRequestError(
          "EXCESSIVE_MESSAGE_LENGTH",
          "Generated message exceeds the maximum allowed length of 2000 characters.",
        );
      }

      return {
        text: cleaned,
        provider: this.name,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new AppError(504, "AI_TIMEOUT", "Gemini request timed out after 30 seconds.");
      }
      throw new AppError(
        502,
        "AI_PROVIDER_ERROR",
        "Failed to communicate with Gemini provider.",
      );
    }
  }
}

export function getAIProvider(): AIProvider {
  const providerEnv = process.env.AI_PROVIDER?.toLowerCase();

  if (providerEnv === "gemini" && process.env.GEMINI_API_KEY) {
    return new GeminiAIProvider(process.env.GEMINI_API_KEY);
  }

  if (providerEnv === "openai" && process.env.OPENAI_API_KEY) {
    return new OpenAIProvider(process.env.OPENAI_API_KEY);
  }

  if (process.env.GEMINI_API_KEY) {
    return new GeminiAIProvider(process.env.GEMINI_API_KEY);
  }

  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider(process.env.OPENAI_API_KEY);
  }

  return new LocalAIProvider();
}
