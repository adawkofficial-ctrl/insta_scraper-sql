/**
 * Comprehensive Unit Test Suite for Google Maps Discovery Waterfall,
 * SSRF Protection, Multi-channel Lead Retention, Dedup, and DNC.
 */
import "./preload_server_only.cjs";
import "dotenv/config";

import {
  parseHtmlForHandles,
  cleanAndValidateHandle,
  runHandleDiscoveryWaterfall,
  isUrlSafe,
  isIpv4PrivateOrBlocked,
  isIpv6PrivateOrBlocked,
  isIpPrivateOrBlocked,
  safeFetchHtml,
} from "../src/lib/services/discovery/handle-discovery-waterfall";
import { computeAvailableChannels, normalizePhone } from "../src/lib/services/contact/contact-parser";
import { normalizeWebsite } from "../src/lib/services/dedup/identity";
import { classifyProfiles } from "../src/lib/services/dedup/dedup-service";
import {
  addDoNotContact,
  checkLeadSuppression,
  checkManySuppression,
  DncChannel,
  DncIdentifierType,
} from "../src/lib/services/compliance/dnc-service";
import { sendSingleMessage } from "../src/lib/services/messaging/messaging-service";
import { previewBulkMessageJob } from "../src/lib/services/messaging/bulk-messaging-service";
import { getPrismaClient } from "../src/lib/db/prisma";
import { scoreFlagCreate, withLeadChannelFlags } from "../src/lib/services/lead/lead-channels";

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

