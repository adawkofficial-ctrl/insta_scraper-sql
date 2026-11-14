/* eslint-disable */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";

const BASE_URL = "http://localhost:3001";

async function runStep8Tests() {
  console.log("==================================================");
  console.log("   STEP 8: MESSAGE TEMPLATES & AI PREVIEW TESTS   ");
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
    // 1. Create campaign
    let campaignId = "";
    {
      const res = await fetch(`${BASE_URL}/api/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Step 8 Outreach Campaign",
          description: "Testing templates and AI personalization",
        }),
      });
      const data = (await res.json()) as any;
      assert(res.status === 201 && Boolean(data.id), "1. Create campaign");
      campaignId = data.id;
    }

    // Create a second campaign for campaign mismatch testing
    let secondCampaignId = "";
    {
      const res = await fetch(`${BASE_URL}/api/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Second Different Campaign",
        }),
      });
      const data = (await res.json()) as any;
      secondCampaignId = data.id;
    }

    // Create leads for campaign 1
    const leadRich = await prisma.lead.create({
      data: {
        campaignId,
        username: "sarah_fit",
        fullName: "Sarah Jenkins",
        category: "Fitness & Wellness",
        biography: "Certified trainer helping women build strength daily 🏋️‍♀️",
        followers: 12500,
        following: 450,
        isBusiness: true,
        profileUrl: "https://www.instagram.com/sarah_fit/",
      },
    });

    const leadMinimal = await prisma.lead.create({
      data: {
        campaignId,
        username: "quiet_user",
        fullName: null,
        category: null,
        biography: null,
        followers: null,
        following: null,
        profileUrl: "https://www.instagram.com/quiet_user/",
      },
    });

    // Create lead in second campaign
    const leadOtherCampaign = await prisma.lead.create({
      data: {
        campaignId: secondCampaignId,
        username: "other_user",
        profileUrl: "https://www.instagram.com/other_user/",
      },
    });

    // 2. Create message template
    let templateId = "";
    {
      const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Fitness Collab Outreach",
          body: "Hi {{firstName}}, I saw your {{category}} page (@{{username}}) and loved your bio: \"{{bio}}\". Wanted to invite you to {{campaignName}}!",
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 201 &&
        data.name === "Fitness Collab Outreach" &&
        data.campaignId === campaignId,
        "2. Create message template in campaign",
      );
      templateId = data.id;
    }

    // 3. List templates for campaign
    {
      const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/templates`);
      const data = (await res.json()) as any[];
      assert(
        res.status === 200 &&
        Array.isArray(data) &&
        data.some((t) => t.id === templateId),
        "3. List templates for campaign",
      );
    }

    // 4. Edit template
    {
      const res = await fetch(`${BASE_URL}/api/templates/${templateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Updated Fitness Collab Outreach",
          body: "Hello {{firstName}}! I noticed your {{category}} profile and wanted to connect about {{campaignName}}.",
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 200 &&
        data.name === "Updated Fitness Collab Outreach" &&
        data.body.includes("Hello {{firstName}}!"),
        "4. Edit template",
      );
    }

    // 5 & 6. Preview template for a lead & verify variable substitution
    {
      const res = await fetch(`${BASE_URL}/api/messages/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: leadRich.id,
          templateId: templateId,
          campaignContext: "Summer Wellness Collab",
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 200 &&
        data.text.includes("Hello Sarah!") &&
        data.text.includes("Fitness & Wellness") &&
        data.text.includes("Summer Wellness Collab"),
        "5 & 6. Preview template renders firstName, category, campaignContext correctly",
      );
    }

    // 7. Test missing lead data (does not crash, uses safe fallbacks)
    {
      const res = await fetch(`${BASE_URL}/api/messages/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: leadMinimal.id,
          templateId: templateId,
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 200 &&
        data.text.includes("Hello quiet_user!") &&
        data.text.includes("profile"),
        "7. Template preview with missing lead fields falls back safely",
      );
    }

    // 8. Generate AI preview
    let generatedAiText = "";
    {
      const initialMessageCount = await prisma.message.count({
        where: { leadId: leadRich.id },
      });

      const res = await fetch(`${BASE_URL}/api/messages/ai-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: leadRich.id,
          templateId: templateId,
          campaignContext: "Summer Wellness Collab",
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 200 &&
        data.generated === true &&
        Boolean(data.provider) &&
        typeof data.text === "string" &&
        data.text.length > 10,
        "8. Generate AI personalized preview",
      );
      generatedAiText = data.text;

      // 9. Verify AI result is NOT automatically sent (database unchanged)
      const afterMessageCount = await prisma.message.count({
        where: { leadId: leadRich.id },
      });
      assert(
        initialMessageCount === afterMessageCount,
        "9. AI preview does NOT create a Message record or send automatically",
      );
    }

    // 10 & 11. Edit generated draft and explicitly send ONE test message using existing messaging API
    const finalEditedText = `${generatedAiText} - P.S. Let me know if you are open to discussing!`;
    {
      const res = await fetch(`${BASE_URL}/api/messages/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: leadRich.id,
          message: finalEditedText,
        }),
      });
      const data = (await res.json()) as any;
      assert(
        Boolean(data.status),
        "10 & 11. Explicitly send ONE test message with final edited text",
      );
    }

    // 12. Verify Message history contains the final sent text
    {
      const latestMessage = await prisma.message.findFirst({
        where: { leadId: leadRich.id },
        orderBy: { createdAt: "desc" },
      });
      assert(
        latestMessage !== null &&
        latestMessage.messageText === finalEditedText &&
        ["SENDING", "SENT", "FAILED"].includes(latestMessage.status),
        "12. Message history accurately records the final edited sent text",
      );
    }

    // 13. Delete template
    {
      const res = await fetch(`${BASE_URL}/api/templates/${templateId}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 200 && data.deleted === true,
        "13. Delete template successfully",
      );

      // Verify deletion in DB
      const check = await prisma.messageTemplate.findUnique({
        where: { id: templateId },
      });
      assert(check === null, "13b. Template deleted from database");
    }

    // 14. Test invalid template / lead / campaign combinations
    // 14a: Non-existent lead (404)
    {
      const res = await fetch(`${BASE_URL}/api/messages/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: "non-existent-lead-9999",
          templateId: "does-not-matter",
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 404 && data.error?.code === "LEAD_NOT_FOUND",
        "14a. Preview returns 404 for non-existent lead",
      );
    }

    // 14b: Non-existent template (404)
    {
      const res = await fetch(`${BASE_URL}/api/messages/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: leadRich.id,
          templateId: "non-existent-template-9999",
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 404 && data.error?.code === "TEMPLATE_NOT_FOUND",
        "14b. Preview returns 404 for non-existent template",
      );
    }

    // 14c: Campaign mismatch (template in campaign 1, lead in campaign 2)
    {
      // Create a template specific to campaign 1
      const camp1Template = await prisma.messageTemplate.create({
        data: {
          campaignId: campaignId,
          name: "Campaign 1 Only Template",
          body: "Hi {{firstName}}",
        },
      });

      const res = await fetch(`${BASE_URL}/api/messages/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: leadOtherCampaign.id, // in secondCampaignId
          templateId: camp1Template.id, // in campaignId
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 400 && data.error?.code === "CAMPAIGN_MISMATCH",
        "14c. Preview returns 400 CAMPAIGN_MISMATCH when template and lead belong to different campaigns",
      );
    }

    // 14d: Template validation error (empty body or name)
    {
      const res = await fetch(`${BASE_URL}/api/campaigns/${campaignId}/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "",
          body: "   ",
        }),
      });
      const data = (await res.json()) as any;
      assert(
        res.status === 400,
        "14d. Template creation fails with 400 on invalid input",
      );
    }

    // Clean up test campaigns
    await prisma.campaign.deleteMany({
      where: { id: { in: [campaignId, secondCampaignId] } },
    });
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

runStep8Tests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
