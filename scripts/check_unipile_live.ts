import "./preload_server_only.cjs";
import "dotenv/config";

async function checkUnipile() {
  const dsn = process.env.UNIPILE_DSN || "https://api66.unipile.com:19650";
  const apiKey = process.env.UNIPILE_API_KEY;
  console.log("Checking Unipile at:", dsn, "apiKey prefix:", apiKey?.slice(0, 8));

  try {
    const res = await fetch(`${dsn}/api/v1/accounts`, {
      headers: {
        "X-API-KEY": apiKey || "",
        "Accept": "application/json",
      },
    });
    console.log("Unipile /api/v1/accounts status:", res.status);
    const data = await res.json();
    console.log("Full Unipile accounts response:\n", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Unipile fetch failed:", err);
  }
}

checkUnipile();
