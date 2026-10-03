/**
 * TASK: Full Instagram lead pipeline optimization regression suite.
 * Tests Part A (Location fix), Part B (Actor field mapping), Part C (Contact data extraction),
 * Part D (Website fallback scrape), Part E (Channel tagging & filtering), and Part F (Budget & Safety).
 */

import {
  evaluateProfileRelevance,
  decideRelevance,
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  type DiscoveryRelevancePolicy,
} from "../src/lib/services/discovery/lead-relevance";
import {
  extractEmail,
  extractPhone,
  normalizePhone,
  extractContactFromBio,
  computeAvailableChannels,
} from "../src/lib/services/contact/contact-parser";
import {
  extractContactsFromHtml,
  findContactSubpageUrls,
  enrichProfilesWithWebsiteFallback,
} from "../src/lib/services/enrichment/website-contact-extractor";
import { normalizeInstagramProfileItem } from "../src/lib/services/scraper/instagram-profile";
import type { LeadProfile } from "../src/lib/types";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}`);
    failed++;
  }
}

function makeProfile(overrides: Partial<LeadProfile> & { username: string }): LeadProfile {
  return {
    profileUrl: `https://www.instagram.com/${overrides.username}`,
    instagramId: null,
    fullName: null,
    biography: null,
    followers: null,
    following: null,
    postsCount: null,
    profilePictureUrl: null,
    isVerified: null,
    isBusiness: null,
    category: null,
    externalUrl: null,
    location: null,
    relatedProfiles: null,
    latestPosts: null,
    source: "apify",
    scrapedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function runTests(): Promise<void> {
  console.log("=================================================================");
  console.log("   FULL INSTAGRAM LEAD PIPELINE OPTIMIZATION TEST SUITE          ");
  console.log("=================================================================");

  // =========================================================================
  // PART A: LOCATION FIX TESTS
  // =========================================================================
  console.log("\n[PART A: Location Bug Diagnosis & Policy Enforcement]");
  const rawalpindiCampaign = {
    intent: "hospital medical center",
    location: "Rawalpindi",
    category: "Healthcare",
  };

  const strictLocationPolicy: DiscoveryRelevancePolicy = {
    ...DEFAULT_DISCOVERY_RELEVANCE_POLICY,
    requireLocationMatch: true,
    allowUnknownLocation: false,
  };

  // 1. Profile with explicit matching location
  const rawalpindiHospital = makeProfile({
    username: "rawalpindi_care",
    fullName: "Rawalpindi Care Hospital",
    biography: "Comprehensive healthcare in Rawalpindi, Pakistan",
    location: "Rawalpindi, Pakistan",
    category: "Hospital",
  });
  const rel1 = evaluateProfileRelevance(rawalpindiHospital, rawalpindiCampaign);
  check(rel1.locationMatch === "MATCHED", "Explicit Rawalpindi location evaluates to MATCHED");
  const dec1 = decideRelevance(rel1, strictLocationPolicy);
  check(dec1.relevant, "Candidate in Rawalpindi is accepted under strict location policy");

  // 2. Profile with local city alias (RWP) in bio
  const rwpClinic = makeProfile({
    username: "city_clinic_rwp",
    fullName: "City Medical Clinic",
    biography: "Leading specialist doctors in RWP. Book your visit now.",
    category: "Medical Center",
  });
  const rel2 = evaluateProfileRelevance(rwpClinic, rawalpindiCampaign);
  check(rel2.locationMatch === "MATCHED", "City alias RWP in bio evaluates to MATCHED");
  const dec2 = decideRelevance(rel2, strictLocationPolicy);
  check(dec2.relevant, "Candidate with RWP alias is accepted under strict location policy");

  // 3. Profile with conflicting explicit location (Dubai)
  const dubaiHospital = makeProfile({
    username: "dubai_specialist_hospital",
    fullName: "Dubai Specialist Hospital",
    biography: "State of the art medical center in Downtown Dubai",
    location: "Dubai, UAE",
    category: "Hospital",
  });
  const rel3 = evaluateProfileRelevance(dubaiHospital, rawalpindiCampaign);
  check(rel3.locationMatch === "NOT_MATCHED", "Conflicting location Dubai evaluates to NOT_MATCHED");
  const dec3 = decideRelevance(rel3, strictLocationPolicy);
  check(!dec3.relevant && dec3.reason === "IRRELEVANT_LOCATION", "Candidate in Dubai is rejected with IRRELEVANT_LOCATION");

  // 4. Candidate with NO location evidence (missing/unknown location on Instagram)
  // This was the known bug: previously passed as relevant because allowUnknownLocation was true.
  const unknownLocationHospital = makeProfile({
    username: "general_healthcare_center",
    fullName: "General Healthcare Center",
    biography: "General practice and dental care. Mon-Fri 9am-5pm.",
    location: null,
    category: "Hospital",
  });
  const rel4 = evaluateProfileRelevance(unknownLocationHospital, rawalpindiCampaign);
  check(rel4.locationMatch === "UNKNOWN", "Missing location on Instagram evaluates to UNKNOWN");
  const dec4 = decideRelevance(rel4, strictLocationPolicy);
  check(!dec4.relevant && dec4.reason === "IRRELEVANT_LOCATION", "Candidate with missing/unknown location is rejected with IRRELEVANT_LOCATION when campaign location is specified");

  // 5. Campaign WITHOUT location: missing location should still be allowed
  const unlocatedCampaign = {
    intent: "hospital medical center",
    location: null,
    category: "Healthcare",
  };
  const rel5 = evaluateProfileRelevance(unknownLocationHospital, unlocatedCampaign);
  const dec5 = decideRelevance(rel5, DEFAULT_DISCOVERY_RELEVANCE_POLICY);
  check(dec5.relevant, "When campaign has no location, missing location is accepted by default");

  // =========================================================================
  // PART B: ACTOR OUTPUT MAPPING
  // =========================================================================
  console.log("\n[PART B: Apify Actor Output Mapping]");
  const sampleApifyProfileItem = {
    id: "71387901184",
    username: "health_medical_center",
    url: "https://www.instagram.com/health_medical_center",
    fullName: "Health & Medical Center Rawalpindi",
    biography: "Best clinic in Rawalpindi. Email: info@healthmed.pk | WhatsApp: 0300-1234567",
    externalUrl: "https://healthmed.pk",
    followersCount: 1540,
    followsCount: 120,
    postsCount: 45,
    isBusinessAccount: true,
    businessCategoryName: "Hospital",
    verified: false,
    profilePicUrl: "https://instagram.com/pic.jpg",
    profilePicUrlHD: "https://instagram.com/pic_hd.jpg",
    locationName: "Rawalpindi, Pakistan",
  };

  const normalized = normalizeInstagramProfileItem(sampleApifyProfileItem, new Date().toISOString());
  check(normalized !== null, "Apify profile output normalizes successfully");
  check(normalized?.username === "health_medical_center", "Normalized username matches");
  check(normalized?.fullName === "Health & Medical Center Rawalpindi", "Normalized fullName matches");
  check(normalized?.followersCount === 1540, "Followers count mapped");
  check(normalized?.isBusinessAccount === true, "isBusinessAccount mapped");
  check(normalized?.externalUrl === "https://healthmed.pk", "externalUrl mapped");
  check(normalized?.email === "info@healthmed.pk", "Bio email extracted during profile normalization");
  check(normalized?.phoneNormalized === "+923001234567", "Bio phone extracted & normalized during profile normalization");
  check(normalized?.contactSource === "instagram_bio", "contactSource is instagram_bio");
  check(
    JSON.stringify(normalized?.availableChannels) === JSON.stringify(["INSTAGRAM", "EMAIL", "PHONE"]),
    "availableChannels contains INSTAGRAM, EMAIL, PHONE",
  );

  // =========================================================================
  // PART C: CONTACT EXTRACTION REGEX & NORMALIZATION
  // =========================================================================
  console.log("\n[PART C: Bio Contact Parser & Phone Formats]");
  // Pakistani mobile formats
  check(extractPhone("Contact: 0300-1234567") === "0300-1234567", "Extract 0300-1234567");
  check(normalizePhone("0300-1234567") === "+923001234567", "Normalize 0300-1234567 to +923001234567");
  check(normalizePhone("03211234567") === "+923211234567", "Normalize 03211234567 to +923211234567");
  check(normalizePhone("+92 333 1234567") === "+923331234567", "Normalize +92 333 1234567 to +923331234567");
  check(normalizePhone("0092 345 1234567") === "+923451234567", "Normalize 0092 prefix to +923451234567");
  // Pakistani landline
  check(extractPhone("Office: 051-5551234") === "051-5551234", "Extract 051-5551234");
  check(normalizePhone("051-5551234") === "+92515551234", "Normalize 051 landline to +92515551234");

  // False positive guards
  check(extractPhone("Established in 2024 in Rawalpindi") === null, "Guard: year 2024 is not a phone");
  check(extractPhone("Proudly serving clients since 1998") === null, "Guard: year 1998 is not a phone");
  check(extractPhone("Over 100k happy customers worldwide!") === null, "Guard: 100k is not a phone");
  check(extractPhone("Package deals starting from $50") === null, "Guard: price $50 is not a phone");

  // Email extraction
  check(extractEmail("Inquiries: contact@rawalpindicare.com") === "contact@rawalpindicare.com", "Valid email extracted");
  check(extractEmail("Icon asset user@2x.png") === null, "Guard: image filename user@2x.png ignored");

  // Bio full extract
  const bioSample = "Rawalpindi Dental Clinic | Dr. Ahmad | Email: drahmed@gmail.com | WA: 0300-7654321";
  const bioParsed = extractContactFromBio(bioSample, "https://dentist.pk");
  check(bioParsed.email === "drahmed@gmail.com", "Bio email parsed");
  check(bioParsed.phoneNormalized === "+923007654321", "Bio phone normalized");
  check(bioParsed.websiteDomain === "dentist.pk", "Website domain parsed");
  check(bioParsed.contactSource === "instagram_bio", "Bio contactSource is instagram_bio");

  // =========================================================================
  // PART D: WEBSITE FALLBACK SCRAPE
  // =========================================================================
  console.log("\n[PART D: Website Fallback Extraction]");
  const fixtureHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Apex Hospital</title></head>
      <body>
        <h1>Apex Hospital Islamabad</h1>
        <p>Book online or write to <a href="mailto:info@apexhospital.com.pk">our reception</a>.</p>
        <p>Helpline: +92 51 8889900</p>
        <nav>
          <a href="/contact">Contact Page</a>
          <a href="/about-us">About Us</a>
          <a href="https://twitter.com/apex">Twitter</a>
        </nav>
      </body>
    </html>
  `;

  const webContacts = extractContactsFromHtml(fixtureHtml);
  check(webContacts.email === "info@apexhospital.com.pk", "Mailto email extracted from website HTML");
  check(webContacts.phone === "+92 51 8889900", "Phone extracted from website HTML");

  const subpages = findContactSubpageUrls(fixtureHtml, "https://apexhospital.com.pk");
  check(subpages.includes("https://apexhospital.com.pk/contact"), "Subpage link /contact found");
  check(subpages.includes("https://apexhospital.com.pk/about-us"), "Subpage link /about-us found");
  check(!subpages.some((s) => s.includes("twitter.com")), "External social link excluded from subpages");

  // Test enrichProfilesWithWebsiteFallback with cap
  console.log("\n[PART D & F: Bounded Fallback & Cap]");
  const candidatePool: LeadProfile[] = [
    // Has bio email -> should NOT trigger website fallback
    makeProfile({
      username: "user_with_bio_email",
      email: "existing@bio.com",
      phone: null,
      externalUrl: "https://site1.com",
    }),
    // Has no bio contact, has website -> eligible for website fallback
    makeProfile({
      username: "user_needs_fallback_1",
      email: null,
      phone: null,
      externalUrl: "https://site2.com",
    }),
    // Has no bio contact, has website -> eligible for website fallback
    makeProfile({
      username: "user_needs_fallback_2",
      email: null,
      phone: null,
      externalUrl: "https://site3.com",
    }),
    // No website -> not eligible
    makeProfile({
      username: "user_no_website",
      email: null,
      phone: null,
      externalUrl: null,
    }),
  ];

  // Test with maxFetches = 1 cap
  const fallbackResult = await enrichProfilesWithWebsiteFallback(candidatePool, {
    maxFetches: 1,
    timeoutMs: 500, // fast timeout for mock test
  });

  check(fallbackResult.fetchesAttempted <= 1, "Fallback fetches bounded by maxFetches cap (attempted <= 1)");
  check(candidatePool[0].availableChannels?.includes("INSTAGRAM") === true, "Candidate 0 has INSTAGRAM channel");
  check(candidatePool[0].availableChannels?.includes("EMAIL") === true, "Candidate 0 has EMAIL channel");

  // =========================================================================
  // PART E: AVAILABLE CHANNELS COMPUTATION
  // =========================================================================
  console.log("\n[PART E: Contact-Channel Tagging]");
  const igOnly = computeAvailableChannels({ hasInstagram: true, email: null, phone: null });
  check(igOnly.length === 1 && igOnly[0] === "INSTAGRAM", "Instagram-only channel tagging");

  const emailOnly = computeAvailableChannels({ hasInstagram: true, email: "user@test.com", phone: null });
  check(emailOnly.includes("INSTAGRAM") && emailOnly.includes("EMAIL") && !emailOnly.includes("PHONE"), "Instagram + Email channel tagging");

  const allChannels = computeAvailableChannels({ hasInstagram: true, email: "user@test.com", phone: "+923001234567" });
  check(allChannels.includes("INSTAGRAM") && allChannels.includes("EMAIL") && allChannels.includes("PHONE"), "Multi-channel (IG, Email, Phone) tagging");

  console.log("\n=================================================================");
  console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner exception:", err);
  process.exit(1);
});
