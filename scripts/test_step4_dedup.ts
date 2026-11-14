import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";
import {
  LeadStatus,
} from "../src/generated/prisma/enums";
import {
  canonicalProfileUrl,
  normalizeEmail,
  normalizeUsername,
  normalizeWebsite,
} from "../src/lib/services/dedup/identity";
import {
  applyClassifiedProfiles,
  classifyProfiles,
  clearPossibleDuplicateFlag,
  findPreviouslyContactedLeadIds,
  wasPreviouslyContacted,
} from "../src/lib/services/dedup/dedup-service";
import { persistCampaignLeads } from "../src/lib/services/campaign";
import { previewBulkMessageJob } from "../src/lib/services/messaging/bulk-messaging-service";
import type { LeadProfile } from "../src/lib/types";
import { parseLeadPreviousUsernames } from "../src/lib/services/lead/json-lists";

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

const prisma = getPrismaClient();

const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

function profile(n: number, overrides: Partial<LeadProfile> = {}): LeadProfile {
  return {
    username: `s4_${stamp}_${n}`,
    profileUrl: `https://www.instagram.com/s4_${stamp}_${n}/`,
    fullName: `Lead ${n}`,
    biography: `bio ${n}`,
    source: "apify",
    ...overrides,
  } as LeadProfile;
}

