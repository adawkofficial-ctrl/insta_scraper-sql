import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import { ApprovalMode, DraftReviewAction, DraftStatus } from "../src/generated/prisma/enums";
import {
  createCampaign,
  getCampaignById,
  listCampaigns,
  updateCampaign,
} from "../src/lib/services/campaign/campaign-service";
import { getAutoApprovalEligibility } from "../src/lib/services/drafts/approval-service";
import { createSessionToken } from "../src/lib/services/auth/auth-service";
import { GET as getEligibilityRoute } from "../src/app/api/campaigns/[campaignId]/approval-eligibility/route";
import type {
  CreateCampaignInput,
  UpdateCampaignInput,
  CampaignSummary,
  AutoApprovalEligibility as ClientAutoApprovalEligibility,
} from "../src/lib/api/campaigns";
import { BadRequestError } from "../src/lib/errors";

const prisma = getPrismaClient();

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function main() {
  console.log("=================================================================");
  console.log("  CAMPAIGN APPROVAL MODE UI & API INTEGRATION SUITE              ");
  console.log("=================================================================\n");

  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  // Create test user and company profile
  const user = await prisma.user.create({
    data: {
      email: `approval_ui_${stamp}@example.com`,
      passwordHash: "hash",
      name: "Approval UI Tester",
    },
  });

  const profile = await prisma.companyProfile.create({
    data: {
      userId: user.id,
      name: `Profile_${stamp}`,
      description: "Test profile for approval UI tests",
      services: [{ name: "SaaS consulting" }],
      targetIndustries: ["tech"],
      targetCountries: ["US"],
      messageLanguage: "en",
    },
  });

  // -------------------------------------------------------------------------
  // 1. Campaign creation with custom approval fields
  // -------------------------------------------------------------------------
  console.log("--- 1. Campaign creation with custom approval fields ---");
  const customCampaign = await createCampaign(
    {
      name: `Custom Approval Campaign ${stamp}`,
      companyProfileId: profile.id,
      requireApproval: false,
      approvalMode: "MANUAL",
      autoApproveMinScore: 85,
      qualityMaxRegenerations: 3,
    },
    user.id,
  );

  check(customCampaign.requireApproval === false, "Custom requireApproval persisted as false");
  check(customCampaign.approvalMode === ApprovalMode.MANUAL, "Custom approvalMode persisted as MANUAL");
  check(customCampaign.autoApproveMinScore === 85, "Custom autoApproveMinScore persisted as 85");
  check(customCampaign.qualityMaxRegenerations === 3, "Custom qualityMaxRegenerations persisted as 3");

  // -------------------------------------------------------------------------
  // 2. Campaign creation with default approval fields
  // -------------------------------------------------------------------------
  console.log("\n--- 2. Campaign creation with default approval fields ---");
  const defaultCampaign = await createCampaign(
    {
      name: `Default Approval Campaign ${stamp}`,
      companyProfileId: profile.id,
    },
    user.id,
  );

  check(defaultCampaign.requireApproval === true, "Default requireApproval is true");
  check(defaultCampaign.approvalMode === ApprovalMode.MANUAL, "Default approvalMode is MANUAL");
  check(defaultCampaign.autoApproveMinScore === 80, "Default autoApproveMinScore is 80");
  check(defaultCampaign.qualityMaxRegenerations === 2, "Default qualityMaxRegenerations is 2");

  // -------------------------------------------------------------------------
  // 3. getCampaignById & listCampaigns return all approval fields
  // -------------------------------------------------------------------------
  console.log("\n--- 3. getCampaignById and listCampaigns field resolution ---");
  const fetched = await getCampaignById(customCampaign.id, user.id);
  check(fetched.requireApproval === false, "getCampaignById returns requireApproval");
  check(fetched.approvalMode === ApprovalMode.MANUAL, "getCampaignById returns approvalMode");
  check(fetched.autoApproveMinScore === 85, "getCampaignById returns autoApproveMinScore");
  check(fetched.qualityMaxRegenerations === 3, "getCampaignById returns qualityMaxRegenerations");

  const list = await listCampaigns(user.id);
  const found = list.find((c) => c.id === customCampaign.id);
  check(found !== undefined, "listCampaigns includes created campaign");
  check(found?.requireApproval === false, "listCampaigns returns requireApproval");
  check(found?.approvalMode === ApprovalMode.MANUAL, "listCampaigns returns approvalMode");
  check(found?.autoApproveMinScore === 85, "listCampaigns returns autoApproveMinScore");
  check(found?.qualityMaxRegenerations === 3, "listCampaigns returns qualityMaxRegenerations");

  // -------------------------------------------------------------------------
  // 4. getAutoApprovalEligibility returns correct contract and live state
  // -------------------------------------------------------------------------
  console.log("\n--- 4. Auto-approval eligibility contract and evaluation ---");
  const eligibility = await getAutoApprovalEligibility(defaultCampaign.id);
  check(typeof eligibility.eligible === "boolean", "eligibility.eligible is boolean");
  check(Array.isArray(eligibility.unmet), "eligibility.unmet is array");
  check(typeof eligibility.metrics === "object", "eligibility.metrics is object");
  check(typeof eligibility.metrics.reviewed === "number", "metrics.reviewed is number");
  check(typeof eligibility.metrics.minReviewed === "number", "metrics.minReviewed is number");
  check(typeof eligibility.metrics.approvalRate === "number", "metrics.approvalRate is number");
  check(typeof eligibility.metrics.minApprovalRate === "number", "metrics.minApprovalRate is number");
  check(typeof eligibility.metrics.editRate === "number", "metrics.editRate is number");
  check(typeof eligibility.metrics.maxEditRate === "number", "metrics.maxEditRate is number");
  check(typeof eligibility.metrics.enabled === "boolean", "metrics.enabled is boolean");

  // On a brand-new campaign, eligible is false and unmet reasons are reported
  check(eligibility.eligible === false, "Brand new campaign is not eligible for auto-approval");
  check(
    eligibility.unmet.some((u) => u.startsWith("auto_approval_disabled")),
    "Unmet criteria includes auto_approval_disabled by default",
  );

  // Test with AUTO_APPROVAL_ENABLED=true and AUTO_APPROVE_MIN_REVIEWED=200
  const origEnabled = process.env.AUTO_APPROVAL_ENABLED;
  const origMinRev = process.env.AUTO_APPROVE_MIN_REVIEWED;
  try {
    process.env.AUTO_APPROVAL_ENABLED = "true";
    process.env.AUTO_APPROVE_MIN_REVIEWED = "200";
    const testEligibility = await getAutoApprovalEligibility(defaultCampaign.id);
    check(
      testEligibility.unmet.some((u) => u.startsWith("insufficient_human_reviews")),
      "Unmet criteria includes insufficient human reviews when enabled",
    );
  } finally {
    if (origEnabled !== undefined) process.env.AUTO_APPROVAL_ENABLED = origEnabled;
    else delete process.env.AUTO_APPROVAL_ENABLED;
    if (origMinRev !== undefined) process.env.AUTO_APPROVE_MIN_REVIEWED = origMinRev;
    else delete process.env.AUTO_APPROVE_MIN_REVIEWED;
  }

  // -------------------------------------------------------------------------
  // 5. Updating approval mode to AUTO_ELIGIBLE fails when ineligible
  // -------------------------------------------------------------------------
  console.log("\n--- 5. updateCampaign guard against ineligible AUTO_ELIGIBLE ---");
  let caughtIneligible = false;
  try {
    await updateCampaign(defaultCampaign.id, { approvalMode: "AUTO_ELIGIBLE" }, user.id);
  } catch (err) {
    if (err instanceof BadRequestError && err.code === "AUTO_APPROVAL_NOT_ELIGIBLE") {
      caughtIneligible = true;
    }
  }
  check(caughtIneligible, "updateCampaign rejects AUTO_ELIGIBLE when eligibility is unmet");

  // -------------------------------------------------------------------------
  // 6. Updating approval fields (requireApproval, autoApproveMinScore, regens)
  // -------------------------------------------------------------------------
  console.log("\n--- 6. updateCampaign updates requireApproval and thresholds ---");
  const updatedCampaign = await updateCampaign(
    defaultCampaign.id,
    {
      requireApproval: false,
      autoApproveMinScore: 92,
      qualityMaxRegenerations: 4,
    },
    user.id,
  );
  check(updatedCampaign.requireApproval === false, "updateCampaign updated requireApproval to false");
  check(updatedCampaign.autoApproveMinScore === 92, "updateCampaign updated autoApproveMinScore to 92");
  check(updatedCampaign.qualityMaxRegenerations === 4, "updateCampaign updated qualityMaxRegenerations to 4");

  // Switching back to requireApproval: true and MANUAL works smoothly
  const switchedBack = await updateCampaign(
    defaultCampaign.id,
    {
      requireApproval: true,
      approvalMode: "MANUAL",
    },
    user.id,
  );
  check(switchedBack.requireApproval === true, "Switched requireApproval back to true");
  check(switchedBack.approvalMode === ApprovalMode.MANUAL, "Switched approvalMode back to MANUAL");

  // -------------------------------------------------------------------------
  // 7. Input bounds validation on update
  // -------------------------------------------------------------------------
  console.log("\n--- 7. Input validation bounds ---");
  let caughtMinScoreLow = false;
  try {
    await updateCampaign(defaultCampaign.id, { autoApproveMinScore: -1 }, user.id);
  } catch (err) {
    if (err instanceof BadRequestError && err.code === "INVALID_AUTO_APPROVE_MIN_SCORE") {
      caughtMinScoreLow = true;
    }
  }
  check(caughtMinScoreLow, "Rejects autoApproveMinScore < 0");

  let caughtMinScoreHigh = false;
  try {
    await updateCampaign(defaultCampaign.id, { autoApproveMinScore: 101 }, user.id);
  } catch (err) {
    if (err instanceof BadRequestError && err.code === "INVALID_AUTO_APPROVE_MIN_SCORE") {
      caughtMinScoreHigh = true;
    }
  }
  check(caughtMinScoreHigh, "Rejects autoApproveMinScore > 100");

  let caughtRegensHigh = false;
  try {
    await updateCampaign(defaultCampaign.id, { qualityMaxRegenerations: 6 }, user.id);
  } catch (err) {
    if (err instanceof BadRequestError && err.code === "INVALID_QUALITY_MAX_REGENERATIONS") {
      caughtRegensHigh = true;
    }
  }
  check(caughtRegensHigh, "Rejects qualityMaxRegenerations > 5");

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  console.log("\n--- Cleanup ---");
  await prisma.campaign.deleteMany({
    where: { id: { in: [customCampaign.id, defaultCampaign.id] } },
  });
  await prisma.companyProfile.deleteMany({
    where: { id: profile.id },
  });
  await prisma.user.deleteMany({
    where: { id: user.id },
  });
  console.log("  Cleaned up test data.");

  console.log("\n=================================================================");
  console.log(` PASSED: ${passed} | FAILED: ${failed}`);
  console.log("=================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled test error:", err);
  process.exit(1);
});
