import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import { listSenderAccounts } from "../src/lib/services/senders/instagram-sender-service";

async function main() {
  const prisma = getPrismaClient();
  const user = await prisma.user.findFirst();
  if (!user) throw new Error("No user in DB");
  console.log("Calling listSenderAccounts for user:", user.id, user.email);
  const senders = await listSenderAccounts(user.id);
  console.log("Synced Senders:", senders);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
