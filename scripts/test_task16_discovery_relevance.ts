/**
 * Task 16 — Discovery relevance regression suite.
 *
 * Deterministic, offline unit tests for the server-side relevance gate that was
 * missing when @andien (Musician) etc. were persisted for a "Fitness / Rawalpindi"
 * campaign. No network, no DB, no Apify.
 */
import type { LeadProfile } from "../src/lib/types";
import {
  buildDiscoverySearchTerm,
  tokenizeSearchQuery,
} from "../src/lib/services/discovery/discovery-query";
import {
  collectRelevantLeads,
  createEmptySkipCounts,
  decideRelevance,
  deduplicateCandidates,
  evaluateProfileRelevance,
  type DiscoverySkipCounts,
} from "../src/lib/services/discovery/lead-relevance";

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

const CAMPAIGN = {
  intent: "fitness gyms and fitness businesses",
  location: "Rawalpindi",
  category: "Fitness",
};

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

function sum(counts: DiscoverySkipCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

async function main(): Promise<void> {
  console.log("=================================================================");
  console.log("   TASK 16: DISCOVERY RELEVANCE REGRESSION SUITE                  ");
  console.log("=================================================================");

  // ---- Search-query construction (root-cause guard) ----
  console.log("\n[Search query construction]");
  const searchTerm = buildDiscoverySearchTerm({
    query: "fitness gyms and fitness businesses",
    category: "Fitness",
    location: "Rawalpindi",
  });
  console.log(`  search="${searchTerm}"`);
  check(searchTerm.includes("rawalpindi") || searchTerm.includes("Rawalpindi"), "location keyword retained in actor search");
  check(!/(^|\s)and(\s|$)/i.test(searchTerm), "stop-word 'and' removed from actor search");
  check(searchTerm.toLowerCase().split(/\s+/).filter((t) => t === "fitness").length === 1, "duplicate 'fitness' token collapsed");
  check(searchTerm.toLowerCase().includes("gym"), "gym keyword retained");
  check(tokenizeSearchQuery("Fitness and Gyms").length === 2, "tokenizer drops stop-words");

  // ---- Test A: fitness campaign + musician profile -> rejected ----
  console.log("\n[Test A] fitness campaign + musician profile");
  const musician = makeProfile({
    username: "musician_account",
    fullName: "Sample Musician",
    biography: "Musician, singer and artist based in Jakarta",
    businessCategoryName: "Musician/Band",
    category: "Musician/Band",
  });
  const musicianRel = evaluateProfileRelevance(musician, CAMPAIGN);
  const musicianDecision = decideRelevance(musicianRel);
  console.log(`  category=${musicianRel.categoryMatch} intent=${musicianRel.intentMatch} location=${musicianRel.locationMatch}`);
  check(musicianRel.intentMatch === "NOT_MATCHED", "musician intent NOT_MATCHED");
  check(musicianRel.categoryMatch === "NOT_MATCHED", "musician category NOT_MATCHED");
  check(!musicianDecision.relevant, "musician rejected");
  check(!musicianDecision.relevant && musicianDecision.reason === "IRRELEVANT_CATEGORY", `musician reason IRRELEVANT_CATEGORY (got ${!musicianDecision.relevant ? musicianDecision.reason : "-"})`);

  // ---- Test B: fitness campaign + fitness/gym profile -> accepted ----
  console.log("\n[Test B] fitness campaign + gym profile");
  const gym = makeProfile({
    username: "ironparadisegym",
    fullName: "Iron Paradise Gym",
    biography: "Fitness center, personal trainer and strength coaching",
    businessCategoryName: "Gym/Physical Fitness Center",
    category: "Gym/Physical Fitness Center",
  });
  const gymRel = evaluateProfileRelevance(gym, CAMPAIGN);
  const gymDecision = decideRelevance(gymRel);
  console.log(`  category=${gymRel.categoryMatch} intent=${gymRel.intentMatch} location=${gymRel.locationMatch}`);
  check(gymRel.categoryMatch === "MATCHED", "gym category MATCHED");
  check(gymRel.intentMatch === "MATCHED", "gym intent MATCHED");
  check(gymDecision.relevant, "gym accepted");

  // ---- Test C: fitness campaign + politician profile -> rejected ----
  console.log("\n[Test C] fitness campaign + politician profile");
  const politician = makeProfile({
    username: "politician_account",
    fullName: "Sample Politician",
    biography: "Member of parliament. Politics and public service.",
    businessCategoryName: "Politician",
    category: "Politician",
  });
  const politicianDecision = decideRelevance(evaluateProfileRelevance(politician, CAMPAIGN));
  check(!politicianDecision.relevant, "politician rejected");
  check(!politicianDecision.relevant && politicianDecision.reason === "IRRELEVANT_CATEGORY", "politician reason IRRELEVANT_CATEGORY");

  // ---- Test C2: generic public figure with no category -> IRRELEVANT_INTENT ----
  console.log("\n[Test C2] generic creator with no category");
  const creator = makeProfile({
    username: "creator_account",
    fullName: "Sample Creator",
    biography: "Digital creator. News and updates.",
  });
  const creatorDecision = decideRelevance(evaluateProfileRelevance(creator, CAMPAIGN));
  check(!creatorDecision.relevant, "generic creator rejected");
  check(!creatorDecision.relevant && creatorDecision.reason === "IRRELEVANT_INTENT", "generic creator reason IRRELEVANT_INTENT");
  check(!creatorDecision.relevant && creatorDecision.reason !== "IRRELEVANT_LOCATION", "creator not rejected purely on location");

  // ---- Test D: Rawalpindi evidence -> location MATCHED + accepted ----
  console.log("\n[Test D] Rawalpindi profile with location evidence");
  const localGym = makeProfile({
    username: "rawalpindifitnessclub",
    fullName: "Rawalpindi Fitness Club",
    biography: "Best gym in Rawalpindi, Pakistan. Personal training available.",
    businessCategoryName: "Gym/Physical Fitness Center",
    category: "Gym/Physical Fitness Center",
    location: "Rawalpindi, Pakistan",
  });
  const localRel = evaluateProfileRelevance(localGym, CAMPAIGN);
  console.log(`  location=${localRel.locationMatch} matched=${localRel.matchedLocationTerms.join(",")}`);
  check(localRel.locationMatch === "MATCHED", "Rawalpindi location MATCHED");
  check(decideRelevance(localRel).relevant, "local gym accepted");

  // ---- Test D2: explicit conflicting location -> NOT_MATCHED + rejected ----
  console.log("\n[Test D2] conflicting explicit location");
  const dubaiGym = makeProfile({
    username: "dubaigym",
    fullName: "Dubai Gym",
    biography: "Fitness and personal training",
    businessCategoryName: "Gym/Physical Fitness Center",
    category: "Gym/Physical Fitness Center",
    location: "Dubai, UAE",
  });
  const dubaiRel = evaluateProfileRelevance(dubaiGym, CAMPAIGN);
  const dubaiDecision = decideRelevance(dubaiRel);
  check(dubaiRel.locationMatch === "NOT_MATCHED", "conflicting location NOT_MATCHED");
  check(!dubaiDecision.relevant && dubaiDecision.reason === "IRRELEVANT_LOCATION", "conflicting location rejected as IRRELEVANT_LOCATION");

  // ---- Test E: no location evidence -> UNKNOWN (not fabricated) and allowed ----
  console.log("\n[Test E] no location evidence");
  const noLocation = makeProfile({
    username: "fitcoachpro",
    fullName: "Fit Coach Pro",
    biography: "Personal trainer and nutrition coach",
    businessCategoryName: "Gym/Physical Fitness Center",
    category: "Gym/Physical Fitness Center",
    location: null,
  });
  const noLocationRel = evaluateProfileRelevance(noLocation, CAMPAIGN);
  const noLocationDecision = decideRelevance(noLocationRel);
  console.log(`  location=${noLocationRel.locationMatch}`);
  check(noLocationRel.locationMatch === "UNKNOWN", "missing location is UNKNOWN (not MATCHED)");
  check(noLocation.location === null, "location not fabricated into profile");
  check(noLocationDecision.relevant, "unknown location still accepted by default policy");

  // ---- Test F: duplicate username -> skipped ----
  console.log("\n[Test F] duplicate username");
  const deduped = deduplicateCandidates(
    ["gymone", "gymone", "gymtwo"],
    ["gymtwo"],
  );
  check(deduped.unique.join(",") === "gymone", "only new unique usernames survive");
  check(deduped.duplicates.join(",") === "gymone,gymtwo", "duplicates reported (in-run + existing)");

  // ---- Test G: pipeline continues past irrelevant candidates to fill capacity ----
  console.log("\n[Test G] 5 relevant leads despite irrelevant candidates first");
  const candidates = Array.from({ length: 15 }, (_, i) => `candidate${i}`);
  const makeIrrelevant = (username: string): LeadProfile =>
    makeProfile({
      username,
      fullName: `Musician ${username}`,
      biography: "Musician and recording artist",
      businessCategoryName: "Musician/Band",
      category: "Musician/Band",
    });
  const makeValid = (username: string): LeadProfile =>
    makeProfile({
      username,
      fullName: `Valid Gym ${username}`,
      biography: "Fitness gym and personal trainer",
      businessCategoryName: "Gym/Physical Fitness Center",
      category: "Gym/Physical Fitness Center",
    });

  let enrichCalls = 0;
  const result = await collectRelevantLeads({
    candidates,
    capacity: 5,
    campaign: CAMPAIGN,
    batchSize: 10,
    maxCandidates: 15,
    enrich: async (batch: string[]) => {
      enrichCalls++;
      if (enrichCalls === 1) {
        // 10 candidates -> 5 irrelevant, 3 enrichment failures, 2 valid
        return {
          profiles: [
            makeIrrelevant(batch[0]),
            makeIrrelevant(batch[1]),
            makeIrrelevant(batch[2]),
            makeIrrelevant(batch[3]),
            makeIrrelevant(batch[4]),
            makeValid(batch[5]),
            makeValid(batch[6]),
          ],
          skipped: [],
        };
      }
      // remaining 5 candidates -> all valid
      return { profiles: batch.map((username) => makeValid(username)), skipped: [] };
    },
  });

  console.log(`  relevant=${result.relevant.length} enriched=${result.candidatesEnriched} failures=${result.enrichmentFailures}`);
  console.log(`  skipCounts=${JSON.stringify(result.skipCounts)}`);
  check(enrichCalls === 2, "pipeline kept enriching after first batch (did not stop at 5 raw candidates)");
  check(result.relevant.length === 5, "collected exactly 5 relevant leads");
  check(result.enrichmentFailures === 3, "counted 3 enrichment failures");
  check(result.skipCounts.IRRELEVANT_CATEGORY === 5, "counted 5 irrelevant candidates");
  check(result.skipCounts.CAMPAIGN_CAPACITY_REACHED === 2, "counted 2 extra valid beyond capacity");
  check(result.candidatesEnriched === 12, "enriched all 12 fetchable candidates");

  // ---- Skip-count bookkeeping sanity ----
  const empty = createEmptySkipCounts();
  check(sum(empty) === 0, "empty skip counts start at zero");

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Unexpected test failure:", error);
  process.exit(1);
});
