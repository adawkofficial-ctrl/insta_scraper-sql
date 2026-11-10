import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";

async function main() {
  const prisma = getPrismaClient();
  const logs = await prisma.usageLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  console.log(`UsageLogs count: ${logs.length}`);
  for (const l of logs) {
    console.log(JSON.stringify(l, null, 2));
  }
}

main().catch(console.error).finally(() => process.exit(0));
