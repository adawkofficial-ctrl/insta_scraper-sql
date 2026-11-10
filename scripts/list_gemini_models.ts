import "./preload_server_only.cjs";
import "dotenv/config";

async function listGeminiModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log("Checking Gemini models list with key prefix:", apiKey?.slice(0, 10));
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    console.log("Status:", res.status);
    const body = await res.json();
    console.log("Response:", JSON.stringify(body, null, 2).slice(0, 1000));
  } catch (err) {
    console.error("List models error:", err);
  }
}

listGeminiModels();
