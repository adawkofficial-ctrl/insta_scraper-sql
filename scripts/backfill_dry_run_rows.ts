import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";

export async function runBackfill() {
  const prisma = getPrismaClient();
  const leadsToBackfill = await prisma.lead.findMany({
    where: {
      isDryRun: false,
      OR: [
        { source: { in: ["dry_run", "sample"] } },
        { source: { startsWith: "sample_" } },
        { username: { startsWith: "sample_business_" } },
        { username: { startsWith: "sample_ig_place_" } },
        { website: { contains: "example.com" } },
        { website: { endsWith: ".example" } },
        { phone: { contains: "555-01" } },
        { phone: { contains: "55501" } },
        { gmapsPlaceId: { startsWith: "ChIJmockPlace" } },
      ],
    },
    select: { id: true, username: true, phone: true, website: true, source: true },
  });

  const updated = await prisma.lead.updateMany({
    where: {
      isDryRun: false,
      OR: [
        { source: { in: ["dry_run", "sample"] } },
        { source: { startsWith: "sample_" } },
        { username: { startsWith: "sample_business_" } },
        { username: { startsWith: "sample_ig_place_" } },
        { website: { contains: "example.com" } },
        { website: { endsWith: ".example" } },
        { phone: { contains: "555-01" } },
        { phone: { contains: "55501" } },
        { gmapsPlaceId: { startsWith: "ChIJmockPlace" } },
      ],
    },
    data: { isDryRun: true },
  });

  const updatedJobs = await prisma.scrapeJob.updateMany({
    where: {
      isDryRun: false,
      OR: [
        { provider: { in: ["dry_run", "mock"] } },
        { errorMessage: { contains: "dry_run_" } },
      ],
    },
    data: { isDryRun: true },
  });

  console.log(JSON.stringify({
    matchedLeads: leadsToBackfill.length,
    updatedLeads: updated.count,
    updatedJobs: updatedJobs.count,
  }));
}

if (require.main === module) {
  runBackfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

