import "./preload_server_only.cjs";
import "dotenv/config";
import { generateStructured } from "../src/lib/services/ai/gemini/gemini-client";

process.env.GEMINI_MODEL = "gemini-2.5-flash";

async function checkGemini() {
  console.log("Calling Gemini generateStructured with model:", process.env.GEMINI_MODEL);
  try {
    const res = await generateStructured({
      systemInstruction: "You are a test evaluator. Always return valid JSON matching schema.",
      userText: "Say hello",
      responseSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
        },
        required: ["status"],
      },
      validate: (data: unknown) => {
        const obj = data as { status?: string };
        if (typeof obj?.status !== "string") throw new Error("Missing status");
        return obj;
      },
      operation: "relevance_check",
      promptVersion: "live_test_v1",
    });
    console.log("Gemini response data:", res.data);
    console.log("Gemini usage tokens:", res.usage);
    console.log("Gemini latency:", res.latencyMs, "ms");
  } catch (err) {
    console.error("Gemini failed:", err);
  }
}

checkGemini();
