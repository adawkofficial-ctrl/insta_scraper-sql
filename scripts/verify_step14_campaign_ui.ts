import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  console.log("==> Running Step 14 Campaign Verification...");

  const connectionString = process.env.DATABASE_URL!;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  const user = await prisma.user.findUnique({
    where: { email: "pcplayer809@gmail.com" },
  });

  if (!user) {
    throw new Error("Test user pcplayer809@gmail.com not found!");
  }
  console.log(`✓ Found user ${user.email} (${user.id})`);

  // 2. Test API login
  const loginRes = await fetch("http://localhost:3001/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "pcplayer809@gmail.com",
      password: "ProductionReady2026!",
    }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed with status ${loginRes.status}: ${await loginRes.text()}`);
  }

  const loginData = await loginRes.json();
  const token = loginData.token;
  if (!token) {
    throw new Error("No token returned in login response body");
  }
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Cookie: `session_token=${token}`,
  };
  console.log("✓ Authenticated token obtained:", token.slice(0, 15) + "...");

  // 3. Create campaign with exact requested Step 14 fields
  const campaignPayload = {
    name: "Rawalpindi Fitness Test",
    description: "Test campaign",
    intent: "fitness gyms and fitness businesses",
    location: "Rawalpindi",
    category: "Fitness",
    leadLimit: 10,
  };

  const createRes = await fetch("http://localhost:3001/api/campaigns", {
    method: "POST",
    headers,
    body: JSON.stringify(campaignPayload),
  });

  if (!createRes.ok) {
    throw new Error(`Create campaign failed: ${createRes.status} ${await createRes.text()}`);
  }

  const createdCampaign = await createRes.json();
  console.log("✓ Created campaign via API:", {
    id: createdCampaign.id,
    name: createdCampaign.name,
    description: createdCampaign.description,
    intent: createdCampaign.intent,
    location: createdCampaign.location,
    category: createdCampaign.category,
    leadLimit: createdCampaign.leadLimit,
  });

  if (
    createdCampaign.intent !== campaignPayload.intent ||
    createdCampaign.location !== campaignPayload.location ||
    createdCampaign.category !== campaignPayload.category ||
    createdCampaign.leadLimit !== campaignPayload.leadLimit
  ) {
    throw new Error("Created campaign API response missing or mismatching Step 14 fields!");
  }

  // 4. Fetch detail via GET /api/campaigns/:id
  const getRes = await fetch(`http://localhost:3001/api/campaigns/${createdCampaign.id}`, {
    headers,
  });

  if (!getRes.ok) {
    throw new Error(`GET campaign detail failed: ${getRes.status} ${await getRes.text()}`);
  }

  const campaignDetail = await getRes.json();
  console.log("✓ GET campaign detail verified:", {
    id: campaignDetail.id,
    name: campaignDetail.name,
    intent: campaignDetail.intent,
    location: campaignDetail.location,
    category: campaignDetail.category,
    leadLimit: campaignDetail.leadLimit,
  });

  if (
    campaignDetail.intent !== campaignPayload.intent ||
    campaignDetail.location !== campaignPayload.location ||
    campaignDetail.category !== campaignPayload.category ||
    campaignDetail.leadLimit !== campaignPayload.leadLimit
  ) {
    throw new Error("Campaign detail response missing or mismatching Step 14 fields!");
  }

  // 5. Fetch list via GET /api/campaigns
  const listRes = await fetch("http://localhost:3001/api/campaigns", {
    headers,
  });

  if (!listRes.ok) {
    throw new Error(`GET campaign list failed: ${listRes.status} ${await listRes.text()}`);
  }

  const campaignList = await listRes.json();
  const foundInList = campaignList.find((c: { id: string; name: string; intent?: string; location?: string; category?: string; leadLimit?: number }) => c.id === createdCampaign.id);
  if (!foundInList) {
    throw new Error("Created campaign not found in list response!");
  }

  console.log("✓ GET campaign list verified item:", {
    id: foundInList.id,
    name: foundInList.name,
    intent: foundInList.intent,
    location: foundInList.location,
    category: foundInList.category,
    leadLimit: foundInList.leadLimit,
  });

  // 6. Direct PostgreSQL verification via Prisma
  const dbCampaign = await prisma.campaign.findUnique({
    where: { id: createdCampaign.id },
  });

  if (!dbCampaign) {
    throw new Error("Campaign not found in PostgreSQL!");
  }

  console.log("✓ Verified directly in PostgreSQL database:", {
    id: dbCampaign.id,
    name: dbCampaign.name,
    intent: dbCampaign.intent,
    location: dbCampaign.location,
    category: dbCampaign.category,
    leadLimit: dbCampaign.leadLimit,
  });

  console.log("\n>>> ALL STEP 14 VERIFICATION CHECKS PASSED SUCCESSFULLY! <<<");
  console.log(`Campaign URL: http://localhost:3001/campaigns/${createdCampaign.id}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
