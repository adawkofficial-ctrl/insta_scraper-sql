/**
 * Pure unit tests for website business-profile extraction and the website
 * scraper parsing fixes (subpage ranking, tel: decoding, script-borne junk
 * emails, tolerant JSON-LD, merged multi-page profiles).
 *
 * No DB, no network: every fetch goes through an in-memory fixture fetcher.
 * Run: npx tsx -r ./scripts/preload_server_only.cjs scripts/test_website_business_profile.ts
 * (run-all-tests sets that preload through NODE_OPTIONS).
 */

import {
  decodeEntities,
  extractBusinessProfile,
  hasBusinessData,
  mergeBusinessProfiles,
  parseJsonLdBlocks,
} from "../src/lib/services/enrichment/website-business-profile";
import {
  extractWebsiteData,
  findSameDomainSubpages,
  scrapeLeadWebsite,
  __resetWebsiteRateLimiterForTesting,
  type WebsiteFetchFn,
} from "../src/lib/services/enrichment/website-lead-enricher";
import { mergeContactsData } from "../src/lib/services/enrichment/website-contact-extractor";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
    failed++;
  }
}

const HOME_HTML = `<!doctype html>
<html lang="en-CA">
<head>
  <title>Maple Smiles Dental &amp; Implants | Toronto Dentist</title>
  <meta name="description" content="Family &amp; cosmetic dentistry in downtown Toronto. Same-day emergency appointments.">
  <meta property="og:site_name" content="Maple Smiles">
  <meta property="og:image" content="https://maplesmiles.ca/og.jpg">
  <meta name="keywords" content="dentist toronto, teeth whitening, invisalign, dental implants">
  <meta name="generator" content="WordPress 6.4">
  <script type="application/ld+json">
  <!--
  {"@context":"https://schema.org","@graph":[
    {"@type":"WebSite","name":"Maple Smiles","url":"https://maplesmiles.ca"},
    {"@type":"Dentist","name":"Maple Smiles Dental","priceRange":"$$","foundingDate":"2009-04-01",
     "telephone":"+1 416-555-0142",
     "address":{"@type":"PostalAddress","streetAddress":"120 King St W","addressLocality":"Toronto","addressRegion":"ON","postalCode":"M5H 1A1","addressCountry":"CA"},
     "geo":{"@type":"GeoCoordinates","latitude":43.6487,"longitude":-79.3817},
     "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"212"},
     "openingHoursSpecification":[
       {"@type":"OpeningHoursSpecification","dayOfWeek":["https://schema.org/Monday","https://schema.org/Tuesday"],"opens":"09:00:00","closes":"17:00:00"},
       {"@type":"OpeningHoursSpecification","dayOfWeek":"Saturday","opens":"10:00","closes":"14:00"}
     ],
     "areaServed":["Toronto","Etobicoke"],
     "makesOffer":[{"@type":"Offer","itemOffered":{"@type":"Service","name":"Teeth Whitening"}},{"@type":"Offer","itemOffered":{"@type":"Service","name":"Dental Implants"}}]
    }
  ]}
  -->
  </script>
  <script>var cfg = {"support":"bundle@sentry-cdn.example","img":"logo@2x.png"};</script>
</head>
<body>
  <header><nav>
    <a href="/">Home</a>
    <a href="/our-team">Our Team</a>
    <a href="/services">Services</a>
    <a href="/contact-maple">Contact</a>
    <a href="https://www.instagram.com/maplesmiles/">IG</a>
  </nav></header>
  <h1>Gentle dentistry for the whole family</h1>
  <p>Short intro.</p>
  <p>Maple Smiles has been caring for Toronto families since 2009, offering everything from routine cleanings to full smile makeovers in a calm, modern clinic.</p>
  <section class="services-grid">
    <h3>Invisalign</h3><h3>Emergency Dentistry</h3><h3>Learn more</h3>
  </section>
  <a href="https://maplesmiles.janeapp.com/">Book online</a>
  <a href="tel:%2B14165550142">Call us</a>
</body>
</html>`;

const CONTACT_HTML = `<html><head><title>Contact Maple Smiles</title></head><body>
  <p>Email us: hello@maplesmiles.ca or dr.lee (at) maplesmiles (dot) ca</p>
  <a href="mailto:Bookings@MapleSmiles.ca">Bookings</a>
  <meta itemprop="openingHours" content="Su closed">
</body></html>`;

