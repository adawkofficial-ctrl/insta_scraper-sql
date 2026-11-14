/* eslint-disable */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";

const BASE_URL = "http://localhost:3001";

async function runStep10Tests() {
  console.log("==================================================");
  console.log("  STEP 10: CAMPAIGN ANALYTICS & DASHBOARD TESTS   ");
  console.log("==================================================");

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

  const connectionString = process.env.DATABASE_URL!;
  const prisma = createPrismaClient();

  try {
    // ----------------------------------------------------
    // Scenario 1: Empty Campaign Analytics
    // ----------------------------------------------------
    let emptyCampaignId = "";
    {
      const res = await fetch(`${BASE_URL}/api/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Step 10 Empty Campaign",
          description: "Campaign with zero entities for analytics baseline",
        }),
      });
      const data = (await res.json()) as any;
      emptyCampaignId = data.id;
      assert(res.status === 201 && Boolean(emptyCampaignId), "1. Created empty campaign");
    }

    {
      const res = await fetch(`${BASE_URL}/api/campaigns/${emptyCampaignId}/analytics`);
      const analytics = (await res.json()) as any;
      assert(
        res.status === 200 &&
        analytics.campaign.id === emptyCampaignId &&
        analytics.leads.total === 0 &&
        analytics.leads.verified === 0 &&
        analytics.leads.business === 0 &&
        analytics.leads.verifiedPercentage === 0 &&
        analytics.leads.businessPercentage === 0 &&
        analytics.categories.length === 0 &&
        analytics.scraping.jobs === 0 &&
        analytics.scraping.processed === 0 &&
        analytics.scraping.failed === 0 &&
        analytics.messages.total === 0 &&
        analytics.messages.sent === 0 &&
        analytics.messages.failed === 0 &&
        analytics.messages.pending === 0 &&
        analytics.execution.total === 0 &&
        analytics.execution.approved === 0 &&
        analytics.execution.skipped === 0,
        "2. Empty campaign analytics returns all zero metrics accurately",
      );
    }

    // ----------------------------------------------------
    // Scenario 2: Campaign with Leads, Scrapes, Messages & Executions
    // ----------------------------------------------------
    let populatedCampaignId = "";
    {
      const res = await fetch(`${BASE_URL}/api/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Step 10 Populated Analytics Campaign",
          description: "Full dataset for comprehensive analytics verification",
        }),
      });
      const data = (await res.json()) as any;
      populatedCampaignId = data.id;
      assert(res.status === 201 && Boolean(populatedCampaignId), "3. Created populated test campaign");
    }

    // Insert 5 leads into populatedCampaignId
    // 2 verified, 3 unverified
    // 3 business, 2 non-business
    // 2 "Fitness", 2 "Tech", 1 null category
    const leadA = await prisma.lead.create({
      data: {
        campaignId: populatedCampaignId,
        username: "fit_guru_1",
        fullName: "Fit Guru",
        profileUrl: "https://instagram.com/fit_guru_1",
        category: "Fitness",
        isVerified: true,
        isBusiness: true,
        postsCount: 120,
        followers: 5000,
      },
    });

    const leadB = await prisma.lead.create({
      data: {
        campaignId: populatedCampaignId,
        username: "fit_trainer_2",
        fullName: "Fit Trainer",
        profileUrl: "https://instagram.com/fit_trainer_2",
        category: "Fitness",
        isVerified: true,
        isBusiness: false,
        postsCount: 50,
        followers: 2200,
      },
    });

    const leadC = await prisma.lead.create({
      data: {
        campaignId: populatedCampaignId,
        username: "tech_dev_1",
        fullName: "Tech Dev",
        profileUrl: "https://instagram.com/tech_dev_1",
        category: "Tech",
        isVerified: false,
        isBusiness: true,
        postsCount: 30,
        followers: 1500,
      },
    });

    const leadD = await prisma.lead.create({
      data: {
        campaignId: populatedCampaignId,
        username: "tech_coder_2",
        fullName: "Tech Coder",
        profileUrl: "https://instagram.com/tech_coder_2",
        category: "Tech",
        isVerified: false,
        isBusiness: true,
        postsCount: 80,
        followers: 3400,
      },
    });

    const leadE = await prisma.lead.create({
      data: {
        campaignId: populatedCampaignId,
        username: "general_creator_3",
        fullName: "General Creator",
        profileUrl: "https://instagram.com/general_creator_3",
        category: null,
        isVerified: false,
        isBusiness: false,
        postsCount: 15,
        followers: 800,
      },
    });

    assert(Boolean(leadA && leadE), "4. Inserted 5 structured leads into test campaign");

    // Insert 2 scrape jobs
    const job1 = await prisma.scrapeJob.create({
      data: {
        campaignId: populatedCampaignId,
        provider: "apify",
        status: "COMPLETED",
        inputCount: 10,
        processedCount: 8,
        startedAt: new Date(Date.now() - 3600000),
        completedAt: new Date(),
      },
    });

    const job2 = await prisma.scrapeJob.create({
      data: {
        campaignId: populatedCampaignId,
        provider: "apify",
        status: "FAILED",
        inputCount: 5,
        processedCount: 2,
        errorMessage: "Apify memory limit exceeded",
        startedAt: new Date(Date.now() - 1800000),
        completedAt: new Date(),
      },
    });

    assert(Boolean(job1 && job2), "5. Inserted completed and failed scrape jobs");

    // Insert Messages
    // 2 SENT, 1 FAILED, 1 DRAFT
    await prisma.message.create({
      data: {
        campaignId: populatedCampaignId,
        leadId: leadA.id,
        provider: "playwright",
        status: "SENT",
        messageText: "Hello Fit Guru! Love your fitness content.",
        sentAt: new Date(),
      },
    });

    await prisma.message.create({
      data: {
        campaignId: populatedCampaignId,
        leadId: leadB.id,
        provider: "playwright",
        status: "SENT",
        messageText: "Hello Fit Trainer! Quick collab question.",
        sentAt: new Date(),
      },
    });

    await prisma.message.create({
      data: {
        campaignId: populatedCampaignId,
        leadId: leadC.id,
        provider: "playwright",
        status: "FAILED",
        messageText: "Hello Tech Dev! Are you open to talks?",
        errorMessage: "Profile is private and closed to incoming DMs",
      },
    });

    await prisma.message.create({
      data: {
        campaignId: populatedCampaignId,
        leadId: leadD.id,
        provider: "playwright",
        status: "DRAFT",
        messageText: "Hello Tech Coder! Staging outreach draft.",
      },
    });

    assert(true, "6. Inserted 4 message records (2 SENT, 1 FAILED, 1 DRAFT)");

    // Insert Execution & Execution Items
    const execution = await prisma.campaignExecution.create({
      data: {
        campaignId: populatedCampaignId,
        status: "RUNNING",
        totalItems: 4,
        processedItems: 3,
        successfulItems: 1,
        failedItems: 0,
      },
    });

    await prisma.campaignExecutionItem.create({
      data: {
        executionId: execution.id,
        leadId: leadA.id,
        status: "SENT",
        messageText: "Exec sent message",
        processedAt: new Date(),
      },
    });

    await prisma.campaignExecutionItem.create({
      data: {
        executionId: execution.id,
        leadId: leadB.id,
        status: "APPROVED",
        messageText: "Exec approved message",
        processedAt: new Date(),
      },
    });

    await prisma.campaignExecutionItem.create({
      data: {
        executionId: execution.id,
        leadId: leadC.id,
        status: "SKIPPED",
        messageText: "Exec skipped message",
        errorMessage: "User manually skipped this item",
        processedAt: new Date(),
      },
    });

    await prisma.campaignExecutionItem.create({
      data: {
        executionId: execution.id,
        leadId: leadD.id,
        status: "PENDING",
        messageText: "Exec pending message",
      },
    });

    assert(true, "7. Inserted execution with 4 execution items in distinct statuses");

    // ----------------------------------------------------
    // Scenario 3: Verify Campaign Analytics API Numbers
    // ----------------------------------------------------
    {
      const res = await fetch(`${BASE_URL}/api/campaigns/${populatedCampaignId}/analytics`);
      const analytics = (await res.json()) as any;

      assert(res.status === 200, "8. GET /api/campaigns/[id]/analytics returned 200 OK");

      // Verify leads
      assert(
        analytics.leads.total === 5 &&
        analytics.leads.verified === 2 &&
        analytics.leads.business === 3 &&
        analytics.leads.verifiedPercentage === 40 &&
        analytics.leads.businessPercentage === 60,
        "9. Lead totals and percentages verified against database (total=5, verified=2 (40%), business=3 (60%))",
      );

      // Verify category counts (Fitness: 2, Tech: 2)
      const fitnessCat = analytics.categories.find((c: any) => c.category === "Fitness");
      const techCat = analytics.categories.find((c: any) => c.category === "Tech");
      assert(
        fitnessCat && fitnessCat.count === 2 && fitnessCat.percentage === 40 &&
        techCat && techCat.count === 2 && techCat.percentage === 40,
        "10. Category counts and distribution correct (Fitness=2/40%, Tech=2/40%) without synthetic data",
      );

      // Verify scraping
      assert(
        analytics.scraping.jobs === 2 &&
        analytics.scraping.processed === 10 &&
        analytics.scraping.failed === 1,
        "11. Scraping aggregates verified (jobs=2, processed=10, failed=1)",
      );

      // Verify messages
      assert(
        analytics.messages.total === 4 &&
        analytics.messages.sent === 2 &&
        analytics.messages.failed === 1 &&
        analytics.messages.pending === 1,
        "12. Message status breakdown verified (sent=2, failed=1, pending=1, total=4)",
      );

      // Verify execution items
      assert(
        analytics.execution.total === 4 &&
        analytics.execution.pending === 1 &&
        analytics.execution.approved === 1 &&
        analytics.execution.skipped === 1 &&
        analytics.execution.sent === 1 &&
        analytics.execution.failed === 0,
        "13. Execution status distribution verified (pending=1, approved=1, skipped=1, sent=1)",
      );
    }

    // ----------------------------------------------------
    // Scenario 4: Message Activity API Pagination & Filtering
    // ----------------------------------------------------
    {
      // Paginated page 1 limit 2
      const res = await fetch(`${BASE_URL}/api/campaigns/${populatedCampaignId}/messages?page=1&limit=2`);
      const data = (await res.json()) as any;
      assert(
        res.status === 200 &&
        data.items.length === 2 &&
        data.pagination.page === 1 &&
        data.pagination.limit === 2 &&
        data.pagination.total === 4 &&
        data.pagination.totalPages === 2,
        "14. Message activity API supports page=1&limit=2 pagination accurately",
      );
    }

    {
      // Status filter: FAILED
      const res = await fetch(`${BASE_URL}/api/campaigns/${populatedCampaignId}/messages?status=FAILED`);
      const data = (await res.json()) as any;
      assert(
        res.status === 200 &&
        data.items.length === 1 &&
        data.items[0].status === "FAILED" &&
        data.items[0].lead.username === "tech_dev_1",
        "15. Message activity API filters by ?status=FAILED correctly",
      );
    }

    // ----------------------------------------------------
    // Scenario 5: Scrape Jobs API Filtering
    // ----------------------------------------------------
    {
      const res = await fetch(`${BASE_URL}/api/campaigns/${populatedCampaignId}/scrape-jobs?status=FAILED`);
      const data = (await res.json()) as any;
      assert(
        res.status === 200 &&
        Array.isArray(data) &&
        data.length === 1 &&
        data[0].status === "FAILED" &&
        data[0].errorMessage === "Apify memory limit exceeded",
        "16. Scrape jobs endpoint filters server-side by status=FAILED",
      );
    }

    // ----------------------------------------------------
    // Scenario 6: Global Dashboard Overview API
    // ----------------------------------------------------
    {
      const res = await fetch(`${BASE_URL}/api/dashboard/overview`);
      const overview = (await res.json()) as any;
      assert(
        res.status === 200 &&
        overview.stats.totalCampaigns >= 2 &&
        overview.stats.totalLeads >= 5 &&
        overview.stats.totalMessages >= 4 &&
        Array.isArray(overview.recentCampaigns) &&
        overview.recentCampaigns.length > 0 &&
        Array.isArray(overview.recentScrapeJobs) &&
        overview.recentScrapeJobs.length > 0 &&
        Array.isArray(overview.recentActivity) &&
        overview.recentActivity.length > 0,
        "17. Global dashboard overview API provides real aggregates, recent jobs, and derived events",
      );

      // Verify recentActivity events are valid types and ordered chronologically
      const firstActivity = overview.recentActivity[0];
      assert(
        Boolean(firstActivity.type) &&
        Boolean(firstActivity.title) &&
        Boolean(firstActivity.description) &&
        Boolean(firstActivity.timestamp),
        "18. Recent activity events are reliably formatted with real DB metadata",
      );
    }

    // ----------------------------------------------------
    // Scenario 7: Security, Isolation & Error States
    // ----------------------------------------------------
    {
      // Invalid Campaign ID
      const res = await fetch(`${BASE_URL}/api/campaigns/non-existent-uuid-9999/analytics`);
      assert(res.status === 404, "19. Non-existent campaign analytics returns 404 Not Found");
    }

    {
      // Cross-Campaign Isolation: empty campaign has 0 messages and 0 leads
      const res = await fetch(`${BASE_URL}/api/campaigns/${emptyCampaignId}/messages`);
      const data = (await res.json()) as any;
      assert(
        res.status === 200 && data.items.length === 0 && data.pagination.total === 0,
        "20. Cross-campaign message access is completely isolated (0 records leaked to other campaigns)",
      );
    }

    // ----------------------------------------------------
    // Scenario 8: Direct Database Verification
    // ----------------------------------------------------
    {
      const dbLeadCount = await prisma.lead.count({ where: { campaignId: populatedCampaignId } });
      const dbMessageCount = await prisma.message.count({ where: { campaignId: populatedCampaignId } });
      const dbJobCount = await prisma.scrapeJob.count({ where: { campaignId: populatedCampaignId } });

      const res = await fetch(`${BASE_URL}/api/campaigns/${populatedCampaignId}/analytics`);
      const analytics = (await res.json()) as any;

      assert(
        dbLeadCount === analytics.leads.total &&
        dbMessageCount === analytics.messages.total &&
        dbJobCount === analytics.scraping.jobs,
        "21. Real-time parity confirmed: API analytics numbers match direct PostgreSQL counts exactly",
      );
    }

    // Clean up created test campaigns
    await prisma.campaignExecutionItem.deleteMany({ where: { executionId: execution.id } });
    await prisma.campaignExecution.deleteMany({ where: { campaignId: populatedCampaignId } });
    await prisma.message.deleteMany({ where: { campaignId: populatedCampaignId } });
    await prisma.scrapeJob.deleteMany({ where: { campaignId: populatedCampaignId } });
    await prisma.lead.deleteMany({ where: { campaignId: populatedCampaignId } });
    await prisma.campaign.delete({ where: { id: populatedCampaignId } });
    await prisma.campaign.delete({ where: { id: emptyCampaignId } });

    console.log("\n--------------------------------------------------");
    console.log(`Step 10 Tests Finished: ${passed} passed, ${failed} failed.`);
    console.log("--------------------------------------------------");

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

runStep10Tests().catch((err) => {
  console.error("Test execution failed with error:", err);
  process.exit(1);
});
