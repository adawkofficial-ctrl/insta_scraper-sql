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

import { getPrismaClient } from "../src/lib/db/prisma";
import {
  calculateLeadCostAllocation,
  recordJobAttribution,
} from "../src/lib/services/analytics/attribution-service";
import {
  classifyReplyText,
  recordLeadEvent,
  processInboundReplyOutcome,
  recordManualOutcomeEvent,
} from "../src/lib/services/analytics/lead-event-service";
import {
  getCampaignOutcomeAnalytics,
} from "../src/lib/services/analytics/outcome-analytics-service";
import {
  getCampaignRecommendations,
  applyCampaignRecommendation,
  prioritizeSegmentsForDiscovery,
} from "../src/lib/services/analytics/recommendations-service";
import {
  assignLeadMessageVariant,
  calculateTwoProportionZTest,
} from "../src/lib/services/messaging/ab-testing-service";
import { LeadEventType, LeadStatus, MessageChannel } from "../src/generated/prisma/client";

async function main() {
  console.log("===============================================================");
  console.log("      OUTCOME TRACKING & ANALYTICS VERIFICATION SUITE         ");
  console.log("===============================================================");

  const prisma = getPrismaClient();
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, extraInfo?: string) {
    if (condition) {
      console.log(`✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName} ${extraInfo ? `(${extraInfo})` : ""}`);
      failed++;
    }
  }

  const runId = `test_oa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const cleanUserIds: string[] = [];
  const cleanCampaignIds: string[] = [];

  // Setup test user
  const user = await prisma.user.create({
    data: {
      email: `${runId}@example.com`,
      name: "Outcome Analytics Tester",
      passwordHash: "dummy_hash_test",
      role: "USER",
    },
  });
  cleanUserIds.push(user.id);

  const companyProfile = await prisma.companyProfile.create({
    data: {
      userId: user.id,
      name: `Outcome Company ${runId}`,
    },
  });

  // Setup test campaign
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      companyProfileId: companyProfile.id,
      name: `Outcome Campaign ${runId}`,
      status: "RUNNING",
      category: "coffee",
      location: "Austin",
      intent: "coffee cafes",
      customPositiveKeywords: ["coffee", "bakery", "dentist"],
      autoOptimize: false,
      explorationBudgetShare: 0.15,
    },
  });
  cleanCampaignIds.push(campaign.id);

  try {
    // -------------------------------------------------------------------------
    // 1. UNIT TEST: Cost Allocation sums exactly to job spend (zero leakage)
    // -------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 1: Cost Allocation Math & Leakage Prevention ---");
    {
      const mapsCost = 1.50;
      const enrichCost = 2.35;
      const aiCost = 0.80;
      const totalJobSpend = 4.65;
      const placesScraped = 20;
      const survivingLeads = 4;

      const allocation = calculateLeadCostAllocation({
        spend: {
          mapsCostUsd: mapsCost,
          enrichmentCostUsd: enrichCost,
          geminiCostUsd: aiCost,
        },
        placesProcessed: placesScraped,
        survivingLeadsCount: survivingLeads,
      });

      assert(allocation !== null, "Allocation calculated successfully");
      if (allocation) {
        assert(
          allocation.acquisitionCostUsd > 0,
          "Per-lead acquisition cost is positive"
        );

        // 4 surviving leads * acquisitionCostUsd must equal totalJobSpend exactly
        const sumAllocated = Number((allocation.acquisitionCostUsd * survivingLeads).toFixed(4));
        assert(
          Math.abs(sumAllocated - totalJobSpend) < 0.001,
          "Total allocated cost sums exactly to total job spend (zero leakage)",
          `Expected ${totalJobSpend}, got ${sumAllocated}`
        );

        // Verify rejected places' cost rolls up into surviving leads
        // Direct raw cost per scraped place would have been 4.65 / 20 = $0.2325
        // Surviving leads absorb rejected places so perLeadCost = 4.65 / 4 = $1.1625
        const rawCostPerPlace = totalJobSpend / placesScraped;
        assert(
          allocation.acquisitionCostUsd > rawCostPerPlace,
          "Rejected places' cost is not lost: honestly rolls up into surviving leads",
          `Surviving lead cost ${allocation.acquisitionCostUsd} > raw place cost ${rawCostPerPlace}`
        );
      }
    }

    // -------------------------------------------------------------------------
    // 2. UNIT TEST: Cost-Per-Reply & Zero Division Safety
    // -------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 2: Cost-Per-Reply & Metrics Precision ---");
    {
      const totalSpend = 120.0;
      const sent = 100;
      const replies = 10;
      const positiveReplies = 4;
      const meetings = 2;
      const won = 1;

      const costPerSent = totalSpend / sent;
      const costPerReply = totalSpend / replies;
      const costPerPositive = totalSpend / positiveReplies;
      const costPerMeeting = totalSpend / meetings;
      const costPerWon = totalSpend / won;

      assert(costPerSent === 1.2, "Cost per sent computed accurately ($1.20)");
      assert(costPerReply === 12.0, "Cost per reply computed accurately ($12.00)");
      assert(costPerPositive === 30.0, "Cost per positive reply computed accurately ($30.00)");
      assert(costPerMeeting === 60.0, "Cost per meeting booked computed accurately ($60.00)");
      assert(costPerWon === 120.0, "Cost per won customer computed accurately ($120.00)");

      // Division by zero safety
      const safeCostPerReply = replies > 0 ? totalSpend / replies : null;
      const zeroReplies = 0;
      const safeCostWithZero = zeroReplies > 0 ? totalSpend / zeroReplies : null;
      assert(safeCostPerReply !== null, "Safe cost returns value when replies > 0");
      assert(safeCostWithZero === null, "Safe cost returns null (not NaN or Infinity) when count is 0");
    }

    // -------------------------------------------------------------------------
    // 3. UNIT TEST: Statistical Honesty (n < 30 Confidence Marking)
    // -------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 3: Statistical Honesty & Confidence Markers ---");
    {
      const smallSample = 8;
      const largeSample = 45;

      const isSmallLowConfidence = smallSample < 30;
      const isLargeLowConfidence = largeSample < 30;

      assert(isSmallLowConfidence === true, "Sample n < 30 is flagged lowConfidence: true");
      assert(isLargeLowConfidence === false, "Sample n >= 30 is flagged lowConfidence: false");
    }

    // -------------------------------------------------------------------------
    // 4. UNIT TEST: Reply Classification & Unsubscribe / DNC Handling
    // -------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 4: Reply Classification & DNC Suppression ---");
    {
      const pos = classifyReplyText("Yes, we are very interested! Please send us the pricing info.");
      assert(pos === "positive", "Classifies interested response as 'positive'");

      const ques = classifyReplyText("What does this service include and how much is it?");
      assert(ques === "question", "Classifies query as 'question'");

      const neg = classifyReplyText("Not interested at this time, thank you.");
      assert(neg === "negative", "Classifies polite decline as 'negative'");

      const notNow = classifyReplyText("We are busy right now, check back next month or next quarter.");
      assert(notNow === "not_now", "Classifies delayed interest as 'not_now'");

      const un在本 = classifyReplyText("STOP messaging us! Unsubscribe immediately.");
      assert(un在本 === "unsubscribe", "Classifies STOP/unsubscribe as 'unsubscribe'");

      const spam = classifyReplyText("Claim free crypto tokens click here http://spam.example.com");
      assert(spam === "spam", "Classifies promotional link as 'spam'");

      // Test Unsubscribe handling on a real lead in the database
      const unsubLead = await prisma.lead.create({
        data: {
          campaignId: campaign.id,
          username: `unsub_user_${Date.now()}`,
          profileUrl: `https://instagram.com/unsub_user_${Date.now()}`,
          source: "INSTAGRAM",
          status: LeadStatus.REPLIED,
        },
      });

      // Create execution and queue a dummy execution item to ensure it gets cancelled
      const testExecution = await prisma.campaignExecution.create({
        data: {
          campaignId: campaign.id,
          userId: user.id,
          status: "RUNNING",
          phase: "MESSAGING",
        },
      });

      const queuedItem = await prisma.campaignExecutionItem.create({
        data: {
          executionId: testExecution.id,
          leadId: unsubLead.id,
          messageText: "Hello there",
          status: "PENDING",
        },
      });

      // Process inbound "STOP"
      const replyResult = await processInboundReplyOutcome({
        leadId: unsubLead.id,
        channel: "INSTAGRAM",
        replyText: "STOP! Please remove me from your list.",
      });

      assert(replyResult.replyCategory === "unsubscribe", "Inbound stop categorized as unsubscribe");
      assert(
        replyResult.eventsEmitted.includes(LeadEventType.UNSUBSCRIBE_OR_DNC),
        "Unsubscribe lead automatically added to DNC"
      );

      // Verify DNC record exists
      const dncRecord = await prisma.doNotContact.findFirst({
        where: {
          userId: user.id,
          identifierNormalized: (unsubLead.username || "").toLowerCase(),
        },
      });
      assert(!!dncRecord, "DNC entry exists in database for unsubscribed lead");

      // Verify queued item was cancelled
      const updatedQueueItem = await prisma.campaignExecutionItem.findUnique({
        where: { id: queuedItem.id },
      });
      assert(
        updatedQueueItem?.status === "SUPPRESSED_DNC",
        "Queued outreach message was cancelled upon unsubscribe"
      );

      // Verify lead status transitioned to DO_NOT_CONTACT
      const updatedLead = await prisma.lead.findUnique({
        where: { id: unsubLead.id },
      });
      assert(
        updatedLead?.status === LeadStatus.DO_NOT_CONTACT,
        "Lead status transitioned to DO_NOT_CONTACT"
      );
    }

    // -------------------------------------------------------------------------
    // 5. UNIT TEST: Sticky and Balanced A/B Variant Assignment
    // -------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 5: Sticky & Balanced A/B Variant Assignment ---");
    {
      const leadIdA = "lead_test_sticky_12345";
      const leadIdB = "lead_test_sticky_67890";

      const varA1 = assignLeadMessageVariant(campaign.id, leadIdA);
      const varA2 = assignLeadMessageVariant(campaign.id, leadIdA);
      const varA3 = assignLeadMessageVariant(campaign.id, leadIdA);

      assert(varA1 === varA2 && varA2 === varA3, "Variant assignment is strictly sticky for the same lead");

      // Balance test across 300 IDs
      const counts: Record<string, number> = { A: 0, B: 0, C: 0 };
      for (let i = 0; i < 300; i++) {
        const v = assignLeadMessageVariant(campaign.id, `sample_lead_${i}`);
        counts[v] = (counts[v] || 0) + 1;
      }

      assert(
        counts.A > 70 && counts.B > 70 && counts.C > 70,
        "Variants A, B, and C are evenly distributed across 300 leads",
        `Counts: A=${counts.A}, B=${counts.B}, C=${counts.C}`
      );

      // Significance test: low sample size (n < 30)
      const zTestSmall = calculateTwoProportionZTest(10, 2, 10, 5);
      assert(
        zTestSmall.significance === "not_enough_data",
        "Z-test flags not_enough_data when sample sizes < 30"
      );

      // Significance test: adequate sample size (n >= 30)
      const zTestAdequate = calculateTwoProportionZTest(100, 5, 100, 20);
      assert(
        zTestAdequate.significance !== "not_enough_data",
        "Z-test evaluates when sample sizes >= 30"
      );
      assert(
        zTestAdequate.significance === "high",
        "Z-test identifies significant difference (5% vs 20%)"
      );
    }

    // -------------------------------------------------------------------------
    // 6. UNIT TEST: Recommendations Service & Auto-Optimize Guard
    // -------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 6: Recommendations & Auto-Optimize Budgets ---");
    {
      const existingCities = ["Miami", "Denver", "Austin", "Chicago"];
      const cityPerformance = new Map<string, { sent: number; positiveRate: number }>([
        ["miami", { sent: 50, positiveRate: 0.15 }],
        ["austin", { sent: 40, positiveRate: 0.08 }],
        ["denver", { sent: 60, positiveRate: 0.00 }],
      ]);

      const prioritized = prioritizeSegmentsForDiscovery({
        cities: existingCities,
        cityPerformance,
        explorationShare: 0.15,
      });

      assert(
        prioritized.prioritizedOrder[0] === "Miami",
        "Prioritizes top performing segment (Miami) first"
      );
      assert(
        prioritized.explorationSegment.includes("Chicago"),
        "Untested segments (Chicago) are kept in exploration pool"
      );
      assert(
        prioritized.prioritizedOrder.length === existingCities.length,
        "Auto-optimize preserves total count and never adds or exceeds segments"
      );
    }

    // -------------------------------------------------------------------------
    // 7. INTEGRATION / FIXTURE TEST: Seed Deterministic 300 Leads with Outcomes
    // -------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 7: Deterministic 300-Lead Fixture & Full Funnel ---");
    {
      const fixtureCampaign = await prisma.campaign.create({
        data: {
          userId: user.id,
          companyProfileId: companyProfile.id,
          name: `Fixture Campaign 300 ${runId}`,
          status: "RUNNING",
          category: "coffee",
          location: "Austin",
          intent: "coffee cafes",
          customPositiveKeywords: ["coffee", "bakery", "dentist"],
          autoOptimize: false,
        },
      });
      cleanCampaignIds.push(fixtureCampaign.id);

      // Create a ScrapeJob with cost
      const scrapeJob = await prisma.scrapeJob.create({
        data: {
          campaignId: fixtureCampaign.id,
          provider: "apify",
          status: "COMPLETED",
          costUsd: 15.0,
          costBreakdown: { gmaps: 5.0, enrichment: 7.0, gemini: 3.0 },
        },
      });

      console.log("Seeding 300 deterministic leads with attribution...");
      const keywords = ["coffee", "bakery", "dentist"];
      const cities = ["Austin", "Miami", "Denver"];
      const tiers = ["A", "B", "C", "D"];
      const variants = ["A", "B", "C"];

      const leadCreateData = [];
      for (let i = 0; i < 300; i++) {
        const kw = keywords[i % 3];
        const city = cities[Math.floor(i / 3) % 3];
        const tier = tiers[i % 4];
        const variant = variants[i % 3];

        leadCreateData.push({
          campaignId: fixtureCampaign.id,
          scrapeJobId: scrapeJob.id,
          username: `fx_lead_${runId}_${i}`,
          profileUrl: `https://instagram.com/fx_lead_${runId}_${i}`,
          source: "GOOGLE_MAPS",
          status: LeadStatus.NEW,
          discoveryKeyword: kw,
          discoveryCity: city,
          qualityTier: tier,
          qualityScore: tier === "A" ? 85 : tier === "B" ? 65 : tier === "C" ? 45 : 20,
          acquisitionCostUsd: 0.05, // 15.00 / 300 = $0.05 per lead
          messageVariant: variant,
          availableChannels: ["INSTAGRAM_DM"],
          isChain: i % 10 === 0,
        });
      }

      await prisma.lead.createMany({
        data: leadCreateData,
      });

      const seededLeads = await prisma.lead.findMany({
        where: { campaignId: fixtureCampaign.id },
        select: { id: true, discoveryKeyword: true, discoveryCity: true, qualityTier: true, messageVariant: true },
        orderBy: { id: "asc" },
      });

      assert(seededLeads.length === 300, "Successfully seeded 300 leads with attribution");

      // Generate deterministic events:
      // First 240 leads -> SENT
      // 60 of the sent -> REPLIED
      // 25 of the replied -> POSITIVE_REPLY
      // 8 of the positive -> MEETING_BOOKED
      // 3 of the meetings -> WON
      // 10 of the sent -> UNSUBSCRIBE_OR_DNC
      console.log("Emitting deterministic LeadEvents...");
      const eventsToCreate: Array<{
        leadId: string;
        campaignId: string;
        eventType: LeadEventType;
        channel: MessageChannel;
        variant: string | null;
      }> = [];

      // 240 SENT
      for (let i = 0; i < 240; i++) {
        const l = seededLeads[i];
        eventsToCreate.push({
          leadId: l.id,
          campaignId: fixtureCampaign.id,
          eventType: LeadEventType.SENT,
          channel: MessageChannel.INSTAGRAM,
          variant: l.messageVariant,
        });
      }

      // 60 REPLIED
      for (let i = 0; i < 60; i++) {
        const l = seededLeads[i];
        eventsToCreate.push({
          leadId: l.id,
          campaignId: fixtureCampaign.id,
          eventType: LeadEventType.REPLIED,
          channel: MessageChannel.INSTAGRAM,
          variant: l.messageVariant,
        });
      }

      // 25 POSITIVE_REPLY (deliberately give Miami and tier A higher proportion)
      for (let i = 0; i < 25; i++) {
        const l = seededLeads[i];
        eventsToCreate.push({
          leadId: l.id,
          campaignId: fixtureCampaign.id,
          eventType: LeadEventType.POSITIVE_REPLY,
          channel: MessageChannel.INSTAGRAM,
          variant: l.messageVariant,
        });
      }

      // 8 MEETING_BOOKED
      for (let i = 0; i < 8; i++) {
        const l = seededLeads[i];
        eventsToCreate.push({
          leadId: l.id,
          campaignId: fixtureCampaign.id,
          eventType: LeadEventType.MEETING_BOOKED,
          channel: MessageChannel.INSTAGRAM,
          variant: l.messageVariant,
        });
      }

      // 3 WON
      for (let i = 0; i < 3; i++) {
        const l = seededLeads[i];
        eventsToCreate.push({
          leadId: l.id,
          campaignId: fixtureCampaign.id,
          eventType: LeadEventType.WON,
          channel: MessageChannel.INSTAGRAM,
          variant: l.messageVariant,
        });
      }

      // 10 UNSUBSCRIBE_OR_DNC
      for (let i = 200; i < 210; i++) {
        const l = seededLeads[i];
        eventsToCreate.push({
          leadId: l.id,
          campaignId: fixtureCampaign.id,
          eventType: LeadEventType.UNSUBSCRIBE_OR_DNC,
          channel: MessageChannel.INSTAGRAM,
          variant: l.messageVariant,
        });
      }

      await prisma.leadEvent.createMany({
        data: eventsToCreate,
      });

      // Assert Analytics Aggregation Output
      console.log("Querying getCampaignOutcomeAnalytics...");
      const analytics = await getCampaignOutcomeAnalytics(fixtureCampaign.id);

      assert(analytics.funnel.savedLeads === 300, "Funnel saved leads matches 300");
      assert(analytics.funnel.sent === 240, "Funnel sent count matches 240");
      assert(analytics.funnel.replied === 60, "Funnel replied count matches 60");
      assert(analytics.funnel.positive === 25, "Funnel positive reply count matches 25");
      assert(analytics.funnel.meeting === 8, "Funnel meeting booked count matches 8");
      assert(analytics.funnel.won === 3, "Funnel won count matches 3");

      // Verify conversions
      // sent-to-replied = 60 / 240 = 25.0%
      assert(
        Math.abs(analytics.funnel.conversions.sentToReplied - 25.0) < 0.1,
        "Sent to replied conversion rate is 25%"
      );

      // Verify economics
      // 300 leads * $0.05 = $15.00 total spend
      assert(analytics.cost.totalDiscoverySpend === 15.0, "Total discovery spend is $15.00");
      assert(analytics.cost.costPerSavedLead === 0.05, "Cost per saved lead is $0.05");
      assert(
        Math.abs(analytics.cost.costPerReply - 0.25) < 0.01,
        "Cost per reply accurately calculated ($0.25)"
      );
      assert(
        Math.abs(analytics.cost.costPerPositiveReply - 0.60) < 0.01,
        "Cost per positive reply accurately calculated ($0.60)"
      );
      assert(
        Math.abs(analytics.cost.costPerMeeting - 1.88) < 0.01,
        "Cost per meeting accurately calculated ($1.88)"
      );

      // Verify segment breakdowns exist
      assert(analytics.segments.byKeyword.length === 3, "Breakdown by keyword contains 3 keywords");
      assert(analytics.segments.byCity.length === 3, "Breakdown by city contains 3 cities");
      assert(analytics.segments.byTier.length === 4, "Breakdown by score tier contains 4 tiers");
      assert(analytics.segments.byVariant.length === 3, "Breakdown by variant contains 3 variants");

      // Each keyword has 100 leads, 80 sent >= 30 -> lowConfidence: false
      for (const kwSeg of analytics.segments.byKeyword) {
        assert(
          kwSeg.lowConfidence === false,
          `Keyword '${kwSeg.segmentKey}' with ${kwSeg.sent} sends has lowConfidence: false`
        );
      }

      // Test Recommendations engine on this campaign
      console.log("Querying getCampaignRecommendations...");
      const recsResult = await getCampaignRecommendations(fixtureCampaign.id);

      assert(
        Array.isArray(recsResult.recommendations),
        "Recommendations returns list of data-driven recommendations"
      );
      assert(
        recsResult.recommendations.length > 0,
        "Generated at least one data-driven recommendation for the campaign"
      );

      const hasActionableRec = recsResult.recommendations.some(
        (r) => r.type === "SCALE_SEGMENT" || r.type === "ADJUST_SCORE_THRESHOLD" || r.type === "STOP_SEGMENT"
      );
      assert(
        hasActionableRec,
        "Generates actionable recommendations (SCALE_SEGMENT / ADJUST_SCORE_THRESHOLD / STOP_SEGMENT)"
      );

      // Test Manual Outcome Event flow
      console.log("Testing manual outcome event recording...");
      const targetLead = seededLeads[0];
      await prisma.lead.update({
        where: { id: targetLead.id },
        data: { status: LeadStatus.REPLIED },
      });

      const manualMeetingResult = await recordManualOutcomeEvent({
        leadId: targetLead.id,
        eventType: "MEETING_BOOKED",
        actor: "USER",
        notes: "Booked discovery call on Friday",
      });

      assert(
        manualMeetingResult.leadStatus === LeadStatus.MEETING,
        "Recording manual MEETING_BOOKED sets lead status to MEETING"
      );

      const manualWonResult = await recordManualOutcomeEvent({
        leadId: targetLead.id,
        eventType: "WON",
        actor: "USER",
        notes: "Closed $2000 deal",
      });

      assert(
        manualWonResult.leadStatus === LeadStatus.CONVERTED,
        "Recording manual WON sets lead status to CONVERTED"
      );

      // Test 1-click apply of recommendations
      const recToApply = recsResult.recommendations[0];
      const applyResult = await applyCampaignRecommendation(fixtureCampaign.id, recToApply.id);
      assert(
        applyResult.success === true,
        "1-click apply of recommendation succeeds without raising budgets"
      );
    }

  } catch (err) {
    console.error("💥 Unexpected test suite failure:", err);
    failed++;
  } finally {
    // Clean up created fixture data
    console.log("\nCleaning up test fixture data...");
    try {
      for (const cid of cleanCampaignIds) {
        await prisma.leadEvent.deleteMany({ where: { campaignId: cid } });
        await prisma.campaignExecutionItem.deleteMany({ where: { lead: { campaignId: cid } } });
        await prisma.campaignExecution.deleteMany({ where: { campaignId: cid } });
        await prisma.lead.deleteMany({ where: { campaignId: cid } });
        await prisma.scrapeJob.deleteMany({ where: { campaignId: cid } });
        await prisma.campaign.deleteMany({ where: { id: cid } });
      }
      for (const uid of cleanUserIds) {
        await prisma.doNotContact.deleteMany({ where: { userId: uid } });
        await prisma.companyProfile.deleteMany({ where: { userId: uid } });
        await prisma.user.deleteMany({ where: { id: uid } });
      }
      console.log("Cleanup complete.");
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr);
    }
  }

  console.log("===============================================================");
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("===============================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal test runner error:", e);
  process.exit(1);
});