async function run() {
  console.log("\n[1] decodeEntities");
  check(decodeEntities("Caf&eacute; &amp; Bar &#8211; &#x27;Best&#x27;") === "Café & Bar – 'Best'", "named + numeric + hex entities");
  check(decodeEntities("&bogus; stays") === "&bogus; stays", "unknown entity left intact");

  console.log("\n[2] JSON-LD tolerance");
  const nodes = parseJsonLdBlocks(HOME_HTML);
  check(nodes.some((n) => n["@type"] === "Dentist"), "parses @graph inside an HTML comment", nodes.map((n) => n["@type"]));
  const messy = `<script type="application/ld+json">{"@type":"Restaurant","name":"Line
Break Diner"};</script>`;
  check(parseJsonLdBlocks(messy).some((n) => n.name === "Line Break Diner"), "recovers raw newline + trailing semicolon");

  console.log("\n[3] extractBusinessProfile (homepage)");
  const profile = extractBusinessProfile(HOME_HTML, "https://maplesmiles.ca/");
  check(profile.title === "Maple Smiles Dental & Implants | Toronto Dentist", "title entity-decoded", profile.title);
  check(profile.description?.startsWith("Family & cosmetic dentistry") === true, "meta description", profile.description);
  check(profile.businessType === "Dentist", "business type from JSON-LD (skips WebSite)", profile.businessType);
  check(profile.businessName === "Maple Smiles Dental", "business name", profile.businessName);
  check(profile.address === "120 King St W, Toronto, ON, M5H 1A1", "structured address joined", profile.address);
  check(profile.city === "Toronto" && profile.postalCode === "M5H 1A1", "city + postal code");
  check(profile.latitude === 43.6487 && profile.longitude === -79.3817, "geo coordinates");
  check(profile.rating === 4.8 && profile.reviewCount === 212, "aggregate rating", [profile.rating, profile.reviewCount]);
  check(profile.priceRange === "$$", "price range");
  check(profile.foundedYear === 2009, "founded year", profile.foundedYear);
  check(
    profile.openingHours.includes("Mo,Tu 09:00-17:00") && profile.openingHours.includes("Sa 10:00-14:00"),
    "opening hours from specification",
    profile.openingHours,
  );
  check(profile.areaServed.join("|") === "Toronto|Etobicoke", "area served", profile.areaServed);
  check(
    ["Teeth Whitening", "Dental Implants", "Invisalign", "Emergency Dentistry"].every((s) => profile.services.includes(s)),
    "services from offers + services section",
    profile.services,
  );
  check(!profile.services.includes("Learn more"), "noise headings filtered", profile.services);
  check(profile.keywords.includes("teeth whitening") && profile.keywords.length === 4, "meta keywords", profile.keywords);
  check(profile.summary?.startsWith("Maple Smiles has been caring") === true, "summary skips short paragraphs", profile.summary);
  check(profile.bookingUrl === "https://maplesmiles.janeapp.com/", "booking link detected", profile.bookingUrl);
  check(profile.platform === "WordPress", "platform detected", profile.platform);
  check(profile.language === "en-CA", "html lang");
  check(hasBusinessData(profile), "hasBusinessData true");

  console.log("\n[4] mergeBusinessProfiles");
  const contactProfile = extractBusinessProfile(CONTACT_HTML, "https://maplesmiles.ca/contact-maple");
  const mergedProfile = mergeBusinessProfiles(profile, contactProfile);
  check(mergedProfile.title === profile.title, "homepage wins on identity fields");
  check(mergedProfile.openingHours.includes("Su closed"), "subpage fills extra hours", mergedProfile.openingHours);
  check(mergedProfile.sourceUrls.length === 2, "source urls tracked", mergedProfile.sourceUrls);
  check(!hasBusinessData(extractBusinessProfile("<html><body></body></html>", "https://x.test/")), "empty page => no data");

  console.log("\n[5] extractWebsiteData parsing fixes");
  const data = extractWebsiteData(HOME_HTML, "https://maplesmiles.ca/", { countryCode: "CA", domain: "maplesmiles.ca" });
  check(data.phones.some((p) => p.normalized === "+14165550142" && p.source === "tel"), "tel:%2B decoded", data.phones);
  check(!data.emails.some((e) => /sentry|2x\.png/.test(e.value)), "no emails from <script> bundles", data.emails);
  const contactData = extractWebsiteData(CONTACT_HTML, "https://maplesmiles.ca/contact-maple", { countryCode: "CA" });
  const values = contactData.emails.map((e) => e.value);
  check(values.includes("bookings@maplesmiles.ca"), "mailto lower-cased", values);
  check(values.includes("dr.lee@maplesmiles.ca"), "(at)/(dot) obfuscation", values);
  check(values.includes("hello@maplesmiles.ca"), "plain text email", values);

  console.log("\n[6] findSameDomainSubpages ranking");
  const subpages = findSameDomainSubpages(HOME_HTML, "https://maplesmiles.ca/", 4);
  check(subpages[0] === "https://maplesmiles.ca/contact-maple", "linked contact page first", subpages);
  check(!subpages.includes("https://maplesmiles.ca/contact"), "guessed /contact skipped when a contact link exists", subpages);
  check(subpages.includes("https://maplesmiles.ca/services"), "services page considered", subpages);
  const intl = findSameDomainSubpages(
    `<a href="/kontakt">Kontakt</a><a href="/impressum">Impressum</a><a href="/blog">Blog</a>`,
    "https://baeckerei.de/",
    4,
  );
  check(intl.includes("https://baeckerei.de/kontakt") && intl.includes("https://baeckerei.de/impressum"), "non-English slugs", intl);
  check(!intl.includes("https://baeckerei.de/blog"), "irrelevant pages skipped", intl);

  console.log("\n[7] scrapeLeadWebsite end-to-end (fixture fetcher)");
  __resetWebsiteRateLimiterForTesting();
  const site: Record<string, string> = {
    "https://maplesmiles.ca/": HOME_HTML,
    "https://maplesmiles.ca": HOME_HTML,
    "https://maplesmiles.ca/contact-maple": CONTACT_HTML,
  };
  const fetchFn: WebsiteFetchFn = async (url) =>
    site[url] ? { ok: true, html: site[url], finalUrl: url, status: 200 } : { ok: false, status: 404, error: "HTTP status 404" };
  const result = await scrapeLeadWebsite(
    { website: "https://maplesmiles.ca/", businessName: "Maple Smiles", countryCode: "CA" },
    { fetchFn, timeoutMs: 1000 },
  );
  check(result.handle === "maplesmiles", "instagram handle", result.handle);
  check(result.business?.businessType === "Dentist", "business profile attached to scrape result", result.business?.businessType);
  check(result.business?.openingHours.includes("Su closed") === true, "subpage merged into profile", result.business?.openingHours);
  check(result.emails.length >= 3, "emails gathered across pages", result.emails.map((e) => e.value));
  const failedPage = result.pages.find((p) => !p.ok);
  check(!failedPage || failedPage.status === 404, "real HTTP status recorded for failed pages", failedPage);

  console.log("\n[8] mergeContactsData keeps prior contacts");
  const merged = mergeContactsData(
    {
      emails: [{ value: "old@site.com", source: "website", sourceUrl: "https://site.com/contact", generic: false }],
      phones: [{ value: "416-555-0000", normalized: "+14165550000", source: "maps" }],
      whatsapps: [],
      socialLinks: { facebook: "https://facebook.com/site" },
    },
    {
      emails: [{ value: "New@Site.com", source: "bio" }],
      phones: [{ value: "416-555-0000", normalized: "+14165550000", source: "website" }],
      whatsapps: [],
      socialLinks: { tiktok: "https://tiktok.com/@site" },
      extractedAt: "2026-11-25T00:00:00.000Z",
    },
  );
  check(merged.emails.length === 2, "previous + new email kept", merged.emails);
  check((merged.emails[0] as unknown as { sourceUrl?: string }).sourceUrl === "https://site.com/contact", "old metadata preserved");
  check(merged.emails.some((e) => e.value === "new@site.com"), "new email lower-cased");
  check(merged.phones.length === 1, "duplicate phone not repeated", merged.phones);
  check(Boolean(merged.socialLinks.facebook && (merged.socialLinks as Record<string, unknown>).tiktok), "socials unioned");

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
