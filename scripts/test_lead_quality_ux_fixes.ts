import "./preload_server_only.cjs";
import "dotenv/config";
import assert from "node:assert/strict";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  checkNameWebsiteMismatch,
  extractDomainParts,
  extractSignificantNameTokens,
} from "../src/lib/services/discovery/name-website-matcher";
import {
  clusterMultiLocationGroups,
  resolveSingleGroupKey,
  isLocationEmailPrefix,
} from "../src/lib/services/discovery/group-detector";
import { computeLeadScore } from "../src/lib/services/discovery/lead-quality-score";
import { canSendNow, reserveSendSlot } from "../src/lib/services/messaging/send-gate";
import { sendSingleMessage } from "../src/lib/services/messaging/messaging-service";
import { enrichLeadHandleWaterfall, HANDLE_ENRICHMENT_COOLDOWN_DAYS } from "../src/lib/services/scraper/profile-enrichment-service";
import { MessageStatus, InstagramSenderStatus } from "@/generated/prisma/client";
import { scoreFlagCreate, withLeadChannelFlags } from "../src/lib/services/lead/lead-channels";

async function main() {
  console.log("=================================================================");
  console.log("   TEST SUITE: LEAD QUALITY & UX FIXES (TORONTO DENTAL)          ");
  console.log("=================================================================\n");

  const prisma = getPrismaClient();

  // ---------------------------------------------------------------------------
  // 1. Name / Website Domain & Header Mismatch Tests (STEP 2)
  // ---------------------------------------------------------------------------
  console.log("[1. Name / Website Mismatch Unit Tests]");

  // Test 1.1: Mantra Dental vs everbrightsmiles.ca -> flag
  const mantraRes = checkNameWebsiteMismatch({
    businessName: "Mantra Dental",
    websiteUrl: "https://everbrightsmiles.ca",
    homepageTitle: "Everbright Smiles Dental Care",
    homepageH1: "Welcome to Everbright Smiles",
  });
  assert(mantraRes.isMismatch === true, "Mantra Dental vs everbrightsmiles.ca must be flagged as mismatch");
  assert(mantraRes.flag === "NAME_WEBSITE_MISMATCH", "Flag must be NAME_WEBSITE_MISMATCH");
  console.log("  PASS: 'Mantra Dental' vs everbrightsmiles.ca is flagged (NAME_WEBSITE_MISMATCH)");

  // Test 1.2: Summer Breeze Dental Scarborough vs summerbreezedental.com -> no flag
  const summerBreezeRes = checkNameWebsiteMismatch({
    businessName: "Summer Breeze Dental Scarborough",
    websiteUrl: "https://summerbreezedental.com",
  });
  assert(summerBreezeRes.isMismatch === false, "Summer Breeze Dental Scarborough vs summerbreezedental.com must NOT be flagged");
  assert(summerBreezeRes.flag === null, "Flag must be null when matched");
  console.log("  PASS: 'Summer Breeze Dental Scarborough' vs summerbreezedental.com is not flagged");

  // Test 1.3: Morningside Dental Care vs morningsidedentalcare.ca -> no flag
  const morningsideRes = checkNameWebsiteMismatch({
    businessName: "Morningside Dental Care",
    websiteUrl: "https://morningsidedentalcare.ca",
  });
  assert(morningsideRes.isMismatch === false, "Morningside Dental Care vs morningsidedentalcare.ca must NOT be flagged");
  assert(morningsideRes.flag === null, "Flag must be null when matched");
  console.log("  PASS: 'Morningside Dental Care' vs morningsidedentalcare.ca is not flagged");

  // Test 1.4: Domain has no token overlap, but homepage Title contains business name
  const titleMatchRes = checkNameWebsiteMismatch({
    businessName: "Royal Oak Dental",
    websiteUrl: "https://ro-clinic.ca",
    homepageTitle: "Royal Oak Dental - Family & Cosmetic Dentistry",
    homepageH1: "Welcome to Royal Oak Dental",
  });
  assert(titleMatchRes.isMismatch === false, "Homepage title containing business name clears mismatch");
  console.log("  PASS: Homepage title containing name prevents false-positive mismatch");

  // ---------------------------------------------------------------------------
  // 2. Multi-Location Group Detection (STEP 3)
  // ---------------------------------------------------------------------------
  console.log("\n[2. Multi-Location Group Detection Unit Tests]");

  // Test 2.1: Location email prefix detection
  assert(isLocationEmailPrefix("ajax") === true, "ajax prefix indicates location branch");
  assert(isLocationEmailPrefix("oshawa") === true, "oshawa prefix indicates location branch");
  assert(isLocationEmailPrefix("toronto") === true, "toronto prefix indicates location branch");
  assert(isLocationEmailPrefix("info") === false, "info prefix is generic");
  console.log("  PASS: Location email prefix detection (ajax@, oshawa@, toronto@)");

  // Test 2.2: Single place with location email is recognized as group
  const byTheLakePlace = {
    id: "place-1",
    fullName: "By The Lake Dental - Ajax",
    website: "https://bythelakedental.com",
    username: "bythelakedental",
    email: "ajax@bythelakedental.com",
  };
  const singleKey = resolveSingleGroupKey(byTheLakePlace);
  assert(singleKey.hasLocationEmail === true, "Location email detected for By The Lake Dental");
  assert(singleKey.groupKey === "domain:bythelakedental.com", "Group key matches domain");

  // Test 2.3: Two places sharing one domain or handle clustered as group
  const placeA = {
    id: "pA",
    fullName: "By The Lake Dental - Toronto",
    website: "https://bythelakedental.com",
    username: "bythelakedental",
    email: "toronto@bythelakedental.com",
  };
  const placeB = {
    id: "pB",
    fullName: "By The Lake Dental - Ajax",
    website: "https://bythelakedental.com",
    username: "bythelakedental",
    email: "ajax@bythelakedental.com",
  };
  const placeC = {
    id: "pC",
    fullName: "Independent Clinic",
    website: "https://independent-clinic.ca",
    username: "independentclinic",
    email: "hello@independent-clinic.ca",
  };

  const clusters = clusterMultiLocationGroups([placeA, placeB, placeC]);
  const outcomeA = clusters.get(placeA);
  const outcomeB = clusters.get(placeB);
  const outcomeC = clusters.get(placeC);

  assert(outcomeA?.isGroup === true, "Place A sharing domain is marked isGroup=true");
  assert(outcomeA?.groupKey === "domain:bythelakedental.com", "Place A groupKey is domain:bythelakedental.com");
  assert(outcomeB?.isGroup === true, "Place B sharing domain is marked isGroup=true");
  assert(outcomeC?.isGroup === false, "Place C is an independent single location (isGroup=false)");
  console.log("  PASS: Two Maps places sharing one domain clustered as multi-location group");

  // ---------------------------------------------------------------------------
  // 3. Lead Quality Scoring & Tier Capping for No-Handle Leads (STEP 1)
  // ---------------------------------------------------------------------------
  console.log("\n[3. Scoring & Tier Capping for No-Handle Leads]");

  const noHandleMapsClinic = {
    rating: 4.8,
    reviewCount: 350,
    website: "https://summerbreezedental.com",
    phone: "+1 416-490-8446",
    isClaimed: true,
    isChain: false,
    hasInstagram: false, // NO IG HANDLE
    email: null,
    availableChannels: ["PHONE", "WHATSAPP", "WEBSITE"],
  };

  const scoreResult = computeLeadScore(noHandleMapsClinic);
  assert(scoreResult.score === 85, `Score is preserved at 85 (got ${scoreResult.score})`);
  assert(scoreResult.tier === "B", `Tier is capped at B for Instagram campaign (got ${scoreResult.tier})`);
  assert(scoreResult.flags.includes("IG_UNKNOWN"), "Flags include IG_UNKNOWN");

  // With handle found, score reaches Tier A
  const withHandleResult = computeLeadScore({
    ...noHandleMapsClinic,
    hasInstagram: true,
    followers: 2500,
    isBusinessAccount: true,
    lastPostAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    postsCount: 120,
  });
  assert(withHandleResult.tier === "A", "With handle found, clinic qualifies for Tier A");
  console.log("  PASS: Score 85 preserved, flag 'IG_UNKNOWN' set, tier capped at B for no-handle leads");

  // ---------------------------------------------------------------------------
  // 4. Handle Waterfall 7-Day Cooldown (STEP 1)
  // ---------------------------------------------------------------------------
  console.log("\n[4. Handle Waterfall & 7-Day Cooldown Tests]");

  const mockLeadNoWebsite = {
    id: "lead-no-site",
    fullName: "Clinic Without Website",
    website: null,
  };
  const noSiteRes = await enrichLeadHandleWaterfall(mockLeadNoWebsite, prisma);
  assert(noSiteRes.outcome === "no_website", "Lead without website returns no_website outcome");

  const mockLeadRecentEnrichment = {
    id: "lead-recent",
    fullName: "Summer Breeze Dental",
    website: "https://summerbreezedental.com",
    lastHandleEnrichmentAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
  };
  const cooldownRes = await enrichLeadHandleWaterfall(mockLeadRecentEnrichment, prisma);
  assert(cooldownRes.outcome === "cooldown", "Waterfall within 7 days is blocked by cooldown");
  assert(cooldownRes.message.includes("cooldown"), "Cooldown message returned");
  console.log("  PASS: 7-day cooldown prevents repeat waterfall requests");

  // ---------------------------------------------------------------------------
  // 5. DB & Send Path Blocking for No-Handle Leads & Group Dedup (STEP 1 & 3)
  // ---------------------------------------------------------------------------
  console.log("\n[5. Outbound Send Path & Group Dedup Tests]");

  // Create isolated test campaign and user
  const testUser = await prisma.user.create({
    data: {
      email: `test_quality_${Date.now()}@example.com`,
      passwordHash: "mock_hash",
      name: "Test Quality User",
    },
  });

  const companyProfile = await prisma.companyProfile.create({
    data: {
      userId: testUser.id,
      name: "Test Practice",
      targetIndustries: ["Dentistry"],
    },
  });

  const testCampaign = await prisma.campaign.create({
    data: {
      userId: testUser.id,
      companyProfileId: companyProfile.id,
      name: `Toronto Dental Quality Test ${Date.now()}`,
      intent: "cosmetic dentistry",
      location: "Toronto, ON",
    },
  });

  const testSender = await prisma.instagramSenderAccount.create({
    data: {
      userId: testUser.id,
      username: `sender_${Date.now()}`,
      status: InstagramSenderStatus.CONNECTED,
      dailyCap: 25,
      hourlyCap: 6,
      sentToday: 0,
      sentTodayDate: new Date().toISOString().slice(0, 10),
      sessionPath: "mock_session_path",
    },
  });

  // Create a lead WITHOUT Instagram handle
  const noHandleLead = await prisma.lead.create({
    data: {
      campaignId: testCampaign.id,
      userId: testUser.id,
      fullName: "Mantra Dental",
      website: "https://everbrightsmiles.ca",
      phone: "+1 416-754-9696",
      username: null,
      usernameNormalized: null,
      ...withLeadChannelFlags(["PHONE", "WHATSAPP", "WEBSITE"]),
      qualityScore: 85,
      qualityTier: "B",
      scoreFlags: scoreFlagCreate(["IG_UNKNOWN", "NAME_WEBSITE_MISMATCH"]),
    },
  });

  // Test 5.1: canSendNow blocks no-handle lead
  const canSendResult = await canSendNow({
    senderAccountId: testSender.id,
    leadId: noHandleLead.id,
    campaignId: testCampaign.id,
  });
  assert(canSendResult.allowed === false, "canSendNow must block lead with no handle");
  assert(canSendResult.reason === "NO_INSTAGRAM_HANDLE", `Reason must be NO_INSTAGRAM_HANDLE (got ${canSendResult.reason})`);
  console.log("  PASS: canSendNow rejects lead without Instagram handle");

  // Test 5.2: reserveSendSlot blocks no-handle lead
  const reserveResult = await reserveSendSlot({
    senderAccountId: testSender.id,
    leadId: noHandleLead.id,
    campaignId: testCampaign.id,
  });
  assert(reserveResult.allowed === false, "reserveSendSlot must block lead with no handle");
  assert(reserveResult.reason === "NO_INSTAGRAM_HANDLE", "reserveSendSlot reason is NO_INSTAGRAM_HANDLE");
  console.log("  PASS: reserveSendSlot rejects lead without Instagram handle");

  // Test 5.3: sendSingleMessage throws BadRequestError NO_INSTAGRAM_CHANNEL
  let sendError: unknown = null;
  try {
    await sendSingleMessage({
      leadId: noHandleLead.id,
      senderAccountId: testSender.id,
      messageText: "Hi, reaching out about your dental practice!",
      campaignId: testCampaign.id,
      userId: testUser.id,
    });
  } catch (err) {
    sendError = err;
  }
  assert(sendError !== null, "sendSingleMessage must throw for no-handle lead");
  assert(
    (sendError as { code?: string }).code === "NO_INSTAGRAM_CHANNEL",
    `Error code must be NO_INSTAGRAM_CHANNEL (got ${(sendError as { code?: string }).code})`,
  );
  console.log("  PASS: sendSingleMessage throws NO_INSTAGRAM_CHANNEL for no-handle lead");

  // Test 5.4: Multi-location Group Dedup Outreach
  // Two places sharing one domain/handle:
  const groupLead1 = await prisma.lead.create({
    data: {
      campaignId: testCampaign.id,
      userId: testUser.id,
      fullName: "By The Lake Dental Toronto",
      username: "bythelakedental",
      usernameNormalized: "bythelakedental",
      website: "https://bythelakedental.com",
      email: "toronto@bythelakedental.com",
      isGroup: true,
      groupKey: "domain:bythelakedental.com",
      ...withLeadChannelFlags(["INSTAGRAM", "EMAIL", "PHONE"]),
      qualityScore: 94,
      qualityTier: "A",
    },
  });

  const groupLead2 = await prisma.lead.create({
    data: {
      campaignId: testCampaign.id,
      userId: testUser.id,
      fullName: "By The Lake Dental Ajax",
      username: "bythelakedental",
      usernameNormalized: "bythelakedental",
      website: "https://bythelakedental.com",
      email: "ajax@bythelakedental.com",
      isGroup: true,
      groupKey: "domain:bythelakedental.com",
      ...withLeadChannelFlags(["INSTAGRAM", "EMAIL", "PHONE"]),
      qualityScore: 94,
      qualityTier: "A",
    },
  });

  // First lead in group can send
  const group1Check = await canSendNow({
    senderAccountId: testSender.id,
    leadId: groupLead1.id,
    campaignId: testCampaign.id,
    bypassGapCheck: true,
    bypassWorkingHours: true,
  });
  assert(group1Check.allowed === true, `Group lead 1 is allowed to send (reason: ${group1Check.reason})`);

  // Record an outbound sent message for group lead 1
  await prisma.message.create({
    data: {
      campaignId: testCampaign.id,
      leadId: groupLead1.id,
      senderAccountId: testSender.id,
      messageText: "Hello By The Lake Dental Toronto!",
      status: MessageStatus.SENT,
      direction: "OUTBOUND",
      sentAt: new Date(),
    },
  });

  // Second lead from the SAME group in the SAME campaign must now be BLOCKED by group dedup!
  const group2Check = await canSendNow({
    senderAccountId: testSender.id,
    leadId: groupLead2.id,
    campaignId: testCampaign.id,
    bypassGapCheck: true,
    bypassWorkingHours: true,
  });
  assert(group2Check.allowed === false, "Second lead in same group must be blocked");
  assert(
    group2Check.reason === "GROUP_ALREADY_CONTACTED",
    `Second lead must be blocked with GROUP_ALREADY_CONTACTED (got ${group2Check.reason})`,
  );
  console.log("  PASS: Group dedup allows only ONE outreach message per group per campaign");

  // Cleanup test DB rows
  await prisma.message.deleteMany({ where: { campaignId: testCampaign.id } });
  await prisma.lead.deleteMany({ where: { campaignId: testCampaign.id } });
  await prisma.instagramSenderAccount.delete({ where: { id: testSender.id } });
  await prisma.campaign.delete({ where: { id: testCampaign.id } });
  await prisma.companyProfile.delete({ where: { id: companyProfile.id } });
  await prisma.user.delete({ where: { id: testUser.id } });

  console.log("\n=================================================================");
  console.log("   ALL LEAD QUALITY & UX TESTS PASSED SUCCESSFULLY!             ");
  console.log("=================================================================\n");
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});

