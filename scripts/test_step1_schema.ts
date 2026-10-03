import "./preload_server_only.cjs";
import "dotenv/config";
import assert from "node:assert/strict";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  LeadStatus,
  AiStatus,
  DncChannel,
  DncIdentifierType,
  DncSource,
  MessageDirection,
  MessageChannel,
  UsageProvider,
  BulkMessageJobStatus,
  BulkMessageItemStatus,
} from "../src/generated/prisma/client";
import {
  transitionLeadStatus,
  bulkTransitionLeadStatus,
  ALLOWED_LEAD_TRANSITIONS,
} from "../src/lib/services/lead/lead-status-service";
import { runBackfill } from "./backfill-lead-status";

async function main() {
  console.log("=== STEP 1: Schema Foundation & Lead Status Tests ===");
  const prisma = getPrismaClient();

  let passed = 0;
  let failed = 0;

  const testUser = await prisma.user.create({
    data: {
      email: `step1_test_${Date.now()}@example.com`,
      passwordHash: "hash123",
      name: "Step 1 Tester",
    },
  });

  const testCampaign = await prisma.campaign.create({
    data: {
      userId: testUser.id,
      name: "Step 1 Foundation Campaign",
    } as any,
  });

  try {
    // -------------------------------------------------------------
    // Test 1: Verify all new foundation Enums exist and are accessible
    // -------------------------------------------------------------
    console.log("\n[Test 1] New foundation Enums exist and have expected variants");
    try {
      assert(LeadStatus.NEW === "NEW");
      assert(LeadStatus.QUALIFYING === "QUALIFYING");
      assert(LeadStatus.QUALIFIED === "QUALIFIED");
      assert(LeadStatus.READY_FOR_OUTREACH === "READY_FOR_OUTREACH");
      assert(LeadStatus.QUEUED === "QUEUED");
      assert(LeadStatus.CONTACTED === "CONTACTED");
      assert(LeadStatus.REPLIED === "REPLIED");
      assert(LeadStatus.INTERESTED === "INTERESTED");
      assert(LeadStatus.FOLLOW_UP === "FOLLOW_UP");
      assert(LeadStatus.MEETING === "MEETING");
      assert(LeadStatus.CONVERTED === "CONVERTED");
      assert(LeadStatus.NOT_INTERESTED === "NOT_INTERESTED");
      assert(LeadStatus.DO_NOT_CONTACT === "DO_NOT_CONTACT");

      assert(AiStatus.PENDING === "PENDING");
      assert(AiStatus.DONE === "DONE");
      assert(AiStatus.FAILED === "FAILED");
      assert(AiStatus.SKIPPED === "SKIPPED");

      assert(DncChannel.INSTAGRAM === "INSTAGRAM");
      assert(DncChannel.EMAIL === "EMAIL");
      assert(DncChannel.ALL === "ALL");

      assert(DncIdentifierType.USERNAME === "USERNAME");
      assert(DncIdentifierType.INSTAGRAM_ID === "INSTAGRAM_ID");
      assert(DncIdentifierType.EMAIL === "EMAIL");
      assert(DncIdentifierType.DOMAIN === "DOMAIN");

      assert(DncSource.MANUAL === "MANUAL");
      assert(DncSource.REPLY_OPT_OUT === "REPLY_OPT_OUT");
      assert(DncSource.UNSUBSCRIBE === "UNSUBSCRIBE");
      assert(DncSource.IMPORT === "IMPORT");

      assert(MessageDirection.OUTBOUND === "OUTBOUND");
      assert(MessageDirection.INBOUND === "INBOUND");

      assert(MessageChannel.INSTAGRAM === "INSTAGRAM");
      assert(MessageChannel.EMAIL === "EMAIL");

      assert(UsageProvider.SPARIOR === "SPARIOR");
      assert(UsageProvider.APIFY === "APIFY");
      assert(UsageProvider.GEMINI === "GEMINI");
      assert(UsageProvider.ZAPIER === "ZAPIER");
      assert(UsageProvider.OTHER === "OTHER");

      console.log("  ✓ All 8 enums verified");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 1 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 2: All new models can be created and queried
    // -------------------------------------------------------------
    console.log("\n[Test 2] Models Lead, LeadStatusHistory, DoNotContact, Conversation, UsageLog create & query");
    let testLeadId = "";
    try {
      // 2a. Lead with new foundation fields
      const lead = await prisma.lead.create({
        data: {
          campaignId: testCampaign.id,
          username: `lead_step1_${Date.now()}`,
          profileUrl: `https://instagram.com/lead_step1_${Date.now()}`,
          fullName: "Schema Test Lead",
          instagramUserId: "ig_uid_12345",
          email: "lead@example.com",
          emailNormalized: "lead@example.com",
          website: "https://example.com",
          websiteDomain: "example.com",
          leadScore: 85,
          leadQuality: "high",
          aiStatus: AiStatus.PENDING,
          aiAnalysis: { summary: "High quality fit" },
          status: LeadStatus.NEW,
        },
      });
      testLeadId = lead.id;
      assert.equal(lead.status, LeadStatus.NEW);
      assert.equal(lead.leadScore, 85);
      assert.equal(lead.emailNormalized, "lead@example.com");

      // 2b. LeadStatusHistory
      const history = await prisma.leadStatusHistory.create({
        data: {
          leadId: lead.id,
          fromStatus: null,
          toStatus: LeadStatus.NEW,
          reason: "initial_creation",
          actor: "system",
        },
      });
      assert.equal(history.toStatus, LeadStatus.NEW);

      // 2c. DoNotContact
      const dnc = await prisma.doNotContact.create({
        data: {
          userId: testUser.id,
          channel: DncChannel.INSTAGRAM,
          identifierType: DncIdentifierType.USERNAME,
          identifierNormalized: "blockeduser",
          reason: "User requested opt-out",
          source: DncSource.MANUAL,
        },
      });
      assert.equal(dnc.identifierNormalized, "blockeduser");

      // 2d. Conversation
      const conversation = await prisma.conversation.create({
        data: {
          userId: testUser.id,
          leadId: lead.id,
          campaignId: testCampaign.id,
          channel: MessageChannel.INSTAGRAM,
          status: "OPEN",
          unreadCount: 1,
        },
      });
      assert.equal(conversation.status, "OPEN");

      // 2e. Message with new fields
      const msg = await prisma.message.create({
        data: {
          campaignId: testCampaign.id,
          leadId: lead.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          channel: MessageChannel.INSTAGRAM,
          messageText: "Hello there!",
          aiGenerated: true,
          promptVersion: "v1.0",
        },
      });
      assert.equal(msg.direction, MessageDirection.OUTBOUND);
      assert.equal(msg.aiGenerated, true);

      // 2f. UsageLog
      const log = await prisma.usageLog.create({
        data: {
          userId: testUser.id,
          campaignId: testCampaign.id,
          provider: UsageProvider.APIFY,
          operation: "instagram_profile_scrape",
          requestCount: 1,
          itemsReturned: 10,
          estimatedCostUsd: 0.05,
          metadata: { actor: "apify/instagram-profile-scraper" },
        },
      });
      assert.equal(log.provider, UsageProvider.APIFY);

      console.log("  ✓ All models created and verified successfully");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 2 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 3: DoNotContact unique constraint
    // -------------------------------------------------------------
    console.log("\n[Test 3] DoNotContact unique constraint on (userId, channel, identifierType, identifierNormalized)");
    try {
      let threwConflict = false;
      try {
        await prisma.doNotContact.create({
          data: {
            userId: testUser.id,
            channel: DncChannel.INSTAGRAM,
            identifierType: DncIdentifierType.USERNAME,
            identifierNormalized: "blockeduser", // Duplicate of 2c
            source: DncSource.REPLY_OPT_OUT,
          },
        });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "P2002") {
          threwConflict = true;
        }
      }
      assert.equal(threwConflict, true, "Expected Prisma P2002 unique constraint violation on DoNotContact");
      console.log("  ✓ DoNotContact unique constraint enforced");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 3 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 4: Conversation unique(leadId, channel) constraint
    // -------------------------------------------------------------
    console.log("\n[Test 4] Conversation unique constraint on (leadId, channel)");
    try {
      let threwConflict = false;
      try {
        await prisma.conversation.create({
          data: {
            userId: testUser.id,
            leadId: testLeadId,
            channel: MessageChannel.INSTAGRAM, // Duplicate channel for testLeadId
            status: "OPEN",
          },
        });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "P2002") {
          threwConflict = true;
        }
      }
      assert.equal(threwConflict, true, "Expected Prisma P2002 unique constraint violation on Conversation");
      console.log("  ✓ Conversation unique constraint enforced");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 4 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 5: Lead status service - Happy path pipeline transitions
    // -------------------------------------------------------------
    console.log("\n[Test 5] Lead status service legal pipeline transitions");
    try {
      const pipelineLead = await prisma.lead.create({
        data: {
          campaignId: testCampaign.id,
          username: `pipeline_${Date.now()}`,
          profileUrl: `https://instagram.com/pipeline_${Date.now()}`,
          status: LeadStatus.NEW,
        },
      });

      // NEW -> QUALIFYING
      const r1 = await transitionLeadStatus({
        leadId: pipelineLead.id,
        to: LeadStatus.QUALIFYING,
        actor: "system",
        reason: "ai_analysis_started",
      });
      assert.equal(r1.status, LeadStatus.QUALIFYING);

      // QUALIFYING -> QUALIFIED
      const r2 = await transitionLeadStatus({
        leadId: pipelineLead.id,
        to: LeadStatus.QUALIFIED,
        actor: "system",
        reason: "score_above_threshold",
      });
      assert.equal(r2.status, LeadStatus.QUALIFIED);

      // QUALIFIED -> READY_FOR_OUTREACH
      const r3 = await transitionLeadStatus({
        leadId: pipelineLead.id,
        to: LeadStatus.READY_FOR_OUTREACH,
        actor: "system",
        reason: "approved",
      });
      assert.equal(r3.status, LeadStatus.READY_FOR_OUTREACH);

      // READY_FOR_OUTREACH -> QUEUED
      const r4 = await transitionLeadStatus({
        leadId: pipelineLead.id,
        to: LeadStatus.QUEUED,
        actor: "worker",
        reason: "enqueued_in_bulk_job",
      });
      assert.equal(r4.status, LeadStatus.QUEUED);

      // QUEUED -> CONTACTED
      const r5 = await transitionLeadStatus({
        leadId: pipelineLead.id,
        to: LeadStatus.CONTACTED,
        actor: "worker",
        reason: "dm_delivered",
      });
      assert.equal(r5.status, LeadStatus.CONTACTED);

      // Verify lastContactedAt populated on CONTACTED
      const contactedLead = await prisma.lead.findUnique({ where: { id: pipelineLead.id } });
      assert(contactedLead?.lastContactedAt !== null, "lastContactedAt should be set on CONTACTED");

      // CONTACTED -> REPLIED
      const r6 = await transitionLeadStatus({
        leadId: pipelineLead.id,
        to: LeadStatus.REPLIED,
        actor: "worker",
        reason: "incoming_dm_detected",
      });
      assert.equal(r6.status, LeadStatus.REPLIED);

      // REPLIED -> INTERESTED
      const r7 = await transitionLeadStatus({
        leadId: pipelineLead.id,
        to: LeadStatus.INTERESTED,
        actor: "user:123",
        reason: "lead_wants_demo",
      });
      assert.equal(r7.status, LeadStatus.INTERESTED);

      // INTERESTED -> MEETING
      const r8 = await transitionLeadStatus({
        leadId: pipelineLead.id,
        to: LeadStatus.MEETING,
        actor: "user:123",
        reason: "calendar_booked",
      });
      assert.equal(r8.status, LeadStatus.MEETING);

      // MEETING -> CONVERTED
      const r9 = await transitionLeadStatus({
        leadId: pipelineLead.id,
        to: LeadStatus.CONVERTED,
        actor: "user:123",
        reason: "contract_signed",
      });
      assert.equal(r9.status, LeadStatus.CONVERTED);

      // Verify history count
      const historyRows = await prisma.leadStatusHistory.findMany({
        where: { leadId: pipelineLead.id },
      });
      assert.equal(historyRows.length, 9, "Expected 9 status history records for full pipeline");

      console.log("  ✓ Complete pipeline transition sequence succeeded with history records");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 5 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 6: Queue recovery, legacy shortcuts, and illegal transitions
    // -------------------------------------------------------------
    console.log("\n[Test 6] Queue recovery, legacy shortcuts, and rejection of illegal transitions");
    try {
      // 6a. Legacy shortcut: NEW -> QUEUED and QUEUED -> READY_FOR_OUTREACH
      const shortcutLead = await prisma.lead.create({
        data: {
          campaignId: testCampaign.id,
          username: `shortcut_${Date.now()}`,
          profileUrl: `https://instagram.com/shortcut_${Date.now()}`,
          status: LeadStatus.NEW,
        },
      });

      const qRes = await transitionLeadStatus({
        leadId: shortcutLead.id,
        to: LeadStatus.QUEUED,
        actor: "system",
      });
      assert.equal(qRes.status, LeadStatus.QUEUED);

      const rollbackRes = await transitionLeadStatus({
        leadId: shortcutLead.id,
        to: LeadStatus.READY_FOR_OUTREACH,
        actor: "worker",
      });
      assert.equal(rollbackRes.status, LeadStatus.READY_FOR_OUTREACH);

      // 6b. Illegal backward jump: READY_FOR_OUTREACH -> QUALIFYING
      let rejectedBackward = false;
      try {
        await transitionLeadStatus({
          leadId: shortcutLead.id,
          to: LeadStatus.QUALIFYING,
          actor: "worker",
        });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "INVALID_LEAD_STATUS_TRANSITION") {
          rejectedBackward = true;
        }
      }
      assert.equal(rejectedBackward, true, "Expected INVALID_LEAD_STATUS_TRANSITION on backward jump");

      // 6c. Illegal skipping: NEW -> CONVERTED
      const freshLead = await prisma.lead.create({
        data: {
          campaignId: testCampaign.id,
          username: `fresh_${Date.now()}`,
          profileUrl: `https://instagram.com/fresh_${Date.now()}`,
          status: LeadStatus.NEW,
        },
      });

      let rejectedSkip = false;
      try {
        await transitionLeadStatus({
          leadId: freshLead.id,
          to: LeadStatus.CONVERTED,
          actor: "worker",
        });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "INVALID_LEAD_STATUS_TRANSITION") {
          rejectedSkip = true;
        }
      }
      assert.equal(rejectedSkip, true, "Expected INVALID_LEAD_STATUS_TRANSITION on skip to CONVERTED");

      console.log("  ✓ Queue recovery and illegal transitions validated");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 6 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 7: DO_NOT_CONTACT entry and exit rules
    // -------------------------------------------------------------
    console.log("\n[Test 7] DO_NOT_CONTACT entry (any status) and exit rule (actor must start with 'user:')");
    try {
      const dncLead = await prisma.lead.create({
        data: {
          campaignId: testCampaign.id,
          username: `dnc_${Date.now()}`,
          profileUrl: `https://instagram.com/dnc_${Date.now()}`,
          status: LeadStatus.QUALIFYING,
        },
      });

      // Any status -> DO_NOT_CONTACT is allowed
      const dncEntry = await transitionLeadStatus({
        leadId: dncLead.id,
        to: LeadStatus.DO_NOT_CONTACT,
        actor: "system",
        reason: "global_dnc_matched",
      });
      assert.equal(dncEntry.status, LeadStatus.DO_NOT_CONTACT);

      // System or worker cannot exit DO_NOT_CONTACT
      let nonUserExitRejected = false;
      try {
        await transitionLeadStatus({
          leadId: dncLead.id,
          to: LeadStatus.NEW,
          actor: "system",
        });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "INVALID_LEAD_STATUS_TRANSITION") {
          nonUserExitRejected = true;
        }
      }
      assert.equal(nonUserExitRejected, true, "Leaving DO_NOT_CONTACT with system actor must be rejected");

      // Explicit user action CAN exit DO_NOT_CONTACT
      const userExit = await transitionLeadStatus({
        leadId: dncLead.id,
        to: LeadStatus.NEW,
        actor: `user:${testUser.id}`,
        reason: "manual_user_override",
      });
      assert.equal(userExit.status, LeadStatus.NEW);

      console.log("  ✓ DO_NOT_CONTACT entry and strict exit rules enforced");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 7 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 8: No-op transition and ACID transaction rollback
    // -------------------------------------------------------------
    console.log("\n[Test 8] No-op status transitions and transaction rollback integrity");
    try {
      const testLead = await prisma.lead.create({
        data: {
          campaignId: testCampaign.id,
          username: `tx_${Date.now()}`,
          profileUrl: `https://instagram.com/tx_${Date.now()}`,
          status: LeadStatus.NEW,
        },
      });

      // No-op transition (NEW -> NEW)
      const noOp = await transitionLeadStatus({
        leadId: testLead.id,
        to: LeadStatus.NEW,
        actor: "system",
      });
      assert.equal(noOp.transitioned, false, "No-op transition must return transitioned: false");

      const historyCountAfterNoOp = await prisma.leadStatusHistory.count({
        where: { leadId: testLead.id },
      });
      assert.equal(historyCountAfterNoOp, 0, "No-op must not write to LeadStatusHistory");

      // Transaction rollback test
      let rollbackHappened = false;
      try {
        await prisma.$transaction(async (tx) => {
          await transitionLeadStatus({
            leadId: testLead.id,
            to: LeadStatus.QUALIFYING,
            actor: "system",
            tx,
          });
          // Intentionally throw downstream error
          throw new Error("SIMULATED_TRANSACTION_FAILURE");
        });
      } catch (err: unknown) {
        if ((err as Error).message === "SIMULATED_TRANSACTION_FAILURE") {
          rollbackHappened = true;
        }
      }
      assert.equal(rollbackHappened, true);

      // Verify DB rolled back
      const leadAfterRollback = await prisma.lead.findUnique({ where: { id: testLead.id } });
      assert.equal(leadAfterRollback?.status, LeadStatus.NEW, "Status must remain NEW after transaction rollback");

      const historyAfterRollback = await prisma.leadStatusHistory.count({
        where: { leadId: testLead.id },
      });
      assert.equal(historyAfterRollback, 0, "No history row must exist after transaction rollback");

      console.log("  ✓ No-op and transaction rollback integrity verified");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 8 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 9: Backfill script logic on seeded data & idempotency
    // -------------------------------------------------------------
    console.log("\n[Test 9] Backfill script logic (seeded data, dry-run, live execution, idempotency)");
    try {
      // Create isolated test campaign
      const backfillCampaign = await prisma.campaign.create({
        data: {
          userId: testUser.id,
          name: `Backfill Test Campaign ${Date.now()}`,
        } as any,
      });

      // Seed 4 distinct lead scenarios:
      // Lead A: has SENT outbound message -> should backfill to CONTACTED
      const leadA = await prisma.lead.create({
        data: {
          campaignId: backfillCampaign.id,
          username: `bf_sent_${Date.now()}`,
          profileUrl: `https://instagram.com/bf_sent_${Date.now()}`,
          status: LeadStatus.NEW,
        },
      });
      const sentTime = new Date("2026-09-01T12:00:00Z");
      await prisma.message.create({
        data: {
          campaignId: backfillCampaign.id,
          leadId: leadA.id,
          status: "SENT",
          direction: "OUTBOUND",
          messageText: "Sent message",
          sentAt: sentTime,
        },
      });

      // Lead B: has in-flight SENDING message -> should backfill to QUEUED
      const leadB = await prisma.lead.create({
        data: {
          campaignId: backfillCampaign.id,
          username: `bf_sending_${Date.now()}`,
          profileUrl: `https://instagram.com/bf_sending_${Date.now()}`,
          status: LeadStatus.NEW,
        },
      });
      await prisma.message.create({
        data: {
          campaignId: backfillCampaign.id,
          leadId: leadB.id,
          status: "SENDING",
          direction: "OUTBOUND",
          messageText: "In-flight message",
        },
      });

      // Lead C: has only FAILED message -> should backfill to NEW
      const leadC = await prisma.lead.create({
        data: {
          campaignId: backfillCampaign.id,
          username: `bf_failed_${Date.now()}`,
          profileUrl: `https://instagram.com/bf_failed_${Date.now()}`,
          status: LeadStatus.NEW,
        },
      });
      await prisma.message.create({
        data: {
          campaignId: backfillCampaign.id,
          leadId: leadC.id,
          status: "FAILED",
          direction: "OUTBOUND",
          messageText: "Failed message",
        },
      });

      // Lead D: untouched lead -> should backfill to NEW
      const leadD = await prisma.lead.create({
        data: {
          campaignId: backfillCampaign.id,
          username: `bf_untouched_${Date.now()}`,
          profileUrl: `https://instagram.com/bf_untouched_${Date.now()}`,
          status: LeadStatus.NEW,
        },
      });

      // 9a. Test Dry Run (must not change database or add history)
      const dryResult = await runBackfill({ dryRun: true });
      assert.equal(dryResult.dryRun, true);

      const checkDryLeadA = await prisma.lead.findUnique({
        where: { id: leadA.id },
        include: { statusHistory: true },
      });
      assert.equal(checkDryLeadA?.statusHistory.length, 0, "Dry run must write no history rows");

      // 9b. Live Backfill
      const liveResult = await runBackfill({ dryRun: false });
      assert.equal(liveResult.dryRun, false);

      const freshLeadA = await prisma.lead.findUnique({ where: { id: leadA.id } });
      const freshLeadB = await prisma.lead.findUnique({ where: { id: leadB.id } });
      const freshLeadC = await prisma.lead.findUnique({ where: { id: leadC.id } });
      const freshLeadD = await prisma.lead.findUnique({ where: { id: leadD.id } });

      assert.equal(freshLeadA?.status, LeadStatus.CONTACTED, "Lead with sent message must become CONTACTED");
      assert.equal(freshLeadA?.lastContactedAt?.toISOString(), sentTime.toISOString());
      assert.equal(freshLeadB?.status, LeadStatus.QUEUED, "Lead with sending message must become QUEUED");
      assert.equal(freshLeadC?.status, LeadStatus.NEW, "Lead with only failed message must remain NEW");
      assert.equal(freshLeadD?.status, LeadStatus.NEW, "Untouched lead must remain NEW");

      // 9c. Idempotency test: Re-running backfill should skip all leads with history
      const rerunResult = await runBackfill({ dryRun: false });
      assert.equal(rerunResult.totalUpdated, 0, "Idempotent re-run must update 0 leads");
      assert(rerunResult.totalSkipped >= 4, "Idempotent re-run must skip leads with history");

      console.log("  ✓ Backfill accurately classifies statuses, handles dry-run, and is idempotent");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 9 failed:", err);
      failed++;
    }

  } finally {
    // Cleanup test user and associated cascade data
    try {
      await prisma.user.delete({ where: { id: testUser.id } });
    } catch {
      // Ignore cleanup error
    }
  }

  console.log(`\n========================================`);
  console.log(`STEP 1 TEST SUMMARY: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
