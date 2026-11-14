/**
 * Email channel tests. SMTP transport is mocked; no real email is sent.
 */

import "./preload_server_only.cjs";
import "dotenv/config";

import crypto from "node:crypto";
import type { Transporter } from "nodemailer";

import { getPrismaClient } from "../src/lib/db/prisma";
import { encryptSecret } from "../src/lib/services/email/email-crypto";
import { setEmailTransportForTesting } from "../src/lib/services/email/email-transport";
import { canSendEmailNow, getEffectiveDailyCap } from "../src/lib/services/email/email-gate";
import { checkEmailDns } from "../src/lib/services/email/email-dns";
import { sendEmailForLead } from "../src/lib/services/email/email-send-service";
import { sanitizeEmailAccount } from "../src/lib/services/email/email-account-service";
import { processEmailUnsubscribe } from "../src/lib/services/email/email-unsubscribe-service";
import { checkEmailAddress } from "../src/lib/services/email/email-address-quality";
import { scoreFlagCreate, withLeadChannelFlags } from "../src/lib/services/lead/lead-channels";

let passed = 0;
let failed = 0;
function check(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail === undefined ? "" : ` -> ${String(detail)}`}`);
    failed++;
  }
}

type SentMail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
};

function makeTransport(options: {
  sent: SentMail[];
  failWith?: Error;
  failOnCall?: number;
}): Transporter {
  let calls = 0;
  return {
    verify: async () => true,
    sendMail: async (message: Record<string, unknown>) => {
      calls++;
      if (options.failWith && (!options.failOnCall || calls >= options.failOnCall)) {
        throw options.failWith;
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((message.headers as Record<string, string>) ?? {})) {
        headers[key] = String(value);
      }
      options.sent.push({
        from: String(message.from),
        to: String(message.to),
        subject: String(message.subject),
        text: String(message.text),
        headers,
      });
      return {
        messageId: `<test-${calls}@example.test>`,
        accepted: [String(message.to)],
        rejected: [],
        response: "250 OK",
      };
    },
  } as unknown as Transporter;
}

async function main(): Promise<void> {
  console.log("================================================");
  console.log("  EMAIL CHANNEL TESTS (MOCK SMTP)");
  console.log("================================================\n");

  process.env.EMAIL_CREDENTIALS_KEY = crypto.randomBytes(32).toString("hex");
  process.env.APP_PUBLIC_URL = "https://app.example.test";
  process.env.EMAIL_COMPANY_NAME = "Test Co";
  process.env.EMAIL_DAILY_CAP = "15";
  process.env.EMAIL_HOURLY_CAP = "4";
  process.env.EMAIL_DAILY_HARD_MAX = "30";
  process.env.EMAIL_JITTER_MIN_SECONDS = "0";
  process.env.EMAIL_JITTER_MAX_SECONDS = "0";
  process.env.EMAIL_WORKING_HOURS_START = "9";
  process.env.EMAIL_WORKING_HOURS_END = "17";

  const prisma = getPrismaClient();
  const suffix = Date.now();
  const user = await prisma.user.create({
    data: {
      email: `email-channel-${suffix}@example.test`,
      passwordHash: "test-hash",
      name: "Email Test",
    },
  });
  const companyProfile = await prisma.companyProfile.create({
    data: { userId: user.id, name: "Test Co" },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      name: "Email Campaign",
      companyProfileId: companyProfile.id,
    },
  });
  const account = await prisma.emailSenderAccount.create({
    data: {
      userId: user.id,
      fromName: "Test Sender",
      fromAddress: "sender@example.test",
      postalAddress: "1 Test Street, Toronto, ON",
      smtpHost: "smtp.example.test",
      smtpPort: 587,
      smtpUser: "smtp-user",
      smtpPasswordEncrypted: encryptSecret("super-secret-smtp-password"),
      secure: true,
      status: "ACTIVE",
      dailyCap: 15,
      hourlyCap: 4,
      warmupStartedAt: new Date(Date.now() - 10 * 86_400_000),
      spfStatus: "PASS",
      dkimStatus: "PASS",
      dmarcStatus: "PASS",
    },
  });

  async function makeLead(input: {
    email: string;
    fullName?: string;
    username?: string | null;
    groupKey?: string | null;
  }) {
    return prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        email: input.email,
        emailNormalized: input.email.toLowerCase(),
        fullName: input.fullName ?? "Test Business",
        username: input.username ?? null,
        city: "Toronto",
        groupKey: input.groupKey ?? null,
        emailSourceUrl: "https://example.test/contact",
        emailFoundAt: new Date(),
        emailConfidence: 0.9,
        ...withLeadChannelFlags(["EMAIL"]),
        source: "test",
      },
    });
  }

  const mondayMorning = new Date("2026-11-09T15:00:00.000Z"); // 10:00 America/Toronto
  const prevOutbound = process.env.OUTBOUND_SENDING_ENABLED;

  try {
    await prisma.emailCampaignSettings.create({
      data: {
        campaignId: campaign.id,
        subjectTemplate: "Question for {businessName}",
        bodyTemplate: "Hi, I had a question about {businessName} in {city}.",
        enabled: true,
      },
    });

    // -----------------------------------------------------------------
    console.log("[1. Kill switch, APP_PUBLIC_URL, address quality]");
    const leadA = await makeLead({ email: "owner@alpha-dental.example" });
    process.env.OUTBOUND_SENDING_ENABLED = "false";
    const blocked = await canSendEmailNow({
      senderAccountId: account.id,
      campaignId: campaign.id,
      leadId: leadA.id,
      now: mondayMorning,
      recipientTimeZone: "America/Toronto",
    });
    check(!blocked.allowed && /OUTBOUND_SENDING_ENABLED/.test(blocked.reason), "OUTBOUND_SENDING_ENABLED=false blocks email");
    process.env.OUTBOUND_SENDING_ENABLED = "true";

    const prevUrl = process.env.APP_PUBLIC_URL;
    delete process.env.APP_PUBLIC_URL;
    const noUrl = await canSendEmailNow({
      senderAccountId: account.id,
      campaignId: campaign.id,
      leadId: leadA.id,
      now: mondayMorning,
      recipientTimeZone: "America/Toronto",
    });
    check(!noUrl.allowed && /APP_PUBLIC_URL/.test(noUrl.reason), "sending refused without APP_PUBLIC_URL");
    process.env.APP_PUBLIC_URL = prevUrl;

    check((await checkEmailAddress("noreply@example.test")).valid === false, "noreply@ rejected");
    check((await checkEmailAddress("privacy@example.test")).valid === false, "privacy@ rejected");
    check((await checkEmailAddress("info@example.test")).valid === true, "info@ allowed");
    check((await checkEmailAddress("info@example.test")).role === "generic", "info@ marked generic role");
    check((await checkEmailAddress("not-an-email")).valid === false, "invalid syntax rejected");

    const base = new Date("2026-11-09T15:00:00.000Z");
    check(getEffectiveDailyCap(15, new Date(base.getTime() - 2 * 86_400_000), base) === 5, "warm-up days 1-3 cap 5");
    check(getEffectiveDailyCap(15, new Date(base.getTime() - 5 * 86_400_000), base) === 10, "warm-up days 4-7 cap 10");
    check(getEffectiveDailyCap(15, new Date(base.getTime() - 20 * 86_400_000), base) === 15, "warm-up day 8+ uses configured cap");

    const dnsHealth = await checkEmailDns("sender@example.test", "mail", async (name) => {
      if (name === "example.test") return [["v=spf1 include:_spf.example.test ~all"]];
      if (name === "mail._domainkey.example.test") return [["v=DKIM1; k=rsa; p=abc"]];
      if (name === "_dmarc.example.test") return [["v=DMARC1; p=quarantine"]];
      return [];
    });
    check(dnsHealth.spf === "PASS", "SPF DNS check");
    check(dnsHealth.dkim === "PASS", "DKIM DNS check with selector");
    check(dnsHealth.dmarc === "PASS", "DMARC DNS check");

    // -----------------------------------------------------------------
    console.log("[2. Exactly one email, footer + headers, compliance record]");
    const sent: SentMail[] = [];
    setEmailTransportForTesting(makeTransport({ sent }));
    const first = await sendEmailForLead({
      leadId: leadA.id,
      campaignId: campaign.id,
      senderAccountId: account.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(first.status === "SENT", "first email sent", first);
    check(sent.length === 1, "transport called once");
    check(sent[0].text.includes("Unsubscribe:"), "footer includes unsubscribe URL");
    check(sent[0].text.includes("reply STOP"), "footer includes reply STOP instruction");
    check(sent[0].text.includes("1 Test Street"), "footer includes postal address");
    check(Boolean(sent[0].headers["List-Unsubscribe"]), "List-Unsubscribe header present");
    check(
      sent[0].headers["List-Unsubscribe"]?.includes("mailto:") &&
        sent[0].headers["List-Unsubscribe"]?.includes("https://"),
      "List-Unsubscribe has mailto + https",
    );
    check(sent[0].headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", "List-Unsubscribe-Post present");

    const stored = await prisma.emailSend.findUnique({ where: { leadId: leadA.id } });
    check(stored?.status === "SENT" && Boolean(stored.messageId), "compliance record stored with message-id");
    check(stored?.addressSource === "https://example.test/contact", "address source stored");
    check(Boolean(stored?.senderIdentity), "sender identity stored");

    const second = await sendEmailForLead({
      leadId: leadA.id,
      campaignId: campaign.id,
      senderAccountId: account.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(second.status !== "SENT", "second attempt is blocked", second.status);
    check(sent.length === 1, "no second transport call");

    // -----------------------------------------------------------------
    console.log("[3. Working hours, placeholders, spam, role addresses]");
    const saturday = new Date("2026-11-07T15:00:00.000Z");
    const leadHours = await makeLead({ email: "hours@beta-dental.example" });
    const hours = await canSendEmailNow({
      senderAccountId: account.id,
      campaignId: campaign.id,
      leadId: leadHours.id,
      now: saturday,
      recipientTimeZone: "America/Toronto",
    });
    check(!hours.allowed && /working hours/.test(hours.reason), "weekend blocked by working hours");

    const leadPlaceholder = await makeLead({ email: "owner@gamma-dental.example" });
    await prisma.emailCampaignSettings.update({
      where: { campaignId: campaign.id },
      data: { subjectTemplate: "Hi {firstName}", bodyTemplate: "Body for {businessName}" },
    });
    const placeholder = await sendEmailForLead({
      leadId: leadPlaceholder.id,
      campaignId: campaign.id,
      senderAccountId: account.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(placeholder.status === "NEEDS_EDIT" && /firstName/.test(placeholder.reason ?? ""), "unresolved placeholder blocked", placeholder);

    await prisma.emailCampaignSettings.update({
      where: { campaignId: campaign.id },
      data: {
        subjectTemplate: "FREE!!! ACT NOW for {businessName}",
        bodyTemplate: "Guaranteed results for {businessName} in {city}",
      },
    });
    const spammy = await sendEmailForLead({
      leadId: leadPlaceholder.id,
      campaignId: campaign.id,
      senderAccountId: account.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(spammy.status === "NEEDS_EDIT", "spammy content blocked", spammy);

    await prisma.emailCampaignSettings.update({
      where: { campaignId: campaign.id },
      data: {
        subjectTemplate: "Question for {businessName}",
        bodyTemplate: "Hi, quick question about {businessName} in {city}.",
      },
    });

    // -----------------------------------------------------------------
    console.log("[4. Caps, DNC, group dedup, cross-channel]");
    const capAccount = await prisma.emailSenderAccount.create({
      data: {
        userId: user.id,
        fromName: "Cap Sender",
        fromAddress: "caps@example.test",
        postalAddress: "1 Test Street, Toronto, ON",
        smtpHost: "smtp.example.test",
        smtpPort: 587,
        smtpUser: "smtp-user",
        smtpPasswordEncrypted: encryptSecret("cap-secret"),
        secure: true,
        status: "ACTIVE",
        dailyCap: 15,
        hourlyCap: 1,
        warmupStartedAt: new Date(Date.now() - 10 * 86_400_000),
        spfStatus: "PASS",
        dkimStatus: "PASS",
        dmarcStatus: "PASS",
      },
    });
    const leadCap = await makeLead({ email: "owner@delta-dental.example" });
    const cap1 = await sendEmailForLead({
      leadId: leadCap.id,
      campaignId: campaign.id,
      senderAccountId: capAccount.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(cap1.status === "SENT", "cap test first send succeeds", cap1);
    const leadCap2 = await makeLead({ email: "owner@epsilon-dental.example" });
    const cap2 = await canSendEmailNow({
      senderAccountId: capAccount.id,
      campaignId: campaign.id,
      leadId: leadCap2.id,
      now: mondayMorning,
      recipientTimeZone: "America/Toronto",
    });
    const cap2Reason = cap2.allowed ? "" : cap2.reason;
    check(!cap2.allowed && /Hourly/.test(cap2Reason), "hourly cap blocks next send", cap2Reason);

    const leadDnc = await makeLead({ email: "owner@zeta-dental.example" });
    await prisma.doNotContact.create({
      data: {
        userId: user.id,
        channel: "EMAIL",
        identifierType: "DOMAIN",
        identifierNormalized: "zeta-dental.example",
        reason: "test",
        source: "MANUAL",
      },
    });
    const dnc = await canSendEmailNow({
      senderAccountId: account.id,
      campaignId: campaign.id,
      leadId: leadDnc.id,
      now: mondayMorning,
      recipientTimeZone: "America/Toronto",
    });
    check(!dnc.allowed && /Do Not Contact/.test(dnc.reason), "DNC by domain blocks email");

    const leadGroup1 = await makeLead({ email: "one@shared-dental.example" });
    const leadGroup2 = await makeLead({ email: "two@shared-dental.example" });
    const group1 = await sendEmailForLead({
      leadId: leadGroup1.id,
      campaignId: campaign.id,
      senderAccountId: account.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(group1.status === "SENT", "group first email sent");
    const group2 = await sendEmailForLead({
      leadId: leadGroup2.id,
      campaignId: campaign.id,
      senderAccountId: account.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(group2.status !== "SENT", "one email per domain/group per campaign", group2.status);

    const leadDm = await makeLead({ email: "owner@eta-dental.example" });
    await prisma.message.create({
      data: {
        campaignId: campaign.id,
        leadId: leadDm.id,
        messageText: "DM already sent",
        status: "SENT",
        direction: "OUTBOUND",
      },
    });
    const dmBlocked = await canSendEmailNow({
      senderAccountId: account.id,
      campaignId: campaign.id,
      leadId: leadDm.id,
      now: mondayMorning,
      recipientTimeZone: "America/Toronto",
    });
    check(!dmBlocked.allowed && /Instagram DM/.test(dmBlocked.reason), "lead contacted by DM is never emailed");

    // -----------------------------------------------------------------
    console.log("[5. Unsubscribe token marks DNC]");
    const leadUnsub = await makeLead({ email: "owner@theta-dental.example" });
    const unsubSend = await sendEmailForLead({
      leadId: leadUnsub.id,
      campaignId: campaign.id,
      senderAccountId: account.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(unsubSend.status === "SENT", "unsubscribe target email sent");
    const tokenRow = await prisma.emailUnsubscribeToken.findFirst({
      where: { leadId: leadUnsub.id },
    });
    check(Boolean(tokenRow), "unsubscribe token stored");
    const unsub = await processEmailUnsubscribe(tokenRow!.token);
    check(unsub.ok, "unsubscribe processed", unsub);
    const unsubLead = await prisma.lead.findUnique({ where: { id: leadUnsub.id } });
    check(Boolean(unsubLead?.emailOptOutAt), "lead marked opted out");
    const dncRows = await prisma.doNotContact.findMany({ where: { userId: user.id, reason: "Unsubscribe link" } });
    check(dncRows.some((r) => r.identifierType === "EMAIL"), "unsubscribe DNC email row");
    check(dncRows.some((r) => r.identifierType === "DOMAIN"), "unsubscribe DNC domain row");

    // -----------------------------------------------------------------
    console.log("[6. UNKNOWN timeout and hard bounce]");
    const leadTimeout = await makeLead({ email: "owner@iota-dental.example" });
    const timeoutError = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
    setEmailTransportForTesting(makeTransport({ sent: [], failWith: timeoutError }));
    const unknown = await sendEmailForLead({
      leadId: leadTimeout.id,
      campaignId: campaign.id,
      senderAccountId: account.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(unknown.status === "UNKNOWN", "timeout marks UNKNOWN", unknown.status);
    const timeoutRow = await prisma.emailSend.findUnique({ where: { leadId: leadTimeout.id } });
    check(timeoutRow?.status === "UNKNOWN", "UNKNOWN persisted");
    const retry = await sendEmailForLead({
      leadId: leadTimeout.id,
      campaignId: campaign.id,
      senderAccountId: account.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(retry.status !== "SENT", "UNKNOWN is never auto-retried");

    const leadBounce = await makeLead({ email: "owner@kappa-dental.example" });
    const bounceError = Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
    setEmailTransportForTesting(makeTransport({ sent: [], failWith: bounceError }));
    const bounce = await sendEmailForLead({
      leadId: leadBounce.id,
      campaignId: campaign.id,
      senderAccountId: account.id,
      now: mondayMorning,
      jitterSecondsOverride: 0,
      recipientTimeZone: "America/Toronto",
    });
    check(bounce.status === "FAILED", "hard bounce marked FAILED");
    const bouncedLead = await prisma.lead.findUnique({ where: { id: leadBounce.id } });
    check(bouncedLead?.emailInvalid === true, "hard bounce marks address invalid");
    const bounceDnc = await prisma.doNotContact.findFirst({
      where: { userId: user.id, identifierType: "EMAIL", identifierNormalized: "owner@kappa-dental.example" },
    });
    check(Boolean(bounceDnc), "hard bounce DNC-suppresses address");

    // -----------------------------------------------------------------
    console.log("[7. Password never exposed]");
    const safe = sanitizeEmailAccount(account);
    check(!Object.keys(safe).some((k) => /password/i.test(k)), "sanitized account has no password field");
    check(!JSON.stringify(safe).includes("super-secret-smtp-password"), "password not present in API shape");
  } finally {
    setEmailTransportForTesting(null);
    await prisma.emailSend.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.emailUnsubscribeToken.deleteMany({ where: { leadId: { in: (await prisma.lead.findMany({ where: { campaignId: campaign.id }, select: { id: true } })).map((l) => l.id) } } });
    await prisma.doNotContact.deleteMany({ where: { userId: user.id } });
    await prisma.message.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.emailCampaignSettings.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.emailSenderAccount.deleteMany({ where: { userId: user.id } });
    await prisma.lead.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.campaign.delete({ where: { id: campaign.id } });
    await prisma.companyProfile.delete({ where: { id: companyProfile.id } });
    await prisma.user.delete({ where: { id: user.id } });
    if (prevOutbound === undefined) delete process.env.OUTBOUND_SENDING_ENABLED;
    else process.env.OUTBOUND_SENDING_ENABLED = prevOutbound;
  }

  console.log(`\nPASSED: ${passed} | FAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
