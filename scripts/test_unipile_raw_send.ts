import "./preload_server_only.cjs";
import "dotenv/config";

async function testRawSend() {
  const dsn = process.env.UNIPILE_DSN;
  const apiKey = process.env.UNIPILE_API_KEY;

  const res = await fetch(`${dsn}/api/v1/chats`, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey || "",
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      account_id: "nCrTK3DpRyuokmiMv1bZOQ",
      attendees_ids: ["18148000534477039"],
      text: "Test message from production readiness verification",
    }),
  });

  console.log("Status:", res.status);
  const body = await res.text();
  console.log("Body:", body);
}

testRawSend();
