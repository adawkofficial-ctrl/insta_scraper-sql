import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import { analyzeLead } from "../src/lib/services/ai/lead-analysis-service";

const prisma = getPrismaClient();

// Find any real lead with data for analysis
async function main() {
  const campaign = await prisma.campaign.findFirst({
    where: { name: { contains: "NTN USA" } },
    include: { companyProfile: true },
  });
  if (!campaign) {
    console.error("Campaign not found");
    process.exit(1);
  }

  let lead = await prisma.lead.findFirst({
    where: {
      campaignId: campaign.id,
      username: "website_devlopers",
    },
  });

  if (!lead) {
    console.log("website_devlopers not found in campaign, finding first suitable lead");
    lead = await prisma.lead.findFirst({
      where: {
        campaignId: campaign.id,
        NOT: { usernameNormalized: { startsWith: "prospect_" } },
      },
    });
  }

  if (!lead) {
    console.error("No lead found in campaign");
    process.exit(1);
  }

  console.log("Campaign User ID:", campaign.userId);
  console.log("Lead:", {
    id: lead.id,
    username: lead.username,
    fullName: lead.fullName,
    biography: lead.biography?.slice(0, 80),
    category: lead.category,
    aiStatus: lead.aiStatus,
    aiFailedReason: lead.aiFailedReason,
  });

  const result = await analyzeLead({
    userId: campaign.userId,
    leadId: lead.id,
    force: true,
  });
  console.log("\nAnalysis Result:", JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error running debug analysis:", err);
    process.exit(1);
  });
