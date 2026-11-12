import "./preload_server_only.cjs";
import "dotenv/config";

import {
  parseHtmlForHandles,
  cleanAndValidateHandle,
  runHandleDiscoveryWaterfall,
  safeFetchHtml,
} from "../src/lib/services/discovery/handle-discovery-waterfall";
import {
  checkNameWebsiteMismatch,
  isSocialOrAggregatorUrl,
  extractSignificantNameTokens,
} from "../src/lib/services/discovery/name-website-matcher";

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
  console.log("   STEP 5 TESTS: INSTAGRAM HANDLE EXTRACTION FIXES & MISMATCH RULES             ");
  console.log("================================================================================");

  // --------------------------------------------------------------------------
  // TEST GROUP 1: Three Evidence Cases
  // --------------------------------------------------------------------------
  console.log("\n[TEST GROUP 1: Three Verified Evidence Cases]");

  // Case 1: fairviewsmiles.ca with ?utm_campaign=gmb
  {
    let fetchCount = 0;
    const urlsFetched: string[] = [];

    const mockFetch = async (url: string) => {
      fetchCount++;
      urlsFetched.push(url);
      if (url.includes("utm_campaign")) {
        // Simulating server error or timeout on query string
        return { ok: false, error: "ETIMEDOUT after 12000ms" };
      }
      return {
        ok: true,
        html: `<!DOCTYPE html><html>
          <header><a href="https://www.instagram.com/fairviewsmiles_dental/">Instagram</a></header>
          <body><h1>Welcome to Fairview Smiles</h1></body>
          <footer><a href="https://www.instagram.com/fairviewsmiles_dental/">Instagram</a></footer>
        </html>`,
      };
    };

    const res = await runHandleDiscoveryWaterfall({
      businessName: "Fairview Smiles Dental",
      websiteUrl: "https://fairviewsmiles.ca/?utm_campaign=gmb",
      fetchFn: mockFetch,
    });

    check(res.handle === "fairviewsmiles_dental", "Case 1: extracts 'fairviewsmiles_dental' handle");
    check(res.handleSource === "homepage", "Case 1: handleSource is 'homepage'");
    check(res.handleConfidence === "high", "Case 1: handleConfidence is 'high'");
    check(urlsFetched.includes("https://fairviewsmiles.ca/"), "Case 1: retried with canonical URL without query string");

    const mismatch = checkNameWebsiteMismatch({
      businessName: "Fairview Smiles Dental",
      websiteUrl: "https://fairviewsmiles.ca/?utm_campaign=gmb",
      homepageTitle: res.homepageTitle,
      homepageH1: res.homepageH1,
      ogSiteName: res.ogSiteName,
      homepageHtml: res.homepageHtml,
    });
    check(!mismatch.isMismatch, "Case 1: no website mismatch flag");
  }

  // Case 2: northyorkdentist.ca (Wix site with image-only anchor & title mismatch bypass)
  {
    const wixHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Dental Services | 88 Finch East Dental Centre | Toronto</title>
  <meta property="og:site_name" content="88 Finch East Dental">
</head>
<body>
  <header>
    <a href="https://www.instagram.com/northyorkdentist/"><img src="https://static.wixstatic.com/media/test.png" alt="Instagram"></a>
  </header>
  <h1>Welcome to Our Dental Practice</h1>
</body>
</html>`;

    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      return { ok: true, html: wixHtml };
    };

    const res = await runHandleDiscoveryWaterfall({
      businessName: "88 Finch East Dental Centre",
      websiteUrl: "https://www.northyorkdentist.ca",
      fetchFn: mockFetch,
    });

    check(res.handle === "northyorkdentist", "Case 2: extracts 'northyorkdentist' from image-only anchor");
    check(res.handleSource === "homepage", "Case 2: handleSource is 'homepage'");
    check(res.handleConfidence === "high", "Case 2: handleConfidence is 'high'");
    check(fetchCount === 1, "Case 2: stopped at homepage without fetching subpages", `got ${fetchCount}`);

    const mismatch = checkNameWebsiteMismatch({
      businessName: "88 Finch East Dental Centre",
      websiteUrl: "https://www.northyorkdentist.ca",
      homepageTitle: res.homepageTitle,
      homepageH1: res.homepageH1,
      ogSiteName: res.ogSiteName,
      homepageHtml: res.homepageHtml,
    });

    check(!mismatch.isMismatch, "Case 2: NO mismatch flag (title/og:site_name contains 'Finch East Dental')");
  }

  // Case 3: Keele Lawrence Dental (Maps website is Facebook page)
  {
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      return { ok: true, html: `<html><body>Facebook</body></html>` };
    };

    const fbUrl = "https://m.facebook.com/Keele-Lawrence-Dental-130010631094260/";
    const res = await runHandleDiscoveryWaterfall({
      businessName: "Keele Lawrence Dental",
      websiteUrl: fbUrl,
      fetchFn: mockFetch,
    });

    check(res.handle === null, "Case 3: handle is null (no IG handle)");
    check(fetchCount === 0, "Case 3: Facebook page was NOT fetched", `fetchCount=${fetchCount}`);
    check(res.socialLinks?.facebook === fbUrl, "Case 3: Facebook link stored in socialLinks.facebook");

    const mismatch = checkNameWebsiteMismatch({
      businessName: "Keele Lawrence Dental",
      websiteUrl: fbUrl,
    });
    check(!mismatch.isMismatch, "Case 3: NO mismatch flag on Facebook page");
  }

  // -------------------------------------------------------------
  // TEST GROUP 2: Required Unit Tests
  // -------------------------------------------------------------
  console.log("\n[TEST GROUP 2: Edge-Case Unit Tests]");

  // 1. Image-only anchor
  {
    const html = `<header><a href="https://www.instagram.com/img_only_profile/"><img src="logo.svg" /></a></header>`;
    const parsed = parseHtmlForHandles(html, "Image Dental");
    check(parsed.candidates[0]?.handle === "img_only_profile", "Image-only anchor extracted properly");
  }

  // 2. Uppercase HREF
  {
    const html = `<div><a HREF="https://www.instagram.com/upper_case_anchor/">Follow</a></div>`;
    const parsed = parseHtmlForHandles(html, "Test");
    check(parsed.candidates[0]?.handle === "upper_case_anchor", "Uppercase HREF extracted properly");
  }

  // 3. Protocol-relative URL
  {
    const handle = cleanAndValidateHandle("//www.instagram.com/proto_rel_user/");
    check(handle === "proto_rel_user", "Protocol-relative URL //instagram.com/... parsed");
  }

  // 4. Relative URL with leading slash
  {
    const handle = cleanAndValidateHandle("/instagram.com/relative_user/");
    check(handle === "relative_user", "Relative URL /instagram.com/... parsed");
  }

  // 5. UTM query on fetched URL
  {
    const clean = cleanAndValidateHandle("https://www.instagram.com/clean_utm/?utm_source=ig_web_button_share_sheet&igsh=ZDNlZDc0MzIxNw==");
    check(clean === "clean_utm", "UTM query stripped from handle URL");
  }

  // 6. www / non-www redirect & normalization
  {
    check(
      cleanAndValidateHandle("https://instagram.com/nowww_user") === "nowww_user",
      "Non-www instagram.com URL parsed",
    );
    check(
      cleanAndValidateHandle("https://www.instagram.com/withwww_user") === "withwww_user",
      "www instagram.com URL parsed",
    );
  }

  // 7. Trailing slash
  {
    check(
      cleanAndValidateHandle("https://www.instagram.com/trailing_slash_user/") === "trailing_slash_user",
      "Trailing slash handled correctly",
    );
  }

  // 8. Underscore handle
  {
    check(
      cleanAndValidateHandle("fairviewsmiles_dental") === "fairviewsmiles_dental",
      "Handle with underscore accepted: fairviewsmiles_dental",
    );
    check(
      cleanAndValidateHandle("https://www.instagram.com/toronto_smile_design_studio/") === "toronto_smile_design_studio",
      "Multiple underscores in handle accepted",
    );
  }

  // 9. Share / post / reel links rejected
  {
    check(cleanAndValidateHandle("https://www.instagram.com/p/C-xyz123/") === null, "Rejects /p/ post URL");
    check(cleanAndValidateHandle("https://www.instagram.com/reel/C-xyz123/") === null, "Rejects /reel/ URL");
    check(cleanAndValidateHandle("https://www.instagram.com/reels/C-xyz123/") === null, "Rejects /reels/ URL");
    check(cleanAndValidateHandle("https://www.instagram.com/stories/highlights/123/") === null, "Rejects /stories/ URL");
    check(cleanAndValidateHandle("https://www.instagram.com/explore/tags/dental/") === null, "Rejects /explore/ URL");
    check(cleanAndValidateHandle("https://www.instagram.com/accounts/login/") === null, "Rejects /accounts/ URL");
    check(cleanAndValidateHandle("https://www.instagram.com/direct/t/123/") === null, "Rejects /direct/ URL");
    check(cleanAndValidateHandle("https://www.instagram.com/share") === null, "Rejects /share URL");
  }

  // 10. Redirect to a private IP blocked (SSRF check)
  {
    const resPrivate = await safeFetchHtml("http://127.0.0.1:8080/test", 2000, 3);
    check(!resPrivate.ok && Boolean(resPrivate.error?.includes("SSRF blocked")), "Direct private IP blocked by SSRF check");

    const res10 = await safeFetchHtml("http://10.0.0.5/admin", 2000, 3);
    check(!res10.ok && Boolean(res10.error?.includes("SSRF blocked")), "10.x.x.x private IP blocked by SSRF check");
  }

  // 11. Timeout then successful retry
  {
    let attempts = 0;
    const retryFetch = async () => {
      attempts++;
      if (attempts === 1) {
        return { ok: false, error: "ETIMEDOUT after 12000ms" };
      }
      return {
        ok: true,
        html: `<html><header><a href="https://www.instagram.com/retry_success_handle/">IG</a></header></html>`,
      };
    };

    const res = await runHandleDiscoveryWaterfall({
      businessName: "Retry Dental",
      websiteUrl: "https://retrydental.ca",
      fetchFn: retryFetch,
    });

    check(res.handle === "retry_success_handle", "Timeout on first attempt succeeded on retry");
    check(attempts === 2, "Fetch function called exactly twice", `attempts=${attempts}`);
  }

  // 12. Tokenizer ignores generic stop words and pure numbers like '88'
  {
    const tokens = extractSignificantNameTokens("88 Finch East Dental Centre");
    check(!tokens.includes("88"), "Tokenizer excludes pure numbers '88'");
    check(!tokens.includes("dental"), "Tokenizer excludes generic stop word 'dental'");
    check(!tokens.includes("centre"), "Tokenizer excludes generic stop word 'centre'");
    check(tokens.includes("finch"), "Tokenizer includes significant token 'finch'");
    check(tokens.includes("east"), "Tokenizer includes significant token 'east'");
  }

  // 13. Social URL detection
  {
    check(isSocialOrAggregatorUrl("https://m.facebook.com/myclinic").isSocial, "Identifies m.facebook.com as social");
    check(isSocialOrAggregatorUrl("https://www.instagram.com/myclinic").isSocial, "Identifies instagram.com as social");
    check(isSocialOrAggregatorUrl("https://linktr.ee/myclinic").isSocial, "Identifies linktr.ee as social");
    check(!isSocialOrAggregatorUrl("https://www.torontodental.ca").isSocial, "Regular business domain is not social");
  }

  console.log("\n================================================================================");
  console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
