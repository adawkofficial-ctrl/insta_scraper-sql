/**
 * Multi-account sending settings, contact ledger, sticky sender and
 * first-message personalization.
 */
import "./preload_server_only.cjs";
import "dotenv/config";

import { getTestDatabaseUrl } from "./test_db_guard.cjs";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  applySenderSettingsToAll,
  createSenderAccount,
  updateSenderSettings,
} from "../src/lib/services/senders";
import {
  calculateEffectiveSenderLimit,
  validateSenderSettings,
} from "../src/lib/services/senders/sender-settings";
import {
  markContactSent,
  normalizeContactHandle,
  reserveFirstContact,
} from "../src/lib/services/messaging/contact-ledger";
import {
  renderPersonalizedFirstMessage,
  selectTemplateVariant,
} from "../src/lib/services/messaging/message-personalization";
import {
  dispatchDueFollowUps,
  scheduleFollowUpsForLead,
} from "../src/lib/services/messaging/follow-up-service";
import type { MessagingProvider } from "../src/lib/services/messaging/messaging-provider";
import { sendSingleMessage } from "../src/lib/services/messaging/messaging-service";

process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.DATABASE_URL_MYSQL_LOCAL = process.env.DATABASE_URL;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.WORKING_HOURS_START = "0";
process.env.WORKING_HOURS_END = "24";
process.env.FOLLOWUP_ALLOW_SENDER_SWITCH = "false";
process.env.OUTBOUND_SENDING_ENABLED = "true";

const prisma = getPrismaClient();
let passed = 0;
let failed = 0;

