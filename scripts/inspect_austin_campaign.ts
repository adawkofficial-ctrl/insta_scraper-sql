import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";

async function run() {
  const prisma = getPrismaClient();
  const camp = await prisma.campaign.findUnique({
    where: { id: "cmw6pjjjw0000hwth44nbxszz" },
    include: { leads: true, scrapeJobs: true }
  });
  console.log("CAMPAIGN cmw6pjjjw0000hwth44nbxszz:", camp?.name, "leads count:", camp?.leads.length);
  for (const l of camp?.leads ?? []) {
    console.log(`  Lead: ${l.id} ${l.username} ${l.phone} ${l.website} isDryRun=${l.isDryRun} source=${l.source}`);
  }
}

run().catch(console.error);

