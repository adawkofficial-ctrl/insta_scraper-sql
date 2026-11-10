import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";

async function main() {
  const prisma = getPrismaClient();
  const m = await prisma.message.findUnique({
    where: { id: "cmuuzpjm1000h44thhs280hyw" },
  });
  console.log("CLASSIFICATION ANALYSIS:", JSON.stringify(m?.aiAnalysis, null, 2));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