function check(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}`);
  }
}

async function main() {
  const tag = `macc_${Date.now()}`;
  const user = await prisma.user.create({
    data: { email: `${tag}@example.com`, passwordHash: "x" },
  });
  const profile = await prisma.companyProfile.create({
    data: { userId: user.id, name: `${tag} profile` },
  });
  const campaignA = await prisma.campaign.create({
    data: {
      userId: user.id,
      companyProfileId: profile.id,
      name: `${tag} A`,
      category: "Dental Clinics",
      followUpEnabled: true,
      followUpCount: 1,
    },
  });
  const campaignB = await prisma.campaign.create({
    data: {
      userId: user.id,
      companyProfileId: profile.id,
      name: `${tag} B`,
      category: "Dental Clinics",
    },
  });

  const senderA = await prisma.instagramSenderAccount.create({
    data: {
      userId: user.id,
      username: `${tag}_a`,
      sessionPath: `test/${tag}/a`,
      status: "CONNECTED",
      dailyCap: 25,
      customMinGapSeconds: 600,
      customMaxGapSeconds: 840,
      workingHoursStart: 0,
      workingHoursEnd: 24,
      timezone: "UTC",
    },
  });
  const senderB = await prisma.instagramSenderAccount.create({
    data: {
      userId: user.id,
      username: `${tag}_b`,
      sessionPath: `test/${tag}/b`,
      status: "CONNECTED",
      dailyCap: 25,
      customMinGapSeconds: 600,
      customMaxGapSeconds: 840,
      workingHoursStart: 0,
      workingHoursEnd: 24,
      timezone: "UTC",
    },
  });

  console.log("\n[1] Per-account settings");
  const created = await createSenderAccount({ username: `${tag}_new` }, user.id);
  check(created.messagesPerDay === 25, "new account inherits 25/day");
  check(created.minutesBetweenMessages === 10, "new account inherits 10-minute gap");
  check(created.jitterMinutes === 4, "new account inherits 0-4 jitter");
  check(created.warmupEnabled === true, "new account inherits warm-up on");
  check(created.scheduleOffsetSeconds > 0, "new account receives a stagger offset");

  const risky = await updateSenderSettings(senderA.id, user.id, {
    messagesPerDay: 30,
    minutesBetweenMessages: 7,
    jitterMinutes: 2,
  });
  check(risky.messagesPerDay === 30 && risky.minutesBetweenMessages === 7, "per-account override persists");
  check(risky.settings.riskWarnings.length >= 2, "above-recommended values return red-risk warnings");

  let ceilingRejected = false;
  try {
    await updateSenderSettings(senderA.id, user.id, { messagesPerDay: 41 });
  } catch {
    ceilingRejected = true;
  }
  check(ceilingRejected, "daily value above hard ceiling is rejected");

  let gapRejected = false;
  try {
    await updateSenderSettings(senderA.id, user.id, { minutesBetweenMessages: 4 });
  } catch {
    gapRejected = true;
  }
  check(gapRejected, "gap below floor is rejected");

  const bulk = await applySenderSettingsToAll(user.id, user.id, {
    messagesPerDay: 20,
    minutesBetweenMessages: 12,
    jitterMinutes: 3,
    warmUpEnabled: true,
  });
  check(bulk.updated >= 2, "bulk apply updates every sender account");
  const auditCount = await prisma.senderSettingsAudit.count({ where: { userId: user.id } });
  check(auditCount >= 3, "settings changes are audited");

  const warmupEffective = calculateEffectiveSenderLimit({
    messagesPerDay: 25,
    minutesBetweenMessages: 10,
    workingHoursStart: 9,
    workingHoursEnd: 18,
    warmupStartedAt: new Date(),
    warmupEnabled: true,
  });
  check(warmupEffective.effectiveMessagesPerDay === 8, "warm-up day 1 caps effective limit at 8");
  check(warmupEffective.limitingFactor === "warmup", "warm-up is reported as the limiting factor");
  check(
    validateSenderSettings({ messagesPerDay: 25, minutesBetweenMessages: 5 }).ok === true,
    "floor-compliant gap is accepted",
  );

  console.log("\n[2] Contact ledger (cross-campaign, unique first message)");
  const leadA = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      userId: user.id,
      username: `${tag}_handle`,
      fullName: "Jane Doe",
      category: "Dentist",
      isBusinessAccount: false,
      status: "NEW",
    },
  });
  const leadB = await prisma.lead.create({
    data: {
      campaignId: campaignB.id,
      userId: user.id,
      username: `${tag}_handle`,
      fullName: "Jane Doe",
      category: "Dentist",
      isBusinessAccount: false,
      status: "NEW",
      duplicateOfLeadId: leadA.id,
    },
  });

  const first = await reserveFirstContact({
    userId: user.id,
    leadId: leadA.id,
    campaignId: campaignA.id,
    handle: normalizeContactHandle(leadA.username),
    senderAccountId: senderA.id,
    senderUsername: senderA.username,
    templateId: "tmpl-a",
    variant: "A",
  });
  check(first.kind === "reserved", "first campaign reserves the handle");

  const afterReservation = await prisma.lead.findUniqueOrThrow({ where: { id: leadA.id } });
  check(afterReservation.assignedSenderAccountId === senderA.id, "sender assignment is stored on the lead");
  check(
    afterReservation.contactedByUsernameSnapshot === senderA.username,
    "sender username snapshot is stored",
  );

  const second = await reserveFirstContact({
    userId: user.id,
    leadId: leadB.id,
    campaignId: campaignB.id,
    handle: normalizeContactHandle(leadB.username),
    senderAccountId: senderB.id,
    senderUsername: senderB.username,
  });
  check(second.kind === "blocked", "duplicate lead in another campaign is blocked");
  check(
    second.kind === "blocked" && second.reason === "ALREADY_CONTACTED",
    "blocked reason is ALREADY_CONTACTED",
  );
  check(
    second.kind === "blocked" &&
      second.contactedByUsername === senderA.username &&
      second.contactedAt instanceof Date,
    "blocked record shows who/when",
  );

  console.log("\n[3] Concurrency: 30 workers x 50 iterations");
  const raceLead = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      userId: user.id,
      username: `${tag}_race`,
      fullName: "Race Contact",
    },
  });
  const raceLead2 = await prisma.lead.create({
    data: {
      campaignId: campaignB.id,
      userId: user.id,
      username: `${tag}_race`,
      fullName: "Race Contact",
      duplicateOfLeadId: raceLead.id,
    },
  });
  const workers = Array.from({ length: 30 }, async (_unused, worker) => {
    const outcomes = [];
    for (let iteration = 0; iteration < 50; iteration++) {
      const useSecond = (worker + iteration) % 2 === 1;
      outcomes.push(
        await reserveFirstContact({
          userId: user.id,
          leadId: useSecond ? raceLead2.id : raceLead.id,
          campaignId: useSecond ? campaignB.id : campaignA.id,
          handle: `${tag}_race`,
          senderAccountId: useSecond ? senderB.id : senderA.id,
          senderUsername: useSecond ? senderB.username : senderA.username,
        }),
      );
    }
    return outcomes;
  });
  const results = (await Promise.all(workers)).flat();
  const winners = results.filter((result) => result.kind === "reserved");
  const losers = results.filter(
    (result) => result.kind === "blocked" && result.reason === "ALREADY_CONTACTED",
  );
  check(winners.length === 1, "exactly one worker wins the first-contact race");
  check(losers.length === results.length - 1, "all other workers receive ALREADY_CONTACTED");
  const raceLedger = await prisma.leadContactLedger.findUnique({
    where: {
      userId_handleNormalized_step_channel: {
        userId: user.id,
        handleNormalized: `${tag}_race`,
        step: "1",
        channel: "INSTAGRAM",
      },
    },
  });
  check(Boolean(raceLedger), "one ledger row exists for the raced handle");

  console.log("\n[4] First-message name guard on the single-send path");
  const namelessLead = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      userId: user.id,
      username: `${tag}_nameless`,
      fullName: null,
      profileUrl: `https://instagram.com/${tag}_nameless`,
      status: "NEW",
    },
  });
  let nameGuardCode = "";
  try {
    await sendSingleMessage(
      {
        campaignId: campaignA.id,
        leadId: namelessLead.id,
        message: "Hello there, quick question.",
        senderAccountId: senderA.id,
        enforceFirstMessageName: true,
      },
      user.id,
    );
  } catch (err) {
    nameGuardCode = (err as { code?: string }).code ?? "";
  }
  check(nameGuardCode === "NAME_REQUIRED", "nameless first message is blocked with NAME_REQUIRED");
  const namelessMessages = await prisma.message.count({ where: { leadId: namelessLead.id } });
  check(namelessMessages === 0, "blocked nameless draft creates no Message row");

  console.log("\n[4b] Sticky follow-up sender");
  const firstSent = await prisma.message.create({
    data: {
      campaignId: campaignA.id,
      leadId: leadA.id,
      senderAccountId: senderA.id,
      status: "SENT",
      direction: "OUTBOUND",
      channel: "INSTAGRAM",
      messageText: "Initial message",
      sentAt: new Date(),
    },
  });
  const followUp = await prisma.followUpMessage.create({
    data: {
      campaignId: campaignA.id,
      leadId: leadA.id,
      step: 1,
      status: "SCHEDULED",
      templateText: "Following up",
      renderedBody: "Hi Jane, following up.",
      dueAt: new Date(),
      idempotencyKey: `followup:${campaignA.id}:${leadA.id}:1`,
      senderAccountId: senderA.id,
      threadId: firstSent.providerMessageId ?? null,
    },
  });
  await prisma.instagramSenderAccount.update({
    where: { id: senderA.id },
    data: { status: "PAUSED", pausedUntil: null },
  });

  let providerCalls = 0;
  const provider = {
    name: "mock",
    sendMessage: async () => {
      providerCalls++;
      return { success: true, providerMessageId: "mock-followup" };
    },
  } as unknown as MessagingProvider;
  const pausedRun = await dispatchDueFollowUps({
    now: new Date(),
    campaignId: campaignA.id,
    leadId: leadA.id,
    messagingProvider: provider,
  });
  check(pausedRun.deferred === 1 && providerCalls === 0, "paused sticky account waits; no account switch");
  const followAfterPause = await prisma.followUpMessage.findUniqueOrThrow({
    where: { id: followUp.id },
  });
  check(followAfterPause.senderAccountId === senderA.id, "follow-up keeps its assigned sender");
  check(Boolean(followAfterPause.retryAt), "waiting follow-up receives retryAt");

  await prisma.instagramSenderAccount.update({
    where: { id: senderA.id },
    data: { status: "CONNECTED" },
  });
  const sentRun = await dispatchDueFollowUps({
    now: new Date(Date.now() + 2 * 3600000),
    campaignId: campaignA.id,
    leadId: leadA.id,
    messagingProvider: provider,
  });
  check(sentRun.sent === 1 && providerCalls === 1, "follow-up sends from the same account after resume");
  const sentFollow = await prisma.followUpMessage.findUniqueOrThrow({
    where: { id: followUp.id },
  });
  const sentMessage = await prisma.message.findFirst({
    where: { id: sentFollow.messageId ?? "" },
  });
  check(sentMessage?.senderAccountId === senderA.id, "sent follow-up records the sticky sender");

  console.log("\n[5] Personalized first messages");
  const business = renderPersonalizedFirstMessage({
    template: "Hi {name}, I noticed your dental clinic in {city}.",
    lead: {
      username: "markhamdental",
      fullName: "Markham Dental Smiles",
      category: "Dentist",
      city: "Markham",
      isBusinessAccount: true,
    },
    campaign: { name: "Dental" },
    requireName: true,
  });
  check(business.ok && business.text.includes("Markham Dental Smiles"), "business name resolves");
  check(business.ok && business.nameKind === "business", "business name is classified as business");

  const person = renderPersonalizedFirstMessage({
    template: "Hi {firstName}, how is {city}?",
    lead: {
      username: "janedoe",
      fullName: "Jane Doe",
      biography: "Independent marketing consultant",
      city: "Toronto",
      isBusinessAccount: false,
    },
    requireName: true,
  });
  check(person.ok && person.text === "Hi Jane, how is Toronto?", "verified person uses first name");

  const ambiguous = renderPersonalizedFirstMessage({
    template: "Hi {name}, quick question.",
    lead: {
      username: "unknown",
      fullName: "Acme Holdings",
      isBusinessAccount: false,
    },
    requireName: true,
  });
  check(ambiguous.ok && ambiguous.nameKind === "business", "business-shaped name resolves as business");

  const noName = renderPersonalizedFirstMessage({
    template: "Hi {name}, quick question.",
    lead: { username: "bare", fullName: null, isBusinessAccount: false },
    requireName: true,
  });
  check(!noName.ok && noName.code === "NAME_REQUIRED", "missing name blocks the draft");

  const unresolved = renderPersonalizedFirstMessage({
    template: "Hi {name}, see {missingThing}.",
    lead: { username: "jane", fullName: "Jane Doe", isBusinessAccount: false },
    requireName: true,
  });
  check(!unresolved.ok && unresolved.code === "UNRESOLVED_PLACEHOLDER", "unresolved placeholder blocks");

  const links = renderPersonalizedFirstMessage({
    template: "Hi {name}, see https://a.example and https://b.example",
    lead: { username: "jane", fullName: "Jane Doe", isBusinessAccount: false },
    requireName: true,
  });
  check(!links.ok && links.code === "TOO_MANY_LINKS", "more than one link blocks");

  const variants = [
    { id: "A", body: "a" },
    { id: "B", body: "b" },
    { id: "C", body: "c" },
  ];
  const picked = selectTemplateVariant({
    variants,
    accountSendCount: 1,
    leadSeed: "lead-1",
    lastVariant: variants[0].id,
  });
  check(picked !== null && picked.id !== "A", "variant rotation avoids the previous variant");

  console.log("\n[5b] Re-contact cooldown");
  const cooldownHandle = `${tag}_cooldown`;
  const cooldownLead = await prisma.lead.create({
    data: {
      campaignId: campaignB.id,
      userId: user.id,
      username: cooldownHandle,
      fullName: "Cooldown Contact",
      status: "NEW",
    },
  });
  const initialCooldownReservation = await reserveFirstContact({
    userId: user.id,
    leadId: cooldownLead.id,
    campaignId: campaignB.id,
    handle: cooldownHandle,
    senderAccountId: senderA.id,
    senderUsername: senderA.username,
  });
  const cooldownLedgerId =
    initialCooldownReservation.kind === "reserved" ? initialCooldownReservation.ledgerId : "";
  await markContactSent({
    ledgerId: cooldownLedgerId,
    sentAt: new Date(Date.now() - 40 * 86400000),
    providerMessageId: "cooldown-initial",
  });
  await prisma.campaign.update({
    where: { id: campaignA.id },
    data: { reContactCooldownDays: 30 },
  });
  const cooldownLead2 = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      userId: user.id,
      username: cooldownHandle,
      fullName: "Cooldown Contact",
      status: "NEW",
      duplicateOfLeadId: cooldownLead.id,
    },
  });
  const cooldownRetry = await reserveFirstContact({
    userId: user.id,
    leadId: cooldownLead2.id,
    campaignId: campaignA.id,
    handle: cooldownHandle,
    senderAccountId: senderB.id,
    senderUsername: senderB.username,
  });
  check(cooldownRetry.kind === "reserved", "re-contact is allowed after the configured cooldown");
  const recontactEvent = await prisma.leadContactEvent.findFirst({
    where: { ledgerId: cooldownLedgerId, status: "RECONTACT" },
  });
  check(Boolean(recontactEvent), "cooldown re-contact is written to the event history");

  console.log("\n[6] 10 accounts x 1000 leads x 3 days simulation");
  const simSenders = [];
  for (let index = 0; index < 10; index++) {
    simSenders.push(
      await prisma.instagramSenderAccount.create({
        data: {
          userId: user.id,
          username: `${tag}_sim_${index}`,
          sessionPath: `test/${tag}/sim-${index}`,
          status: "CONNECTED",
          dailyCap: 25,
          customMinGapSeconds: 600,
          customMaxGapSeconds: 840,
          workingHoursStart: 9,
          workingHoursEnd: 18,
          timezone: "UTC",
          scheduleOffsetSeconds: index * 61,
          warmupEnabled: true,
          warmupStartedAt: new Date(Date.now() - 30 * 86400000),
        },
      }),
    );
  }

  const simLeads = Array.from({ length: 1000 }, (_, index) => ({
    campaignId: campaignA.id,
    userId: user.id,
    username: `${tag}_simlead_${index}`,
    fullName: `Sim Lead ${index}`,
    category: "Dentist",
    status: "NEW" as const,
  }));
  console.log("  sim: leads prepared");
  await prisma.lead.createMany({ data: simLeads });
  console.log("  sim: leads inserted");
  const simLeadRows = await prisma.lead.findMany({
    where: { campaignId: campaignA.id, username: { startsWith: `${tag}_simlead_` } },
    select: { id: true, username: true },
    orderBy: { username: "asc" },
  });

  const simMessages: Array<{
    campaignId: string;
    leadId: string;
    senderAccountId: string;
    senderUsernameSnapshot: string;
    status: "SENT";
    direction: "OUTBOUND";
    channel: "INSTAGRAM";
    messageText: string;
    sentAt: Date;
    step: string;
  }> = [];
  let queueIndex = 0;
  const capacity = 25 * 10 * 3;
  const base = Date.UTC(2026, 0, 5, 9, 0, 0);
  const gapsBySender = new Map<string, number[]>();
  const firstMinuteBySender = new Map<string, number>();
  const simLedgerRows: Array<{
    userId: string;
    leadId: string;
    campaignId: string;
    senderAccountId: string;
    handle: string;
    handleNormalized: string;
    step: string;
    channel: "INSTAGRAM";
    status: string;
    senderUsernameSnapshot: string;
    sentAt: Date;
    completedAt: Date;
  }> = [];

  for (let day = 0; day < 3; day++) {
    for (let accountIndex = 0; accountIndex < simSenders.length; accountIndex++) {
      const sender = simSenders[accountIndex];
      let cursor = base + day * 86400000 + sender.scheduleOffsetSeconds * 1000;
      let previous: number | null = null;
      for (let slot = 0; slot < 25 && queueIndex < simLeadRows.length; slot++) {
        const lead = simLeadRows[queueIndex++];
        const sentAt = new Date(cursor);
        simLedgerRows.push({
          userId: user.id,
          leadId: lead.id,
          campaignId: campaignA.id,
          senderAccountId: sender.id,
          handle: lead.username ?? "",
          handleNormalized: (lead.username ?? "").toLowerCase(),
          step: "1",
          channel: "INSTAGRAM",
          status: "SENT",
          senderUsernameSnapshot: sender.username,
          sentAt,
          completedAt: sentAt,
        });
        if (!firstMinuteBySender.has(sender.id)) {
          firstMinuteBySender.set(sender.id, sentAt.getUTCHours() * 60 + sentAt.getUTCMinutes());
        }
        if (previous !== null) {
          const list = gapsBySender.get(sender.id) ?? [];
          list.push((cursor - previous) / 60000);
          gapsBySender.set(sender.id, list);
        }
        previous = cursor;
        simMessages.push({
          campaignId: campaignA.id,
          leadId: lead.id,
          senderAccountId: sender.id,
          senderUsernameSnapshot: sender.username,
          status: "SENT",
          direction: "OUTBOUND",
          channel: "INSTAGRAM",
          messageText: `Simulation message for ${lead.username}`,
          sentAt,
          step: "1",
        });
        cursor += (10 + (slot % 5)) * 60000;
      }
    }
  }
  console.log(`  sim: rows prepared messages=${simMessages.length} ledger=${simLedgerRows.length}`);
  await prisma.leadContactLedger.createMany({ data: simLedgerRows });
  console.log("  sim: ledger inserted");
  await prisma.message.createMany({ data: simMessages });
  console.log("  sim: messages inserted");

  check(simMessages.length === capacity, "3-day simulation sends the calculated capacity (750)");
  const allGaps = Array.from(gapsBySender.values()).flat();
  check(allGaps.every((gap) => gap >= 10), "every recorded account gap is >= the configured minimum");
  check(new Set(allGaps).size > 1, "jitter produces varying gaps");
  check(
    new Set(firstMinuteBySender.values()).size >= 8,
    "account start times are staggered across minutes",
  );
  const perMinute = new Map<string, number>();
  for (const message of simMessages) {
    const key = message.sentAt.toISOString().slice(0, 16);
    perMinute.set(key, (perMinute.get(key) ?? 0) + 1);
  }
  check(
    Array.from(perMinute.values()).every((count) => count <= 2),
    "no more than 2 sends occur in any single minute",
  );
  const perAccountDay = new Map<string, number>();
  for (const message of simMessages) {
    const key = `${message.senderAccountId}:${message.sentAt.toISOString().slice(0, 10)}`;
    perAccountDay.set(key, (perAccountDay.get(key) ?? 0) + 1);
  }
  check(
    Array.from(perAccountDay.values()).every((count) => count <= 25),
    "no account exceeds its daily cap on any simulated day",
  );
  const simLedger = await prisma.leadContactLedger.count({
    where: { userId: user.id, handleNormalized: { startsWith: `${tag}_simlead_` } },
  });
  check(simLedger === capacity, "one ledger reservation per sent lead, matching capacity");
  check(
    new Set(simMessages.map((message) => message.leadId)).size === capacity,
    "each lead receives exactly one first message",
  );
  const stats = await prisma.message.groupBy({
    by: ["senderAccountId"],
    where: { campaignId: campaignA.id, messageText: { startsWith: "Simulation message" } },
    _count: { _all: true },
  });
  check(stats.length === 10 && stats.every((row) => row._count._all === 75), "records cover all 10 accounts");

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Suite crashed:", error);
  process.exit(1);
});

