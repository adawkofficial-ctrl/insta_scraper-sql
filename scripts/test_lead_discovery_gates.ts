/**
 * Unit tests for lead-discovery pipeline improvements:
 * 1. Intent cleaner (pitch stripping, universal splitting, stopwords, category retention)
 * 2. Category gate (hard gate with category synonym map, fallback, null allowance)
 * 3. Negative keywords (word boundaries, accent insensitivity, rejection reason)
 * 4. AI relevance gate (mocked Gemini structured output, score threshold, accountType check, fail-closed)
 */
// Preload server-only mock before any server module is loaded
import "./preload_server_only.cjs";

import {
  extractDiscoveryKeywords,
  stripPitchClauses,
} from "../src/lib/services/discovery/discovery-query";
import {
  isCategoryAllowed,
  normalizeCategoryString,
} from "../src/lib/services/discovery/category-synonyms";
import {
  findMatchedNegativeKeyword,
  normalizeForBoundaryCheck,
  stripAccents,
} from "../src/lib/services/discovery/negative-keywords";
import {
  collectRelevantLeads,
  decideRelevance,
  evaluateProfileRelevance,
  prefilterCandidate,
  DEFAULT_DISCOVERY_RELEVANCE_POLICY,
  type DiscoveryRelevancePolicy,
  type RelevanceCampaignContext,
} from "../src/lib/services/discovery/lead-relevance";
import type { LeadProfile } from "../src/lib/types";

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

