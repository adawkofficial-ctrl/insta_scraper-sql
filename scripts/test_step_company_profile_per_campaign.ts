import "./preload_server_only.cjs";
import "dotenv/config";
import assert from "node:assert/strict";
import { getPrismaClient } from "../src/lib/db/prisma";
import { Prisma } from "../src/generated/prisma/client";
import {
  listCompanyProfiles,
  getCompanyProfileRecordById,
  createCompanyProfile,
  updateCompanyProfile,
  deleteCompanyProfile,
  resolveCompanyProfileForCampaign,
  requireCompleteCompanyProfile,
  getCompanyProfileCompleteness,
} from "../src/lib/services/company-profile/company-profile-service";
import { createCampaign } from "../src/lib/services/campaign/campaign-service";
import { runQualityChecks } from "../src/lib/services/quality/runner";
import { QualityContext } from "../src/lib/services/quality/types";
import { CompanyProfileIncompleteError, BadRequestError } from "../src/lib/errors";

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
  console.log("  COMPANY PROFILE PER CAMPAIGN SUITE (PARTS F.1 - F.5)           ");
  console.log("=================================================================\n");

  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  const user = await prisma.user.create({
    data: {
      email: `cmp_user_${stamp}@example.com`,
      passwordHash: "x",
      name: "Campaign Profile Tester",
    },
  });

  const completeDataA = {
    name: "Dental Clinic Profile",
    description: "Modern dental implants and teeth whitening for clinics.",
    services: [{ name: "teeth whitening", description: "cosmetic whitening" }],
    targetIndustries: ["healthcare", "dental"],
    targetCountries: ["US"],
    idealCustomerProfile: "Private dental practice owners",
    brandTone: "professional and empathetic",
    messageLanguage: "en",
    preferredLength: { minWords: 15, maxWords: 50 },
    ctaStyle: "soft invitation",
    pricingPolicy: "quote after consultation",
    forbiddenClaims: ["miracle cure", "cure all ills"],
  };

  const completeDataB = {
    name: "Fitness Studio Profile",
    description: "Growth partner for boutique fitness and yoga studios.",
    services: [{ name: "membership acquisition", description: "fill classes" }],
    targetIndustries: ["fitness", "wellness"],
    targetCountries: ["US", "CA"],
    idealCustomerProfile: "Studio owners with 2+ locations",
    brandTone: "energetic and direct",
    messageLanguage: "en",
    preferredLength: { minWords: 15, maxWords: 50 },
    ctaStyle: "direct call to action",
    pricingPolicy: "tiered monthly subscriptions",
    forbiddenClaims: ["guaranteed wealth", "free trial forever"],
  };

  try {
    // -------------------------------------------------------------
    // F.1: Multiple profiles per user CRUD & delete blocking
    // -------------------------------------------------------------
    console.log("[F.1] Multiple profiles per user CRUD & delete blocking");

    const profileA = await createCompanyProfile(user.id, completeDataA);
    check(profileA.name === "Dental Clinic Profile", "Profile A created");
    check(profileA.isDefault === true, "Profile A isDefault is true (first profile for user)");

    const profileB = await createCompanyProfile(user.id, { ...completeDataB, isDefault: true });
    check(profileB.name === "Fitness Studio Profile", "Profile B created");
    check(profileB.isDefault === true, "Profile B isDefault is true");

    const list = await listCompanyProfiles(user.id);
    check(list.length === 2, "User has exactly 2 profiles listed");
    check(list.some((item) => item.profile.name === "Dental Clinic Profile"), "List includes Profile A");
    check(list.some((item) => item.profile.name === "Fitness Studio Profile"), "List includes Profile B");

    const updatedA = await updateCompanyProfile(user.id, profileA.id, {
      name: "Advanced Dental Solutions",
    });
    check(updatedA.name === "Advanced Dental Solutions", "Profile A name updated");

    // Create campaign using profile A
    const campA = await createCampaign(
      {
        name: `Dental Outreach ${stamp}`,
        companyProfileId: profileA.id,
      },
      user.id,
    );
    check(campA.companyProfileId === profileA.id, "Campaign created referencing Profile A");

    // Block delete when referenced
    let deleteBlocked = false;
    let errorDetail = "";
    try {
      await deleteCompanyProfile(user.id, profileA.id);
    } catch (err: any) {
      deleteBlocked = err instanceof BadRequestError && err.code === "PROFILE_IN_USE";
      errorDetail = err.message;
    }
    check(deleteBlocked, "deleteCompanyProfile blocked when profile is in use by campaign");
    check(errorDetail.includes(campA.name), "deleteCompanyProfile error mentions referencing campaign");

    // Delete campaign and now delete profile A should succeed
    await prisma.campaign.delete({ where: { id: campA.id } });
    const deleteRes = await deleteCompanyProfile(user.id, profileA.id);
    check(deleteRes.success && deleteRes.deletedId === profileA.id, "deleteCompanyProfile succeeds when unreferenced");

    const listAfterDelete = await listCompanyProfiles(user.id);
    check(listAfterDelete.length === 1 && listAfterDelete[0].profile.id === profileB.id, "Only Profile B remains");

    // Recreate Profile A for subsequent tests
    const recreatedProfileA = await createCompanyProfile(user.id, completeDataA);

    // -------------------------------------------------------------
    // F.2: Campaign creation with existing profile vs inline-created profile
    // -------------------------------------------------------------
    console.log("\n[F.2] Campaign creation with existing vs inline profile");

    // (a) Existing profile
    const campWithExisting = await createCampaign(
      {
        name: `Camp Existing ${stamp}`,
        companyProfileId: recreatedProfileA.id,
      },
      user.id,
    );
    check(campWithExisting.companyProfileId === recreatedProfileA.id, "Campaign created with existing profile");

    // (b) Inline created profile
    const campWithInline = await createCampaign(
      {
        name: `Camp Inline ${stamp}`,
        companyProfile: {
          name: "Real Estate Partners",
          description: "Listing acquisition software for realtors.",
          services: [{ name: "lead generation" }],
          targetIndustries: ["real estate"],
          targetCountries: ["US"],
          brandTone: "concise",
          messageLanguage: "en",
          ctaStyle: "question",
          pricingPolicy: "per-close fee",
          preferredLength: { minWords: 10, maxWords: 40 },
        },
      },
      user.id,
    );
    check(typeof campWithInline.companyProfileId === "string", "Inline profile creates new companyProfileId");
    check(campWithInline.companyProfileId !== recreatedProfileA.id, "Inline profile is a distinct new profile");

    const inlineProfileRecord = await getCompanyProfileRecordById(campWithInline.companyProfileId, user.id);
    check(inlineProfileRecord?.name === "Real Estate Partners", "Inline profile stored with expected name");

    // -------------------------------------------------------------
    // F.3: Gemini context and quality checks isolation across campaigns
    // -------------------------------------------------------------
    console.log("\n[F.3] Campaign profile isolation in Gemini context & Quality checks");

    // Campaign 1 uses recreatedProfileA (forbidden: "miracle cure")
    const campaign1 = await createCampaign(
      {
        name: `Camp 1 Isolation ${stamp}`,
        companyProfileId: recreatedProfileA.id,
      },
      user.id,
    );

    // Campaign 2 uses profileB (forbidden: "guaranteed wealth")
    const campaign2 = await createCampaign(
      {
        name: `Camp 2 Isolation ${stamp}`,
        companyProfileId: profileB.id,
      },
      user.id,
    );

    const resolvedCamp1 = await resolveCompanyProfileForCampaign(campaign1.id, user.id);
    const resolvedCamp2 = await resolveCompanyProfileForCampaign(campaign2.id, user.id);
    assert(resolvedCamp1, "resolvedCamp1 must exist");
    assert(resolvedCamp2, "resolvedCamp2 must exist");

    check(
      resolvedCamp1.forbiddenClaims.includes("miracle cure"),
      "Campaign 1 resolves Profile A forbidden claims",
    );
    check(
      !resolvedCamp1.forbiddenClaims.includes("guaranteed wealth"),
      "Campaign 1 does NOT have Profile B forbidden claims",
    );
    check(
      resolvedCamp2.forbiddenClaims.includes("guaranteed wealth"),
      "Campaign 2 resolves Profile B forbidden claims",
    );
    check(
      !resolvedCamp2.forbiddenClaims.includes("miracle cure"),
      "Campaign 2 does NOT have Profile A forbidden claims",
    );

    // Test Quality Check FORBIDDEN_CLAIMS rule isolation
    function makeContext(campId: string, profileDto: any, bodyText: string): QualityContext {
      return {
        draft: {
          id: `draft_${Date.now()}`,
          body: bodyText,
          generatedBody: bodyText,
          promptVersion: "draft-v1",
          personalizationPointsUsed: ["teeth whitening"],
        },
        lead: {
          id: `lead_${Date.now()}`,
          campaignId: campId,
          username: "test_dr_smith",
          fullName: "Dr. Smith",
          biography: "Dental clinic and oral care specialist in NY",
          category: "Dentist",
          businessCategoryName: "Dentist",
          location: "New York",
          status: "QUALIFIED",
          aiStatus: "DONE",
          leadScore: 90,
          duplicateOfLeadId: null,
          targetNiche: "dental",
          personalizationPoints: ["teeth whitening"],
          hasPostContext: false,
        },
        campaign: {
          id: campId,
          aiQualificationEnabled: true,
          messageLanguage: "en",
        },
        company: {
          name: profileDto.name,
          description: profileDto.description,
          services: profileDto.services.map((s: any) => s.name),
          forbiddenClaims: profileDto.forbiddenClaims,
          preferredLength: profileDto.preferredLength,
          pricingPolicy: profileDto.pricingPolicy,
          brandTone: profileDto.brandTone,
          messageLanguage: profileDto.messageLanguage,
          rawText: `${profileDto.name} ${profileDto.description}`,
        },
        suppression: {
          suppressed: false,
          matchedIdentifierTypes: [],
        },
        previouslyContacted: false,
        history: {
          exactDuplicateBodies: [],
          recentOutboundTexts: [],
          recentCampaignOpeners: [],
        },
      };
    }

    // Message containing Campaign 1's forbidden claim ("miracle cure")
    const draftWithMiracleCure = "Hello Dr. Smith, noticed your clinic. Our teeth whitening is a miracle cure for stained teeth! Would you be open to chatting?";

    // Evaluated under Campaign 1 context
    const checkUnderCamp1 = runQualityChecks(makeContext(campaign1.id, resolvedCamp1, draftWithMiracleCure));
    const camp1HasForbiddenBlocker = checkUnderCamp1.blockers.some((b) => b.id === "FORBIDDEN_CLAIMS");
    check(camp1HasForbiddenBlocker, "Campaign 1 blocks draft containing 'miracle cure'");

    // Evaluated under Campaign 2 context
    const checkUnderCamp2 = runQualityChecks(makeContext(campaign2.id, resolvedCamp2, draftWithMiracleCure));
    const camp2HasForbiddenBlocker = checkUnderCamp2.blockers.some((b) => b.id === "FORBIDDEN_CLAIMS");
    check(!camp2HasForbiddenBlocker, "Campaign 2 ALLOWS same draft because 'miracle cure' is not in its profile");

    // Message containing Campaign 2's forbidden claim ("guaranteed wealth")
    const draftWithGuaranteedWealth = "Hello, noticed your clinic. Our studio system leads to guaranteed wealth and revenue! Would you like a preview?";

    const checkWealthCamp1 = runQualityChecks(makeContext(campaign1.id, resolvedCamp1, draftWithGuaranteedWealth));
    check(!checkWealthCamp1.blockers.some((b) => b.id === "FORBIDDEN_CLAIMS"), "Campaign 1 ALLOWS draft with 'guaranteed wealth'");

    const checkWealthCamp2 = runQualityChecks(makeContext(campaign2.id, resolvedCamp2, draftWithGuaranteedWealth));
    check(checkWealthCamp2.blockers.some((b) => b.id === "FORBIDDEN_CLAIMS"), "Campaign 2 BLOCKS draft with 'guaranteed wealth'");

    // -------------------------------------------------------------
    // F.4: Completeness gate is scoped per-campaign-profile
    // -------------------------------------------------------------
    console.log("\n[F.4] Completeness gate is strictly per-campaign-profile");

    // Create an incomplete profile for user
    const incompleteProfile = await createCompanyProfile(user.id, {
      name: "Incomplete Marketing Profile",
      description: "Only has name and description",
      services: [],
    });

    const campIncomplete = await createCampaign(
      {
        name: `Camp Incomplete ${stamp}`,
        companyProfileId: incompleteProfile.id,
      },
      user.id,
    );

    // Check complete campaign
    let completePassed = false;
    try {
      const resolved = await requireCompleteCompanyProfile({
        campaignId: campaign1.id,
        userId: user.id,
      });
      completePassed = resolved.id === recreatedProfileA.id;
    } catch {}
    check(completePassed, "requireCompleteCompanyProfile succeeds for Campaign 1 (complete profile)");

    // Check incomplete campaign
    let incompleteBlocked = false;
    let missingList: string[] = [];
    try {
      await requireCompleteCompanyProfile({
        campaignId: campIncomplete.id,
        userId: user.id,
      });
    } catch (err) {
      if (err instanceof CompanyProfileIncompleteError) {
        incompleteBlocked = true;
        missingList = err.missingFields;
      }
    }
    check(incompleteBlocked, "requireCompleteCompanyProfile blocks Campaign with incomplete profile");
    check(missingList.includes("services"), "Missing fields accurately include services");
    check(missingList.includes("targetIndustries"), "Missing fields accurately include targetIndustries");

    // -------------------------------------------------------------
    // F.5: Backfill migration verification
    // -------------------------------------------------------------
    console.log("\n[F.5] Database backfill verification");

    const totalCampaigns = await prisma.campaign.count();
    const nullRows = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT count(*) as count FROM "Campaign" WHERE "companyProfileId" IS NULL`,
    );
    const nullCampaigns = Number(nullRows[0]?.count ?? 0);

    const unlinkedRows = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT count(*) as count FROM "Campaign" c LEFT JOIN "CompanyProfile" p ON c."companyProfileId" = p."id" WHERE p."id" IS NULL`,
    );
    const unlinkedCampaigns = Number(unlinkedRows[0]?.count ?? 0);

    check(totalCampaigns > 0, `Database has ${totalCampaigns} total campaigns`);
    check(nullCampaigns === 0, "Zero campaigns have null companyProfileId");
    check(unlinkedCampaigns === 0, "Zero campaigns have missing/unlinked companyProfile relation");

    // Cleanup test data
    await prisma.campaign.deleteMany({ where: { userId: user.id } });
    await prisma.companyProfile.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });

  } catch (error) {
    console.error("Test execution failed:", error);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");

  if (failed > 0) process.exit(1);
}

main();