async function runTests() {
  console.log("================================================================================");
  console.log("   STEP 5 UNIT TESTS: GMAPS WATERFALL, SSRF, MULTI-CHANNEL, DEDUP, & DNC        ");
  console.log("================================================================================");

  // --------------------------------------------------------------------------
  // TEST GROUP 1: Bad-Handle Rejection
  // --------------------------------------------------------------------------
  console.log("\n[TEST GROUP 1: Bad-Handle Rejection & Cleaning]");
  {
    // Profile paths vs non-profile paths
    check(cleanAndValidateHandle("https://instagram.com/p/Cxyz12345") === null, "Rejects /p/ post URL");
    check(cleanAndValidateHandle("https://instagram.com/reel/C89abcdef") === null, "Rejects /reel/ URL");
    check(cleanAndValidateHandle("https://instagram.com/reels/C89abcdef") === null, "Rejects /reels/ URL");
    check(cleanAndValidateHandle("https://instagram.com/explore/tags/austin") === null, "Rejects /explore/ URL");
    check(cleanAndValidateHandle("https://instagram.com/accounts/login") === null, "Rejects /accounts/ URL");
    check(cleanAndValidateHandle("https://instagram.com/stories/austin") === null, "Rejects /stories/ URL");
    check(cleanAndValidateHandle("https://instagram.com/share") === null, "Rejects /share URL");

    // Reserved words & platforms
    check(cleanAndValidateHandle("instagram") === null, "Rejects reserved handle 'instagram'");
    check(cleanAndValidateHandle("@facebook") === null, "Rejects reserved handle 'facebook'");
    check(cleanAndValidateHandle("support") === null, "Rejects reserved word 'support'");
    check(cleanAndValidateHandle("terms") === null, "Rejects reserved word 'terms'");
    check(cleanAndValidateHandle("privacy") === null, "Rejects reserved word 'privacy'");

    // Site builders & badges
    check(cleanAndValidateHandle("wix") === null, "Rejects site-builder handle 'wix'");
    check(cleanAndValidateHandle("squarespace") === null, "Rejects site-builder handle 'squarespace'");
    check(cleanAndValidateHandle("shopify") === null, "Rejects site-builder handle 'shopify'");
    check(cleanAndValidateHandle("wordpress") === null, "Rejects site-builder handle 'wordpress'");

    // Valid handles with cleaning
    check(
      cleanAndValidateHandle("https://www.instagram.com/downtownroastery/?hl=en") === "downtownroastery",
      "Cleans URL query params & trailing slash",
    );
    check(
      cleanAndValidateHandle("@UrbanBrewLab") === "urbanbrewlab",
      "Cleans @ prefix and lowercases handle",
    );
    check(
      cleanAndValidateHandle("https://instagr.am/apexfitnessatx") === "apexfitnessatx",
      "Parses instagr.am short domain",
    );
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 2: Homepage Anchor, Meta, & JSON-LD Parsing
  // --------------------------------------------------------------------------
  console.log("\n[TEST GROUP 2: Homepage Anchor, Meta, & JSON-LD Parsing]");
  {
    // Anchor in body
    const htmlAnchor = `
      <html>
        <body>
          <h1>Welcome to Lone Star Dental</h1>
          <a href="https://instagram.com/lonestardentalatx">Follow our Dental Care</a>
        </body>
      </html>
    `;
    const resAnchor = parseHtmlForHandles(htmlAnchor, "Lone Star Dental", "homepage");
    check(resAnchor.candidates.length > 0, "Found candidate in anchor link");
    check(resAnchor.candidates[0].handle === "lonestardentalatx", "Parsed handle lonestardentalatx from anchor");
    check(resAnchor.candidates[0].confidence === "high", "High confidence for matching business name");

    // Meta og:see_also / creator
    const htmlMeta = `
      <html>
        <head>
          <meta property="og:see_also" content="https://instagram.com/solisyoga_atx">
        </head>
        <body>Yoga studio</body>
      </html>
    `;
    const resMeta = parseHtmlForHandles(htmlMeta, "Solis Yoga", "homepage");
    check(resMeta.candidates.some((c) => c.handle === "solisyoga_atx"), "Parsed handle from meta tag");

    // JSON-LD sameAs
    const htmlJsonLd = `
      <html>
        <head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "LocalBusiness",
            "name": "Barton Creek Vet",
            "sameAs": [
              "https://www.facebook.com/bartoncreekvet",
              "https://instagram.com/bartoncreekvet"
            ]
          }
          </script>
        </head>
        <body>Clinic</body>
      </html>
    `;
    const resJsonLd = parseHtmlForHandles(htmlJsonLd, "Barton Creek Vet", "homepage");
    check(resJsonLd.candidates.some((c) => c.handle === "bartoncreekvet"), "Parsed handle from JSON-LD sameAs");
    check(resJsonLd.socialLinks.facebook?.includes("facebook.com/bartoncreekvet") === true, "Extracted Facebook from sameAs");
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 3: Contact-Page Fallback & Linkhub Parsing
  // --------------------------------------------------------------------------
  console.log("\n[TEST GROUP 3: Contact-Page Fallback & Linkhub Parsing]");
  {
    // Contact page fallback via runHandleDiscoveryWaterfall
    const mockSitePages: Record<string, string> = {
      "/": "<html><body><h1>Verde Landscape</h1><a href=\"/contact-us\">Contact Us</a></body></html>",
      "/contact-us": "<html><body><h1>Get in touch</h1><a href=\"https://instagram.com/verdelandscape_atx\">Instagram</a></body></html>",
    };

    const mockFetch = async (url: string) => {
      try {
        const u = new URL(url);
        const html = mockSitePages[u.pathname] ?? mockSitePages["/"];
        return { ok: true, html, status: 200 };
      } catch {
        return { ok: false, status: 500 };
      }
    };

    const waterfallContact = await runHandleDiscoveryWaterfall({
      businessName: "Verde Landscape Design",
      websiteUrl: "https://verdelandscape.example.com",
      fetchFn: mockFetch,
    });

    check(waterfallContact.handle === "verdelandscape_atx", "Found handle on subpage fallback");
    check(waterfallContact.handleSource === "contact_page", "handleSource recorded as contact_page");

    // Link-in-bio hub parsing
    const mockHubPages: Record<string, string> = {
      "https://artisanbakery.example.com": "<html><body><a href=\"https://linktr.ee/artisanbakeryatx\">All Links</a></body></html>",
      "https://linktr.ee/artisanbakeryatx": "<html><body><a href=\"https://instagram.com/artisanbakery_atx\">Instagram Feed</a></body></html>",
    };

    const mockHubFetch = async (url: string) => {
      const html = mockHubPages[url];
      if (html) return { ok: true, html, status: 200 };
      return { ok: true, html: mockHubPages["https://artisanbakery.example.com"], status: 200 };
    };

    const waterfallHub = await runHandleDiscoveryWaterfall({
      businessName: "Artisan Bakery",
      websiteUrl: "https://artisanbakery.example.com",
      fetchFn: mockHubFetch,
    });

    check(waterfallHub.handle === "artisanbakery_atx", "Extracted handle from link-in-bio hub");
    check(waterfallHub.handleSource === "linkhub", "handleSource recorded as linkhub");
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 4: Confidence Selection & Matching
  // --------------------------------------------------------------------------
  console.log("\n[TEST GROUP 4: Confidence Selection & Header/Footer Weighting]");
  {
    // Header/footer preference over generic body link
    const htmlMulti = `
      <html>
        <body>
          <header>
            <a href="https://instagram.com/bestmatchbakery">Our Official IG</a>
          </header>
          <div class="content">
            <p>Our sponsor: <a href="https://instagram.com/randomsponsor">Sponsor</a></p>
          </div>
          <footer>
            &copy; 2026 Best Match Bakery
          </footer>
        </body>
      </html>
    `;
    const parsedMulti = parseHtmlForHandles(htmlMulti, "Best Match Bakery", "homepage");
    check(parsedMulti.candidates[0].handle === "bestmatchbakery", "Prefers header/footer matching handle");
    check(parsedMulti.candidates[0].confidence === "high", "Confidence is high for name match + header link");

    // Non-matching handle marked as low confidence
    const htmlUnrelated = `
      <html>
        <body>
          <h1>Acme Construction</h1>
          <p><a href="https://instagram.com/totally_different_brand_name">Portfolio</a></p>
        </body>
      </html>
    `;
    const parsedUnrelated = parseHtmlForHandles(htmlUnrelated, "Acme Construction", "homepage");
    check(parsedUnrelated.candidates[0].handle === "totally_different_brand_name", "Identified candidate");
    check(parsedUnrelated.candidates[0].confidence === "low", "Low confidence when handle has poor name match");
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 5: Hardened SSRF Guard & Redirect Validation
  // --------------------------------------------------------------------------
  console.log("\n[TEST GROUP 5: SSRF Guard & Redirect Validation]");
  {
    // IP subnet checks
    check(isIpv4PrivateOrBlocked("127.0.0.1") === true, "Blocks IPv4 loopback 127.0.0.1");
    check(isIpv4PrivateOrBlocked("127.0.0.2") === true, "Blocks 127.0.0.2");
    check(isIpv4PrivateOrBlocked("10.0.0.1") === true, "Blocks 10.0.0.0/8 private IP");
    check(isIpv4PrivateOrBlocked("172.16.0.1") === true, "Blocks 172.16.0.0/12 private IP");
    check(isIpv4PrivateOrBlocked("192.168.1.1") === true, "Blocks 192.168.0.0/16 private IP");
    check(isIpv4PrivateOrBlocked("169.254.169.254") === true, "Blocks AWS/cloud metadata 169.254.169.254");
    check(isIpv4PrivateOrBlocked("100.64.0.1") === true, "Blocks Carrier-Grade NAT 100.64.0.0/10");
    check(isIpv4PrivateOrBlocked("0.0.0.0") === true, "Blocks 0.0.0.0");
    check(isIpv4PrivateOrBlocked("8.8.8.8") === false, "Allows public IP 8.8.8.8");

    // IPv6 checks
    check(isIpv6PrivateOrBlocked("::1") === true, "Blocks IPv6 loopback ::1");
    check(isIpv6PrivateOrBlocked("fe80::1") === true, "Blocks IPv6 link-local fe80::/10");
    check(isIpv6PrivateOrBlocked("fc00::1") === true, "Blocks IPv6 unique local fc00::/7");
    check(isIpv6PrivateOrBlocked("::ffff:127.0.0.1") === true, "Blocks IPv4-mapped IPv6 loopback");
    check(isIpv6PrivateOrBlocked("::ffff:192.168.1.1") === true, "Blocks IPv4-mapped IPv6 private");

    // URL safety check for loopback/internal hosts
    const localhostSafe = await isUrlSafe("http://localhost:3000");
    check(localhostSafe.safe === false, "isUrlSafe blocks http://localhost:3000");

    const loopbackIpSafe = await isUrlSafe("http://127.0.0.1/admin");
    check(loopbackIpSafe.safe === false, "isUrlSafe blocks http://127.0.0.1");

    const metadataSafe = await isUrlSafe("http://169.254.169.254/latest/meta-data/");
    check(metadataSafe.safe === false, "isUrlSafe blocks AWS metadata endpoint");

    const privateIpSafe = await isUrlSafe("http://192.168.1.100/router");
    check(privateIpSafe.safe === false, "isUrlSafe blocks private 192.168.1.100");

    // SSRF redirect trap test with custom fetcher simulation
    const redirectTrap127 = async () => {
      // safeFetchHtml validates destination at every hop before following
      const res = await safeFetchHtml("http://127.0.0.1:8080/secret", 3000, 3);
      return res.ok;
    };
    check((await redirectTrap127()) === false, "safeFetchHtml rejects direct call to 127.0.0.1");

    const redirectTrapPrivate = async () => {
      const res = await safeFetchHtml("http://192.168.1.1/admin", 3000, 3);
      return res.ok;
    };
    check((await redirectTrapPrivate()) === false, "safeFetchHtml rejects direct call to private 192.168.1.1");
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 6: Multi-channel Leads & Channels Calculation
  // --------------------------------------------------------------------------
  console.log("\n[TEST GROUP 6: Multi-channel Leads & Available Channels]");
  {
    // Place with email, phone, and website but no IG
    const channelsNoIg = computeAvailableChannels({
      hasInstagram: false,
      email: "service@austinauto.com",
      phone: "+15125550113",
      whatsapp: "+15125550113",
      website: "https://austinauto.com",
    });
    check(!channelsNoIg.includes("INSTAGRAM"), "No INSTAGRAM channel when hasInstagram is false");
    check(channelsNoIg.includes("EMAIL"), "Has EMAIL channel");
    check(channelsNoIg.includes("PHONE"), "Has PHONE channel");
    check(channelsNoIg.includes("WHATSAPP"), "Has WHATSAPP channel derived from phone");
    check(channelsNoIg.includes("WEBSITE"), "Has WEBSITE channel");

    // Phone normalizer to E.164
    check(normalizePhone("+1 (512) 555-0113") === "+15125550113", "Normalizes US phone with formatting to E.164");
    check(normalizePhone("512.555.0113") === "+15125550113", "Normalizes 10-digit US phone to +1 E.164");

    // Website normalizer
    check(normalizeWebsite("https://www.example.com/about/")?.domain === "example.com", "Normalizes website domain");
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 7: Cross-Campaign Deduplication by PlaceId, Domain, Phone
  // --------------------------------------------------------------------------
  console.log("\n[TEST GROUP 7: Deduplication by PlaceId, Domain, & Phone]");
  {
    const prisma = getPrismaClient();

    // Find or create test user and campaign
    let user = await prisma.user.findFirst();
    if (!user) {
      user = await prisma.user.create({
        data: { email: "waterfall_test@example.com", passwordHash: "mockHash" },
      });
    }

    let campaign = await prisma.campaign.findFirst({
      where: { userId: user.id },
    });
    if (!campaign) {
      let company = await prisma.companyProfile.findFirst({ where: { userId: user.id } });
      if (!company) {
        company = await prisma.companyProfile.create({
          data: { userId: user.id, name: "Waterfall Test Corp" },
        });
      }
      campaign = await prisma.campaign.create({
        data: {
          userId: user.id,
          name: "Waterfall Test Campaign",
          companyProfileId: company.id,
        },
      });
    }

    const testPlaceId = `test_place_${Date.now()}`;
    const testDomain = `testdomain-${Date.now()}.com`;
    const testPhone = `+1512555${Math.floor(1000 + Math.random() * 9000)}`;

    // Create an initial lead with placeId, domain, and phone
    const initialLead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        gmapsPlaceId: testPlaceId,
        websiteDomain: testDomain,
        website: `https://${testDomain}`,
        phoneNormalized: testPhone,
        phone: testPhone,
        source: "google_maps",
        status: "NEW",
        ...withLeadChannelFlags(["EMAIL", "PHONE", "WEBSITE"]),
      },
    });

    try {
      // 1. Dedup by gmapsPlaceId
      const dedupByPlaceId = await classifyProfiles({
        userId: user.id,
        campaignId: campaign.id,
        profiles: [{ gmapsPlaceId: testPlaceId, website: "https://other.com" }],
        client: prisma,
      });
      check(dedupByPlaceId[0].kind === "HARD_DUPLICATE", "Dedupes candidate by gmapsPlaceId");
      check(
        dedupByPlaceId[0].kind === "HARD_DUPLICATE" && dedupByPlaceId[0].leadId === initialLead.id,
        "Matched existing lead by gmapsPlaceId",
      );

      // 2. Dedup by websiteDomain
      const dedupByDomain = await classifyProfiles({
        userId: user.id,
        campaignId: campaign.id,
        profiles: [{ website: `https://www.${testDomain}/contact` }],
        client: prisma,
      });
      check(dedupByDomain[0].kind === "HARD_DUPLICATE", "Dedupes candidate by normalized website domain");

      // 3. Dedup by normalized phone
      const dedupByPhone = await classifyProfiles({
        userId: user.id,
        campaignId: campaign.id,
        profiles: [{ phone: testPhone }],
        client: prisma,
      });
      check(dedupByPhone[0].kind === "HARD_DUPLICATE", "Dedupes candidate by normalized E.164 phone");
    } finally {
      // Clean up test lead
      await prisma.lead.delete({ where: { id: initialLead.id } });
    }
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 8: Instagram DM Exclusion for No-IG Leads
  // --------------------------------------------------------------------------
  console.log("\n[TEST GROUP 8: Instagram DM Exclusion for No-IG Leads]");
  {
    const prisma = getPrismaClient();
    const campaign = await prisma.campaign.findFirst({
      include: { user: true },
    });
    const user = campaign?.user;

    if (user && campaign) {
      // Create a test lead with NO IG handle
      const noIgLead = await prisma.lead.create({
        data: {
          campaignId: campaign.id,
          userId: user.id,
          username: null,
          instagramUsername: null,
          profileUrl: null,
          email: "test_no_ig@example.com",
          phone: "+15125559999",
          phoneNormalized: "+15125559999",
          source: "google_maps",
          status: "NEW",
          ...withLeadChannelFlags(["EMAIL", "PHONE", "WHATSAPP"]),
        },
      });

      try {
        // Direct sendSingleMessage attempt should fail with NO_INSTAGRAM_CHANNEL error
        let errorCaught = false;
        try {
          await sendSingleMessage(
            {
              leadId: noIgLead.id,
              campaignId: campaign.id,
              message: "Hello from IG bot",
            },
            user.id,
          );
        } catch (err: any) {
          errorCaught = true;
          check(
            err.code === "NO_INSTAGRAM_CHANNEL" || err.message?.includes("Instagram handle") || err.message?.includes("Instagram direct messaging"),
            `sendSingleMessage throws NO_INSTAGRAM_CHANNEL (${err.code})`,
          );
        }
        check(errorCaught, "sendSingleMessage rejected sending DM to lead with no IG handle");

        // Bulk preview should skip this lead
        const bulkPreview = await previewBulkMessageJob(campaign.id, { leadIds: [noIgLead.id] }, user.id);
        const skippedItem = bulkPreview.skippedReasons.find((s) => s.leadId === noIgLead.id);
        check(Boolean(skippedItem), "previewBulkMessageJob skips lead with no IG username");
        check(
          skippedItem?.reason?.includes("Instagram handle") || skippedItem?.reason === "NO_INSTAGRAM_CHANNEL",
          `Bulk preview skip reason is valid (${skippedItem?.reason})`,
        );
      } finally {
        await prisma.lead.delete({ where: { id: noIgLead.id } });
      }
    }
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 9: DNC Suppression Covering Email, Phone, Domain
  // --------------------------------------------------------------------------
  console.log("\n[TEST GROUP 9: DNC Suppression for Multi-Channel Leads]");
  {
    const prisma = getPrismaClient();
    const campaign = await prisma.campaign.findFirst({
      include: { user: true },
    });
    const user = campaign?.user;

    if (user) {
      const testDncPhone = "+15125558888";
      const testDncEmail = "suppressed@example.com";
      const testDncDomain = "dnc-suppressed-domain.com";

      // Insert DNC entries for email, phone, and domain via addDoNotContact
      await addDoNotContact({
        userId: user.id,
        actor: "test",
        entries: [
          {
            identifierType: DncIdentifierType.PHONE,
            value: testDncPhone,
            channel: DncChannel.ALL,
            reason: "User requested no phone outreach",
          },
          {
            identifierType: DncIdentifierType.EMAIL,
            value: testDncEmail,
            channel: DncChannel.ALL,
            reason: "Unsubscribed email",
          },
          {
            identifierType: DncIdentifierType.DOMAIN,
            value: testDncDomain,
            channel: DncChannel.ALL,
            reason: "Blocked domain",
          },
        ],
      });

      try {
        // Test single checkLeadSuppression on phone
        const phoneSup = await checkLeadSuppression({
          userId: user.id,
          lead: { phone: testDncPhone },
        });
        check(phoneSup.suppressed === true, "DNC blocks lead matching suppressed phone");

        // Test single checkLeadSuppression on email
        const emailSup = await checkLeadSuppression({
          userId: user.id,
          lead: { email: testDncEmail },
        });
        check(emailSup.suppressed === true, "DNC blocks lead matching suppressed email");

        // Test single checkLeadSuppression on domain
        const domainSup = await checkLeadSuppression({
          userId: user.id,
          lead: { website: `https://${testDncDomain}/contact` },
        });
        check(domainSup.suppressed === true, "DNC blocks lead matching suppressed domain");

        // Test checkManySuppression across multi-channel leads
        const manySup = await checkManySuppression({
          userId: user.id,
          leads: [
            { id: "lead_phone", phone: testDncPhone },
            { id: "lead_email", email: testDncEmail },
            { id: "lead_clean", email: "clean@example.com", phone: "+15125550000" },
          ],
        });

        check(manySup.get("lead_phone")?.suppressed === true, "checkManySuppression blocks lead by phone");
        check(manySup.get("lead_email")?.suppressed === true, "checkManySuppression blocks lead by email");
        check(manySup.get("lead_clean")?.suppressed === false, "checkManySuppression allows unsuppressed lead");
      } finally {
        await prisma.doNotContact.deleteMany({
          where: {
            userId: user.id,
            identifierNormalized: { in: [testDncPhone, testDncEmail.toLowerCase(), testDncDomain.toLowerCase()] },
          },
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