function makeProfile(
  overrides: Partial<LeadProfile> & { username: string },
): LeadProfile {
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
    isBusiness: true,
    isBusinessAccount: true,
    category: null,
    businessCategoryName: null,
    externalUrl: null,
    website: null,
    location: null,
    relatedProfiles: null,
    latestPosts: null,
    source: "apify",
    scrapedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function runTests() {
  console.log("=== 1. INTENT CLEANER TESTS ===");

  {
    const inputIntent =
      "dental clinics, dentists and cosmetic dentistry practices that could sell or recommend teeth whitening products to patients";
    const stripped = stripPitchClauses(inputIntent);
    check(
      !stripped.includes("that could sell or recommend") &&
        !stripped.includes("teeth whitening products to patients"),
      "stripPitchClauses removes pitch and purpose clause",
      `Got: "${stripped}"`,
    );

    const keywords = extractDiscoveryKeywords({ query: inputIntent });
    console.log("  Extracted keywords:", keywords);

    check(
      keywords.includes("dental clinics"),
      "keywords include 'dental clinics'",
      JSON.stringify(keywords),
    );
    check(
      keywords.includes("dentists"),
      "keywords include 'dentists'",
      JSON.stringify(keywords),
    );
    check(
      keywords.includes("cosmetic dentistry"),
      "keywords include 'cosmetic dentistry' (trailing 'practices' stripped)",
      JSON.stringify(keywords),
    );
    check(
      !keywords.includes("products") &&
        !keywords.includes("practices") &&
        !keywords.includes("patients"),
      "keywords do not include generic stopwords 'products', 'practices', 'patients'",
      JSON.stringify(keywords),
    );
  }

  {
    // Test 2-word phrase retention vs generic noun:
    // "dental practice" should be retained as a 2-word phrase, but standalone "practices" dropped
    const keywords = extractDiscoveryKeywords({
      query: "dental practice, practices, patients, products, cosmetic dentists",
    });
    check(
      keywords.includes("dental practice"),
      "2-word phrase 'dental practice' is preserved",
      JSON.stringify(keywords),
    );
    check(
      !keywords.includes("practices") &&
        !keywords.includes("patients") &&
        !keywords.includes("products"),
      "standalone generic nouns 'practices', 'patients', 'products' are dropped",
      JSON.stringify(keywords),
    );
  }

  {
    // Test category retention when query has overlapping word
    const keywords = extractDiscoveryKeywords({
      query: "cosmetic dental surgery",
      category: "Dental",
    });
    check(
      keywords.includes("dental") || keywords.includes("Dental"),
      "Category candidate is always included and deduped",
      JSON.stringify(keywords),
    );
  }

  {
    // Test universal split on commas, semicolons, pipes, and conjunctions ('and', '&', 'or')
    const keywords = extractDiscoveryKeywords({
      query: "clinic one; clinic two | clinic three and clinic four & clinic five or clinic six",
    });
    check(
      keywords.length === 6 &&
        keywords.includes("clinic one") &&
        keywords.includes("clinic two") &&
        keywords.includes("clinic three") &&
        keywords.includes("clinic four") &&
        keywords.includes("clinic five") &&
        keywords.includes("clinic six"),
      "Splits on ;, |, and, &, or and caps at 6 keywords",
      JSON.stringify(keywords),
    );
  }

  console.log("\n=== 2. CATEGORY GATE TESTS ===");

  {
    const targetCategory = "Dental";

    // Rejections for category "Dental"
    const rejectedCategories = [
      "Product/service",
      "Software Company",
      "Nonprofit organization",
      "Consulting agency",
      "Digital creator",
    ];

    for (const cat of rejectedCategories) {
      check(
        !isCategoryAllowed(cat, targetCategory),
        `Category "${cat}" is rejected for target "${targetCategory}"`,
      );
    }

    // Acceptances for category "Dental"
    check(
      isCategoryAllowed("Dentist & Dental Office", targetCategory),
      `"Dentist & Dental Office" is accepted for "${targetCategory}"`,
    );
    check(
      isCategoryAllowed("Medical & Health", targetCategory),
      `"Medical & Health" is accepted for "${targetCategory}"`,
    );
    check(
      isCategoryAllowed("Cosmetic Dentist", targetCategory),
      `"Cosmetic Dentist" is accepted for "${targetCategory}"`,
    );

    // Null/empty category passes the category gate
    check(
      isCategoryAllowed(null, targetCategory),
      `null category passes category gate (deferred to negative keywords and AI)`,
    );
    check(
      isCategoryAllowed("", targetCategory),
      `empty category passes category gate`,
    );
    check(
      isCategoryAllowed(undefined, targetCategory),
      `undefined category passes category gate`,
    );

    // Safe fallback for unmapped category
    check(
      isCategoryAllowed("Specialty Orthodontics", "Orthodontics"),
      `Unmapped category fallback performs fuzzy contains-match`,
    );
    check(
      !isCategoryAllowed("Car Wash", "Orthodontics"),
      `Unmapped category fallback rejects non-matching category`,
    );

    // Plural/descriptive campaign categories must resolve to their synonym group
    for (const cat of ["Dentist", "Dental clinic", "Orthodontist", "Cosmetic dentist"]) {
      check(
        isCategoryAllowed(cat, "Dental Clinics"),
        `"${cat}" is accepted for "Dental Clinics"`,
      );
    }
    check(
      isCategoryAllowed("Dentist", "Dental Clinic"),
      `"Dentist" is accepted for "Dental Clinic"`,
    );
    check(
      !isCategoryAllowed("Software Company", "Dental Clinics"),
      `"Software Company" is rejected for "Dental Clinics"`,
    );
  }

  {
    // Verify hard rejection in decideRelevance even when intent words match
    const campaignContext: RelevanceCampaignContext = {
      intent: "teeth whitening products for clinics",
      location: null,
      category: "Dental",
    };
    const profileWithBadCategory = makeProfile({
      username: "primewash_sp",
      fullName: "Prime Wash",
      biography: "Quality teeth whitening products for cars", // contains intent words!
      category: "Product/service",
    });

    const evalBadCat = evaluateProfileRelevance(profileWithBadCategory, campaignContext);
    const decision = decideRelevance(evalBadCat);
    check(
      !decision.relevant && decision.reason === "IRRELEVANT_CATEGORY",
      "decideRelevance rejects candidate with bad category with IRRELEVANT_CATEGORY even if intent words match",
      `Decision: ${JSON.stringify(decision)}`,
    );
  }

  console.log("\n=== 3. NEGATIVE KEYWORDS TESTS ===");

  {
    // Test normalization and word boundary
    check(
      stripAccents("Estética Automotiva") === "Estetica Automotiva",
      "stripAccents handles accented Portuguese/French/Spanish text",
    );
    check(
      normalizeForBoundaryCheck("prime_wash.sp") === "prime wash sp",
      "normalizeForBoundaryCheck normalizes separators to spaces",
    );

    // Check that 'dentist' is NOT blocked by short substrings
    const cleanMatch = findMatchedNegativeKeyword([
      "dr_dentist",
      "Dr. Smith Dental Clinic",
      "Certified cosmetic dentist offering implants and whitening",
      "Dentist & Dental Office",
    ]);
    check(
      cleanMatch === null,
      "'dentist' is NOT blocked by negative keywords",
      `Matched: ${cleanMatch}`,
    );

    // Test rejection of the 5 problematic leads from the campaign:
    // 1) @itdaoc (Dental Training Academy / NDAEB)
    const itdaocMatch = findMatchedNegativeKeyword([
      "itdaoc",
      "ITD Dental Academy",
      "NDAEB Preparation & Dental Training Academy course",
      "Education",
    ]);
    check(
      itdaocMatch !== null,
      "@itdaoc rejected by negative keywords (matched 'ndaeb' or 'course' or 'trainer')",
      `Matched: ${itdaocMatch}`,
    );

    // 2) @international_dentists_canada (mentorship community)
    const idcMatch = findMatchedNegativeKeyword([
      "international_dentists_canada",
      "International Dentists Canada",
      "Community supporting foreign dentists with mentorship and licensing guidance",
    ]);
    check(
      idcMatch !== null,
      "@international_dentists_canada rejected by negative keywords (matched 'mentorship')",
      `Matched: ${idcMatch}`,
    );

    // 3) @fairlystaffing (dental staffing app)
    const fairlyMatch = findMatchedNegativeKeyword([
      "fairlystaffing",
      "Fairly Dental Staffing",
      "Find dental temp jobs and permanent dental hygiene staffing across Canada",
    ]);
    check(
      fairlyMatch !== null,
      "@fairlystaffing rejected by negative keywords (matched 'staffing')",
      `Matched: ${fairlyMatch}`,
    );

    // 4) @royalcollegedentistscanada (regulatory college)
    const rcMatch = findMatchedNegativeKeyword([
      "royalcollegedentistscanada",
      "Royal College of Dentists of Canada",
      "National dental regulatory body and fellowship examination college of dentists",
    ]);
    check(
      rcMatch !== null,
      "@royalcollegedentistscanada rejected by negative keywords (matched 'royal college' or 'college of')",
      `Matched: ${rcMatch}`,
    );

    // 5) @primewash_sp (car wash)
    const primewashMatch = findMatchedNegativeKeyword([
      "primewash_sp",
      "Prime Wash Detail",
      "Estética automotiva especializada em polimento e lavagem",
      "Product/service",
    ]);
    check(
      primewashMatch !== null,
      "@primewash_sp rejected by negative keywords (matched 'estetica automotiva' / 'automotive')",
      `Matched: ${primewashMatch}`,
    );

    // Legitimate clinic @dentistabrasileironocanada
    const legitClinic = {
      username: "dentistabrasileironocanada",
      fullName: "Dra. Carolina Freitas | Dentist in Canada",
      biography: "Horizons Dental Care clinic in Toronto. Family & cosmetic dentistry.",
      category: "Dentist & Dental Office",
    };
    const legitMatch = findMatchedNegativeKeyword([
      legitClinic.username,
      legitClinic.fullName,
      legitClinic.biography,
      legitClinic.category,
    ]);
    check(
      legitMatch === null,
      "@dentistabrasileironocanada is NOT blocked by negative keywords",
      `Matched: ${legitMatch}`,
    );

    // Test prefilterCandidate on legit clinic
    const preResult = prefilterCandidate(
      legitClinic,
      {
        intent: "dental clinics, dentists and cosmetic dentistry",
        location: null,
        category: "Dental",
      },
    );
    check(
      preResult.action === "PROCEED",
      "@dentistabrasileironocanada passes pre-filter candidate check",
      JSON.stringify(preResult),
    );
  }

  console.log("\n=== 4. AI RELEVANCE GATE TESTS ===");

  {
    const { evaluateProfileRelevanceWithAI } = await import(
      "../src/lib/services/discovery/ai-relevance"
    );

    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-gemini-key";
    const originalFetch = globalThis.fetch;
    const campaignContext: RelevanceCampaignContext = {
      intent: "dental clinics and cosmetic dentistry practices",
      category: "Dental",
      location: "Toronto, Canada",
    };

    const clinicProfile = makeProfile({
      username: "toronto_smile_clinic",
      fullName: "Toronto Smile Dental Clinic",
      biography: "Full-service dental office providing teeth whitening and cleanings.",
      category: "Dentist & Dental Office",
      followers: 3500,
      website: "https://torontosmileclinic.com",
    });

    try {
      // 4a. Mock Gemini returning score 85 + business_clinic -> ACCEPTED
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        relevant: true,
                        score: 85,
                        reason: "Genuine operating dental clinic that fits the campaign criteria",
                        accountType: "business_clinic",
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result85 = await evaluateProfileRelevanceWithAI(clinicProfile, campaignContext, {
        threshold: 70,
      });
      check(
        result85.relevant === true &&
          result85.score === 85 &&
          result85.accountType === "business_clinic",
        "AI gate accepts lead with score 85 and accountType 'business_clinic'",
        JSON.stringify(result85),
      );

      // 4b. Mock Gemini returning score 60 -> REJECTED (below threshold 70)
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        relevant: true,
                        score: 60,
                        reason: "Marginal relevance to dental campaign",
                        accountType: "business_clinic",
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result60 = await evaluateProfileRelevanceWithAI(clinicProfile, campaignContext, {
        threshold: 70,
      });
      check(
        result60.relevant === false && result60.score === 60,
        "AI gate rejects lead with score 60 (< 70 threshold)",
        JSON.stringify(result60),
      );

      // 4c. Mock Gemini returning score 90 but accountType = 'individual' -> REJECTED
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        relevant: true,
                        score: 90,
                        reason: "Individual dentist influencer, not an operating clinic",
                        accountType: "individual",
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const resultIndividual = await evaluateProfileRelevanceWithAI(
        clinicProfile,
        campaignContext,
        { threshold: 70 },
      );
      check(
        resultIndividual.relevant === false &&
          resultIndividual.accountType === "individual",
        "AI gate rejects accountType 'individual' even with score 90",
        JSON.stringify(resultIndividual),
      );

      // 4d. Mock Gemini returning invalid non-JSON / API error -> FAIL CLOSED as AI_UNAVAILABLE without throwing
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: "THIS IS INVALID NOT JSON {{{",
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      let threw = false;
      let resultInvalid: any = null;
      try {
        resultInvalid = await evaluateProfileRelevanceWithAI(clinicProfile, campaignContext, {
          threshold: 70,
        });
      } catch {
        threw = true;
      }

      check(
        !threw &&
          resultInvalid !== null &&
          resultInvalid.relevant === false &&
          resultInvalid.reason === "AI_UNAVAILABLE",
        "AI gate fails closed with reason 'AI_UNAVAILABLE' on invalid JSON without throwing",
        JSON.stringify(resultInvalid),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("\n=== 5. COLLECT RELEVANT LEADS PIPELINE INTEGRATION ===");

  {
    // Verify that cheap gates run BEFORE AI gate, so obviously bad candidates never invoke AI
    let aiCallCount = 0;
    const candidates = [
      "primewash_sp", // Car wash: rejected by negative keyword / category gate
      "fairlystaffing", // Staffing: rejected by negative keyword gate
      "toronto_smile_clinic", // Genuine clinic: passes cheap gates, reaches AI gate
    ];

    const profilesMap = new Map<string, LeadProfile>([
      [
        "primewash_sp",
        makeProfile({
          username: "primewash_sp",
          fullName: "Prime Wash",
          biography: "Estética automotiva car wash detail",
          category: "Product/service",
        }),
      ],
      [
        "fairlystaffing",
        makeProfile({
          username: "fairlystaffing",
          fullName: "Fairly Staffing",
          biography: "Dental staffing agency",
          category: "Employment Agency",
        }),
      ],
      [
        "toronto_smile_clinic",
        makeProfile({
          username: "toronto_smile_clinic",
          fullName: "Toronto Smile Clinic",
          biography: "Dental clinic offering cosmetic dentistry and whitening",
          category: "Dentist & Dental Office",
        }),
      ],
    ]);

    const result = await collectRelevantLeads({
      candidates,
      capacity: 5,
      campaign: {
        intent: "dental clinics and cosmetic dentistry practices",
        location: null,
        category: "Dental",
      },
      policy: {
        ...DEFAULT_DISCOVERY_RELEVANCE_POLICY,
        requireLocationMatch: false,
        allowUnknownLocation: true,
        useAiRelevanceCheck: true,
        aiRelevanceThreshold: 70,
      },
      enrich: async (batch) => {
        return {
          profiles: batch.map((u) => profilesMap.get(u)!).filter(Boolean),
          skipped: [],
        };
      },
      checkAiRelevance: async (p) => {
        aiCallCount++;
        return {
          relevant: true,
          score: 88,
          reason: "Clinic practice verified",
          accountType: "business_clinic",
        };
      },
    });

    check(
      aiCallCount === 1,
      "AI relevance gate called ONLY on candidates passing cheap gates (cost control: 1 out of 3)",
      `aiCallCount = ${aiCallCount}`,
    );
    check(
      result.relevant.length === 1 &&
        result.relevant[0].username === "toronto_smile_clinic",
      "Only the legitimate dental clinic was qualified",
      JSON.stringify(result.relevant.map((p) => p.username)),
    );
    check(
      result.rejectionLog.length >= 2,
      "rejectionLog recorded rejections for failed candidates",
      JSON.stringify(result.rejectionLog),
    );
    check(
      result.gateRejections.negative_keyword >= 1 || result.gateRejections.category >= 1,
      "gateRejections tracked counts per gate",
      JSON.stringify(result.gateRejections),
    );
  }

  console.log(`\n========================================`);
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner encountered unhandled error:", err);
  process.exit(1);
});