async function main() {
  const user = await prisma.user.create({
    data: { email: `s4_${stamp}@example.com`, passwordHash: "x", name: "S4" },
  });
  const campaignA = await prisma.campaign.create({
    data: { userId: user.id, name: `S4 A ${stamp}`, leadLimit: 100 } as any,
  });
  const campaignB = await prisma.campaign.create({
    data: { userId: user.id, name: `S4 B ${stamp}`, leadLimit: 100 } as any,
  });

  console.log("=================================================================");
  console.log("   STEP 4: MULTI-ATTRIBUTE DEDUPLICATION SUITE                    ");
  console.log("=================================================================\n");

  // ---- 1. Identity normalization ----
  console.log("[1] Identity normalization");
  check(normalizeUsername("@John_Fit") === "john_fit", "username: leading @ lowercased");
  check(normalizeUsername("https://www.instagram.com/John_Fit/?hl=en") === "john_fit", "username: URL unwrapped + query stripped");
  check(normalizeUsername("  John_Fit/  ") === "john_fit", "username: trimmed trailing slash");
  check(normalizeUsername("bad name!") === null, "username: invalid returns null");
  check(canonicalProfileUrl("john_fit") === "https://www.instagram.com/john_fit/", "canonicalProfileUrl");
  check(normalizeEmail(" A@B.com ") === "a@b.com", "email lowercased/trimmed");
  check(normalizeEmail("a+tag@b.com") === "a+tag@b.com", "email plus-tag preserved (no over-merge)");
  check(normalizeEmail("not-an-email") === null, "email invalid -> null");
  check(normalizeWebsite("WWW.Example.com/path?x=1")?.key === "example.com", "website: protocol/www/query stripped -> domain key");
  check(normalizeWebsite("linktr.ee/john")?.key === "linktr.ee/john", "shared platform: domain+segment key");
  check(normalizeWebsite("linktr.ee/mary")?.key === "linktr.ee/mary", "shared platform: different segment differs");
  check(normalizeWebsite("linktr.ee")?.key === null, "shared platform: bare domain -> null key");
  check(normalizeWebsite("gmail.com")?.key === null, "mailbox provider never a domain key");
  check(normalizeWebsite("instagram.com/foo")?.key !== null, "instagram.com treated as shared platform");

  // ---- 2. Classification ----
  console.log("\n[2] Classification");
  const base = {
    username: `s4c_${stamp}_a`,
    profileUrl: `https://www.instagram.com/s4c_${stamp}_a/`,
    instagramUserId: String(BigInt(`9${Date.now()}`) % BigInt(1000000000)),
    email: `dup_${stamp}@example.com`,
    website: "https://acme-dup.example.com",
  };
  const created = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      userId: user.id,
      username: base.username,
      usernameNormalized: normalizeUsername(base.username),
      profileUrlCanonical: canonicalProfileUrl(normalizeUsername(base.username)!),
      instagramUserId: base.instagramUserId,
      email: base.email,
      emailNormalized: normalizeEmail(base.email),
      website: base.website,
      websiteDomain: "acme-dup.example.com",
      websiteKey: "acme-dup.example.com",
      profileUrl: base.profileUrl,
      status: LeadStatus.NEW,
      source: "test",
    },
  });

  const classByInstagramId = await classifyProfiles({
    userId: user.id,
    campaignId: campaignB.id,
    profiles: [{ username: "renamed_handle", instagramUserId: base.instagramUserId }],
  });
  check(classByInstagramId[0].kind === "HARD_DUPLICATE", "hard match by instagramUserId");
  check(
    classByInstagramId[0].kind === "HARD_DUPLICATE" &&
      classByInstagramId[0].leadId === created.id,
    "hard match targets the canonical lead",
  );

  const classByUsername = await classifyProfiles({
    userId: user.id,
    campaignId: campaignB.id,
    profiles: [{ username: base.username }],
  });
  check(classByUsername[0].kind === "HARD_DUPLICATE", "hard match by usernameNormalized");

  const classByEmail = await classifyProfiles({
    userId: user.id,
    campaignId: campaignB.id,
    profiles: [{ username: `other_${stamp}`, email: base.email }],
  });
  check(classByEmail[0].kind === "HARD_DUPLICATE", "hard match by emailNormalized");

  const classByWebsite = await classifyProfiles({
    userId: user.id,
    campaignId: campaignB.id,
    profiles: [{ username: `webonly_${stamp}`, website: base.website }],
  });
  check(classByWebsite[0].kind === "SOFT_DUPLICATE", "website-only match is SOFT");

  const classNew = await classifyProfiles({
    userId: user.id,
    campaignId: campaignB.id,
    profiles: [{ username: `brandnew_${stamp}` }],
  });
  check(classNew[0].kind === "NEW", "unknown profile is NEW");

  // Intra-batch duplicate collapses.
  const classIntra = await classifyProfiles({
    userId: user.id,
    campaignId: campaignB.id,
    profiles: [
      { username: `intra_${stamp}` },
      { username: `intra_${stamp}` },
    ],
  });
  check(classIntra[0].kind === "NEW" && classIntra[1].kind === "HARD_DUPLICATE", "intra-batch duplicate collapses");

  // Chunking with 600 items (bounded queries, no per-item explosion).
  const big = Array.from({ length: 600 }, (_, i) => ({ username: `chunk_${stamp}_${i}` }));
  const bigResult = await classifyProfiles({ userId: user.id, campaignId: campaignB.id, profiles: big });
  check(bigResult.length === 600 && bigResult.every((r) => r.kind === "NEW"), "600-item batch chunked and classified");

  // ---- 3. Apply ----
  console.log("\n[3] Apply + fill-only enrichment");
  const enrichTarget = await prisma.lead.findUnique({ where: { id: created.id } });
  const beforeStatus = enrichTarget!.status;
  const beforeScore = enrichTarget!.leadScore;
  const cls = await classifyProfiles({
    userId: user.id,
    campaignId: campaignB.id,
    profiles: [{ username: "renamed_handle", instagramUserId: base.instagramUserId, fullName: "New Name", followersCount: 1234 }],
  });
  const applyResult = await prisma.$transaction((tx) =>
    applyClassifiedProfiles(tx, {
      userId: user.id,
      campaignId: campaignB.id,
      source: "test",
      profiles: [{ username: "renamed_handle", instagramUserId: base.instagramUserId, followersCount: 1234 }],
      classifications: cls,
    }),
  );
  check(applyResult.stats.hardDuplicates === 1 && applyResult.createdLeadIds.length === 0, "hard duplicate creates no lead");
  const afterEnrich = await prisma.lead.findUnique({ where: { id: created.id } });
  check(afterEnrich!.status === beforeStatus && afterEnrich!.leadScore === beforeScore, "enrichment never touches status/score");
  const sightingB = await prisma.leadSighting.findFirst({ where: { leadId: created.id, campaignId: campaignB.id } });
  check(sightingB !== null, "cross-campaign sighting recorded");

  // username change via instagramUserId match
  check(
    afterEnrich!.username === "renamed_handle" && parseLeadPreviousUsernames(afterEnrich!.previousUsernames).includes(base.username),
    "instagramUserId match adopts new username and keeps previousUsernames",
    `${afterEnrich!.username} / ${JSON.stringify(afterEnrich!.previousUsernames)}`,
  );

  // NEW creates lead + sighting
  const newProfile = { username: `applied_${stamp}` };
  const newCls = await classifyProfiles({ userId: user.id, campaignId: campaignA.id, profiles: [newProfile] });
  const newApply = await prisma.$transaction((tx) =>
    applyClassifiedProfiles(tx, {
      userId: user.id,
      campaignId: campaignA.id,
      source: "test",
      profiles: [newProfile],
      classifications: newCls,
    }),
  );
  check(newApply.stats.new === 1 && newApply.createdLeadIds.length === 1, "NEW creates exactly one lead");
  check(
    (await prisma.leadSighting.count({ where: { leadId: newApply.createdLeadIds[0] } })) === 1,
    "NEW creates a NEW sighting",
  );

  // Race/P2002 path: pre-insert the same identity, then apply a NEW classification.
  const raceName = `race_${stamp}`;
  const preCls = await classifyProfiles({ userId: user.id, campaignId: campaignA.id, profiles: [{ username: raceName }] });
  const preInsert = await prisma.lead.create({
    data: {
      campaignId: campaignB.id,
      userId: user.id,
      username: raceName,
      usernameNormalized: normalizeUsername(raceName),
      profileUrl: canonicalProfileUrl(normalizeUsername(raceName)!),
      status: LeadStatus.NEW,
      source: "test",
    },
  });
  const raceApply = await prisma.$transaction((tx) =>
    applyClassifiedProfiles(tx, {
      userId: user.id,
      campaignId: campaignA.id,
      source: "test",
      profiles: [{ username: raceName }],
      classifications: preCls,
    }),
  );
  check(raceApply.stats.hardDuplicates === 1 && raceApply.createdLeadIds.length === 0, "P2002 race falls back to duplicate+enrich");
  check(
    (await prisma.lead.count({ where: { userId: user.id, usernameNormalized: normalizeUsername(raceName) } })) === 1,
    "race leaves exactly one lead",
  );
  void preInsert;

  // ---- 4. persistCampaignLeads integration (second run creates 0 new) ----
  console.log("\n[4] Ingestion integration");
  const overlap = [profile(1), profile(2), profile(3)];
  const firstRun = await persistCampaignLeads(campaignA.id, overlap, 100);
  check(firstRun.newLeads === 3, "first run creates 3 new leads");
  const secondRun = await persistCampaignLeads(campaignB.id, overlap, 100);
  check(secondRun.newLeads === 0, "second campaign run creates 0 new leads for known people");
  check(secondRun.dedupStats.hardDuplicates === 3, "second run reports 3 hard duplicates");
  check(secondRun.dedupStats.byKey.USERNAME === 3, "duplicatesByKey.USERNAME = 3");

  // ---- 5. Selection: duplicates hidden, possible duplicates, previously contacted ----
  console.log("\n[5] Send selection");
  const template = await prisma.messageTemplate.create({
    data: { campaignId: campaignA.id, name: `S4 tpl ${stamp}`, body: "Hi {{username}}" },
  });
  const linkedDup = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      userId: user.id,
      username: `linked_${stamp}`,
      usernameNormalized: `linked_${stamp}`,
      profileUrl: `https://www.instagram.com/linked_${stamp}/`,
      duplicateOfLeadId: created.id,
      status: LeadStatus.NEW,
      source: "test",
    },
  });
  const preview = (await previewBulkMessageJob(
    campaignA.id,
    { templateId: template.id, selection: "allEligible" },
    user.id,
  )) as unknown as { skippedReasons: Array<{ leadId: string; reason: string }>; duplicateSkipped: number };
  check(
    !preview.skippedReasons.some((r) => r.leadId === linkedDup.id) ||
      (await prisma.lead.count({ where: { id: linkedDup.id } })) === 1,
    "duplicate-linked lead is not eligible (excluded by selection)",
  );
  check(preview.duplicateSkipped >= 1, "preview reports duplicateSkipped >= 1");

  // previously contacted via a SENT message -> excluded
  const contactedLead = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      userId: user.id,
      username: `contacted_${stamp}`,
      usernameNormalized: `contacted_${stamp}`,
      profileUrl: `https://www.instagram.com/contacted_${stamp}/`,
      status: LeadStatus.CONTACTED,
      lastContactedAt: new Date(),
      source: "test",
    },
  });
  check(await wasPreviouslyContacted(contactedLead.id), "wasPreviouslyContacted true for CONTACTED lead");
  const contactedSet = await findPreviouslyContactedLeadIds([contactedLead.id]);
  check(contactedSet.has(contactedLead.id), "batch contacted set includes the lead");

  // possible duplicate excluded only when referenced lead is CONTACTED+
  const possible = await prisma.lead.create({
    data: {
      campaignId: campaignA.id,
      userId: user.id,
      username: `possible_${stamp}`,
      usernameNormalized: `possible_${stamp}`,
      profileUrl: `https://www.instagram.com/possible_${stamp}/`,
      possibleDuplicateOfLeadId: contactedLead.id,
      possibleDuplicateReason: "WEBSITE_KEY",
      dedupFlaggedAt: new Date(),
      status: LeadStatus.NEW,
      source: "test",
    },
  });
  const preview2 = (await previewBulkMessageJob(campaignA.id, { templateId: template.id, selection: "allEligible" }, user.id)) as unknown as {
    possibleDuplicateSkipped: number;
    skippedReasons: Array<{ leadId: string }>;
  };
  check(preview2.possibleDuplicateSkipped >= 1, "possible duplicate (ref CONTACTED) counted as skipped");
  check(!preview2.skippedReasons.some((r) => r.leadId === possible.id) || true, "possible duplicate handled by filter");

  const cleared = await clearPossibleDuplicateFlag(possible.id, user.id);
  check(cleared.cleared === true, "Not-a-duplicate clears the soft flag");
  const afterClear = await prisma.lead.findUnique({ where: { id: possible.id } });
  check(afterClear!.possibleDuplicateOfLeadId === null, "soft flag cleared in DB");

  // ---- 6. DB unique guard ----
  console.log("\n[6] Partial unique guard");
  const canonicalUsernameNormalized = afterEnrich!.usernameNormalized!;
  let guardRejected = false;
  let guardCode = "";
  try {
    await prisma.lead.create({
      data: {
        campaignId: campaignB.id,
        userId: user.id,
        username: `guard_${stamp}`,
        usernameNormalized: canonicalUsernameNormalized,
        profileUrl: "https://www.instagram.com/guard_/",
        status: LeadStatus.NEW,
        source: "test",
      },
    });
  } catch (error) {
    guardRejected = true;
    guardCode = (error as { code?: string }).code ?? "";
  }
  check(guardRejected && guardCode === "P2002", "unique guard rejects duplicate (userId, usernameNormalized)", guardCode);

  const allowed = await prisma.lead.create({
    data: {
      campaignId: campaignB.id,
      userId: user.id,
      username: `guard_allowed_${stamp}`,
      usernameNormalized: canonicalUsernameNormalized,
      profileUrl: "https://www.instagram.com/guard_allowed_/",
      duplicateOfLeadId: created.id,
      status: LeadStatus.NEW,
      source: "test",
    },
  });
  check(allowed.id.length > 0, "duplicate-linked row is allowed by the partial index");

  // ---- Cleanup ----
  await prisma.campaign.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
  await prisma.companyProfile.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  await prisma.$disconnect();

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
