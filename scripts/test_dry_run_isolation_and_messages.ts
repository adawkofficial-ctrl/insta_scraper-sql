import "dotenv/config";
(process.env as Record<string, string>).NODE_ENV = "test";
import assert from "node:assert";

// Preload server-only mock and test db guard
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

async function run() {
  const { getPrismaClient } = await import("../src/lib/db/prisma");
  const { classifyProfiles } = await import("../src/lib/services/dedup/dedup-service");
  const { buildDiscoveryNotice } = await import("../src/lib/services/discovery/discovery-service");
  const { createEmptySkipCounts } = await import("../src/lib/services/discovery/lead-relevance");
  const { getDryRunCounts, deleteDryRunData } = await import("../src/lib/services/lead/dry-run-cleanup");
  const {
    getMonthlyBudgetUsd,
    getMonthlyApifyBudgetRemaining,
  } = await import("../src/lib/services/scraper/apify-cost-guard");

  console.log("=== DRY-RUN ISOLATION & MESSAGE CLASSIFICATION TESTS ===");
  const prisma = getPrismaClient();

  let passed = 0;

  // Create test user and campaign for DB tests
  const testEmail = `dryrun-test-${Date.now()}@example.com`;
  const user = await prisma.user.create({
    data: {
      email: testEmail,
      name: "Dry Run Isolation Tester",
      passwordHash: "test-hash",
    },
  });

  const companyProfile = await prisma.companyProfile.create({
    data: {
      userId: user.id,
      name: "Test Dental Studio",
      description: "Testing dry-run isolation",
      isDefault: true,
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      name: "Dry Run Test Campaign",
      companyProfileId: companyProfile.id,
      intent: "dentist",
      location: "Toronto, ON",
      category: "Dentist",
    },
  });

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Deduplication Isolation - Real runs ignore dry-run leads
    // -------------------------------------------------------------------------
    console.log("\n[Test 1] Dedup service: Real runs ignore dry-run leads");

    // Insert 1 dry-run lead and 1 real lead in this campaign
    const dryLead = await prisma.lead.create({
      data: {
        userId: user.id,
        campaignId: campaign.id,
        username: "dry_run_dentist_alpha",
        usernameNormalized: "dry_run_dentist_alpha",
        isDryRun: true,
        source: "dry_run",
        fullName: "Alpha Dry Run Dentist",
      },
    });

    const realLead = await prisma.lead.create({
      data: {
        userId: user.id,
        campaignId: campaign.id,
        username: "real_dentist_beta",
        usernameNormalized: "real_dentist_beta",
        isDryRun: false,
        source: "apify",
        fullName: "Beta Real Dentist",
      },
    });

    // When classifying candidates for a REAL run (isDryRun: false):
    const classificationReal = await classifyProfiles({
      userId: user.id,
      campaignId: campaign.id,
      profiles: [
        { username: "dry_run_dentist_alpha" }, // Matches dry lead -> Should NOT be marked DUPLICATE in real run
        { username: "real_dentist_beta" },      // Matches real lead -> SHOULD be marked DUPLICATE
        { username: "fresh_dentist_gamma" },    // Matches nothing -> SHOULD be NEW
      ],
      isDryRun: false,
    });

    const realDuplicates = classificationReal.filter((c) => c.kind === "HARD_DUPLICATE");
    const realNew = classificationReal.filter((c) => c.kind === "NEW");

    assert.strictEqual(
      realDuplicates.length,
      1,
      "Real run should find exactly 1 duplicate (the real lead)",
    );
    assert.strictEqual(
      realDuplicates[0].normalized.username,
      "real_dentist_beta",
      "Duplicate in real run must be the real lead",
    );
    assert.strictEqual(
      realNew.length,
      2,
      "Real run should treat the dry-run username and the fresh username as new candidates",
    );
    assert.ok(
      realNew.some((c) => c.normalized.username === "dry_run_dentist_alpha"),
      "Candidate sharing username with dry-run lead must be treated as new in real run",
    );
    passed++;
    console.log("  PASS: Real run correctly ignores dry-run leads during dedup");

    // When classifying candidates for a DRY-RUN run (isDryRun: true):
    const classificationDry = await classifyProfiles({
      userId: user.id,
      campaignId: campaign.id,
      profiles: [
        { username: "dry_run_dentist_alpha" },
        { username: "real_dentist_beta" },
      ],
      isDryRun: true,
    });

    const dryDuplicates = classificationDry.filter((c) => c.kind === "HARD_DUPLICATE");
    assert.strictEqual(
      dryDuplicates.length,
      2,
      "Dry-run run should see both dry-run and real leads as duplicates",
    );
    passed++;
    console.log("  PASS: Dry-run correctly deduplicates across all candidates");

    // -------------------------------------------------------------------------
    // TEST 2: Cleanup Service - Deletes only dry-run leads and jobs
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Dry-run cleanup service");

    // Add another dry lead and a dry scrape job
    await prisma.lead.create({
      data: {
        userId: user.id,
        campaignId: campaign.id,
        username: "sample_business_99",
        usernameNormalized: "sample_business_99",
        isDryRun: true,
        source: "sample",
        fullName: "Sample 99",
      },
    });

    const dryJob = await prisma.scrapeJob.create({
      data: {
        campaignId: campaign.id,
        provider: "dry_run",
        isDryRun: true,
        status: "COMPLETED",
        inputCount: 0,
        processedCount: 0,
      },
    });

    const realJob = await prisma.scrapeJob.create({
      data: {
        campaignId: campaign.id,
        provider: "apify",
        isDryRun: false,
        status: "COMPLETED",
        inputCount: 5,
        processedCount: 5,
      },
    });

    const countsBefore = await getDryRunCounts(user.id);
    assert.ok(countsBefore.dryLeads >= 2, "Must count at least 2 dry-run leads");
    assert.ok(countsBefore.dryScrapeJobs >= 1, "Must count at least 1 dry scrape job");
    passed++;

    // Execute cleanup
    const cleanupResult = await deleteDryRunData({ userId: user.id });
    assert.ok(cleanupResult.deletedLeads >= 2, "Must delete at least 2 dry leads");
    assert.ok(cleanupResult.deletedScrapeJobs >= 1, "Must delete at least 1 dry scrape job");
    passed++;

    // Confirm real lead and real scrape job are STILL IN DATABASE
    const realLeadAfter = await prisma.lead.findUnique({ where: { id: realLead.id } });
    assert.ok(realLeadAfter, "Real lead must NOT be deleted by dry-run cleanup");
    assert.strictEqual(realLeadAfter.username, "real_dentist_beta");

    const realJobAfter = await prisma.scrapeJob.findUnique({ where: { id: realJob.id } });
    assert.ok(realJobAfter, "Real scrape job must NOT be deleted by dry-run cleanup");

    // Confirm dry lead and dry job are gone
    const dryLeadAfter = await prisma.lead.findUnique({ where: { id: dryLead.id } });
    assert.strictEqual(dryLeadAfter, null, "Dry lead must be deleted");

    const dryJobAfter = await prisma.scrapeJob.findUnique({ where: { id: dryJob.id } });
    assert.strictEqual(dryJobAfter, null, "Dry scrape job must be deleted");
    passed++;
    console.log("  PASS: Dry-run cleanup permanently deleted dry data while preserving real data");

    // -------------------------------------------------------------------------
    // TEST 3: Result Message Classification
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Discovery summary message classification");

    // Case A: BUDGET_BLOCKED
    const msgBudget = buildDiscoveryNotice({
      persisted: 0,
      requested: 10,
      existingLeads: 0,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 10,
      gmapsPlacesFound: 0,
      gmapsWithWebsite: 0,
      gmapsWithInstagram: 0,
      gmapsDuplicatesSkipped: 0,
      skipCounts: createEmptySkipCounts(),
      stopReason: "monthly_budget_exhausted",
    });
    assert.ok(
      msgBudget && msgBudget.includes("BUDGET_BLOCKED"),
      `Expected BUDGET_BLOCKED in: ${msgBudget}`,
    );
    passed++;

    // Case B: ALL_DUPLICATES (never says "no matching places found in Google Maps")
    const dupSkipCounts = createEmptySkipCounts();
    dupSkipCounts.DUPLICATE = 10;
    const msgDuplicates = buildDiscoveryNotice({
      persisted: 0,
      requested: 10,
      existingLeads: 5,
      discovered: 10,
      existingSkipped: 5,
      enrichSkipped: 0,
      remainingCapacity: 5,
      gmapsPlacesFound: 10,
      gmapsWithWebsite: 10,
      gmapsWithInstagram: 10,
      gmapsDuplicatesSkipped: 5,
      skippedAlreadySeenCount: 5,
      skipCounts: dupSkipCounts,
      stopReason: "all_keywords_exhausted",
    });
    assert.ok(
      msgDuplicates && msgDuplicates.includes("ALL_DUPLICATES"),
      `Expected ALL_DUPLICATES in: ${msgDuplicates}`,
    );
    assert.ok(
      !msgDuplicates.toLowerCase().includes("no matching places found in google maps"),
      "Must NEVER say no matching places when places were returned",
    );
    assert.ok(
      msgDuplicates.includes("already"),
      `Expected mention of already in leads/past runs in: ${msgDuplicates}`,
    );
    passed++;

    // Case C: ALL_FILTERED
    const filterSkipCounts = createEmptySkipCounts();
    filterSkipCounts.ENRICHMENT_CRITERIA_REJECTED = 2;
    const msgFiltered = buildDiscoveryNotice({
      persisted: 0,
      requested: 10,
      existingLeads: 0,
      discovered: 15,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 10,
      gmapsPlacesFound: 15,
      gmapsWithWebsite: 2,
      gmapsWithInstagram: 2,
      gmapsDuplicatesSkipped: 0,
      skipCounts: filterSkipCounts,
      stopReason: "all_keywords_exhausted",
    });
    assert.ok(
      msgFiltered && msgFiltered.includes("ALL_FILTERED"),
      `Expected ALL_FILTERED in: ${msgFiltered}`,
    );
    passed++;

    // Case D: NO_RESULTS (only when 0 places found)
    const msgNoResults = buildDiscoveryNotice({
      persisted: 0,
      requested: 10,
      existingLeads: 0,
      discovered: 0,
      existingSkipped: 0,
      enrichSkipped: 0,
      remainingCapacity: 10,
      gmapsPlacesFound: 0,
      gmapsWithWebsite: 0,
      gmapsWithInstagram: 0,
      gmapsDuplicatesSkipped: 0,
      skipCounts: createEmptySkipCounts(),
      stopReason: "all_keywords_exhausted",
    });
    assert.ok(
      msgNoResults && msgNoResults.includes("NO_RESULTS"),
      `Expected NO_RESULTS in: ${msgNoResults}`,
    );
    passed++;
    console.log("  PASS: Message classification handles BUDGET_BLOCKED, ALL_DUPLICATES, ALL_FILTERED, NO_RESULTS accurately");

    // -------------------------------------------------------------------------
    // TEST 4: Budget Unset vs Exhausted Logic
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Budget handling (unset vs exhausted)");

    const originalBudgetEnv = process.env.APIFY_MONTHLY_BUDGET_USD;

    // Unset budget
    delete process.env.APIFY_MONTHLY_BUDGET_USD;
    assert.strictEqual(
      getMonthlyBudgetUsd(),
      null,
      "getMonthlyBudgetUsd must return null when unset",
    );
    const remainingUnset = await getMonthlyApifyBudgetRemaining();
    assert.strictEqual(
      remainingUnset,
      null,
      "getMonthlyApifyBudgetRemaining must return null when budget is unset",
    );
    passed++;

    // Restore budget env
    if (originalBudgetEnv !== undefined) {
      process.env.APIFY_MONTHLY_BUDGET_USD = originalBudgetEnv;
    }
    console.log("  PASS: Budget unset returns null without blocking");

    console.log(`\nAll ${passed} assertions in dry-run isolation test suite PASSED!`);
  } finally {
    // Cleanup test user and campaign
    await prisma.leadSighting.deleteMany({
      where: { lead: { campaignId: campaign.id } },
    }).catch(() => undefined);
    await prisma.lead.deleteMany({
      where: { campaignId: campaign.id },
    }).catch(() => undefined);
    await prisma.scrapeJob.deleteMany({
      where: { campaignId: campaign.id },
    }).catch(() => undefined);
    await prisma.campaign.delete({
      where: { id: campaign.id },
    }).catch(() => undefined);
    await prisma.companyProfile.delete({
      where: { id: companyProfile.id },
    }).catch(() => undefined);
    await prisma.user.delete({
      where: { id: user.id },
    }).catch(() => undefined);
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  });
