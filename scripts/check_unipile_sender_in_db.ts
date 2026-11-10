import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";

async function main() {
  const prisma = getPrismaClient();
  const unipileSenders = await prisma.instagramSenderAccount.findMany({
    where: {
      OR: [
        { connectionMethod: "UNIPILE" },
        { unipileAccountId: { not: null } },
        { username: "loopfrag.official" }
      ]
    }
  });
  console.log("Existing Unipile Senders in DB:", unipileSenders);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
