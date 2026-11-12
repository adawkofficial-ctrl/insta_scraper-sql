import "dotenv/config";

// Mock server-only before importing server code in standalone script
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
  const { parseLeadCsv, normalizeCsvHandle, parseCsvRows, detectColumnMapping } = await import(
    "../src/lib/services/lead/csv-lead-parser"
  );
  const { importLeadsFromCsv, previewCsvLeads } = await import(
    "../src/lib/services/lead/csv-lead-import-service"
  );
  const { getPrismaClient } = await import("../src/lib/db/prisma");

  console.log("==================================================");
  console.log("        CSV LEAD UPLOAD TEST SUITE               ");
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

  // ----------------------------------------------------
  // TEST 1: Username & Profile URL Normalization
  // ----------------------------------------------------
  console.log("\n[1] Testing Instagram Handle Normalization...");
  assert(normalizeCsvHandle("@alex_rivera") === "alex_rivera", "Strips leading @ from handle");
  assert(normalizeCsvHandle("  SARAH.FIT  ") === "sarah.fit", "Lowercases and trims handle");
  assert(
    normalizeCsvHandle("https://www.instagram.com/growth_agency/") === "growth_agency",
    "Extracts handle from full Instagram profile URL",
  );
  assert(
    normalizeCsvHandle("https://instagram.com/johndoe?igsh=OGQ5ZDc2ODk2ZA==") === "johndoe",
    "Strips tracking parameters from profile URL",
  );
  assert(normalizeCsvHandle("https://instagram.com/p/C12345678/") === null, "Rejects post URL (/p/)");
  assert(normalizeCsvHandle("https://instagram.com/reel/C12345678/") === null, "Rejects reel URL (/reel/)");
  assert(normalizeCsvHandle("invalid..username") === null, "Rejects consecutive dots in username");
  assert(normalizeCsvHandle("invalid username with spaces") === null, "Rejects spaces in username");

  // ----------------------------------------------------
  // TEST 2: RFC 4180 CSV Parsing (Quotes & Delimiters)
  // ----------------------------------------------------
  console.log("\n[2] Testing RFC 4180 CSV Parsing with Escaped Quotes & Commas...");
  const rawCsv = `username,full_name,biography,email
alex_rivera,"Rivera, Alex","Founder at Acme, Inc. ""Building the future""",alex@example.com
natashafit,Natasha Romanoff,Certified Fitness Coach,natasha@fit.org`;

  const parsedRows = parseCsvRows(rawCsv);
  assert(parsedRows.length === 3, "Parsed exactly 3 rows (1 header + 2 data rows)");
  assert(parsedRows[1][1] === "Rivera, Alex", "Preserves comma inside quoted full_name");
  assert(
    parsedRows[1][2] === 'Founder at Acme, Inc. "Building the future"',
    "Properly unescapes double quotes inside biography",
  );

  // ----------------------------------------------------
  // TEST 3: Column Mapping & Alias Detection
  // ----------------------------------------------------
  console.log("\n[3] Testing Column Alias Auto-Detection...");
  const messyHeaders = ["Instagram Handle", "Contact Name", "About Me", "Email Address", "Phone Number", "Niche", "Follower Count"];
  const mapping = detectColumnMapping(messyHeaders);

  assert(mapping.username === 0, "Maps 'Instagram Handle' to username");
  assert(mapping.fullName === 1, "Maps 'Contact Name' to fullName");
  assert(mapping.biography === 2, "Maps 'About Me' to biography");
  assert(mapping.email === 3, "Maps 'Email Address' to email");
  assert(mapping.phone === 4, "Maps 'Phone Number' to phone");
  assert(mapping.category === 5, "Maps 'Niche' to category");
  assert(mapping.followersCount === 6, "Maps 'Follower Count' to followersCount");

  // ----------------------------------------------------
  // TEST 4: Full CSV Parsing & Lead Mapping
  // ----------------------------------------------------
  console.log("\n[4] Testing Full Lead CSV Parsing...");
  const fullCsv = `Handle,Full Name,Email,Phone,Niche,Followers
@trainer_mike,Mike Davis,mike@fitbody.com,+15551234567,Personal Trainer,12500
https://instagram.com/sarah_yoga/,Sarah Jenkins,sarah@zenyoga.com,,Yoga & Wellness,"24,800"
"invalid user spaces",Bad User,bad@email.com,,,100
@trainer_mike,Mike Davis Duplicate,mike@fitbody.com,,,12500
plain_handle,John Doe,john@test.com,+15559876543,SaaS Founder,5000`;

  const parseResult = parseLeadCsv(fullCsv);
  assert(parseResult.totalRows === 5, "Total data rows parsed: 5");
  assert(parseResult.validCount === 3, "Valid distinct leads extracted: 3 (skips invalid and duplicate)");
  assert(parseResult.invalidCount === 1, "Invalid handle flagged: 1 (invalid user spaces)");

  const lead1 = parseResult.leads.find((l) => l.username === "trainer_mike");
  assert(Boolean(lead1), "Found lead 'trainer_mike'");
  assert(lead1?.fullName === "Mike Davis", "Parsed fullName 'Mike Davis'");
  assert(lead1?.email === "mike@fitbody.com", "Parsed normalized email 'mike@fitbody.com'");
  assert(lead1?.phone === "+15551234567", "Parsed phone '+15551234567'");
  assert(lead1?.followersCount === 12500, "Parsed numeric followersCount 12500");

  const lead2 = parseResult.leads.find((l) => l.username === "sarah_yoga");
  assert(lead2?.followersCount === 24800, "Cleaned comma in followers count '24,800' -> 24800");

  // ----------------------------------------------------
  // TEST 5: Headerless CSV & Plain List of Handles
  // ----------------------------------------------------
  console.log("\n[5] Testing Headerless CSV / List of Handles...");
  const headerlessInput = `@athlete_one
https://instagram.com/athlete_two/
athlete_three`;

  const headerlessResult = parseLeadCsv(headerlessInput);
  assert(headerlessResult.validCount === 3, "Parsed 3 handles from raw headerless list");
  assert(
    headerlessResult.leads.map((l) => l.username).sort().join(",") === "athlete_one,athlete_three,athlete_two",
    "All 3 handles extracted and normalized cleanly",
  );

  // ----------------------------------------------------
  // TEST 6: Preview API Service Functionality
  // ----------------------------------------------------
  console.log("\n[6] Testing previewCsvLeads Function...");
  const preview = await previewCsvLeads(fullCsv);
  assert(preview.validCount === 3, "previewCsvLeads returns correct valid count");
  assert(preview.previewRows.length === 3, "previewCsvLeads returns preview rows");
  assert(preview.previewRows[0].username === "@trainer_mike", "previewRows includes formatted handle");

  // ----------------------------------------------------
  // TEST 7: Database Import & Transactional Deduplication
  // ----------------------------------------------------
  console.log("\n[7] Testing Database Import, Deduplication, and Updates...");
  const prisma = getPrismaClient();

  // Find or create a test campaign and user
  let testUser = await prisma.user.findFirst();
  if (!testUser) {
    testUser = await prisma.user.create({
      data: {
        email: "test_csv_importer@example.com",
        passwordHash: "test_hash",
        name: "CSV Importer Test",
      },
    });
  }

  let companyProfile = await prisma.companyProfile.findFirst({ where: { userId: testUser.id } });
  if (!companyProfile) {
    companyProfile = await prisma.companyProfile.create({
      data: {
        userId: testUser.id,
        name: "Test Agency",
      },
    });
  }

  const testCampaign = await prisma.campaign.create({
    data: {
      userId: testUser.id,
      name: `CSV Test Campaign ${Date.now()}`,
      companyProfileId: companyProfile.id,
    },
  });

  try {
    const importCsv1 = `username,full_name,email,category
test_lead_alpha,Alpha Lead,alpha@example.com,Technology
test_lead_beta,Beta Lead,beta@example.com,Marketing
test_lead_gamma,Gamma Lead,,Consulting`;

    const result1 = await importLeadsFromCsv(testCampaign.id, testUser.id, importCsv1);
    assert(result1.createdCount === 3, `Initial import created 3 new leads (got: ${result1.createdCount})`);

    // Verify leads in DB
    const dbLeads = await prisma.lead.findMany({
      where: { campaignId: testCampaign.id },
    });
    assert(dbLeads.length === 3, "Database contains exactly 3 leads for test campaign");
    assert(dbLeads.every((l) => l.source === "csv_upload"), "Lead source properly set to 'csv_upload'");

    // Test second import with skipExisting: true
    const result2 = await importLeadsFromCsv(testCampaign.id, testUser.id, importCsv1, { skipExisting: true });
    assert(result2.createdCount === 0, "Duplicate import created 0 new leads");
    assert(result2.skippedDuplicates === 3, "Duplicate import skipped 3 existing leads");

    // Test third import with new phone number for existing lead
    const importCsvWithNewData = `username,phone
test_lead_gamma,+15557778888`;
    const result3 = await importLeadsFromCsv(testCampaign.id, testUser.id, importCsvWithNewData, { skipExisting: false });
    assert(result3.updatedCount === 1, "Enriched existing lead with phone number");

    const updatedGamma = await prisma.lead.findFirst({
      where: { campaignId: testCampaign.id, username: "test_lead_gamma" },
    });
    assert(updatedGamma?.phone === "+15557778888", "Phone number was saved to existing lead record");
  } finally {
    // Cleanup test campaign & leads
    await prisma.lead.deleteMany({ where: { campaignId: testCampaign.id } });
    await prisma.campaign.delete({ where: { id: testCampaign.id } }).catch(() => {});
  }

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log("\n==================================================");
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in CSV test runner:", err);
  process.exit(1);
});
