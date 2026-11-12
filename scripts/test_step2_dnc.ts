import "./preload_server_only.cjs";
import "dotenv/config";
import assert from "node:assert/strict";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  LeadStatus,
  DncChannel,
  DncIdentifierType,
  DncSource,
  BulkMessageJobStatus,
  BulkMessageItemStatus,
  CampaignExecutionStatus,
  CampaignExecutionPhase,
  ExecutionItemStatus,
  MessageStatus,
} from "../src/generated/prisma/client";
import {
  normalizeUsername,
  normalizeEmail,
  normalizeDomain,
  getLeadIdentifiers,
  checkLeadSuppression,
  checkManySuppression,
  addDoNotContact,
  removeDoNotContact,
  listDoNotContact,
  cancelPendingOutreachForLeads,
} from "../src/lib/services/compliance/dnc-service";
import { detectOptOut } from "../src/lib/services/compliance/opt-out-detector";
import {
  setMessagingProvider,
  sendSingleMessage,
  createBulkMessageJob,
  dispatchBulkJobQueue,
  previewBulkMessageJob,
} from "../src/lib/services/messaging";
import {
  dispatchExecution,
} from "../src/lib/services/execution/campaign-execution-service";
import { DncSuppressedError, BadRequestError } from "../src/lib/errors";

