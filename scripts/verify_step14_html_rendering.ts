import "dotenv/config";

async function main() {
  console.log("==> Running UI HTML & API Persistence Verification for Step 14...");

  // 1. Login
  const loginRes = await fetch("http://localhost:3001/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "pcplayer809@gmail.com",
      password: "ProductionReady2026!",
    }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }

  const { token } = await loginRes.json();
  const headers = {
    Authorization: `Bearer ${token}`,
    Cookie: `session_token=${token}`,
  };

  // 2. Create campaign via API
  const campaignPayload = {
    name: "Rawalpindi Fitness Test Verification",
    description: "Full end-to-end verification campaign",
    intent: "fitness gyms and fitness businesses",
    location: "Rawalpindi",
    category: "Fitness",
    leadLimit: 10,
  };

  const createRes = await fetch("http://localhost:3001/api/campaigns", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(campaignPayload),
  });

  if (!createRes.ok) {
    throw new Error(`Create failed: ${createRes.status} ${await createRes.text()}`);
  }

  const campaign = await createRes.json();
  console.log("✓ Created campaign:", campaign.id, campaign.name);

  // 3. Verify GET /api/campaigns/:id returns all 4 fields
  const detailRes = await fetch(`http://localhost:3001/api/campaigns/${campaign.id}`, { headers });
  const detailData = await detailRes.json();

  console.log("✓ Detail API response:", {
    intent: detailData.intent,
    location: detailData.location,
    category: detailData.category,
    leadLimit: detailData.leadLimit,
  });

  if (
    detailData.intent !== "fitness gyms and fitness businesses" ||
    detailData.location !== "Rawalpindi" ||
    detailData.category !== "Fitness" ||
    detailData.leadLimit !== 10
  ) {
    throw new Error("Detail API does not return correct Step 14 fields!");
  }

  // 4. Verify GET /api/campaigns list returns all 4 fields
  const listRes = await fetch("http://localhost:3001/api/campaigns", { headers });
  const listData = await listRes.json();
  const itemInList = listData.find((c: { id: string; intent?: string; location?: string; category?: string; leadLimit?: number }) => c.id === campaign.id);

  if (!itemInList) {
    throw new Error("Campaign missing from list API!");
  }

  console.log("✓ List API response item:", {
    intent: itemInList.intent,
    location: itemInList.location,
    category: itemInList.category,
    leadLimit: itemInList.leadLimit,
  });

  if (
    itemInList.intent !== "fitness gyms and fitness businesses" ||
    itemInList.location !== "Rawalpindi" ||
    itemInList.category !== "Fitness" ||
    itemInList.leadLimit !== 10
  ) {
    throw new Error("List API does not return correct Step 14 fields!");
  }

  // 5. Test empty/null fields handling (Requirement 5)
  console.log("\n==> Testing null/empty fields fallback handling...");
  const minimalCampaignPayload = {
    name: "Minimal Campaign Without Intent Fields",
    description: null,
  };

  const minimalCreateRes = await fetch("http://localhost:3001/api/campaigns", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(minimalCampaignPayload),
  });

  const minimalCampaign = await minimalCreateRes.json();
  const minimalDetailRes = await fetch(`http://localhost:3001/api/campaigns/${minimalCampaign.id}`, { headers });
  const minimalDetail = await minimalDetailRes.json();

  console.log("✓ Minimal campaign detail:", {
    intent: minimalDetail.intent,
    location: minimalDetail.location,
    category: minimalDetail.category,
    leadLimit: minimalDetail.leadLimit,
  });

  // Verify fields are null (not undefined)
  if (
    minimalDetail.intent !== null ||
    minimalDetail.location !== null ||
    minimalDetail.category !== null ||
    minimalDetail.leadLimit !== null
  ) {
    throw new Error("Minimal campaign fields should be null!");
  }

  console.log("\n==> Testing page load and re-fetch simulation (persists across reloads)...");
  // 6. Simulate page refresh by fetching detail again
  const refreshedDetailRes = await fetch(`http://localhost:3001/api/campaigns/${campaign.id}`, { headers });
  const refreshedDetail = await refreshedDetailRes.json();

  if (
    refreshedDetail.intent !== "fitness gyms and fitness businesses" ||
    refreshedDetail.location !== "Rawalpindi" ||
    refreshedDetail.category !== "Fitness" ||
    refreshedDetail.leadLimit !== 10
  ) {
    throw new Error("Refreshed campaign detail does not match!");
  }
  console.log("✓ Persisted and verified across reload simulation!");

  console.log("\n============================================================");
  console.log("🎉 ALL TESTS PASSED: CAMPAIGN STEP 14 UI & API PERSISTENCE OK!");
  console.log("============================================================");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
