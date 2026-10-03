/* eslint-disable */
import "dotenv/config";

const BASE_URL = "http://localhost:3001";

async function runVerification() {
  console.log("==================================================");
  console.log("   STEP 6: FRONTEND & API FLOW VERIFICATION       ");
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

  // 1. Verify Home Page HTML delivers React Shell & Metadata
  {
    const res = await fetch(`${BASE_URL}/`);
    const html = await res.text();
    assert(
      res.status === 200 && html.includes("InstaScraper"),
      "Home page (/) returns 200 OK with title / brand markup",
    );
  }

  // 2. Verify GET /api/campaigns loads campaigns for Dashboard
  let campaigns: any[] = [];
  {
    const res = await fetch(`${BASE_URL}/api/campaigns`);
    campaigns = await res.json();
    assert(
      res.status === 200 &&
      Array.isArray(campaigns) &&
      campaigns.some((c) => c.name === "Fitness & Wellness Influencers"),
      "Dashboard GET /api/campaigns returns populated campaign list",
    );
  }

  const demoCampaign = campaigns.find((c) => c.name === "Fitness & Wellness Influencers");
  assert(
    Boolean(demoCampaign && demoCampaign.leadCount === 4 && demoCampaign.scrapeJobCount === 1),
    "Demo campaign has 4 leads and 1 scrape job reported in summary stats",
  );

  // 3. Verify Create Campaign flow (POST /api/campaigns)
  let newCampaignId = "";
  {
    const res = await fetch(`${BASE_URL}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Startup Tech Founders",
        description: "B2B SaaS founders & tech leaders",
      }),
    });
    const json = await res.json();
    assert(
      res.status === 201 && json.id && json.status === "DRAFT",
      "Create campaign modal submit creates DRAFT campaign (201 Created)",
    );
    newCampaignId = json.id;
  }

  // 4. Verify Campaign Detail HTML route works for new campaign
  {
    const res = await fetch(`${BASE_URL}/campaigns/${newCampaignId}`);
    assert(res.status === 200, "Campaign detail page (/campaigns/[id]) returns 200 OK");
  }

  // 5. Verify Campaign Detail Data API for demo campaign
  let demoDetail: any = null;
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${demoCampaign.id}`);
    demoDetail = await res.json();
    assert(
      res.status === 200 &&
      demoDetail.name === "Fitness & Wellness Influencers" &&
      demoDetail.leadCount === 4 &&
      Array.isArray(demoDetail.recentScrapeJobs),
      "GET /api/campaigns/[id] delivers campaign metadata and recentScrapeJobs",
    );
  }

  // 6. Verify Lead Table data fetch (GET /api/campaigns/[id]/leads?page=1&limit=25)
  let leadsData: any = null;
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${demoCampaign.id}/leads?page=1&limit=25`);
    leadsData = await res.json();
    assert(
      res.status === 200 &&
      leadsData.items.length === 4 &&
      leadsData.pagination.total === 4 &&
      leadsData.items.some((l: any) => l.username === "sarah_fitcoach"),
      "Lead Table fetch returns 4 leads with pagination metadata",
    );
  }

  // 7. Verify Search filter (?search=sarah)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${demoCampaign.id}/leads?search=sarah`);
    const json = await res.json();
    assert(
      res.status === 200 &&
      json.items.length === 1 &&
      json.items[0].username === "sarah_fitcoach",
      "Lead Table search (?search=sarah) filters down to @sarah_fitcoach",
    );
  }

  // 8. Verify Verified filter (?isVerified=true)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${demoCampaign.id}/leads?isVerified=true`);
    const json = await res.json();
    assert(
      res.status === 200 &&
      json.items.length === 2 &&
      json.items.every((l: any) => l.isVerified === true),
      "Lead Table filter (?isVerified=true) returns only verified accounts",
    );
  }

  // 9. Verify Business filter (?isBusiness=false)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${demoCampaign.id}/leads?isBusiness=false`);
    const json = await res.json();
    assert(
      res.status === 200 &&
      json.items.length === 1 &&
      json.items[0].username === "yoga_with_elena",
      "Lead Table filter (?isBusiness=false) returns only personal accounts",
    );
  }

  // 10. Verify Category filter (?category=Food)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${demoCampaign.id}/leads?category=Food`);
    const json = await res.json();
    assert(
      res.status === 200 &&
      json.items.length === 1 &&
      json.items[0].username === "clean_eats_daily",
      "Lead Table filter (?category=Food) filters by niche",
    );
  }

  // 11. Verify Single Lead Profile for Side Drawer (GET /api/leads/[leadId])
  const sarah = leadsData.items.find((l: any) => l.username === "sarah_fitcoach");
  {
    const res = await fetch(`${BASE_URL}/api/leads/${sarah.id}`);
    const json = await res.json();
    assert(
      res.status === 200 &&
      json.username === "sarah_fitcoach" &&
      json.followers === 48200 &&
      json.campaign?.id === demoCampaign.id,
      "Lead Profile drawer fetch delivers complete profile with campaign reference",
    );
  }

  // 12. Verify Lead In-Place Metadata Editing (PATCH /api/leads/[leadId])
  {
    const res = await fetch(`${BASE_URL}/api/leads/${sarah.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Sarah Jenkins (Pro Coach)",
        category: "Elite Fitness Coach",
        biography: "Updated bio from lead drawer editing.",
      }),
    });
    const json = await res.json();
    assert(
      res.status === 200 &&
      json.fullName === "Sarah Jenkins (Pro Coach)" &&
      json.category === "Elite Fitness Coach" &&
      json.biography === "Updated bio from lead drawer editing.",
      "Lead Drawer edit saves updated metadata (PATCH /api/leads/[id])",
    );

    // Verify persistence on fresh fetch
    const verifyRes = await fetch(`${BASE_URL}/api/leads/${sarah.id}`);
    const verifyJson = await verifyRes.json();
    assert(
      verifyJson.fullName === "Sarah Jenkins (Pro Coach)",
      "Edited lead metadata persists in PostgreSQL database",
    );
  }

  // 13. Verify Scrape History fetch (GET /api/campaigns/[id]/scrape-jobs)
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${demoCampaign.id}/scrape-jobs`);
    const json = await res.json();
    assert(
      res.status === 200 &&
      Array.isArray(json) &&
      json.length >= 1 &&
      json[0].status === "COMPLETED" &&
      json[0].processedCount === 4,
      "Scrape History tab fetches jobs (GET /api/campaigns/[id]/scrape-jobs)",
    );
  }

  // 14. Verify Scrape Validation (POST /api/scraper/instagram/profile)
  {
    const res = await fetch(`${BASE_URL}/api/scraper/instagram/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaignId: "non-existent-campaign-id",
        profiles: ["cristiano"],
      }),
    });
    const json = await res.json();
    assert(
      res.status === 404 && json.error?.code === "CAMPAIGN_NOT_FOUND",
      "Scrape Leads triggers backend validation for invalid campaign ID (404)",
    );
  }

  // 15. Verify Clean Deletion of Created Campaign
  {
    const res = await fetch(`${BASE_URL}/api/campaigns/${newCampaignId}`, {
      method: "DELETE",
    });
    const json = await res.json();
    assert(
      res.status === 200 && json.deleted === true,
      "Delete campaign action deletes campaign (DELETE /api/campaigns/[id])",
    );

    // Verify subsequent lookup returns 404
    const checkRes = await fetch(`${BASE_URL}/api/campaigns/${newCampaignId}`);
    assert(checkRes.status === 404, "Deleted campaign returns 404 on subsequent fetch");
  }

  console.log("\n==================================================");
  console.log(`TOTAL CHECKS: ${passed + failed}`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
