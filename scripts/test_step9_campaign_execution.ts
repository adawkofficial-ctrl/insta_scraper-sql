/* eslint-disable */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const BASE_URL = "http://localhost:3001";

async function runStep9Tests() {
  console.log("==================================================");
  console.log("  STEP 9: CAMPAIGN EXECUTION ARCHITECTURE TESTS   ");
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
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    // 1. Create campaign with execution settings
    let campaignId = "";
    {
      const res = await fetch(`${BASE_URL}/api/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Step 9 Execution Campaign",
          description: "Testing execution preview and review planning",
          executionMode: "REVIEW_REQUIRED",
          messageApprovalRequired: true,
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 201 &&
        Boolean(data.id) &&
        data.executionMode === "REVIEW_REQUIRED" &&
        data.messageApprovalRequired === true,
        "1. Create campaign with execution configuration",
      );
      campaignId = data.id;
    }

    // 2. Add leads: valid leads and one lead without usable profile URL
    const lead1 = await prisma.lead.create({
      data: {
        campaignId,
        username: "clara_creator",
        fullName: "Clara Oswald",
        category: "Visual Arts",
        biography: "Digital creator & travel filmmaker",
        followers: 8400,
        profileUrl: "https://www.instagram.com/clara_creator/",
      },
    });

    const lead2 = await prisma.lead.create({
      data: {
        campaignId,
        username: "dan_design",
        fullName: "Dan Lewis",
        category: "Graphic Design",
        biography: "Brand identity specialist",
        followers: 4200,
        profileUrl: "https://www.instagram.com/dan_design/",
      },
    });

    const leadNoUrl = await prisma.lead.create({
      data: {
        campaignId,
        username: "no_url_user",
        fullName: "No Profile URL",
        profileUrl: "", // invalid / missing profile URL
      },
    });

    assert(Boolean(lead1.id && lead2.id && leadNoUrl.id), "2. Add leads to campaign");

    // 17. Test execution without template (fails with 400 MISSING_TEMPLATE)
    {
      const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 400 && data.error?.code === "MISSING_TEMPLATE",
        "17. Execution preview requires a message template (400 MISSING_TEMPLATE)",
      );
    }

    // 3. Create message template
    let templateId = "";
    {
      const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Collaborator Outreach",
          body: "Hello {{firstName}}, I saw your work in {{category}} (@{{username}}) and wanted to reach out regarding {{campaignName}}.",
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 201 && Boolean(data.id),
        "3. Create message template for campaign",
      );
      templateId = data.id;
    }

    // 4, 5, 6, 16. Generate execution preview and verify lead eligibility
    let executionId = "";
    let item1Id = "";
    let item2Id = "";
    {
      const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId,
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 201 && Boolean(data.executionId),
        "4. Generate execution preview",
      );
      assert(
        data.status === "PREVIEW",
        "5. Verify execution status is PREVIEW",
      );
      assert(
        Array.isArray(data.items) &&
        data.items.length === 2 &&
        data.items.every((it: any) => it.status === "PENDING"),
        "6. Verify execution items are PENDING and formatted correctly",
      );
      assert(
        data.totalEligibleLeads === 2 && data.planned === 2 && data.skipped === 1,
        "16. Lead without profile URL is excluded/skipped from planned items",
      );

      executionId = data.executionId;
      item1Id = data.items[0].id;
      item2Id = data.items[1].id;
    }

    // 7. Verify NO Instagram message was sent (DB check)
    {
      const messageCount = await prisma.message.count({
        where: { campaignId },
      });
      assert(
        messageCount === 0,
        "7. Verify NO Instagram message record was created or sent during execution preview",
      );
    }

    // 8 & 9. Approve one item (changes PENDING -> APPROVED)
    {
      const res = await fetch(
        `${BASE_URL}/api/campaign-executions/${executionId}/items/${item1Id}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageText: "Hello Clara, approved personalized message!",
          }),
        },
      );
      const data = (await res.json()) as any;
      assert(
        res.status === 200 &&
        data.status === "APPROVED" &&
        data.messageText === "Hello Clara, approved personalized message!",
        "8 & 9. Approve execution item (PENDING -> APPROVED with optional text edit)",
      );

      // Verify no message was sent on approval
      const msgCountAfterApprove = await prisma.message.count({
        where: { campaignId },
      });
      assert(
        msgCountAfterApprove === 0,
        "8b. Approving an item does NOT send the message",
      );
    }

    // 10 & 11. Skip another item (changes PENDING -> SKIPPED)
    {
      const res = await fetch(
        `${BASE_URL}/api/campaign-executions/${executionId}/items/${item2Id}/skip`,
        {
          method: "POST",
        },
      );
      const data = (await res.json()) as any;
      assert(
        res.status === 200 && data.status === "SKIPPED",
        "10 & 11. Skip execution item (PENDING -> SKIPPED)",
      );
    }

    // Test GET /api/campaign-executions/[executionId] pagination and review query
    {
      const res = await fetch(`${BASE_URL}/api/campaign-executions/${executionId}?page=1&limit=10`);
      const data = (await res.json()) as any;
      assert(
        res.status === 200 &&
        data.id === executionId &&
        data.items.length === 2 &&
        data.pagination.total === 2 &&
        Boolean(data.campaignName),
        "Review API: GET /api/campaign-executions/:id returns paginated execution items",
      );
    }

    // 12 & 13. Cancel a preview
    {
      const res = await fetch(`${BASE_URL}/api/campaign-executions/${executionId}/cancel`, {
        method: "POST",
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 200 && data.status === "CANCELLED" && data.cancelled === true,
        "12 & 13. Cancel execution preview (PREVIEW -> CANCELLED)",
      );
    }

    // 14. Test invalid campaignId (404)
    {
      const res = await fetch(`${BASE_URL}/api/campaigns/non-existent-campaign-9999/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 404 && data.error?.code === "CAMPAIGN_NOT_FOUND",
        "14. Execution preview rejects non-existent campaign with 404",
      );
    }

    // 15. Test mismatched execution / item IDs (400 or 404)
    {
      // Create a second campaign and execution
      const camp2 = await prisma.campaign.create({
        data: { name: "Second Execution Campaign", userId: "dev_default_user_001" } as any,
      });
      const exec2 = await prisma.campaignExecution.create({
        data: { campaignId: camp2.id, status: "PREVIEW" },
      });

      // Try to approve item1 using exec2's ID
      const res = await fetch(
        `${BASE_URL}/api/campaign-executions/${exec2.id}/items/${item1Id}/approve`,
        {
          method: "POST",
        },
      );
      const data = (await res.json()) as any;
      assert(
        res.status === 400 && data.error?.code === "EXECUTION_MISMATCH",
        "15. Rejects approval with mismatched executionId / itemId (400 EXECUTION_MISMATCH)",
      );

      // Clean up camp2
      await prisma.campaign.delete({ where: { id: camp2.id } });
    }

    // 18. Campaign Status Transition validation check
    {
      // DRAFT cannot transition directly to COMPLETED
      const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED" }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 400 && data.error?.code === "INVALID_STATUS_TRANSITION",
        "18. Invalid status transition (DRAFT -> COMPLETED) is rejected with 400",
      );

      // DRAFT -> RUNNING is valid
      const validRes = await fetch(`${BASE_URL}/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "RUNNING" }),
      });
      const validData = (await validRes.json()) as any;
      assert(
        validRes.status === 200 && validData.status === "RUNNING",
        "18b. Valid status transition (DRAFT -> RUNNING) succeeds",
      );
    }

    // Clean up test campaign
    await prisma.campaign.delete({ where: { id: campaignId } });
  } finally {
    await prisma.$disconnect();
  }

  console.log("\n==================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runStep9Tests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
