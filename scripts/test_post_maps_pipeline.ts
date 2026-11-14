/**
 * Post-Maps pipeline tests (mocked actor; no network, no paid calls).
 */

import "./preload_server_only.cjs";
import "dotenv/config";

import { setMockActorRunnerForTesting } from "../src/lib/services/scraper/apify-cost-guard";
import { GoogleMapsDiscoveryProvider } from "../src/lib/services/discovery/google-maps-discovery-provider";
import { scrapeInstagramProfiles } from "../src/lib/services/scraper";
import { getPrismaClient } from "../src/lib/db/prisma";
import { extractDiscoveryKeywords } from "../src/lib/services/discovery/discovery-query";
import { normalizePhone } from "../src/lib/services/contact/contact-parser";

let passed = 0;
let failed = 0;
function check(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail === undefined ? "" : ` -> ${String(detail)}`}`);
    failed++;
  }
}

const ACTOR = "compass/crawler-google-places";
const PROFILE_ACTOR = "apify/instagram-profile-scraper";

function makeFixtures() {
  const items: Record<string, unknown>[] = [];
  const dup = {
    placeId: [] as string[],
    domain: [] as string[],
    phone: [] as string[],
    handle: [] as string[],
  };

  for (let i = 0; i < 5; i++) {
    const placeId = `dup_place_${i}`;
    dup.placeId.push(placeId);
    items.push({
      placeId,
      title: `PlaceId Dup ${i}`,
      categoryName: "Dentist",
      city: "Toronto",
      phone: `+1 416 555 20${i}`,
      totalScore: 4.5,
      reviewsCount: 100,
    });
  }
  for (let i = 0; i < 5; i++) {
    const domain = `dupdomain${i}.example`;
    dup.domain.push(domain);
    items.push({
      placeId: `dup_domain_place_${i}`,
      title: `Domain Dup ${i}`,
      categoryName: "Dentist",
      city: "Toronto",
      website: `https://www.${domain}/contact`,
      totalScore: 4.5,
      reviewsCount: 100,
    });
  }
  for (let i = 0; i < 5; i++) {
    const phone = `+1 416 555 30${i}`;
    dup.phone.push(phone);
    items.push({
      placeId: `dup_phone_place_${i}`,
      title: `Phone Dup ${i}`,
      categoryName: "Dentist",
      city: "Toronto",
      phone,
      totalScore: 4.5,
      reviewsCount: 100,
    });
  }
  for (let i = 0; i < 5; i++) {
    const handle = `duphandle${i}`;
    dup.handle.push(handle);
    items.push({
      placeId: `dup_handle_place_${i}`,
      title: `Handle Dup ${i}`,
      categoryName: "Dentist",
      city: "Toronto",
      phone: `+1 416 555 40${i}`,
      instagram: handle,
      totalScore: 4.5,
      reviewsCount: 100,
    });
  }

  for (let i = 0; i < 15; i++) {
    items.push({
      placeId: `contact_only_${i}`,
      title: `Contact Only Dental ${i}`,
      categoryName: "Dentist",
      city: "Toronto",
      phone: `+1 416 555 50${i.toString().padStart(2, "0")}`,
      totalScore: 4.2,
      reviewsCount: 50,
    });
  }

  for (let i = 0; i < 15; i++) {
    items.push({
      placeId: `handle_place_${i}`,
      title: `Handle Dental ${i}`,
      categoryName: "Dentist",
      city: "Toronto",
      phone: `+1 416 555 60${i.toString().padStart(2, "0")}`,
      instagram: `handle_dental_${i}`,
      totalScore: 4.7,
      reviewsCount: 120,
    });
  }

  for (let i = 0; i < 5; i++) {
    items.push({
      placeId: `no_contact_${i}`,
      title: `No Contact Dental ${i}`,
      categoryName: "Dentist",
      city: "Toronto",
      totalScore: 4.1,
      reviewsCount: 20,
    });
  }

  return { items, dup };
}

