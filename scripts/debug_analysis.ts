import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import { analyzeLead } from "../src/lib/services/ai/lead-analysis-service";

const prisma = getPrismaClient();

// Find any real lead with data for analysis
const lead = await prisma.lead.findFirst({
  where: {
    AND: [
      { username: { not: { startsWith: "prospect_" } } },
      { username: { not: { startsWith: "dnc_" } } },
      { username: { not: "loopfrag.official" } },
    ],
  },
  include: { campaign: true },
  orderBy: { createdAt: "asc" },
});

if (!lead) {
  console.error("No real lead found in DB");
  process.exit(1);
}

console.log("Lead:", {
  id: lead.id,
  username: lead.username,
  fullName: lead.fullName,
  biography: lead.biography?.slice(0, 80),
  category: lead.category,
  aiStatus: lead.aiStatus,
});

const result = await analyzeLead({
  userId: lead.campaign.userId,
  leadId: lead.id,
  force: true,
});
console.log("\nAnalysis Result:", JSON.stringify(result, null, 2));
process.exit(0);
