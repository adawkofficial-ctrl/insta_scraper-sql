/**
 * Free website enrichment tests (fixtures + mocked fetcher).
 *
 * No real Apify / Gemini / Unipile / network calls. The only DB writes go to
 * DATABASE_URL_TEST and are cleaned up.
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
import { LeadStatus } from "@/generated/prisma/client";
import {
  scrapeLeadWebsite,
  extractWebsiteData,
  decodeCloudflareEmail,
  decodeObfuscatedEmails,
  isJunkWebsiteEmail,
  runWithConcurrency,
  enrichLeadsFromWebsites,
  applyWebsiteEnrichmentToLead,
  __resetWebsiteRateLimiterForTesting,
} from "../src/lib/services/enrichment/website-lead-enricher";
import {
  saveLeadAsEnrichPending,
  saveContactOnlyLead,
} from "../src/lib/services/discovery/candidate-persistence";
import { safeFetchHtml } from "../src/lib/services/discovery/handle-discovery-waterfall";
import { listCampaignLeads } from "../src/lib/services/lead/lead-service";
import {
  createCampaign,
  parseCampaignLeadLimit,
} from "../src/lib/services/campaign/campaign-service";
import {
  getMaxLeadLimit,
  parseLeadLimit,
} from "../src/lib/services/scraper/instagram-profile";
import { MAX_CAMPAIGN_LEAD_LIMIT } from "../src/lib/constants/campaign-limits";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` -> ${detail}` : ""}`);
    failed++;
  }
}

function fixture(domain: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", "websites", `${domain}.html`), "utf8");
}

function parseFixtureHost(url: string): { host: string; path: string } {
  const parsed = new URL(url);
  return { host: parsed.hostname.replace(/^www\./, ""), path: parsed.pathname };
}

const fixtureDomains = new Set([
  "canarydental.ca",
  "kingeastdental.com",
  "fairviewsmiles.ca",
  "northyorkdentist.ca",
]);

function fixtureFetch() {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    const { host, path: pathname } = parseFixtureHost(url);
    if (!fixtureDomains.has(host)) {
      return { ok: false, status: 404, error: "HTTP 404" };
    }
    if (pathname === "/" || pathname === "") {
      return { ok: true, html: fixture(host), finalUrl: url, status: 200 };
    }
    if (host === "kingeastdental.com") {
      return {
        ok: true,
        html: `<!doctype html><html><body><a href="mailto:info@kingeastdental.com">info@kingeastdental.com</a></body></html>`,
        finalUrl: url,
        status: 200,
      };
    }
    return { ok: true, html: "<html><body>No contact info</body></html>", finalUrl: url, status: 200 };
  };
  return { fetchFn, calls };
}

function encodeCloudflare(email: string): string {
  const key = 0x42;
  const bytes = [key, ...Array.from(email).map((char) => char.charCodeAt(0) ^ key)];
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function runTests() {
  console.log("=== FREE WEBSITE ENRICHMENT TESTS ===");
  __resetWebsiteRateLimiterForTesting();

  // -------------------------------------------------------------------------
  // 1. The four hand-verified fixtures
  // -------------------------------------------------------------------------
  {
    const { fetchFn } = fixtureFetch();
    const canary = await scrapeLeadWebsite(
      { website: "https://www.canarydental.ca/", businessName: "Canary Dental", countryCode: "CA" },
      { fetchFn },
    );
    check(canary.handle === "canarydental", "canarydental.ca -> IG canarydental", String(canary.handle));
    check(canary.handleConfidence === "high", "canarydental.ca handle is high confidence", String(canary.handleConfidence));
    check(
      canary.socialLinks.facebook === "https://www.facebook.com/canarydental",
      "canarydental.ca -> canonical Facebook",
      String(canary.socialLinks.facebook),
    );
    check(
      canary.pages.some((page) => page.ignoredInstagramPaths.length >= 2),
      "canarydental.ca reel/post links are ignored",
      JSON.stringify(canary.pages.map((page) => page.ignoredInstagramPaths)),
    );
    check(canary.emails.length === 0, "canarydental.ca has no email in fixtures", JSON.stringify(canary.emails));

    const king = await scrapeLeadWebsite(
      { website: "https://kingeastdental.com/", businessName: "King East Dental", countryCode: "CA" },
      { fetchFn },
    );
    check(king.handle === null, "kingeastdental.com -> no handle", String(king.handle));
    check(king.emails[0]?.value === "info@kingeastdental.com", "kingeastdental.com -> info@ email", JSON.stringify(king.emails));
    check(king.emails[0]?.generic === true, "kingeastdental.com email marked generic");
    check(king.phones.some((phone) => phone.normalized === "+16473495999"), "kingeastdental.com -> E.164 phone", JSON.stringify(king.phones));

    const fairview = await scrapeLeadWebsite(
      { website: "https://fairviewsmiles.ca/?utm_campaign=gmb", businessName: "Fairview Smiles Dentistry", countryCode: "CA" },
      { fetchFn },
    );
    check(fairview.handle === "fairviewsmiles_dental", "fairviewsmiles.ca -> IG fairviewsmiles_dental", String(fairview.handle));
    check(
      fairview.socialLinks.facebook === "https://www.facebook.com/Fairview-Smiles-110530135042377",
      "fairviewsmiles.ca -> canonical Facebook (web. stripped)",
      String(fairview.socialLinks.facebook),
    );
    check(
      fairview.phones.every((phone) => phone.normalized !== "+083340981636"),
      "fairviewsmiles.ca publisher ID is not parsed as a phone",
      JSON.stringify(fairview.phones),
    );

    const northyork = await scrapeLeadWebsite(
      { website: "https://northyorkdentist.ca", businessName: "88 Finch East Dental Centre", countryCode: "CA" },
      { fetchFn },
    );
    check(northyork.handle === "northyorkdentist", "northyorkdentist.ca -> IG northyorkdentist", String(northyork.handle));
    check(
      northyork.socialLinks.facebook === "https://www.facebook.com/88fincheastdental",
      "northyorkdentist.ca -> Facebook 88fincheastdental",
      String(northyork.socialLinks.facebook),
    );
    check(
      northyork.emails.some((email) => email.value === "smile@88fincheastdental.com"),
      "northyorkdentist.ca keeps email on a different domain",
      JSON.stringify(northyork.emails),
    );
    check(northyork.phones.some((phone) => phone.normalized === "+14162218828"), "northyorkdentist.ca -> phone", JSON.stringify(northyork.phones));
  }

  // -------------------------------------------------------------------------
  // 2. URL/anchor edge cases
  // -------------------------------------------------------------------------
  {
    const html = `
      <html><body>
        <A HREF="//WWW.INSTAGRAM.COM/UpperCaseHandle/">Image only</A>
        <a href="/contact-us"><img src="x.png" alt=""></a>
        <a href="https://www.instagram.com/p/PostOnly/">post</a>
        <a href="https://www.instagram.com/explore/tags/dental/">explore</a>
      </body></html>`;
    const data = extractWebsiteData(html, "https://example.ca/", {
      businessName: "Example Dental",
      domain: "example.ca",
    });
    check(data.handle === "uppercasehandle", "uppercase + protocol-relative IG href", String(data.handle));
    check(
      data.ignoredInstagramPaths.some((url) => url.includes("/p/")),
      "post link ignored",
      JSON.stringify(data.ignoredInstagramPaths),
    );
    check(
      data.ignoredInstagramPaths.some((url) => url.includes("/explore/")),
      "explore link ignored",
      JSON.stringify(data.ignoredInstagramPaths),
    );

    const imageOnly = extractWebsiteData(
      `<a href="https://www.instagram.com/imageonly/"><img src="logo.svg" alt=""></a>`,
      "https://example.ca/",
      { businessName: "Image Only Dental", domain: "example.ca" },
    );
    check(imageOnly.handle === "imageonly", "image-only anchor extracts IG handle", String(imageOnly.handle));
  }

  // -------------------------------------------------------------------------
  // 3. Fetch retry / UTM / redirect behavior
  // -------------------------------------------------------------------------
  {
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      if (url.includes("utm_")) return { ok: false, status: 403, error: "HTTP 403" };
      return { ok: true, html: "<html><body><a href='mailto:info@retry.ca'>info@retry.ca</a></body></html>", finalUrl: url, status: 200 };
    };
    const res = await scrapeLeadWebsite(
      { website: "https://retry.ca/?utm_campaign=gmb", businessName: "Retry Dental" },
      { fetchFn, maxSubpages: 0 },
    );
    check(res.pages[0].ok, "UTM URL retried without query and succeeded", JSON.stringify(res.pages));
    check(calls.some((url) => !url.includes("utm_")), "retry used the query-less URL", JSON.stringify(calls));

    // www -> non-www final URL
    const wwwFetch = async (url: string) => ({
      ok: true,
      html: "<html><body>ok</body></html>",
      finalUrl: url.replace("www.", ""),
      status: 200,
    });
    const www = await scrapeLeadWebsite(
      { website: "https://www.example.ca/", businessName: "Example" },
      { fetchFn: wwwFetch, maxSubpages: 0 },
    );
    check(
      www.pages[0].requestedUrl === "https://www.example.ca/" && www.pages[0].finalUrl === "https://example.ca/",
      "www/non-www redirect is followed",
      JSON.stringify(www.pages[0]),
    );

    // timeout then retry
    let attempts = 0;
    const timeoutFetch = async () => {
      attempts++;
      if (attempts === 1) return { ok: false, status: null, error: "Timeout after 12000ms" };
      return { ok: true, html: "<html><body>ok</body></html>", finalUrl: "https://timeout.ca/", status: 200 };
    };
    const timeoutRes = await scrapeLeadWebsite(
      { website: "https://timeout.ca/", businessName: "Timeout" },
      { fetchFn: timeoutFetch, maxSubpages: 0 },
    );
    check(timeoutRes.pages[0].ok && attempts === 2, "timeout triggers one retry", `attempts=${attempts} pages=${JSON.stringify(timeoutRes.pages)}`);
  }

  // -------------------------------------------------------------------------
  // 4. SSRF: redirect to a private IP is blocked
  // -------------------------------------------------------------------------
  {
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("public.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" },
        });
      }
      return new Response("should not reach", { status: 200 });
    }) as typeof fetch;
    try {
      const res = await safeFetchHtml("https://public.example/", 5_000);
      check(!res.ok && Boolean(res.error), "redirect to private IP is blocked", JSON.stringify(res));
    } finally {
      global.fetch = originalFetch;
    }
  }

  // -------------------------------------------------------------------------
  // 5. Email decoding / filtering
  // -------------------------------------------------------------------------
  {
    const email = "info@cloudflare-test.ca";
    check(decodeCloudflareEmail(encodeCloudflare(email)) === email, "Cloudflare email decodes", decodeCloudflareEmail(encodeCloudflare(email)) ?? "null");
    const obfuscated = decodeObfuscatedEmails("Contact us at info [at] obfuscated [dot] ca or hello(at)obfuscated(dot)ca");
    check(
      obfuscated.includes("info@obfuscated.ca") && obfuscated.includes("hello@obfuscated.ca"),
      "[at]/[dot] obfuscated emails decode",
      JSON.stringify(obfuscated),
    );
    check(isJunkWebsiteEmail("logo@2x.png"), "image-file email is junk");
    check(isJunkWebsiteEmail("noreply@clinic.ca"), "noreply email is junk");
    check(isJunkWebsiteEmail("test@example.com"), "example.com email is junk");
    check(!isJunkWebsiteEmail("smile@88fincheastdental.com"), "different-domain email is kept");
  }

  // -------------------------------------------------------------------------
  // 6. Facebook-only website + meta publisher + multiple handles
  // -------------------------------------------------------------------------
  {
    let fetches = 0;
    const fb = await scrapeLeadWebsite(
      { website: "https://www.facebook.com/Fairview-Smiles-110530135042377", businessName: "Fairview" },
      { fetchFn: async () => { fetches++; return { ok: false, error: "should not fetch" }; } },
    );
    check(fb.socialOnly === true && fetches === 0, "Facebook-only website is stored, not fetched", `fetches=${fetches}`);
    check(
      fb.socialLinks.facebook === "https://www.facebook.com/Fairview-Smiles-110530135042377",
      "Facebook-only website normalized",
      String(fb.socialLinks.facebook),
    );

    const publisherOnly = extractWebsiteData(
      `<html><head><meta property="article:publisher" content="https://web.facebook.com/people/Fairview-Smiles/100083340981636/" /></head><body></body></html>`,
      "https://fairviewsmiles.ca/",
      { businessName: "Fairview Smiles Dentistry", domain: "fairviewsmiles.ca" },
    );
    check(
      publisherOnly.socialLinks.facebook === "https://www.facebook.com/people/Fairview-Smiles/100083340981636",
      "meta article:publisher is handled",
      String(publisherOnly.socialLinks.facebook),
    );

    const multiple = extractWebsiteData(
      `<html><body>
        <header><a href="https://www.instagram.com/canarydental/">Follow</a></header>
        <main><a href="https://www.instagram.com/unrelated_promo/">Promo</a>
        <a href="https://www.instagram.com/unrelated_promo/">Promo again</a></main>
      </body></html>`,
      "https://canarydental.ca/",
      { businessName: "Canary Dental", domain: "canarydental.ca" },
    );
    check(multiple.handle === "canarydental", "multiple handles: best business/header match wins", String(multiple.handle));
    check(multiple.alternates.includes("unrelated_promo"), "other handles stored as alternates", JSON.stringify(multiple.alternates));
  }

  // -------------------------------------------------------------------------
  // 7. Concurrency limit
  // -------------------------------------------------------------------------
  {
    let active = 0;
    let maxActive = 0;
    const results = await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return value * 2;
    });
    check(maxActive <= 2, "concurrency limit respected", `maxActive=${maxActive}`);
    check(JSON.stringify(results) === JSON.stringify([2, 4, 6, 8, 10, 12]), "concurrency preserves order", JSON.stringify(results));
  }

  // -------------------------------------------------------------------------
  // 8. Persist-first field copy + website contacts
  // -------------------------------------------------------------------------
  const prisma = getPrismaClient();
  const tag = `website_enrichment_${Date.now()}`;
  const user = await prisma.user.create({
    data: { email: `${tag}@example.com`, name: "Website Enrichment Test", passwordHash: "hash" },
  });
  const profile = await prisma.companyProfile.create({
    data: { userId: user.id, name: "Website Enrichment Co" },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      companyProfileId: profile.id,
      name: `${tag} campaign`,
      location: "Toronto, ON",
      leadLimit: 20,
    },
  });

  try {
    await saveLeadAsEnrichPending({
      campaignId: campaign.id,
      userId: user.id,
      placeId: `${tag}_place_1`,
      name: "Maps Values Dental",
      handle: "mapsvaluesdental",
      website: "https://mapsvaluesdental.ca",
      phone: "+1 416-555-0100",
      city: "Toronto",
      rating: 4.8,
      reviewsCount: 434,
      handleSource: "maps",
      handleConfidence: "high",
      fields: {
        category: "Dental clinic",
        address: "100 King St W, Toronto, ON",
        state: "ON",
        countryCode: "CA",
        mapsUrl: "https://maps.google.com/?cid=123",
        email: "hello@mapsvaluesdental.ca",
        socialLinks: {
          instagram: "https://www.instagram.com/mapsvaluesdental/",
          facebook: "https://www.facebook.com/mapsvaluesdental",
        },
        websiteEmails: [
          { value: "hello@mapsvaluesdental.ca", normalized: "hello@mapsvaluesdental.ca", generic: false, sourceUrl: "https://mapsvaluesdental.ca/" },
        ],
        websitePhones: [
          { value: "+1 416-555-0100", normalized: "+14165550100", sourceUrl: "https://mapsvaluesdental.ca/" },
        ],
      },
    });
    const lead = await prisma.lead.findFirst({ where: { campaignId: campaign.id, gmapsPlaceId: `${tag}_place_1` } });
    const raw = (lead?.rawProfileData ?? {}) as Record<string, unknown>;
    const maps = (raw.maps ?? {}) as Record<string, unknown>;
    const contacts = (raw.contacts ?? {}) as Record<string, unknown>;
    check(lead?.category === "Dental clinic", "persist-first copies category", String(lead?.category));
    check(lead?.location === "100 King St W, Toronto, ON", "persist-first copies address", String(lead?.location));
    check(lead?.city === "Toronto", "persist-first copies city", String(lead?.city));
    check(lead?.rating === 4.8, "persist-first copies rating", String(lead?.rating));
    check(lead?.reviewCount === 434, "persist-first copies review count", String(lead?.reviewCount));
    check(lead?.gmapsPlaceId === `${tag}_place_1`, "persist-first copies placeId", String(lead?.gmapsPlaceId));
    check(maps.mapsUrl === "https://maps.google.com/?cid=123", "persist-first stores Maps URL", String(maps.mapsUrl));
    check(maps.countryCode === "CA", "persist-first stores country", String(maps.countryCode));
    check(Array.isArray(contacts.emails) && (contacts.emails as unknown[]).length === 1, "persist-first stores website email", JSON.stringify(contacts.emails));
    check(Array.isArray(contacts.phones) && (contacts.phones as unknown[]).length >= 1, "persist-first stores phones", JSON.stringify(contacts.phones));
    check(
      (contacts.socialLinks as Record<string, string>)?.facebook === "https://www.facebook.com/mapsvaluesdental",
      "persist-first stores social links",
      JSON.stringify(contacts.socialLinks),
    );
    check(Boolean(lead?.qualityTier !== null && lead?.qualityScore !== null), "persist-first computes quality score/tier", `${lead?.qualityTier}/${lead?.qualityScore}`);
    check(Boolean(lead?.availableChannels?.includes("EMAIL")), "persist-first channel flags include EMAIL", JSON.stringify(lead?.availableChannels));
    check(Boolean(lead?.availableChannels?.includes("SOCIAL")), "persist-first channel flags include SOCIAL", JSON.stringify(lead?.availableChannels));

    await saveContactOnlyLead({
      campaignId: campaign.id,
      userId: user.id,
      placeId: `${tag}_place_2`,
      name: "Contact Only Dental",
      website: "https://contactonly.ca",
      phone: "+1 416-555-0101",
      city: "North York",
      rating: 4.6,
      reviewsCount: 88,
      fields: {
        category: "Dentist",
        address: "200 Yonge St, North York, ON",
        state: "ON",
        countryCode: "CA",
        mapsUrl: "https://maps.google.com/?cid=456",
        email: "info@contactonly.ca",
        socialLinks: { facebook: "https://www.facebook.com/contactonly" },
        websiteEmails: [{ value: "info@contactonly.ca", normalized: "info@contactonly.ca", generic: true }],
      },
    });
    const contactLead = await prisma.lead.findFirst({ where: { campaignId: campaign.id, gmapsPlaceId: `${tag}_place_2` } });
    check(contactLead?.category === "Dentist", "contact-only lead copies category", String(contactLead?.category));
    check(contactLead?.location === "200 Yonge St, North York, ON", "contact-only lead copies address", String(contactLead?.location));
    check(contactLead?.city === "North York", "contact-only lead copies city", String(contactLead?.city));
    check(contactLead?.rating === 4.6, "contact-only lead copies rating", String(contactLead?.rating));
    check(contactLead?.email === "info@contactonly.ca", "contact-only lead copies email", String(contactLead?.email));

    // Rehandle must never overwrite an existing handle.
    const existing = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "Existing Handle Dental",
        website: "https://canarydental.ca",
        username: "existing_handle",
        instagramUsername: "existing_handle",
        usernameNormalized: "existing_handle",
        city: "Toronto",
        status: LeadStatus.ENRICH_PENDING,
      },
    });
    const rehandle = await enrichLeadsFromWebsites({
      campaignId: campaign.id,
      leadIds: [existing.id],
      force: true,
      concurrency: 2,
      fetchFn: fixtureFetch().fetchFn,
    });
    const after = await prisma.lead.findUnique({ where: { id: existing.id } });
    check(after?.username === "existing_handle", "rehandle never overwrites existing handle", String(after?.username));
    check(
      after?.email === "info@canarydental.ca" || after?.email === null,
      "rehandle can add website email without touching handle",
      String(after?.email),
    );
    const afterRaw = (after?.rawProfileData ?? {}) as Record<string, unknown>;
    check(
      Array.isArray(afterRaw.handleAlternates) && (afterRaw.handleAlternates as string[]).includes("canarydental"),
      "new handle stored as an alternate",
      JSON.stringify(afterRaw.handleAlternates),
    );
    check(rehandle.results[0]?.handle === "existing_handle", "bulk result reports existing handle", JSON.stringify(rehandle.results[0]));

    // "Scrape websites for all leads" must include leads that already have a
    // handle/email/social link and still add newly discovered platforms.
    const completeLead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "Complete Lead Dental",
        website: "https://fairviewsmiles.ca",
        username: "complete_handle",
        instagramUsername: "complete_handle",
        usernameNormalized: "complete_handle",
        email: "existing@complete.ca",
        socialLink: "https://www.facebook.com/existing",
        socialPlatform: "facebook",
        status: LeadStatus.ENRICH_PENDING,
      },
    });
    const scanAll = await enrichLeadsFromWebsites({
      campaignId: campaign.id,
      leadIds: [completeLead.id],
      scanAll: true,
      force: true,
      concurrency: 2,
      fetchFn: fixtureFetch().fetchFn,
    });
    check(
      scanAll.totalEligible === 1,
      "scanAll includes leads that already have IG/email/socials",
      JSON.stringify(scanAll.results),
    );
    check(
      scanAll.results[0]?.newHandle === false && scanAll.results[0]?.handle === "complete_handle",
      "scanAll never overwrites an existing handle",
      JSON.stringify(scanAll.results[0]),
    );
    check(
      (scanAll.results[0]?.newSocialCount ?? 0) > 0,
      "scanAll adds newly discovered social links",
      JSON.stringify(scanAll.results[0]),
    );
    const completeAfter = await prisma.lead.findUnique({ where: { id: completeLead.id } });
    const completeRaw = (completeAfter?.rawProfileData ?? {}) as {
      contacts?: { socialLinks?: Record<string, string> };
    };
    check(
      completeRaw.contacts?.socialLinks?.instagram === "https://www.instagram.com/fairviewsmiles_dental/",
      "scanAll stores the new Instagram social URL",
      JSON.stringify(completeRaw.contacts?.socialLinks),
    );

    // A lead with instagramUsername but no username must be backfilled so the
    // list treats it as having Instagram and hides the Find IG action.
    const igOnlyLead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "IG Only Dental",
        instagramUsername: "known_handle",
        username: null,
        status: LeadStatus.ENRICH_PENDING,
      },
    });
    const emptyExtraction = {
      website: "https://existing-ig.ca",
      domain: "existing-ig.ca",
      pages: [],
      handle: null,
      handleConfidence: null,
      alternates: [],
      socialLinks: {},
      emails: [],
      phones: [],
      whatsapp: null,
      socialOnly: false,
      fetchedAt: new Date().toISOString(),
      homepageHtml: null,
      homepageTitle: null,
      homepageH1: null,
      ogSiteName: null,
    };
    await applyWebsiteEnrichmentToLead(
      {
        id: igOnlyLead.id,
        username: null,
        instagramUsername: "known_handle",
        fullName: "IG Only Dental",
        website: "https://existing-ig.ca",
        status: LeadStatus.ENRICH_PENDING,
        campaign: { location: "Toronto, ON" },
      },
      emptyExtraction,
      { force: true },
    );
    const igOnlyAfter = await prisma.lead.findUnique({ where: { id: igOnlyLead.id } });
    check(
      igOnlyAfter?.username === "known_handle",
      "username is backfilled from instagramUsername",
      String(igOnlyAfter?.username),
    );

    // Campaign and campaign-scoped discovery limits have no 100 cap.
    check(
      getMaxLeadLimit() === MAX_CAMPAIGN_LEAD_LIMIT,
      "discovery max lead limit has no 100 cap",
      String(getMaxLeadLimit()),
    );
    check(parseLeadLimit(101) === 101, "discovery lead limit accepts 101");
    check(parseLeadLimit(1000) === 1000, "discovery lead limit accepts 1000");
    check(parseCampaignLeadLimit(101) === 101, "campaign lead limit accepts 101");
    check(parseCampaignLeadLimit(1000) === 1000, "campaign lead limit accepts 1000");
    check(
      parseCampaignLeadLimit(2_147_483_647) === 2_147_483_647,
      "campaign lead limit accepts the 32-bit maximum",
    );
    for (const invalid of [0, -1, 1.5, 2_147_483_648]) {
      let rejected = false;
      try {
        parseCampaignLeadLimit(invalid);
      } catch {
        rejected = true;
      }
      check(rejected, `campaign lead limit rejects ${invalid}`);
    }
    const bigCampaign = await createCampaign(
      {
        name: `${tag} 1000 lead limit`,
        intent: "Dental clinics",
        leadLimit: 1000,
        companyProfileId: profile.id,
      },
      user.id,
    );
    check(bigCampaign.leadLimit === 1000, "campaign with leadLimit 1000 persists", String(bigCampaign.leadLimit));

    // Lead list filter: has IG, website, or email only.
    const noContact = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        fullName: "No Contact At All",
        status: LeadStatus.NEW,
      },
    });
    const filtered = await listCampaignLeads(
      campaign.id,
      { channel: "has_ig_website_or_email", limit: "100" },
      user.id,
    );
    const filteredItems = filtered.items as Array<{ id: string }>;
    check(
      filteredItems.every((item) => item.id !== noContact.id),
      "lead filter hides leads without IG, website, or email",
      JSON.stringify(filteredItems.map((item) => item.id)),
    );
    check(
      filteredItems.some((item) => item.id === lead?.id) &&
        filteredItems.some((item) => item.id === contactLead?.id) &&
        filteredItems.some((item) => item.id === existing.id),
      "lead filter keeps IG / website / email leads",
      JSON.stringify(filteredItems.map((item) => item.id)),
    );
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }

  console.log("\n=======================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");
  if (failed > 0) process.exit(1);
}

runTests()
  .catch((err) => {
    console.error("Test execution threw error:", err);
    process.exit(1);
  })
  .finally(async () => {
    const prisma = getPrismaClient();
    await prisma.$disconnect();
  });
