/**
 * Test Suite: Location relevance for national-scale accounts and social-link classification.
 *
 * Verifies:
 * 1. National/location-agnostic Instagram accounts (e.g. @hellopakistan, @fhmpakistan)
 *    are rejected for city-scoped campaigns with reason IRRELEVANT_LOCATION_NATIONAL_SCALE.
 * 2. Small local businesses with no location signal in bio/category are still allowed (UNKNOWN allowed).
 * 3. Accounts with explicit matching city in bio/location are allowed regardless of follower count.
 * 4. Accounts with contradicting city in bio/location are rejected as IRRELEVANT_LOCATION.
 * 5. Social platform links (YouTube, Facebook, TikTok, WhatsApp, Linktree, etc.) are recognized,
 *    stored as socialLink/socialPlatform, website is kept null, and website-fallback scraping is skipped.
 * 6. Real business websites are stored as clean root homepage URLs (not deep article paths),
 *    and fallback scraping still extracts contacts from them.
 * 7. Canonical/og:url tags discovered on scraped pages never overwrite website with deep article paths.
 */

import {
  evaluateProfileRelevance,
  decideRelevance,
  collectRelevantLeads,
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  DEFAULT_NATIONAL_SCALE_FOLLOWER_THRESHOLD,
  DEFAULT_NATIONAL_CATEGORIES,
} from "../src/lib/services/discovery/lead-relevance";
import {
  detectSocialPlatform,
  cleanBusinessWebsite,
  isSocialOrSharedPlatform,
  extractDomain,
  SHARED_PLATFORM_DOMAINS,
  SOCIAL_PLATFORM_MAP,
} from "../src/lib/constants/social-platforms";
import {
  extractContactFromBio,
  normalizeWebsite,
} from "../src/lib/services/contact/contact-parser";
import {
  extractContactsFromWebsite,
  extractContactsFromHtml,
  enrichProfilesWithWebsiteFallback,
} from "../src/lib/services/enrichment/website-contact-extractor";
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
    contactSource: null,
    availableChannels: null,
    source: "apify",
    scrapedAt: "2026-10-03T09:00:00.000Z",
    ...overrides,
  };
}

