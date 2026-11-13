/**
 * STEP 0 replay: show exactly what the existing handle waterfall does for the
 * four hand-verified websites, then what the new free website scraper does.
 *
 * Uses fixtures + an injected fetcher. No real network / Apify / Gemini /
 * Unipile calls. Writes only to DATABASE_URL_TEST and cleans up its own rows.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTestDatabaseUrl } = require("./test_db_guard.cjs");
process.env.DATABASE_URL = getTestDatabaseUrl();
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { getPrismaClient } from "../src/lib/db/prisma";
import { runHandleDiscoveryWaterfall } from "../src/lib/services/discovery/handle-discovery-waterfall";
import { scrapeLeadWebsite } from "../src/lib/services/enrichment/website-lead-enricher";
import { saveLeadAsEnrichPending } from "../src/lib/services/discovery/candidate-persistence";

const FIXTURES = ["canarydental.ca", "kingeastdental.com", "fairviewsmiles.ca", "northyorkdentist.ca"];

function fixtureHtml(domain: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", "websites", `${domain}.html`), "utf8");
}

function contactHtml(domain: string): string {
  return `<!doctype html><html><head><title>Contact ${domain}</title></head><body>
    <header><a href="/">Home</a></header>
    <main><h1>Contact ${domain}</h1>
    <a href="mailto:info@${domain}">info@${domain}</a>
    <a href="tel:+14165550123">Call</a>
    </main></body></html>`;
}

async function main() {
  const pages: string[] = [];
  const fetchFn = async (url: string) => {
    pages.push(url);
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const isHome = parsed.pathname === "/" || parsed.pathname === "";
    const html = isHome
      ? fixtureHtml(domain)
      : domain === "kingeastdental.com"
        ? contactHtml(domain)
        : fixtureHtml(domain);
    return { ok: true, html, finalUrl: url, status: 200 };
  };

  console.log("STEP 0 — WEBSITE WATERFALL REPLAY (fixtures, mocked fetch)\n");
  console.log("BEFORE — current runHandleDiscoveryWaterfall:");
  console.log("site | pages | anchors | IG handle | confidence | socials | email (not extracted) | ignored IG paths");
  for (const domain of FIXTURES) {
    pages.length = 0;
    const res = await runHandleDiscoveryWaterfall({
      businessName: domain,
      websiteUrl: `https://${domain}/`,
      fetchFn,
    });
    const html = fixtureHtml(domain);
    const anchors = (html.match(/<a\b/gi) ?? []).length;
    const emails = (html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).filter(
      (e) => !/\.(png|jpe?g|svg)$/i.test(e),
    );
    const ignored = (html.match(/instagram\.com\/(?:reel|p)\/[^"'#\s<>]+/gi) ?? []).length;
    console.log(
      `${domain} | ${pages.length} | ${anchors} | ${res.handle ?? "—"} | ${res.handleConfidence ?? "—"} | ${Object.entries(
        res.socialLinks ?? {},
      )
        .filter(([, v]) => Boolean(v))
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "—"} | ${emails.join(", ") || "— (not extracted into contacts)"} | ${ignored}`,
    );
  }

  console.log("\nAFTER — new scrapeLeadWebsite (fixtures, mocked fetch):");
  console.log("site | pages | IG handle | email | phone | socials | ignored IG paths | diagnostics");
  for (const domain of FIXTURES) {
    const res = await scrapeLeadWebsite(
      { website: `https://${domain}/`, businessName: domain, countryCode: "CA" },
      { fetchFn },
    );
    console.log(
      `${domain} | ${res.pages.length} | ${res.handle ?? "—"} | ${res.emails[0]?.value ?? "—"} | ${
        res.phones[0]?.normalized ?? "—"
      } | ${
        Object.entries(res.socialLinks)
          .filter(([, v]) => Boolean(v))
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "—"
      } | ${res.pages.reduce((n, p) => n + p.ignoredInstagramPaths.length, 0)} | ${res.pages
        .map((p) => `${p.url}:${p.ok ? p.status : p.error}`)
        .join(" ; ")}`,
    );
  }

  // Persist-first field copy report.
  const prisma = getPrismaClient();
  const tag = `step0_${Date.now()}`;
  const user = await prisma.user.create({
    data: { email: `${tag}@example.com`, name: "Step0", passwordHash: "x" },
  });
  const profile = await prisma.companyProfile.create({
    data: { userId: user.id, name: "Step0 Co" },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      companyProfileId: profile.id,
      name: `${tag} campaign`,
      location: "Toronto, ON",
      leadLimit: 5,
    },
  });

  try {
    await saveLeadAsEnrichPending({
      campaignId: campaign.id,
      userId: user.id,
      placeId: `${tag}_place`,
      name: "Canary Dental",
      handle: "canarydental",
      website: "https://www.canarydental.ca/",
      phone: "+1 416-900-1902",
      city: "Toronto",
      rating: 4.8,
      reviewsCount: 434,
      handleSource: "homepage",
      handleConfidence: "high",
    });
    const summarizeLead = (lead: Awaited<ReturnType<typeof prisma.lead.findFirst>>) => {
      const raw = (lead?.rawProfileData ?? {}) as Record<string, unknown>;
      const maps = (raw.maps ?? {}) as Record<string, unknown>;
      const contacts = (raw.contacts ?? {}) as Record<string, unknown>;
      return {
        category: lead?.category ?? null,
        address: lead?.location ?? null,
        city: lead?.city ?? null,
        country: maps.countryCode ?? null,
        rating: lead?.rating ?? null,
        reviewsCount: lead?.reviewCount ?? null,
        mapsUrl: maps.mapsUrl ?? null,
        placeId: lead?.gmapsPlaceId ?? null,
        tier: lead?.qualityTier ?? null,
        email: lead?.email ?? null,
        socials: contacts.socialLinks ?? null,
      };
    };

    const leadBefore = await prisma.lead.findFirst({
      where: { campaignId: campaign.id, gmapsPlaceId: `${tag}_place` },
    });
    console.log("\nPERSIST-FIRST LEAD FIELD COPY — BEFORE (no Maps fields passed):");
    console.log(JSON.stringify(summarizeLead(leadBefore)));

    await saveLeadAsEnrichPending({
      campaignId: campaign.id,
      userId: user.id,
      placeId: `${tag}_place_after`,
      name: "Canary Dental After",
      handle: "canarydental_after",
      website: "https://www.canarydental.ca/",
      phone: "+1 416-900-1902",
      city: "Toronto",
      rating: 4.8,
      reviewsCount: 434,
      handleSource: "homepage",
      handleConfidence: "high",
      fields: {
        category: "Dental clinic",
        address: "100 King St W, Toronto, ON",
        state: "ON",
        countryCode: "CA",
        mapsUrl: "https://www.google.com/maps/place/?q=place_id:ChIJ_canary",
        email: "info@canarydental.ca",
        socialLinks: {
          instagram: "https://www.instagram.com/canarydental/",
          facebook: "https://www.facebook.com/canarydental",
        },
        websiteEmails: [
          {
            value: "info@canarydental.ca",
            normalized: "info@canarydental.ca",
            generic: true,
            sourceUrl: "https://canarydental.ca/contact",
          },
        ],
        websitePhones: [
          { value: "+1 416-900-1902", normalized: "+14169001902", sourceUrl: "https://canarydental.ca/" },
        ],
      },
    });
    const leadAfter = await prisma.lead.findFirst({
      where: { campaignId: campaign.id, gmapsPlaceId: `${tag}_place_after` },
    });
    console.log("\nPERSIST-FIRST LEAD FIELD COPY — AFTER (Maps + website fields passed):");
    console.log(JSON.stringify(summarizeLead(leadAfter)));
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
