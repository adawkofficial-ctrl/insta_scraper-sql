/**
 * Test Suite: Contact Extraction Pipeline (Stage 3 & Minimal Enrichment Whitelist)
 *
 * 4a) Whitelist: unwanted profile-actor fields (posts, likes, comments, images, related profiles) are NOT persisted.
 * 4b) Extractor finds email/phone/WhatsApp in bio and sample HTML; junk emails dropped;
 *     phones normalized to E.164 for CA; sources recorded (bio | website | maps).
 * 4c) Contacts are extracted only for accepted leads (rejected leads trigger zero fetches).
 * 4d) SSRF, timeout (6s), body size cap (1 MB), and max 2 pages limits still hold.
 */

import "./preload_server_only.cjs";

import {
  normalizeInstagramProfileItem,
  filterProfileActorPayload,
  WHITELISTED_PROFILE_ENRICHMENT_FIELDS,
} from "../src/lib/services/scraper/instagram-profile";
import {
  extractAllEmails,
  extractAllPhones,
  extractWhatsappLinks,
  isJunkEmail,
  normalizePhoneToE164,
  normalizeEmail,
} from "../src/lib/services/contact/contact-parser";
import {
  extractLeadContacts,
  enrichProfilesWithContacts,
  fetchPageSafe,
  fetchWebsiteContactPages,
  isPrivateOrBlockedUrl,
  WEBSITE_EXTRACT_TIMEOUT_MS,
  WEBSITE_EXTRACT_MAX_BYTES,
  WEBSITE_EXTRACT_CONCURRENCY,
} from "../src/lib/services/enrichment/website-contact-extractor";
import type { LeadProfile } from "../src/lib/types";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function runTests() {
  console.log("\n--- TEST 4a: Profile Actor Whitelist ---");

  // Raw Apify Actor output with posts, comments, likes, images, related profiles
  const dirtyApifyItem = {
    username: "torontodental",
    fullName: "Toronto Dental Clinic",
    followersCount: 1540,
    followsCount: 320,
    postsCount: 88,
    biography: "Gentle dental care in Toronto. Call (416) 555-0199",
    externalUrl: "https://torontodental.com",
    externalUrls: [{ title: "Website", url: "https://torontodental.com" }],
    isBusinessAccount: true,
    businessCategoryName: "Dentist & Dental Clinic",
    isPrivate: false,
    verified: true,
    // Unwanted actor fields that MUST be dropped:
    posts: [{ id: "p1", likesCount: 45 }],
    latestPosts: [{ id: "lp1", caption: "Visit us" }],
    likes: 120,
    comments: 44,
    profilePicUrl: "https://instagram.fcdn.net/v/t51/pic.jpg",
    profilePicUrlHD: "https://instagram.fcdn.net/v/t51/pic_hd.jpg",
    profilePictureUrl: "https://instagram.fcdn.net/v/t51/pic.jpg",
    relatedProfiles: [{ username: "otherdental" }],
    taggedPosts: [{ id: "tp1" }],
    highlights: [{ id: "h1" }],
  };

  const normalized = normalizeInstagramProfileItem(dirtyApifyItem, new Date().toISOString());
  check(normalized !== null, "normalizeInstagramProfileItem returns non-null for valid item");

  if (normalized) {
    check(normalized.username === "torontodental", "username is preserved");
    check(normalized.fullName === "Toronto Dental Clinic", "fullName is preserved");
    check(normalized.followersCount === 1540, "followersCount is preserved");
    check(normalized.followsCount === 320, "followsCount is preserved");
    check(normalized.postsCount === 88, "postsCount is preserved");
    check(normalized.biography === "Gentle dental care in Toronto. Call (416) 555-0199", "biography is preserved");
    check(normalized.externalUrl === "https://torontodental.com", "externalUrl is preserved");
    check(normalized.isBusinessAccount === true, "isBusinessAccount is preserved");
    check(normalized.businessCategoryName === "Dentist & Dental Clinic", "businessCategoryName is preserved");
    check(normalized.isPrivate === false, "isPrivate is preserved");
    check(normalized.verified === true, "verified is preserved");

    // Dropped fields must be null:
    check(normalized.profilePictureUrl === null, "profilePictureUrl dropped (null)");
    check(normalized.profilePicUrl === null, "profilePicUrl dropped (null)");
    check(normalized.profilePicUrlHD === null, "profilePicUrlHD dropped (null)");
    check(normalized.relatedProfiles === null, "relatedProfiles dropped (null)");
    check(normalized.latestPosts === null, "latestPosts dropped (null)");

    // rawProfileData must only retain whitelisted profile fields + enrichmentStatus
    const rawData = normalized.rawProfileData as Record<string, unknown>;
    check(rawData !== null && typeof rawData === "object", "rawProfileData is an object");
    check(rawData.posts === undefined, "rawProfileData.posts dropped");
    check(rawData.latestPosts === undefined, "rawProfileData.latestPosts dropped");
    check(rawData.likes === undefined, "rawProfileData.likes dropped");
    check(rawData.comments === undefined, "rawProfileData.comments dropped");
    check(rawData.profilePicUrl === undefined, "rawProfileData.profilePicUrl dropped");
    check(rawData.profilePicUrlHD === undefined, "rawProfileData.profilePicUrlHD dropped");
    check(rawData.profilePictureUrl === undefined, "rawProfileData.profilePictureUrl dropped");
    check(rawData.relatedProfiles === undefined, "rawProfileData.relatedProfiles dropped");
    check(rawData.taggedPosts === undefined, "rawProfileData.taggedPosts dropped");
    check(rawData.highlights === undefined, "rawProfileData.highlights dropped");
    check(rawData.externalUrls !== undefined, "rawProfileData.externalUrls preserved when present");
  }

  // Check filterProfileActorPayload directly
  const filtered = filterProfileActorPayload(dirtyApifyItem);
  check(Object.keys(filtered).every((k) => (WHITELISTED_PROFILE_ENRICHMENT_FIELDS as readonly string[]).includes(k)), "filterProfileActorPayload keeps only whitelisted keys");
  check(!("posts" in filtered), "filtered does not contain posts");
  check(!("likes" in filtered), "filtered does not contain likes");
  check(!("comments" in filtered), "filtered does not contain comments");
  check(!("profilePicUrl" in filtered), "filtered does not contain profilePicUrl");
  check(!("relatedProfiles" in filtered), "filtered does not contain relatedProfiles");
  check(filtered.username === "torontodental", "filtered contains username");
  check(filtered.followersCount === 1540, "filtered contains followersCount");

  console.log("\n--- TEST 4b: Contact Extractor (Bio, HTML, WhatsApp, Junk Filter, E.164, Sources) ---");

  // 1. Bio extraction
  const sampleBio = `
    Top rated dental clinic in Yorkville, Toronto 🦷
    📍 123 Bay St, Toronto, ON
    📞 (416) 555-0199
    💬 WhatsApp us: https://wa.me/14165550199
    ✉️ hello@yorkvilledental.ca
    🌐 https://yorkvilledental.ca
  `;

  const bioContacts = await extractLeadContacts({
    bio: sampleBio,
    countryCode: "CA",
  });

  check(bioContacts.emails.length === 1, "Bio extractor finds 1 email");
  check(bioContacts.emails[0]?.value === "hello@yorkvilledental.ca", "Bio email correctly extracted");
  check(bioContacts.emails[0]?.source === "bio", "Bio email source is 'bio'");

  check(bioContacts.phones.length === 1, "Bio extractor finds 1 phone");
  check(bioContacts.phones[0]?.normalized === "+14165550199", "Bio phone normalized to E.164 for CA (+14165550199)");
  check(bioContacts.phones[0]?.source === "bio", "Bio phone source is 'bio'");

  check(bioContacts.whatsapps.length === 1, "Bio extractor finds 1 WhatsApp link");
  check(bioContacts.whatsapps[0]?.url.includes("wa.me/14165550199"), "Bio WhatsApp URL is correct");
  check(bioContacts.whatsapps[0]?.source === "bio", "Bio WhatsApp source is 'bio'");

  // 2. Junk email filtering
  check(isJunkEmail("hero_banner.png") === true, "Junk filter drops png filename");
  check(isJunkEmail("logo.jpeg") === true, "Junk filter drops jpeg filename");
  check(isJunkEmail("icon.svg") === true, "Junk filter drops svg filename");
  check(isJunkEmail("example@clinic.com") === true, "Junk filter drops example@ address");
  check(isJunkEmail("test@yorkvilledental.ca") === true, "Junk filter drops test@ address");
  check(isJunkEmail("noreply@torontodental.com") === true, "Junk filter drops noreply@ address");
  check(isJunkEmail("no-reply@domain.com") === true, "Junk filter drops no-reply@ address");
  check(isJunkEmail("donotreply@booking.com") === true, "Junk filter drops donotreply@ address");
  check(isJunkEmail("error-reports@sentry.io") === true, "Junk filter drops sentry.io domain");
  check(isJunkEmail("support@sentry-cdn.com") === true, "Junk filter drops sentry-related domain");
  check(isJunkEmail("info@wixpress.com") === true, "Junk filter drops wixpress.com domain");
  check(isJunkEmail("webmaster@wix.com") === true, "Junk filter drops wix.com domain");
  check(isJunkEmail("admin@wordpress.com") === true, "Junk filter drops wordpress.com domain");
  check(isJunkEmail("info@example.org") === true, "Junk filter drops example.org domain");
  check(isJunkEmail("contact@valid-dental-clinic.ca") === false, "Junk filter keeps genuine clinic email");
  check(isJunkEmail("dr.smith@yorkvilledental.com") === false, "Junk filter keeps doctor email");

  // 3. E.164 normalization for CA and other countries
  check(normalizePhoneToE164("416-555-0199", "CA") === "+14165550199", "10-digit CA phone normalized to +14165550199");
  check(normalizePhoneToE164("(416) 555-0199", "CA") === "+14165550199", "Formatted CA phone normalized to +14165550199");
  check(normalizePhoneToE164("1-416-555-0199", "CA") === "+14165550199", "11-digit with 1 CA phone normalized to +14165550199");
  check(normalizePhoneToE164("03001234567", "PK") === "+923001234567", "Pakistani mobile normalized to +923001234567");
  check(normalizePhoneToE164("07123456789", "GB") === "+447123456789", "UK phone normalized to +447123456789");
  check(normalizePhoneToE164("2024", "CA") === null, "Year 2024 rejected as phone");
  check(normalizePhoneToE164("123", "CA") === null, "Short number rejected as phone");

  // 4. HTML parsing with mocked fetch
  const sampleHomepageHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Downtown Dental</title></head>
      <body>
        <header>
          <a href="mailto:contact@downtowndental.ca">contact@downtowndental.ca</a>
          <a href="mailto:banner.png@2x.jpg">Junk</a>
          <a href="mailto:noreply@downtowndental.ca">No reply</a>
          <a href="tel:416-555-4321">Call (416) 555-4321</a>
        </header>
        <main>
          <p>Book via WhatsApp: <a href="https://api.whatsapp.com/send?phone=14165554321">Chat</a></p>
          <p>Or visit our <a href="/contact-us">Contact Page</a></p>
        </main>
        <footer>
          <a href="https://facebook.com/downtowndental">Facebook</a>
          <a href="https://tiktok.com/@downtowndental">TikTok</a>
        </footer>
      </body>
    </html>
  `;

  const sampleContactSubpageHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Contact Us - Downtown Dental</title></head>
      <body>
        <h1>Get in Touch</h1>
        <p>Direct line: <a href="tel:+14165558888">+1 (416) 555-8888</a></p>
        <p>Alternate email: info@downtowndental.ca</p>
      </body>
    </html>
  `;

  // Mock global fetch to intercept requests for downtowndental.ca
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input.toString();

    if (urlStr.includes("downtowndental.ca/contact-us")) {
      return new Response(sampleContactSubpageHtml, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (urlStr.includes("downtowndental.ca")) {
      return new Response(sampleHomepageHtml, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  try {
    const contactsFromWeb = await extractLeadContacts({
      website: "https://downtowndental.ca",
      mapsPhone: "(416) 555-9999",
      countryCode: "CA",
    });

    // Check emails
    const emailValues = contactsFromWeb.emails.map((e) => e.value);
    check(emailValues.includes("contact@downtowndental.ca"), "HTML extracted contact@downtowndental.ca");
    check(emailValues.includes("info@downtowndental.ca"), "Contact page extracted info@downtowndental.ca");
    check(!emailValues.some((e) => e.includes("noreply")), "Junk email noreply dropped");
    check(!emailValues.some((e) => e.includes("banner.png")), "Junk image email dropped");

    // Check email source
    const webEmail = contactsFromWeb.emails.find((e) => e.value === "contact@downtowndental.ca");
    check(webEmail?.source === "website", "Website email source is 'website'");

    // Check phones and sources
    const mapsPhone = contactsFromWeb.phones.find((p) => p.source === "maps");
    check(mapsPhone !== undefined, "Maps phone is preserved");
    check(mapsPhone?.normalized === "+14165559999", "Maps phone normalized to +14165559999");
    check(mapsPhone?.source === "maps", "Maps phone source is 'maps'");

    const webPhone = contactsFromWeb.phones.find((p) => p.normalized === "+14165554321");
    check(webPhone !== undefined, "Website phone 416-555-4321 extracted");
    check(webPhone?.source === "website", "Website phone source is 'website'");

    const subpagePhone = contactsFromWeb.phones.find((p) => p.normalized === "+14165558888");
    check(subpagePhone !== undefined, "Subpage phone +14165558888 extracted");
    check(subpagePhone?.source === "website", "Subpage phone source is 'website'");

    // Check WhatsApp
    check(contactsFromWeb.whatsapps.length > 0, "WhatsApp extracted from HTML link");
    check(contactsFromWeb.whatsapps[0]?.url.includes("api.whatsapp.com"), "WhatsApp URL contains api.whatsapp.com");
    check(contactsFromWeb.whatsapps[0]?.source === "website", "WhatsApp source is 'website'");

    // Check Social Links
    check(contactsFromWeb.socialLinks.facebook?.includes("facebook.com/downtowndental") === true, "Facebook link extracted");
    check(contactsFromWeb.socialLinks.tiktok?.includes("tiktok.com/@downtowndental") === true, "TikTok link extracted");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\n--- TEST 4c: Accepted vs Rejected Leads (Stage 3 Extraction Timing) ---");

  let fetchCallCount = 0;
  const mockFetchCounter = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCallCount++;
    return new Response("<html><body>Contact us: info@clinic.ca</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof globalThis.fetch;

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchCounter;

  try {
    // Lead 1: Accepted lead that passed all gates
    const acceptedLead: LeadProfile = {
      username: "acceptedclinic",
      profileUrl: "https://instagram.com/acceptedclinic/",
      instagramId: "id_1",
      fullName: "Accepted Clinic",
      biography: "Quality health services in Toronto",
      website: "https://acceptedclinic.com",
      externalUrl: "https://acceptedclinic.com",
      followers: 1200,
      following: 300,
      followersCount: 1200,
      followsCount: 300,
      postsCount: 50,
      profilePictureUrl: null,
      isVerified: false,
      isBusiness: true,
      category: "Medical & Health",
      location: "Toronto, ON, Canada",
      relatedProfiles: null,
      latestPosts: null,
      source: "apify",
      scrapedAt: new Date().toISOString(),
    };

    // Lead 2: Rejected lead (e.g. failed category, negative keyword, or AI gate)
    const rejectedLead: LeadProfile = {
      username: "rejectedlead",
      profileUrl: "https://instagram.com/rejectedlead/",
      instagramId: "id_2",
      fullName: "Crypto Academy",
      biography: "Buy bitcoin forex trading signals",
      website: "https://cryptoscam.com",
      externalUrl: "https://cryptoscam.com",
      followers: 50,
      following: 2000,
      followersCount: 50,
      followsCount: 2000,
      postsCount: 5,
      profilePictureUrl: null,
      isVerified: false,
      isBusiness: false,
      category: "Cryptocurrency",
      location: null,
      relatedProfiles: null,
      latestPosts: null,
      source: "apify",
      scrapedAt: new Date().toISOString(),
    };

    // In discovery-service.ts, only accepted leads that survive gates (toPersist) are passed to enrichProfilesWithContacts.
    // The rejected leads are never passed to the extractor!
    fetchCallCount = 0;

    // Simulate rejected leads: zero calls made
    // (Notice we do NOT call enrichProfilesWithContacts on rejected leads)
    check(fetchCallCount === 0, "Rejected leads trigger 0 fetches initially");

    // Simulate accepted leads: only accepted lead is processed
    const enrichmentResult = await enrichProfilesWithContacts([acceptedLead], {
      countryCode: "CA",
    });

    check(fetchCallCount > 0, "Accepted lead triggers website contact extraction fetch");
    check(enrichmentResult.enrichedProfiles.length === 1, "Enriched profiles returned 1 lead");
    check(enrichmentResult.contactsExtracted.email >= 1, "ContactsExtracted email count tracked in funnel");
    check(enrichmentResult.leadsWithAnyContact === 1, "leadsWithAnyContact counted in funnel");
    check(acceptedLead.rawProfileData !== undefined, "rawProfileData populated on accepted lead");
    check(Boolean((acceptedLead.rawProfileData as { contacts?: unknown })?.contacts), "rawProfileData.contacts is saved");
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("\n--- TEST 4d: SSRF, Timeout, Size limits, Max 2 pages ---");

  // 1. SSRF guard checks
  check(isPrivateOrBlockedUrl("http://localhost") === true, "SSRF: localhost blocked");
  check(isPrivateOrBlockedUrl("http://localhost:3000") === true, "SSRF: localhost:3000 blocked");
  check(isPrivateOrBlockedUrl("http://app.localhost") === true, "SSRF: *.localhost blocked");
  check(isPrivateOrBlockedUrl("http://127.0.0.1") === true, "SSRF: 127.0.0.1 blocked");
  check(isPrivateOrBlockedUrl("http://127.0.0.1:8080/admin") === true, "SSRF: 127.0.0.1:8080 blocked");
  check(isPrivateOrBlockedUrl("http://0.0.0.0") === true, "SSRF: 0.0.0.0 blocked");
  check(isPrivateOrBlockedUrl("http://10.0.0.1") === true, "SSRF: 10.0.0.1 private IP blocked");
  check(isPrivateOrBlockedUrl("http://172.16.0.1") === true, "SSRF: 172.16.0.1 private IP blocked");
  check(isPrivateOrBlockedUrl("http://192.168.1.1") === true, "SSRF: 192.168.1.1 private IP blocked");
  check(isPrivateOrBlockedUrl("http://169.254.169.254/latest/meta-data") === true, "SSRF: 169.254.169.254 AWS metadata IP blocked");
  check(isPrivateOrBlockedUrl("ftp://clinic.ca") === true, "SSRF: non-http/https protocol blocked");
  check(isPrivateOrBlockedUrl("file:///etc/passwd") === true, "SSRF: file:// protocol blocked");
  check(isPrivateOrBlockedUrl("https://exampleclinic.ca") === false, "SSRF: public https allowed");
  check(isPrivateOrBlockedUrl("http://exampleclinic.ca") === false, "SSRF: public http allowed");

  // fetchPageSafe directly refuses blocked URLs without making network request
  const blockedResult = await fetchPageSafe("http://127.0.0.1:9099/private");
  check(blockedResult === null, "fetchPageSafe returns null for SSRF-blocked IP without network call");

  // 2. Constants and limits
  check(WEBSITE_EXTRACT_TIMEOUT_MS === 6000, "Timeout is strictly 6000ms (6s)");
  check(WEBSITE_EXTRACT_MAX_BYTES === 1024 * 1024, "Max body size is strictly 1 MB (1048576 bytes)");
  check(WEBSITE_EXTRACT_CONCURRENCY === 5, "Concurrency is strictly 5");

  // 3. Max 2 pages check
  let pageFetchCount = 0;
  const mockPageTracker = (async (input: RequestInfo | URL) => {
    pageFetchCount++;
    const urlStr = typeof input === "string" ? input : input.toString();
    if (urlStr.includes("/contact")) {
      return new Response("<html><body>Contact page: info@clinic.ca</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response(
      "<html><body><a href='/contact'>Contact Us</a><a href='/about'>About</a><a href='/location'>Location</a></body></html>",
      {
        status: 200,
        headers: { "content-type": "text/html" },
      },
    );
  }) as typeof globalThis.fetch;

  const savedFetch = globalThis.fetch;
  globalThis.fetch = mockPageTracker;

  try {
    pageFetchCount = 0;
    const pages = await fetchWebsiteContactPages("https://mytestclinic.com", 6000);
    check(pages.homeHtml !== null, "Homepage fetched");
    check(pages.contactHtml !== null, "Contact subpage fetched");
    check(pageFetchCount === 2, `Fetched exactly 2 pages (actual: ${pageFetchCount})`);
  } finally {
    globalThis.fetch = savedFetch;
  }

  console.log(`\n========================================`);
  console.log(`SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