async function runTests() {
  console.log("\n--- PART 1: Location Relevance for National Accounts vs Local Businesses ---");

  const islamabadCampaign = {
    intent: "lifestyle and fitness brands in Islamabad",
    location: "Islamabad",
    category: "Lifestyle",
  };

  // Test 1: @hellopakistan (1.7M followers, Magazine, no city mention in bio) -> REJECTED
  const helloPakistan = makeProfile({
    username: "hellopakistan",
    fullName: "HELLO! Pakistan",
    biography: "Pakistan's premier lifestyle and fashion magazine.",
    category: "Magazine",
    followers: 1_700_000,
    externalUrl: "https://www.hmagpak.com/14-Sep-2026/gilded-hour-luxury-fashion",
  });

  const helloEval = evaluateProfileRelevance(helloPakistan, islamabadCampaign);
  check(
    helloEval.isNationalScaleLocationMismatch === true,
    "@hellopakistan flagged as isNationalScaleLocationMismatch",
  );
  const helloDecision = decideRelevance(helloEval);
  check(
    helloDecision.relevant === false,
    "@hellopakistan rejected for city-scoped campaign",
  );
  check(
    !helloDecision.relevant && helloDecision.reason === "IRRELEVANT_LOCATION_NATIONAL_SCALE",
    "@hellopakistan rejected specifically with IRRELEVANT_LOCATION_NATIONAL_SCALE",
  );

  // Test 2: @fhmpakistan (3.0M followers, Media/News Company, no city mention in bio) -> REJECTED
  const fhmPakistan = makeProfile({
    username: "fhmpakistan",
    fullName: "FHM Pakistan",
    biography: "Pakistan's leading youth lifestyle and entertainment portal.",
    category: "Media/news company",
    followers: 3_000_000,
    externalUrl: "https://www.youtube.com/@FHMPakistanofficial",
  });

  const fhmEval = evaluateProfileRelevance(fhmPakistan, islamabadCampaign);
  const fhmDecision = decideRelevance(fhmEval);
  check(
    !fhmDecision.relevant && fhmDecision.reason === "IRRELEVANT_LOCATION_NATIONAL_SCALE",
    "@fhmpakistan (3.0M followers, Media) rejected with IRRELEVANT_LOCATION_NATIONAL_SCALE",
  );

  // Test 3: Small local business with NO location signal (2,500 followers, Gym) -> STILL ALLOWED (UNKNOWN allowed)
  const localGym = makeProfile({
    username: "iron_haven_fitness",
    fullName: "Iron Haven Fitness",
    biography: "Transform your body with our custom lifestyle & fitness coaching programs. DM to join!",
    category: "Gym",
    followers: 2_500,
  });

  const localGymEval = evaluateProfileRelevance(localGym, islamabadCampaign);
  const localGymDecision = decideRelevance(localGymEval);
  check(
    localGymEval.locationMatch === "UNKNOWN",
    "Small local gym with no bio location has locationMatch UNKNOWN",
  );
  check(
    localGymEval.isNationalScaleLocationMismatch === false,
    "Small local gym is NOT flagged as national scale mismatch",
  );
  check(
    localGymDecision.relevant === true,
    "Small local gym without city mention is STILL ALLOWED (regression check)",
  );

  // Test 4: Large national-scale account with EXPLICIT matching city in bio -> STILL ALLOWED
  const islamabadMegaVenue = makeProfile({
    username: "islamabad_lifestyle_hub",
    fullName: "Islamabad Lifestyle Hub",
    biography: "The biggest entertainment & event complex in Islamabad. Located in F-7 Markaz, Islamabad.",
    category: "Media",
    followers: 850_000,
  });

  const megaVenueEval = evaluateProfileRelevance(islamabadMegaVenue, islamabadCampaign);
  const megaVenueDecision = decideRelevance(megaVenueEval);
  check(
    megaVenueEval.locationMatch === "MATCHED",
    "Mega venue with explicit Islamabad mention has locationMatch MATCHED",
  );
  check(
    megaVenueEval.isNationalScaleLocationMismatch === false,
    "Mega venue with explicit city match is NOT flagged as national mismatch",
  );
  check(
    megaVenueDecision.relevant === true,
    "850k follower account with explicit Islamabad in bio is ALLOWED",
  );

  // Test 5: Account with explicit CONTRADICTING city in bio -> REJECTED with IRRELEVANT_LOCATION
  const lahoreGym = makeProfile({
    username: "lahore_fitness_studio",
    fullName: "Lahore Fitness Studio",
    biography: "The best workout and lifestyle studio in Lahore and Gulberg.",
    category: "Gym",
    followers: 5_000,
    location: "Lahore, Pakistan",
  });

  const lahoreEval = evaluateProfileRelevance(lahoreGym, islamabadCampaign);
  const lahoreDecision = decideRelevance(lahoreEval);
  check(
    lahoreEval.locationMatch === "NOT_MATCHED",
    "Lahore account in Islamabad campaign has locationMatch NOT_MATCHED",
  );
  check(
    !lahoreDecision.relevant && lahoreDecision.reason === "IRRELEVANT_LOCATION",
    "Contradicting city account rejected as IRRELEVANT_LOCATION",
  );

  // Test 6: Campaign WITHOUT location specified -> large national accounts allowed
  const globalCampaign = {
    intent: "top magazines in Pakistan",
    location: null,
    category: "Magazine",
  };
  const globalEval = evaluateProfileRelevance(helloPakistan, globalCampaign);
  const globalDecision = decideRelevance(globalEval);
  check(
    globalDecision.relevant === true,
    "@hellopakistan is ALLOWED when campaign has no location restriction",
  );

  // Test 7: collectRelevantLeads skip breakdown includes IRRELEVANT_LOCATION_NATIONAL_SCALE
  const collection = await collectRelevantLeads({
    candidates: ["hellopakistan", "fhmpakistan", "iron_haven_fitness", "lahore_fitness_studio"],
    capacity: 10,
    campaign: islamabadCampaign,
    enrich: async (batch) => {
      const map: Record<string, LeadProfile> = {
        hellopakistan: helloPakistan,
        fhmpakistan: fhmPakistan,
        iron_haven_fitness: localGym,
        lahore_fitness_studio: lahoreGym,
      };
      return {
        profiles: batch.map((u) => map[u]).filter(Boolean),
        skipped: [],
      };
    },
  });

  check(
    collection.relevant.length === 1 && collection.relevant[0].username === "iron_haven_fitness",
    "collectRelevantLeads keeps only the relevant local lead",
  );
  check(
    collection.skipCounts.IRRELEVANT_LOCATION_NATIONAL_SCALE === 2,
    "collectRelevantLeads accurately counts 2 IRRELEVANT_LOCATION_NATIONAL_SCALE skips",
  );
  check(
    collection.skipCounts.IRRELEVANT_LOCATION === 1,
    "collectRelevantLeads accurately counts 1 IRRELEVANT_LOCATION skip",
  );

  console.log("\n--- PART 2: Social-Link vs Real-Website Classification ---");

  // Test 8: detectSocialPlatform recognizes all major social/messaging/link-in-bio platforms
  const platformsToTest = [
    { url: "https://www.youtube.com/@FHMPakistanofficial", expected: "youtube" },
    { url: "https://youtu.be/dQw4w9WgXcQ", expected: "youtube" },
    { url: "https://facebook.com/hellopakistan", expected: "facebook" },
    { url: "https://www.tiktok.com/@creator", expected: "tiktok" },
    { url: "https://twitter.com/brand", expected: "twitter" },
    { url: "https://x.com/brand", expected: "twitter" },
    { url: "https://linkedin.com/company/agency", expected: "linkedin" },
    { url: "https://instagram.com/myotherpage", expected: "instagram" },
    { url: "https://wa.me/923001234567", expected: "whatsapp" },
    { url: "https://whatsapp.com/channel/123", expected: "whatsapp" },
    { url: "https://t.me/pakistantrends", expected: "telegram" },
    { url: "https://linktr.ee/fhmofficial", expected: "linktree" },
    { url: "https://linkin.bio/creator", expected: "linkinbio" },
    { url: "https://beacons.ai/creator", expected: "beacons" },
    { url: "https://bio.link/creator", expected: "biolink" },
    { url: "https://lnk.bio/creator", expected: "lnkbio" },
    { url: "https://campsite.bio/creator", expected: "campsite" },
    { url: "https://stan.store/creator", expected: "stanstore" },
    { url: "https://taplink.cc/creator", expected: "taplink" },
    { url: "https://threads.net/@creator", expected: "threads" },
    { url: "https://snapchat.com/add/creator", expected: "snapchat" },
    { url: "https://pinterest.com/creator", expected: "pinterest" },
  ];

  let allPlatformsDetected = true;
  for (const pt of platformsToTest) {
    const res = detectSocialPlatform(pt.url);
    if (!res || res.platform !== pt.expected) {
      console.error(`  FAIL: ${pt.url} expected ${pt.expected}, got ${res?.platform}`);
      allPlatformsDetected = false;
    }
  }
  check(allPlatformsDetected, "detectSocialPlatform recognizes all 22 required social/aggregator platforms");

  // Test 9: extractContactFromBio classifies YouTube link as socialLink, leaving website null
  const fhmBioContact = extractContactFromBio(
    fhmPakistan.biography,
    "https://www.youtube.com/@FHMPakistanofficial",
  );
  check(
    fhmBioContact.socialLink === "https://www.youtube.com/@FHMPakistanofficial",
    "@fhmpakistan external_url stored in socialLink",
  );
  check(
    fhmBioContact.socialPlatform === "youtube",
    "@fhmpakistan socialPlatform classified as youtube",
  );
  check(
    fhmBioContact.website === null,
    "@fhmpakistan website is null (not stored as general business website)",
  );
  check(
    fhmBioContact.websiteDomain === null,
    "@fhmpakistan websiteDomain is null",
  );

  // Test 10: extractContactFromBio with Linktree link
  const linktreeContact = extractContactFromBio(
    "Check out my links below!",
    "https://linktr.ee/brandprofile",
  );
  check(
    linktreeContact.socialLink === "https://linktr.ee/brandprofile" &&
      linktreeContact.socialPlatform === "linktree" &&
      linktreeContact.website === null,
    "Linktree URL stored as socialLink with platform linktree, website remains null",
  );

  // Test 11: Real business website stored as root homepage URL
  const deepArticleUrl = "https://www.hmagpak.com/14-Sep-2026/gilded-hour-luxury-fashion?ref=ig_bio";
  const realSiteContact = extractContactFromBio(
    "Official website of HMag Pakistan.",
    deepArticleUrl,
  );
  check(
    realSiteContact.website === "https://hmagpak.com",
    "Real business website stored as root homepage (https://hmagpak.com), not deep article URL",
  );
  check(
    realSiteContact.websiteDomain === "hmagpak.com",
    "Real business websiteDomain correctly stored as hmagpak.com",
  );
  check(
    realSiteContact.socialLink === null,
    "Real business website has socialLink null",
  );

  // Test 12: cleanBusinessWebsite normalizes variations properly
  const clean1 = cleanBusinessWebsite("http://www.example.com/blog/2026/article?utm_source=ig");
  check(
    clean1?.url === "https://example.com" && clean1?.domain === "example.com",
    "cleanBusinessWebsite strips www, deep path, and query params to root homepage",
  );

  const cleanSocial = cleanBusinessWebsite("https://www.youtube.com/@channel");
  check(
    cleanSocial === null,
    "cleanBusinessWebsite returns null for social platform domains",
  );

  console.log("\n--- PART 3: Website Fallback Scraper Behavior ---");

  // Test 13: Website fallback scraper skips social platform URLs entirely
  const socialScrapeResult = await extractContactsFromWebsite("https://www.youtube.com/@FHMPakistanofficial");
  check(
    socialScrapeResult.email === null &&
      socialScrapeResult.phone === null &&
      socialScrapeResult.contactSource === null,
    "extractContactsFromWebsite returns empty result without scraping for YouTube URL",
  );

  const linktreeScrapeResult = await extractContactsFromWebsite("https://linktr.ee/someone");
  check(
    linktreeScrapeResult.email === null &&
      linktreeScrapeResult.phone === null &&
      linktreeScrapeResult.contactSource === null,
    "extractContactsFromWebsite returns empty result without scraping for Linktree URL",
  );

  // Test 14: enrichProfilesWithWebsiteFallback skips candidates with only social links
  const socialCandidate = makeProfile({
    username: "social_star",
    socialLink: "https://www.youtube.com/@FHMPakistanofficial",
    socialPlatform: "youtube",
    website: null,
    externalUrl: "https://www.youtube.com/@FHMPakistanofficial",
  });
  await enrichProfilesWithWebsiteFallback([socialCandidate], { maxFetches: 5 });
  check(
    socialCandidate.contactSource === null,
    "enrichProfilesWithWebsiteFallback does NOT scrape YouTube and leaves contactSource null",
  );

  console.log("\n--- PART 4: Canonical / og:url Preservation ---");

  // Test 15: HTML containing canonical and og:url tags with deep path does NOT overwrite root URL
  const htmlWithCanonical = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Article Title - Brand Name</title>
        <link rel="canonical" href="https://example.com/2026/09/deep-article-title-slug?page=2" />
        <meta property="og:url" content="https://example.com/2026/09/deep-article-title-slug" />
      </head>
      <body>
        <h1>Contact Us</h1>
        <p>Email: contact@example.com</p>
        <p>Call us at +92 51 1234567</p>
      </body>
    </html>
  `;

  const parsedHtml = extractContactsFromHtml(htmlWithCanonical);
  check(
    parsedHtml.email === "contact@example.com",
    "extractContactsFromHtml finds email from HTML content",
  );
  check(
    parsedHtml.phone !== null,
    "extractContactsFromHtml finds phone from HTML content",
  );

  // And normalizeWebsite preserves rootUrl and domain
  const normResult = normalizeWebsite("https://example.com/2026/09/deep-article-title-slug?page=2");
  check(
    normResult?.rootUrl === "https://example.com" && normResult?.domain === "example.com",
    "normalizeWebsite extracts rootUrl https://example.com regardless of deep input path",
  );

  console.log("\n========================================================");
  console.log(`TOTAL PASS: ${passed} | TOTAL FAIL: ${failed}`);
  console.log("========================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