async function main() {
  console.log("=== STEP 2: DO_NOT_CONTACT (DNC) Enforcement Suite ===");
  const prisma = getPrismaClient();

  let passed = 0;
  let failed = 0;

  const testUserA = await prisma.user.create({
    data: {
      email: `step2_user_a_${Date.now()}@example.com`,
      passwordHash: "hashA",
      name: "Step 2 User A",
    },
  });

  const testUserB = await prisma.user.create({
    data: {
      email: `step2_user_b_${Date.now()}@example.com`,
      passwordHash: "hashB",
      name: "Step 2 User B",
    },
  });

  const testCampaignA = await prisma.campaign.create({
    data: {
      userId: testUserA.id,
      name: "Step 2 Campaign A",
    } as any,
  });

  const testTemplateA = await prisma.messageTemplate.create({
    data: {
      campaignId: testCampaignA.id,
      name: "DNC Test Template",
      body: "Hello {{username}}!",
    },
  });

  try {
    // -------------------------------------------------------------
    // Test 1: Normalization Helpers
    // -------------------------------------------------------------
    console.log("\n[Test 1] Normalization helpers: username, email, domain");
    try {
      // Username normalization
      assert.equal(normalizeUsername("@John_Doe"), "john_doe");
      assert.equal(normalizeUsername("https://instagram.com/john_doe/"), "john_doe");
      assert.equal(normalizeUsername("https://www.instagram.com/john_doe?utm_source=ig"), "john_doe");
      assert.equal(normalizeUsername("  @ALICE.SMITH/  "), "alice.smith");

      // Email normalization (strips mailto, lowercases, removes dots for gmail)
      assert.equal(normalizeEmail("mailto:John.Doe@gmail.com"), "johndoe@gmail.com");
      assert.equal(normalizeEmail("  j.o.h.n@googlemail.com  "), "john@googlemail.com");
      assert.equal(normalizeEmail("Jane.Doe@company.org"), "jane.doe@company.org");

      // Domain normalization (strips protocol, www, query, trailing slash)
      assert.equal(normalizeDomain("https://www.AgencySite.com/about?ref=1#top"), "agencysite.com");
      assert.equal(normalizeDomain("http://SUB.DOMAIN.ORG/"), "sub.domain.org");
      assert.equal(normalizeDomain("www.example.co.uk"), "example.co.uk");

      // Identifier extraction
      const ids = getLeadIdentifiers({
        username: "john_doe",
        instagramUserId: "12345",
        email: "john@example.com",
        websiteDomain: "example.com",
      });
      assert.equal(ids.username, "john_doe");
      assert.equal(ids.instagramUserId, "12345");
      assert.equal(ids.email, "john@example.com");
      assert.equal(ids.websiteDomain, "example.com");

      console.log("  ✓ Normalization handles @, URLs, case, gmail dots, protocols, and queries");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 1 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 2: Opt-Out Phrase Detector (Positive and Negative Vectors)
    // -------------------------------------------------------------
    console.log("\n[Test 2] Opt-out phrase detector: positive & negative cases");
    try {
      const positiveCases = [
        "stop",
        "STOP",
        "Stop.",
        "Stop! Please leave me alone",
        "unsubscribe",
        "unsubscibe", // typo
        "unsubcribe", // typo
        "un-subscribe",
        "remove me from your list",
        "take me off this list",
        "do not contact me again",
        "don't contact",
        "stop messaging me",
        "leave me alone",
        "opt out",
        "please stop",
        "quit messaging",
        "stop dming me",
        "mujhe message mat karo",
        "STOP 🛑 please",
      ];

      for (const phrase of positiveCases) {
        const result = detectOptOut(phrase);
        assert.equal(result.optOut, true, `Expected "${phrase}" to be detected as opt-out`);
      }

      const negativeCases = [
        "can't stop thinking about it",
        "don't stop sending these updates",
        "can you stop by my office tomorrow?",
        "meet me at the bus stop",
        "non-stop value in this course",
        "not interested", // bare disinterest -> low confidence, not an explicit DNC
        "i am not interested thanks",
        "Hello, how much does your service cost?",
      ];

      for (const phrase of negativeCases) {
        const result = detectOptOut(phrase);
        assert.equal(result.optOut, false, `Expected "${phrase}" NOT to trigger DNC opt-out`);
      }

      console.log(`  ✓ Checked ${positiveCases.length} positive and ${negativeCases.length} negative phrase vectors`);
      passed++;
    } catch (err) {
      console.error("  ✗ Test 2 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 3: Matching Rules & Cross-Channel Semantics
    // -------------------------------------------------------------
    console.log("\n[Test 3] Matching rules: channel isolation, domain rules, and defense-in-depth");
    try {
      // Create test lead with username, email, website
      const lead1 = await prisma.lead.create({
        data: {
          campaignId: testCampaignA.id,
          username: "target_brand",
          profileUrl: "https://instagram.com/target_brand",
          email: "hello@targetbrand.com",
          emailNormalized: "hello@targetbrand.com",
          website: "https://targetbrand.com",
          websiteDomain: "targetbrand.com",
          status: LeadStatus.NEW,
        },
      });

      // 3a. Lead not suppressed initially
      const initialCheck = await checkLeadSuppression({
        userId: testUserA.id,
        lead: lead1,
        channel: DncChannel.INSTAGRAM,
      });
      assert.equal(initialCheck.suppressed, false);

      // 3b. Add DOMAIN suppression for channel EMAIL only
      const domainDnc = await prisma.doNotContact.create({
        data: {
          userId: testUserA.id,
          channel: DncChannel.EMAIL,
          identifierType: DncIdentifierType.DOMAIN,
          identifierNormalized: "targetbrand.com",
          source: DncSource.MANUAL,
        },
      });

      // Checking for EMAIL channel should be suppressed
      const emailCheck = await checkLeadSuppression({
        userId: testUserA.id,
        lead: lead1,
        channel: DncChannel.EMAIL,
      });
      assert.equal(emailCheck.suppressed, true, "Domain suppression must apply to EMAIL outreach");

      // Checking for INSTAGRAM channel must NOT be suppressed by an EMAIL domain entry
      const igCheckWithEmailDomain = await checkLeadSuppression({
        userId: testUserA.id,
        lead: lead1,
        channel: DncChannel.INSTAGRAM,
      });
      assert.equal(
        igCheckWithEmailDomain.suppressed,
        false,
        "Domain entry for EMAIL channel must NOT block Instagram DMs",
      );

      // 3c. Clean up domain entry and add channel=INSTAGRAM entry
      await prisma.doNotContact.delete({ where: { id: domainDnc.id } });

      const igDnc = await prisma.doNotContact.create({
        data: {
          userId: testUserA.id,
          channel: DncChannel.INSTAGRAM,
          identifierType: DncIdentifierType.USERNAME,
          identifierNormalized: "target_brand",
          source: DncSource.MANUAL,
        },
      });

      const igCheck = await checkLeadSuppression({
        userId: testUserA.id,
        lead: lead1,
        channel: DncChannel.INSTAGRAM,
      });
      assert.equal(igCheck.suppressed, true, "Username DNC must block Instagram outreach");

      const emailCheckIgDnc = await checkLeadSuppression({
        userId: testUserA.id,
        lead: lead1,
        channel: DncChannel.EMAIL,
      });
      assert.equal(
        emailCheckIgDnc.suppressed,
        false,
        "INSTAGRAM channel DNC entry must NOT block EMAIL outreach",
      );

      // 3d. Lead status fallback (defense-in-depth)
      await prisma.doNotContact.delete({ where: { id: igDnc.id } });
      const dncStatusLead = await prisma.lead.create({
        data: {
          campaignId: testCampaignA.id,
          username: "fallback_dnc_user",
          profileUrl: "https://instagram.com/fallback_dnc_user",
          status: LeadStatus.DO_NOT_CONTACT,
        },
      });

      const fallbackCheck = await checkLeadSuppression({
        userId: testUserA.id,
        lead: dncStatusLead,
        channel: DncChannel.INSTAGRAM,
      });
      assert.equal(fallbackCheck.suppressed, true, "Lead with status DO_NOT_CONTACT must be suppressed");
      assert.equal(fallbackCheck.matches[0].identifierType, DncIdentifierType.USERNAME);

      console.log("  ✓ Matching rules accurately enforce channel isolation and defense-in-depth");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 3 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 4: Batch checkManySuppression Efficiency & Accuracy
    // -------------------------------------------------------------
    console.log("\n[Test 4] checkManySuppression bounded queries and mapping");
    try {
      // Seed 5 leads
      const leads = await Promise.all(
        Array.from({ length: 5 }).map((_, i) =>
          prisma.lead.create({
            data: {
              campaignId: testCampaignA.id,
              username: `batch_lead_${i}_${Date.now()}`,
              profileUrl: `https://instagram.com/batch_lead_${i}`,
              status: LeadStatus.NEW,
            },
          }),
        ),
      );

      // Suppress 2 of them in DNC table
      await prisma.doNotContact.create({
        data: {
          userId: testUserA.id,
          channel: DncChannel.ALL,
          identifierType: DncIdentifierType.USERNAME,
          identifierNormalized: leads[1].username!.toLowerCase(),
          source: DncSource.MANUAL,
        },
      });
      await prisma.doNotContact.create({
        data: {
          userId: testUserA.id,
          channel: DncChannel.ALL,
          identifierType: DncIdentifierType.USERNAME,
          identifierNormalized: leads[3].username!.toLowerCase(),
          source: DncSource.MANUAL,
        },
      });

      const suppressionMap = await checkManySuppression({
        userId: testUserA.id,
        leads,
        channel: DncChannel.INSTAGRAM,
      });

      assert.equal(suppressionMap.get(leads[0].id)?.suppressed, false);
      assert.equal(suppressionMap.get(leads[1].id)?.suppressed, true);
      assert.equal(suppressionMap.get(leads[2].id)?.suppressed, false);
      assert.equal(suppressionMap.get(leads[3].id)?.suppressed, true);
      assert.equal(suppressionMap.get(leads[4].id)?.suppressed, false);

      // Verify bulk preview filters out suppressed leads and reports suppressedCount
      const previewRes = await previewBulkMessageJob(
        testCampaignA.id,
        { templateId: testTemplateA.id, selection: "allEligible" },
        testUserA.id,
      );
      assert(typeof previewRes.suppressedCount === "number");
      assert(previewRes.suppressedCount >= 2);

      console.log("  ✓ checkManySuppression correctly classifies multi-lead batch");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 4 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 5: addDoNotContact Idempotency, Status Transition & History
    // -------------------------------------------------------------
    console.log("\n[Test 5] addDoNotContact idempotency, status transition, and audit history");
    try {
      const leadForDnc = await prisma.lead.create({
        data: {
          campaignId: testCampaignA.id,
          username: `idempotent_user_${Date.now()}`,
          profileUrl: "https://instagram.com/idempotent_user",
          status: LeadStatus.READY_FOR_OUTREACH,
        },
      });

      // First add
      const addRes1 = await addDoNotContact({
        userId: testUserA.id,
        entries: [
          {
            identifierType: DncIdentifierType.USERNAME,
            value: `@${leadForDnc.username!.toUpperCase()}`,
            channel: DncChannel.ALL,
            reason: "User requested opt out",
          },
        ],
        source: DncSource.REPLY_OPT_OUT,
        actor: "user:test_user_a",
      });

      assert.equal(addRes1.created, 1);
      assert.equal(addRes1.alreadyExisted, 0);
      assert.equal(addRes1.leadsUpdated, 1);

      // Verify lead status transition
      const updatedLead = await prisma.lead.findUnique({ where: { id: leadForDnc.id } });
      assert.equal(updatedLead?.status, LeadStatus.DO_NOT_CONTACT);

      // Verify audit history was recorded
      const history = await prisma.leadStatusHistory.findMany({
        where: { leadId: leadForDnc.id },
      });
      assert(history.length >= 1);
      assert.equal(history[history.length - 1].toStatus, LeadStatus.DO_NOT_CONTACT);
      assert.equal(history[history.length - 1].reason, "dnc:REPLY_OPT_OUT");
      assert.equal(history[history.length - 1].actor, "user:test_user_a");

      // Second add with same value (idempotency check)
      const addRes2 = await addDoNotContact({
        userId: testUserA.id,
        entries: [
          {
            identifierType: DncIdentifierType.USERNAME,
            value: leadForDnc.username!.toLowerCase(),
            channel: DncChannel.ALL,
          },
        ],
        source: DncSource.MANUAL,
        actor: "user:test_user_a",
      });

      assert.equal(addRes2.created, 0);
      assert.equal(addRes2.alreadyExisted, 1);

      console.log("  ✓ addDoNotContact is idempotent, updates lead status, and writes audit history");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 5 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 6: Pending Outreach Cancellation
    // -------------------------------------------------------------
    console.log("\n[Test 6] cancelPendingOutreachForLeads marks items SUPPRESSED_DNC and updates parent jobs");
    try {
      const cancelLead = await prisma.lead.create({
        data: {
          campaignId: testCampaignA.id,
          username: `cancel_target_${Date.now()}`,
          profileUrl: "https://instagram.com/cancel_target",
          status: LeadStatus.NEW,
        },
      });

      // Create a bulk message job with one item for this lead
      const bulkJob = await prisma.bulkMessageJob.create({
        data: {
          campaignId: testCampaignA.id,
          userId: testUserA.id,
          templateId: testTemplateA.id,
          status: BulkMessageJobStatus.RUNNING,
          total: 1,
          queued: 1,
        },
      });

      const bulkItem = await prisma.bulkMessageItem.create({
        data: {
          jobId: bulkJob.id,
          leadId: cancelLead.id,
          renderedMessage: "Test message",
          status: BulkMessageItemStatus.QUEUED,
        },
      });

      // Create a campaign execution with one item
      const exec = await prisma.campaignExecution.create({
        data: {
          campaignId: testCampaignA.id,
          userId: testUserA.id,
          status: CampaignExecutionStatus.RUNNING,
          phase: CampaignExecutionPhase.READY,
          totalItems: 1,
        },
      });

      const execItem = await prisma.campaignExecutionItem.create({
        data: {
          executionId: exec.id,
          leadId: cancelLead.id,
          messageText: "Test execution message",
          status: ExecutionItemStatus.PENDING,
        },
      });

      // Create a queued Message row
      const queuedMsg = await prisma.message.create({
        data: {
          campaignId: testCampaignA.id,
          leadId: cancelLead.id,
          messageText: "Queued single message",
          status: MessageStatus.SENDING,
        },
      });

      // Cancel pending outreach
      const cancelRes = await cancelPendingOutreachForLeads({
        userId: testUserA.id,
        leadIds: [cancelLead.id],
      });

      assert.equal(cancelRes.cancelledBulkItems, 1);
      assert.equal(cancelRes.cancelledExecutionItems, 1);
      assert.equal(cancelRes.cancelledMessages, 1);

      // Verify item statuses
      const freshBulkItem = await prisma.bulkMessageItem.findUnique({ where: { id: bulkItem.id } });
      assert.equal(freshBulkItem?.status, BulkMessageItemStatus.SUPPRESSED_DNC);

      const freshExecItem = await prisma.campaignExecutionItem.findUnique({ where: { id: execItem.id } });
      assert.equal(freshExecItem?.status, ExecutionItemStatus.SUPPRESSED_DNC);

      const freshMsg = await prisma.message.findUnique({ where: { id: queuedMsg.id } });
      assert.equal(freshMsg?.status, MessageStatus.FAILED);
      assert.equal(freshMsg?.errorCode, "SUPPRESSED_DNC");

      // Verify parent bulk job was updated to CANCELLED or COMPLETED cleanly
      const freshBulkJob = await prisma.bulkMessageJob.findUnique({ where: { id: bulkJob.id } });
      assert(
        freshBulkJob?.status === BulkMessageJobStatus.CANCELLED ||
          freshBulkJob?.status === BulkMessageJobStatus.COMPLETED,
      );

      console.log("  ✓ Pending outreach cancelled cleanly across bulk jobs, executions, and message rows");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 6 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 7: Dispatch-Time Check with Mocked Sender (MOST CRITICAL)
    // -------------------------------------------------------------
    console.log("\n[Test 7] Dispatch-time enforcement blocks send even when suppressed AFTER enqueue");
    try {
      const lateDncLead = await prisma.lead.create({
        data: {
          campaignId: testCampaignA.id,
          username: `late_dnc_${Date.now()}`,
          profileUrl: "https://instagram.com/late_dnc",
          status: LeadStatus.NEW,
        },
      });

      // Create bulk message job with ONLY this specific lead
      const jobRes = await createBulkMessageJob(
        testCampaignA.id,
        { templateId: testTemplateA.id, selection: "specific", leadIds: [lateDncLead.id] },
        testUserA.id,
      );

      let mockSendCalled = 0;
      setMessagingProvider({
        name: "mock-sender",
        async sendMessage(req) {
          mockSendCalled++;
          return {
            success: true,
            provider: "mock-sender",
            messageText: req.message,
            messageId: "mock_123",
          };
        },
        async getStatus() {
          return { authenticated: true, status: "READY", provider: "mock-sender" };
        },
        async connect() {},
        async disconnect() {},
      });

      // Now, suppress the lead in the DNC list AFTER enqueue but BEFORE dispatch!
      await addDoNotContact({
        userId: testUserA.id,
        entries: [
          {
            identifierType: DncIdentifierType.USERNAME,
            value: lateDncLead.username!,
            channel: DncChannel.ALL,
          },
        ],
        source: DncSource.MANUAL,
        actor: "user:tester",
      });

      // Execute dispatch
      await dispatchBulkJobQueue(jobRes.job.id);

      // Sender must NEVER have been called!
      assert.equal(mockSendCalled, 0, "Playwright sender must NOT be called for a suppressed lead!");

      // Item must be marked SUPPRESSED_DNC
      const jobItems = await prisma.bulkMessageItem.findMany({
        where: { jobId: jobRes.job.id, leadId: lateDncLead.id },
      });
      assert.equal(jobItems.length, 1);
      assert.equal(jobItems[0].status, BulkMessageItemStatus.SUPPRESSED_DNC);

      // Parent job must complete cleanly without hanging
      const finishedJob = await prisma.bulkMessageJob.findUnique({
        where: { id: jobRes.job.id },
      });
      assert(
        finishedJob?.status === BulkMessageJobStatus.COMPLETED ||
          finishedJob?.status === BulkMessageJobStatus.CANCELLED,
      );

      // Test dispatchExecution with an approved item for the suppressed lead
      const testExec = await prisma.campaignExecution.create({
        data: {
          campaignId: testCampaignA.id,
          userId: testUserA.id,
          status: CampaignExecutionStatus.READY,
          totalItems: 1,
        },
      });
      const testExecItem = await prisma.campaignExecutionItem.create({
        data: {
          executionId: testExec.id,
          leadId: lateDncLead.id,
          messageText: "Test execution message",
          status: ExecutionItemStatus.APPROVED,
        },
      });

      const execDispatch = await dispatchExecution(testExec.id, testUserA.id);
      assert.equal(execDispatch.sent, 0, "Suppressed lead must NOT be sent in campaign execution!");
      assert.equal(execDispatch.suppressed, 1, "Suppressed lead must be counted as suppressed!");

      const freshExecItem = await prisma.campaignExecutionItem.findUnique({
        where: { id: testExecItem.id },
      });
      assert.equal(freshExecItem?.status, ExecutionItemStatus.SUPPRESSED_DNC);

      console.log("  ✓ Dispatch-time check caught late suppression, skipped sender, and marked SUPPRESSED_DNC");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 7 failed:", err);
      failed++;
    } finally {
      setMessagingProvider(null);
    }

    // -------------------------------------------------------------
    // Test 8: Single-Send Path Rejection
    // -------------------------------------------------------------
    console.log("\n[Test 8] Single send throws DncSuppressedError with HTTP 409 code");
    try {
      const suppressedSingleLead = await prisma.lead.create({
        data: {
          campaignId: testCampaignA.id,
          username: `single_dnc_${Date.now()}`,
          profileUrl: "https://instagram.com/single_dnc",
          status: LeadStatus.DO_NOT_CONTACT,
        },
      });

      let thrownError: unknown = null;
      try {
        await sendSingleMessage({
          campaignId: testCampaignA.id,
          leadId: suppressedSingleLead.id,
          message: "Hello there!",
          userId: testUserA.id,
        });
      } catch (err) {
        thrownError = err;
      }

      assert(thrownError instanceof DncSuppressedError, "Must throw DncSuppressedError");
      assert.equal((thrownError as DncSuppressedError).statusCode, 409);
      assert.equal((thrownError as DncSuppressedError).code, "DNC_SUPPRESSED");

      // Verify no message was created in the DB
      const msgCount = await prisma.message.count({
        where: { leadId: suppressedSingleLead.id },
      });
      assert.equal(msgCount, 0, "No message row must be created for a suppressed lead");

      console.log("  ✓ sendSingleMessage throws DncSuppressedError (409) and creates no Message row");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 8 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 9: removeDoNotContact Restoration Logic
    // -------------------------------------------------------------
    console.log("\n[Test 9] removeDoNotContact restores lead status safely (user actor only)");
    try {
      const restorableLead = await prisma.lead.create({
        data: {
          campaignId: testCampaignA.id,
          username: `restore_target_${Date.now()}`,
          profileUrl: "https://instagram.com/restore_target",
          status: LeadStatus.QUALIFIED,
        },
      });

      // Add to DNC
      await addDoNotContact({
        userId: testUserA.id,
        entries: [
          {
            identifierType: DncIdentifierType.USERNAME,
            value: restorableLead.username!,
            channel: DncChannel.ALL,
          },
        ],
        source: DncSource.MANUAL,
        actor: "user:tester",
      });

      const dncEntry = await prisma.doNotContact.findFirst({
        where: {
          userId: testUserA.id,
          identifierNormalized: restorableLead.username!.toLowerCase(),
        },
      });
      assert(dncEntry, "DNC entry must exist");

      // 9a. Non-user actor must be rejected
      let nonUserError: unknown = null;
      try {
        await removeDoNotContact({
          userId: testUserA.id,
          entryId: dncEntry.id,
          actor: "system:worker",
        });
      } catch (err) {
        nonUserError = err;
      }
      assert(nonUserError instanceof BadRequestError, "Removal by non-user actor must throw BadRequestError");

      // 9b. Valid removal by user: restores status to QUALIFIED
      const removeRes = await removeDoNotContact({
        userId: testUserA.id,
        entryId: dncEntry.id,
        actor: "user:tester",
      });

      assert.equal(removeRes.success, true);
      assert.equal(removeRes.leadsRestored, 1);

      const restoredLead = await prisma.lead.findUnique({
        where: { id: restorableLead.id },
      });
      assert.equal(restoredLead?.status, LeadStatus.QUALIFIED);

      // Verify LeadStatusHistory recorded "dnc_removed"
      const restoreHistory = await prisma.leadStatusHistory.findMany({
        where: { leadId: restorableLead.id },
      });
      assert.equal(restoreHistory[restoreHistory.length - 1].reason, "dnc_removed");

      console.log("  ✓ removeDoNotContact enforces user actor, restores previous status, and logs history");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 9 failed:", err);
      failed++;
    }

    // -------------------------------------------------------------
    // Test 10: Multi-Tenant Isolation & List Pagination
    // -------------------------------------------------------------
    console.log("\n[Test 10] Multi-tenant isolation and list pagination");
    try {
      // User A entry
      await addDoNotContact({
        userId: testUserA.id,
        entries: [
          {
            identifierType: DncIdentifierType.USERNAME,
            value: `isolation_a_${Date.now()}`,
            channel: DncChannel.ALL,
          },
        ],
        actor: "user:user_a",
      });

      // User B entry
      await addDoNotContact({
        userId: testUserB.id,
        entries: [
          {
            identifierType: DncIdentifierType.USERNAME,
            value: `isolation_b_${Date.now()}`,
            channel: DncChannel.ALL,
          },
        ],
        actor: "user:user_b",
      });

      // User A listing
      const userAList = await listDoNotContact({
        userId: testUserA.id,
        page: 1,
        pageSize: 10,
      });

      // None of User B's entries should be in User A's list
      assert(userAList.items.every((it) => it.userId === testUserA.id));

      // User A attempting to delete User B entry must fail
      const userBEntry = await prisma.doNotContact.findFirst({
        where: { userId: testUserB.id },
      });
      assert(userBEntry);

      let deleteCrossTenantError: unknown = null;
      try {
        await removeDoNotContact({
          userId: testUserA.id,
          entryId: userBEntry.id,
          actor: "user:user_a",
        });
      } catch (err) {
        deleteCrossTenantError = err;
      }
      assert(deleteCrossTenantError !== null, "User A cannot delete User B's DNC entry");

      console.log("  ✓ Tenant isolation strictly enforced on listing and removal");
      passed++;
    } catch (err) {
      console.error("  ✗ Test 10 failed:", err);
      failed++;
    }

  } finally {
    // Cleanup test users and cascade relations
    try {
      await prisma.user.deleteMany({
        where: { id: { in: [testUserA.id, testUserB.id] } },
      });
    } catch {
      // Ignore cleanup error
    }
  }

  console.log(`\n========================================`);
  console.log(`STEP 2 TEST SUMMARY: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