async function main(): Promise<void> {
  console.log("=================================================");
  console.log("  POST-MAPS PIPELINE TESTS (MOCKED)");
  console.log("=================================================\n");

  const prisma = getPrismaClient();
  process.env.APIFY_DRY_RUN = "false";
  const user = await prisma.user.create({
    data: {
      email: `post-maps-${Date.now()}@example.test`,
      passwordHash: "test-hash",
      name: "Post Maps Test",
    },
  });
  const companyProfile = await prisma.companyProfile.create({
    data: { userId: user.id, name: "Post Maps Co" },
  });
  const campaign = await prisma.campaign.create({
    data: { userId: user.id, name: "Post Maps Campaign", companyProfileId: companyProfile.id },
  });

  const { items, dup } = makeFixtures();

  try {
    const leadBase = {
      campaignId: campaign.id,
      userId: user.id,
      source: "test",
      hasPhone: true,
    };
    // 20 existing duplicates, with the exact keys the pipeline must match.
    for (const placeId of dup.placeId) {
      await prisma.lead.create({ data: { ...leadBase, fullName: "dup", gmapsPlaceId: placeId } });
    }
    for (const domain of dup.domain) {
      await prisma.lead.create({
        data: {
          ...leadBase,
          fullName: "dup",
          website: `https://${domain}`,
          websiteDomain: domain,
          websiteKey: domain,
        },
      });
    }
    for (const phone of dup.phone) {
      await prisma.lead.create({
        data: {
          ...leadBase,
          fullName: "dup",
          phoneNormalized: normalizePhone(phone) ?? phone.replace(/\D/g, "").slice(-10),
        },
      });
    }
    for (const handle of dup.handle) {
      await prisma.lead.create({
        data: { ...leadBase, fullName: "dup", username: handle, usernameNormalized: handle },
      });
    }

    // A dry-run row must NOT block a real run.
    await prisma.lead.create({
      data: {
        ...leadBase,
        fullName: "dry dup",
        isDryRun: true,
        gmapsPlaceId: "handle_place_0",
      },
    });

    const calls: Array<{ actorId: string; input: Record<string, unknown> }> = [];
    setMockActorRunnerForTesting(async (actorId, input) => {
      calls.push({ actorId, input });
      if (actorId === ACTOR) {
        return {
          run: { id: "maps_run_1", defaultDatasetId: "ds_maps", status: "SUCCEEDED", usageTotalUsd: 0.15 },
          items,
          usageTotalUsd: 0.15,
          computeUnits: 0,
        } as never;
      }
      return {
        run: { id: "profile_run_1", defaultDatasetId: "ds_profiles", status: "SUCCEEDED", usageTotalUsd: 0.02 },
        items: ((input.directUrls as string[] | undefined) ??
          (input.usernames as string[] | undefined) ??
          []).map((entry) => {
          const username = entry.split("/").filter(Boolean).pop() ?? "unknown";
          return {
            username,
            fullName: `Profile ${username}`,
            followersCount: 1200,
            followsCount: 100,
            postsCount: 40,
            biography: "Dental clinic in Toronto",
            externalUrl: "https://maps-site.example",
            isBusinessAccount: true,
            private: false,
            latestPosts: [{ timestamp: new Date().toISOString(), likesCount: 20 }],
          };
        }) ?? [],
        usageTotalUsd: 0.02,
        computeUnits: 0,
      } as never;
    });

    process.env.DISCOVERY_PROVIDER = "google_maps";
    process.env.GMAPS_MAX_PLACES_PER_SEARCH = "100";
    process.env.GMAPS_MAX_TOTAL_PLACES = "100";
    process.env.GMAPS_MAX_CITIES = "1";
    process.env.GMAPS_MAX_SEARCHES_PER_JOB = "1";

    const provider = new GoogleMapsDiscoveryProvider();
    const result = await provider.discover({
      query: "dentist, dental clinic",
      location: "Toronto",
      limit: 50,
      campaignId: campaign.id,
      userId: user.id,
      isDryRun: false,
    });

    const mapsCalls = calls.filter((c) => c.actorId === ACTOR);
    const profileCallsWhileDiscovery = calls.filter((c) => c.actorId === PROFILE_ACTOR);

    console.log("[1. Dedup before paid stages]");
    check(mapsCalls.length === 1, "one Maps run", mapsCalls.length);
    check(profileCallsWhileDiscovery.length === 0, "zero profile-scraper calls during discovery/dedup");
    check(result.gmapsPlacesFound === 55, "paid for 55 places", result.gmapsPlacesFound);
    check(result.duplicatesSkipped === 20, "20 duplicates dropped", result.duplicatesSkipped);
    check(
      result.candidates.length === 30,
      "30 new places remain (15 contact-only + 15 handle)",
      result.candidates.length,
    );
    check(result.placesDroppedNoContact === 5, "5 no-contact places dropped", result.placesDroppedNoContact);

    console.log("\n[2. No-handle contact-only pool]");
    const contactOnly = result.candidates.filter((c) => !c.username);
    const withHandle = result.candidates.filter((c) => Boolean(c.username));
    check(contactOnly.length === 15, "15 contact-only places", contactOnly.length);
    check(withHandle.length === 15, "15 handle places", withHandle.length);
    check(
      contactOnly.every((c) => c.phone && !c.email && !c.website),
      "contact-only stores only available fields",
    );
    check(
      contactOnly.every((c) => c.availableChannels?.includes("PHONE")),
      "contact-only has a usable channel",
    );
    check(
      withHandle.every((c) => c.handleConfidence === "high"),
      "Maps handles are high confidence",
    );

    console.log("\n[3. Profile scraper only for handles, batched]");
    const handles = withHandle.map((c) => c.username!).filter(Boolean);
    const profiles = await scrapeInstagramProfiles(handles, handles.length, {
      campaignId: campaign.id,
      userId: user.id,
    });
    const profileCalls = calls.filter((c) => c.actorId === PROFILE_ACTOR);
    check(profileCalls.length === 1, "exactly one batched profile-scraper call", profileCalls.length);
    check(profiles.profiles.length === 15, "all 15 profiles enriched", profiles.profiles.length);
    const batchHandles =
      (profileCalls[0]?.input.directUrls as string[] | undefined) ??
      (profileCalls[0]?.input.usernames as string[] | undefined);
    check(Array.isArray(batchHandles) && batchHandles.length === 15, "batch passes 15 deduped handles");

    console.log("\n[4. No-contact place is dropped, not paid further]");
    check(
      result.placesDroppedNoContact === 5,
      "5 places with no phone/email/website dropped as NO_CONTACT",
    );
    check(
      calls.every((c) => c.actorId === ACTOR || c.actorId === PROFILE_ACTOR),
      "only Maps and profile-scraper actors were ever used",
    );

    console.log("\n[5. Accounting]");
    const paid = result.gmapsPlacesFound ?? 0;
    const dupes = result.duplicatesSkipped ?? 0;
    const newPlaces = paid - dupes;
    const costPerNew = result.actualCostUsd && newPlaces > 0 ? result.actualCostUsd / newPlaces : null;
    check(paid === 55 && dupes === 20 && newPlaces === 35, "paid 55, duplicates 20, new 35");
    check(
      costPerNew !== null && Math.abs(costPerNew - 0.15 / 35) < 0.0001,
      "cost per NEW place uses actual spend",
      costPerNew,
    );
  } finally {
    setMockActorRunnerForTesting(null);
    await prisma.lead.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.campaign.delete({ where: { id: campaign.id } });
    await prisma.companyProfile.delete({ where: { id: companyProfile.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }

  console.log(`\nPASSED: ${passed} | FAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
