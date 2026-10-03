/**
 * Step 4 backfill: identity normalization for existing leads.
 *
 * Run order (see report-duplicates.ts / apply-duplicate-links.ts headers):
 *   1. backfill-identity --dry-run
 *   2. backfill-identity
 *   3. report-duplicates
 *   4. apply-duplicate-links --dry-run
 *   5. apply-duplicate-links --apply
 *
 * Idempotent, batched (500), never deletes and never touches instagramUserId
 * (unknown for historical rows). For each lead it:
 *   - fills usernameNormalized / profileUrlCanonical
 *   - fills emailNormalized (from email) when missing
 *   - fills websiteDomain / websiteKey (from website/externalUrl) when missing
 *   - creates a LeadSighting(matchedBy "NEW") in the lead's own campaign when absent
 *
 * Usage: npx tsx scripts/backfill-identity.ts [--dry-run]
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { normalizeEmail, normalizeUsername, normalizeWebsite, canonicalProfileUrl } from "../src/lib/services/dedup/identity";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH = 500;

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  const total = await prisma.lead.count();
  let scanned = 0;
  let updated = 0;
  let sightingsCreated = 0;
  let cursor: string | undefined;

  for (;;) {
    const leads = await prisma.lead.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        campaignId: true,
        username: true,
        email: true,
        emailNormalized: true,
        website: true,
        externalUrl: true,
        usernameNormalized: true,
        profileUrlCanonical: true,
        websiteKey: true,
        websiteDomain: true,
      },
    });
    if (leads.length === 0) break;
    cursor = leads[leads.length - 1].id;

    for (const lead of leads) {
      scanned += 1;
      const n = normalizeUsername(lead.username);
      const emailNorm = lead.emailNormalized ?? normalizeEmail(lead.email);
      const websiteRaw = lead.website ?? lead.externalUrl ?? null;
      const website = websiteRaw ? normalizeWebsite(websiteRaw) : null;

      const data: Record<string, string> = {};
      if (!lead.usernameNormalized && n) data.usernameNormalized = n;
      if (!lead.profileUrlCanonical && n) data.profileUrlCanonical = canonicalProfileUrl(n);
      if (!lead.emailNormalized && emailNorm) data.emailNormalized = emailNorm;
      if (!lead.websiteDomain && website?.domain) data.websiteDomain = website.domain;
      if (!lead.websiteKey && website?.key) data.websiteKey = website.key;

      if (Object.keys(data).length > 0) {
        updated += 1;
        if (!DRY_RUN) {
          await prisma.lead.update({ where: { id: lead.id }, data });
        }
      }

      // One provenance sighting per (lead, campaign).
      const existingSighting = await prisma.leadSighting.findFirst({
        where: { leadId: lead.id, campaignId: lead.campaignId },
        select: { id: true },
      });
      if (!existingSighting) {
        sightingsCreated += 1;
        if (!DRY_RUN) {
          await prisma.leadSighting.create({
            data: {
              leadId: lead.id,
              campaignId: lead.campaignId,
              source: "backfill",
              matchedBy: "NEW",
            },
          });
        }
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: DRY_RUN ? "dry-run" : "apply",
        totalLeads: total,
        scanned,
        identityRowsUpdated: updated,
        sightingsCreated,
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
