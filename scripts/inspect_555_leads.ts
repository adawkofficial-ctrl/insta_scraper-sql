import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";

async function run() {
  const prisma = getPrismaClient();
  const leads = await prisma.lead.findMany({
    where: { phone: { contains: "555" } },
    select: { id: true, username: true, phone: true, website: true, source: true, isDryRun: true, campaignId: true }
  });
  console.log("555 LEADS:", JSON.stringify(leads, null, 2));
}

run().catch(console.error);

