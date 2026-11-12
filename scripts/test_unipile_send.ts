import "./preload_server_only.cjs";
import "dotenv/config";
import { getUnipileClient } from "../src/lib/services/unipile";

async function testSend() {
  const unipile = getUnipileClient();
  const accounts = await unipile.getAccounts();
  const active = accounts[0];

  try {
    const res = await (unipile.sendDirectMessage as any)({
      accountId: active.id,
      recipientId: "18148000534477039",
      text: "Production readiness test ping from system audit",
    });
    console.log("Send direct message result:", res);
  } catch (err) {
    console.error("Send error:", err);
  }
}

testSend();
