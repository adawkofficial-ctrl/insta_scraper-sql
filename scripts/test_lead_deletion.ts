import "dotenv/config";

// Mock server-only before importing
try {
  const serverOnlyPath = require.resolve("server-only");
  require.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    exports: {},
  } as unknown as NodeModule;
} catch {}

async function main() {
  const { getPrismaClient } = await import("../src/lib/db/prisma");
  const { deleteLead, deleteLeads } = await import("../src/lib/services/lead");
  const prisma = getPrismaClient();

  console.log("==================================================");
  console.log("        LEAD DELETION TEST SUITE                  ");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, name: string) {
    if (cond) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      failed++;
    }
  }

  let testUser = await prisma.user.findFirst();
  if (!testUser) {
    testUser = await prisma.user.create({
      data: {
        email: `delete_test_${Date.now()}@example.com`,
        name: "Delete Tester",
        passwordHash: "test_password_hash",
      },
    });
  }

  let companyProfile = await prisma.companyProfile.findFirst({
    where: { userId: testUser.id },
  });
  if (!companyProfile) {
    companyProfile = await prisma.companyProfile.create({
      data: {
        userId: testUser.id,
        name: "Delete Test Agency",
      },
    });
  }

  const campaign = await prisma.campaign.create({
    data: {
      userId: testUser.id,
      name: `Delete Test Campaign ${Date.now()}`,
      companyProfileId: companyProfile.id,
    },
  });

  try {
    // 1. Create test leads
    const lead1 = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: testUser.id,
        username: `delete_lead_1_${Date.now()}`,
        profileUrl: `https://www.instagram.com/delete_lead_1_${Date.now()}/`,
        fullName: "Delete Test Lead 1",
      },
    });

    const lead2 = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: testUser.id,
        username: `delete_lead_2_${Date.now()}`,
        profileUrl: `https://www.instagram.com/delete_lead_2_${Date.now()}/`,
        fullName: "Delete Test Lead 2",
      },
    });

    const lead3 = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: testUser.id,
        username: `delete_lead_3_${Date.now()}`,
        profileUrl: `https://www.instagram.com/delete_lead_3_${Date.now()}/`,
        fullName: "Delete Test Lead 3",
      },
    });

    assert(Boolean(lead1.id && lead2.id && lead3.id), "Created 3 test leads for deletion");

    // 2. Test single lead deletion
    console.log("\n[1] Testing deleteLead (single)...");
    const singleDelRes = await deleteLead(lead1.id, testUser.id);
    assert(singleDelRes.deleted === true && singleDelRes.id === lead1.id, "deleteLead returns deleted true");

    const foundLead1 = await prisma.lead.findUnique({ where: { id: lead1.id } });
    assert(foundLead1 === null, "Lead 1 was removed from database");

    // 3. Test bulk lead deletion
    console.log("\n[2] Testing deleteLeads (bulk)...");
    const bulkDelRes = await deleteLeads([lead2.id, lead3.id], testUser.id);
    assert(bulkDelRes.deletedCount === 2, `deleteLeads deleted exactly 2 leads (got: ${bulkDelRes.deletedCount})`);
    assert(
      bulkDelRes.deletedIds.includes(lead2.id) && bulkDelRes.deletedIds.includes(lead3.id),
      "deleteLeads returned both deleted lead IDs",
    );

    const remainingLeads = await prisma.lead.count({ where: { campaignId: campaign.id } });
    assert(remainingLeads === 0, `All leads deleted, campaign has 0 leads (got: ${remainingLeads})`);

    // 4. Test deleteLeads with empty array
    console.log("\n[3] Testing deleteLeads edge cases...");
    const emptyRes = await deleteLeads([], testUser.id);
    assert(emptyRes.deletedCount === 0 && emptyRes.deletedIds.length === 0, "Empty leadIds array safely returns 0");

    // 5. Test user isolation / tenancy
    const otherUser = await prisma.user.create({
      data: {
        email: `other_user_${Date.now()}@example.com`,
        name: "Other User",
        passwordHash: "test_password_hash",
      },
    });

    const otherLead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: testUser.id,
        username: `other_user_lead_${Date.now()}`,
        profileUrl: `https://www.instagram.com/other_${Date.now()}/`,
      },
    });

    // otherUser should not be able to delete lead belonging to testUser's campaign
    const unauthorizedRes = await deleteLeads([otherLead.id], otherUser.id);
    assert(unauthorizedRes.deletedCount === 0, "User tenancy protects leads from deletion by other users");

    const verifiedStillExists = await prisma.lead.findUnique({ where: { id: otherLead.id } });
    assert(Boolean(verifiedStillExists), "Lead remained intact after unauthorized deletion attempt");

    // Clean up
    await prisma.lead.delete({ where: { id: otherLead.id } });
    await prisma.user.delete({ where: { id: otherUser.id } });
  } finally {
    await prisma.lead.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.campaign.delete({ where: { id: campaign.id } });
  }

  console.log("\n==================================================");
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
