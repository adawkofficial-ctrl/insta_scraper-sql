/* eslint-disable */
// Automated API verification script for Step 5
import { PrismaClient } from "./src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const BASE_URL = "http://localhost:3001";

async function main() {
  console.log("--- STARTING STEP 5 API VERIFICATION ---");
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string) {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      failed++;
    }
  }

  const connectionString = process.env.DATABASE_URL;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
  });

  // 1. Test POST /api/campaigns validation (empty name)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    const json = (await res.json()) as any;
    assert(res.status === 400 && json.error?.code === "EMPTY_NAME", "POST /api/campaigns rejects empty name with 400");
  }

  // 2. Test POST /api/campaigns (create campaign)
  let campaignId = "";
  {
    const res = await fetch(`${BASE_URL}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test E2E Campaign",
        description: "Initial description for testing",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 201 &&
      json.id &&
      json.name === "Test E2E Campaign" &&
      json.status === "DRAFT" &&
      json.description === "Initial description for testing",
      "POST /api/campaigns creates new DRAFT campaign with 201",
    );
    campaignId = json.id;
  }

  // 3. Test GET /api/campaigns (list)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns`);
    const json = (await res.json()) as any[];
    assert(
      res.status === 200 &&
      Array.isArray(json) &&
      json.some((c) => c.id === campaignId && c.leadCount === 0 && c.scrapeJobCount === 0),
      "GET /api/campaigns lists campaigns with leadCount and scrapeJobCount",
    );
  }

  // 4. Test GET /api/campaigns/[campaignId]
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}`);
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      json.id === campaignId &&
      Array.isArray(json.recentScrapeJobs) &&
      json.leadCount === 0,
      "GET /api/campaigns/[campaignId] returns campaign with recentScrapeJobs",
    );
  }

  // 5. Test GET /api/campaigns/[campaignId] (404)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/non-existent-campaign-id-9999`);
    const json = (await res.json()) as any;
    assert(
      res.status === 404 && json.error?.code === "CAMPAIGN_NOT_FOUND",
      "GET /api/campaigns/[campaignId] returns 404 for missing campaign",
    );
  }

  // 6. Test PATCH /api/campaigns/[campaignId] (valid updates)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated Campaign Name",
        description: "Updated description",
        status: "RUNNING",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      json.name === "Updated Campaign Name" &&
      json.status === "RUNNING" &&
      json.description === "Updated description",
      "PATCH /api/campaigns/[campaignId] updates name, description, and status",
    );
  }

  // 7. Test PATCH /api/campaigns/[campaignId] (invalid status & empty name)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "INVALID_STATUS" }),
    });
    const json = (await res.json()) as any;
    assert(res.status === 400 && json.error?.code === "INVALID_STATUS", "PATCH rejects invalid status with 400");
  }
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    const json = (await res.json()) as any;
    assert(res.status === 400 && json.error?.code === "EMPTY_NAME", "PATCH rejects empty name with 400");
  }

  // 8. Test POST /api/scraper/instagram/profile campaign validation
  {
    const res = await fetch(`${BASE_URL}/api/scraper/instagram/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaignId: "non-existent-campaign-id-9999",
        profiles: ["instagram"],
      }),
    });
    const json = (await res.json()) as any;
    assert(res.status === 404 && json.error?.code === "CAMPAIGN_NOT_FOUND", "POST /api/scraper validates campaign exists (404)");
  }

  // 9. Seed test leads and scrape job for this campaign
  console.log("\nSeeding test leads and scrape job...");
  const scrapeJob = await prisma.scrapeJob.create({
    data: {
      campaignId,
      status: "COMPLETED",
      provider: "apify",
      inputCount: 3,
      processedCount: 3,
      startedAt: new Date(Date.now() - 60000),
      completedAt: new Date(),
    },
  });

  const lead1 = await prisma.lead.create({
    data: {
      campaignId,
      username: "fitness_coach_anna",
      profileUrl: "https://www.instagram.com/fitness_coach_anna/",
      fullName: "Anna Fitness",
      biography: "Certified fitness coach helping you grow.",
      category: "Fitness Model",
      isVerified: true,
      isBusiness: true,
      followers: 15000,
    },
  });

  const lead2 = await prisma.lead.create({
    data: {
      campaignId,
      username: "tech_coder_bob",
      profileUrl: "https://www.instagram.com/tech_coder_bob/",
      fullName: "Bob Dev",
      biography: "Full stack dev and open source enthusiast.",
      category: "Software",
      isVerified: false,
      isBusiness: true,
      followers: 8000,
    },
  });

  const lead3 = await prisma.lead.create({
    data: {
      campaignId,
      username: "daily_recipes_cat",
      profileUrl: "https://www.instagram.com/daily_recipes_cat/",
      fullName: "Cat Chef",
      biography: "Simple 15-minute home recipes.",
      category: "Food",
      isVerified: false,
      isBusiness: false,
      followers: 45000,
    },
  });

  // 10. Test GET /api/campaigns/[campaignId]/leads (pagination & default listing)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/leads?page=1&limit=2`);
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      json.items.length === 2 &&
      json.pagination.page === 1 &&
      json.pagination.limit === 2 &&
      json.pagination.total === 3 &&
      json.pagination.totalPages === 2,
      "GET /api/campaigns/[campaignId]/leads paginates correctly",
    );
  }

  // 11. Test GET /api/campaigns/[campaignId]/leads (search filter)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/leads?search=fitness`);
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      json.items.length === 1 &&
      json.items[0].username === "fitness_coach_anna",
      "GET /api/campaigns/[campaignId]/leads searches by username/fullName",
    );
  }

  // 12. Test GET /api/campaigns/[campaignId]/leads (isVerified filter)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/leads?isVerified=true`);
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      json.items.length === 1 &&
      json.items[0].isVerified === true,
      "GET /api/campaigns/[campaignId]/leads filters by isVerified=true",
    );
  }

  // 13. Test GET /api/campaigns/[campaignId]/leads (isBusiness filter)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/leads?isBusiness=false`);
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      json.items.length === 1 &&
      json.items[0].username === "daily_recipes_cat",
      "GET /api/campaigns/[campaignId]/leads filters by isBusiness=false",
    );
  }

  // 14. Test GET /api/campaigns/[campaignId]/leads (invalid limit filter)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/leads?limit=999`);
    const json = (await res.json()) as any;
    assert(
      res.status === 400 && json.error?.code === "INVALID_LIMIT",
      "GET /api/campaigns/[campaignId]/leads rejects limit > 100 with 400",
    );
  }

  // 15. Test GET /api/leads/[leadId]
  {
    const res = await fetch(`${BASE_URL}/api/leads/${lead1.id}`);
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      json.id === lead1.id &&
      json.username === "fitness_coach_anna" &&
      json.campaign?.id === campaignId,
      "GET /api/leads/[leadId] returns single lead with campaign reference",
    );
  }

  // 16. Test GET /api/leads/[leadId] 404
  {
    const res = await fetch(`${BASE_URL}/api/leads/non-existent-lead-9999`);
    const json = (await res.json()) as any;
    assert(res.status === 404 && json.error?.code === "LEAD_NOT_FOUND", "GET /api/leads/[leadId] returns 404 for missing lead");
  }

  // 17. Test PATCH /api/leads/[leadId] (valid updates)
  {
    const res = await fetch(`${BASE_URL}/api/leads/${lead1.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Anna Fitness Guru",
        biography: "New bio text",
        category: "Health & Fitness",
        externalUrl: "https://anna.fitness",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      json.fullName === "Anna Fitness Guru" &&
      json.biography === "New bio text" &&
      json.category === "Health & Fitness" &&
      json.externalUrl === "https://anna.fitness",
      "PATCH /api/leads/[leadId] updates allowed fields",
    );
  }

  // 18. Test PATCH /api/leads/[leadId] (unallowed fields)
  {
    const res = await fetch(`${BASE_URL}/api/leads/${lead1.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "hacked_username",
      }),
    });
    const json = (await res.json()) as any;
    assert(
      res.status === 400 && json.error?.code === "UNALLOWED_FIELDS",
      "PATCH /api/leads/[leadId] rejects arbitrary / unallowed fields with 400",
    );
  }

  // 19. Test DELETE /api/leads/[leadId]
  {
    const res = await fetch(`${BASE_URL}/api/leads/${lead3.id}`, {
      method: "DELETE",
    });
    const json = (await res.json()) as any;
    assert(res.status === 200 && json.deleted === true, "DELETE /api/leads/[leadId] deletes single lead");

    // Verify fetching deleted lead returns 404
    const checkRes = await fetch(`${BASE_URL}/api/leads/${lead3.id}`);
    assert(checkRes.status === 404, "Deleted lead returns 404 on fetch");
  }

  // 20. Test GET /api/campaigns/[campaignId]/scrape-jobs
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/scrape-jobs`);
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      Array.isArray(json) &&
      json.some((j) => j.id === scrapeJob.id && j.provider === "apify"),
      "GET /api/campaigns/[campaignId]/scrape-jobs returns campaign jobs",
    );
  }

  // 21. Test GET /api/scrape-jobs/[jobId]
  {
    const res = await fetch(`${BASE_URL}/api/scrape-jobs/${scrapeJob.id}`);
    const json = (await res.json()) as any;
    assert(
      res.status === 200 &&
      json.id === scrapeJob.id &&
      json.campaign?.id === campaignId,
      "GET /api/scrape-jobs/[jobId] returns scrape job with campaign reference",
    );
  }

  // 22. Test GET /api/scrape-jobs/[jobId] 404
  {
    const res = await fetch(`${BASE_URL}/api/scrape-jobs/non-existent-job-9999`);
    const json = (await res.json()) as any;
    assert(res.status === 404 && json.error?.code === "SCRAPE_JOB_NOT_FOUND", "GET /api/scrape-jobs/[jobId] returns 404 for missing job");
  }

  // 23. Test DELETE /api/campaigns/[campaignId] and CASCADE deletion
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}`, {
      method: "DELETE",
    });
    const json = (await res.json()) as any;
    assert(res.status === 200 && json.deleted === true, "DELETE /api/campaigns/[campaignId] deletes campaign");

    // Verify campaign is 404
    const checkCampaign = await fetch(`${BASE_URL}/api/campaigns/${campaignId}`);
    assert(checkCampaign.status === 404, "Deleted campaign returns 404");

    // Verify leads belonging to the campaign were deleted (cascade)
    const remainingLeads = await prisma.lead.count({ where: { campaignId } });
    assert(remainingLeads === 0, "All leads belonging to campaign deleted via cascade");

    // Verify scrape jobs belonging to the campaign were deleted (cascade)
    const remainingJobs = await prisma.scrapeJob.count({ where: { campaignId } });
    assert(remainingJobs === 0, "All scrape jobs belonging to campaign deleted via cascade");
  }

  // 24. Test duplicate profile upsert handling in lead service
  {
    // Create new campaign
    const camp = await prisma.campaign.create({
      data: { name: "Duplicate Test Campaign", status: "DRAFT", userId: "dev_default_user_001" } as any,
    });

    // Create lead
    await prisma.lead.create({
      data: {
        campaignId: camp.id,
        username: "dup_user",
        profileUrl: "https://instagram.com/dup_user",
        fullName: "Original Name",
      },
    });

    // Upsert duplicate lead
    const upserted = await prisma.lead.upsert({
      where: {
        campaignId_username: {
          campaignId: camp.id,
          username: "dup_user",
        },
      },
      update: {
        fullName: "Updated Name",
      },
      create: {
        campaignId: camp.id,
        username: "dup_user",
        profileUrl: "https://instagram.com/dup_user",
        fullName: "Updated Name",
      },
    });

    assert(upserted.fullName === "Updated Name", "Duplicate profile upserted cleanly without conflict");

    // Clean up
    await prisma.campaign.delete({ where: { id: camp.id } });
  }

  await prisma.$disconnect();

  console.log("\n==========================================");
  console.log(`TOTAL TESTS: ${passed + failed}`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log("==========================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
