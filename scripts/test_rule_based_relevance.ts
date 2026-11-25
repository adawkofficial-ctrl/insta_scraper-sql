/**
 * Rule-based (AI off) location + content relevance. Pure, no DB/network.
 * Run: npx tsx -r ./scripts/preload_server_only.cjs scripts/test_rule_based_relevance.ts
 */
import type { LeadProfile } from "../src/lib/types";
import {
  isAutoAiEnrichmentEnabled,
  ruleBasedCandidateRelevance,
  ruleBasedProfileRelevance,
} from "../src/lib/services/discovery/rule-based-relevance";
import { evaluateMapsCandidateRelevanceWithAI } from "../src/lib/services/discovery/ai-relevance";

let passed = 0;
let failed = 0;
const check = (c: boolean, n: string, d?: unknown) => {
  if (c) { passed++; console.log(`  PASS: ${n}`); } else { failed++; console.error(`  FAIL: ${n} -> ${JSON.stringify(d)}`); }
};

const campaign = { intent: "dental clinics", location: "Toronto, Canada", category: "dentist" };
const p = (x: Partial<LeadProfile>) => ({ username: "x", ...x }) as LeadProfile;

async function main() {
  process.env.AI_AUTO_ENRICHMENT = "false";
  check(!isAutoAiEnrichmentEnabled(), "flag off");

  const good = ruleBasedProfileRelevance(
    p({ fullName: "King West Dental", biography: "Family dentist in downtown Toronto", category: "Dentist", location: "Toronto, ON" }),
    campaign, 60,
  );
  check(good.relevant && good.score >= 80, "content + location match passes", good);

  const wrongCity = ruleBasedProfileRelevance(
    p({ fullName: "Vancouver Smiles Dental", biography: "Dentist in Vancouver, BC", category: "Dentist", location: "Vancouver, BC" }),
    campaign, 60,
  );
  check(!wrongCity.relevant && wrongCity.analytics.riskFlags.includes("LOCATION_MISMATCH"), "other city rejected", wrongCity);

  const wrongContent = ruleBasedProfileRelevance(
    p({ fullName: "Toronto Pizza House", biography: "Best pizza in Toronto", category: "Restaurant", location: "Toronto, ON" }),
    campaign, 60,
  );
  check(!wrongContent.relevant, "unrelated business rejected", wrongContent);

  const viaGate = await evaluateMapsCandidateRelevanceWithAI(
    { businessName: "Yonge Dental Care", category: "Dentist", address: "123 Yonge St, Toronto, ON" },
    campaign,
  );
  check(viaGate.relevant && viaGate.reason.startsWith("Rule-based"), "AI gate uses rules when AI is off (no Gemini call)", viaGate);

  const cand = ruleBasedCandidateRelevance({ businessName: "Bloor Dentistry", category: "Dental clinic", city: "Toronto" }, campaign, 60);
  check(cand.relevant, "maps candidate scored", cand);

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
