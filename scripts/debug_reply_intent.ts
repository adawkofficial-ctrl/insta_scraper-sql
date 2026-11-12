import "./preload_server_only.cjs";
import "dotenv/config";
import { buildReplyIntentPrompt } from "../src/lib/services/ai/prompts/reply-intent-v1";
import { generateStructured } from "../src/lib/services/ai/gemini";
import {
  REPLY_INTENT_RESPONSE_SCHEMA,
  validateReplyIntentOutput,
  REPLY_INTENT_PROMPT_VERSION,
} from "../src/lib/services/ai/prompts/reply-intent-v1";

async function main() {
  const p = buildReplyIntentPrompt({
    inboundMessageText:
      "Hi! Yes, our company website is quite outdated and we are actively looking for a redesign and UI/UX refresh this quarter. What is your pricing and can we schedule a brief discovery call?",
    recentHistory: [
      {
        direction: "OUTBOUND",
        messageText:
          "Hello! We specialize in modern web application redesigns and UI/UX engineering for B2B firms.",
        createdAt: new Date(),
      },
    ],
    company: {
      name: "Apex Digital Web Engineering",
      description:
        "Premier web application and redesign consultancy building modern Next.js architectures.",
      services: [{ name: "Website Redesign" }, { name: "UI/UX Engineering" }],
      targetIndustries: ["B2B SaaS", "E-commerce"],
      brandTone: "Professional, consultative, authoritative, and concise",
      pricingPolicy: "Custom development projects start at 5,000 USD.",
      ctaStyle: "Ask a low-friction question",
      forbiddenClaims: [],
      idealCustomerProfile: "B2B SaaS companies",
      targetCountries: ["US"],
      messageLanguage: "English",
      preferredLength: { minWords: 20, maxWords: 60 },
      exampleMessages: [],
      objectionNotes: null,
    },
    leadUsername: "prospect_test",
  });

  console.log("System instruction snippet:\n", p.systemInstruction.slice(0, 300));
  console.log("\nUser text:\n", p.userText);

  const res = await generateStructured({
    systemInstruction: p.systemInstruction,
    userText: p.userText,
    responseSchema: REPLY_INTENT_RESPONSE_SCHEMA,
    validate: validateReplyIntentOutput,
    operation: "reply_classification",
    promptVersion: REPLY_INTENT_PROMPT_VERSION,
  });

  console.log("\nClassified result:\n", JSON.stringify(res.data, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error running test:", err);
    process.exit(1);
  });
