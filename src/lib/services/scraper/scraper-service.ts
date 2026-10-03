import "server-only";

import type {
  LeadProfile,
  ScrapeInput,
  SkippedScrapeProfile,
} from "@/lib/types";

import { getScraperProviderName } from "@/lib/env";
import { ApifyProvider } from "./apify-provider";
import { SpariorProfileProvider } from "./sparior";
import type { ScraperProvider } from "./scraper-provider";
import type { ProfileProvider } from "./profile-provider";

let scraperProvider: ScraperProvider | null = null;
let profileProvider: ProfileProvider | null = null;

export function getScraperProvider(): ScraperProvider {
  const providerName = getScraperProviderName();
  if (providerName === "sparior") {
    return new SpariorProfileProvider();
  }
  if (scraperProvider === null) {
    scraperProvider = new ApifyProvider();
  }

  return scraperProvider;
}

export function getProfileProvider(): ProfileProvider {
  const providerName = getScraperProviderName();
  if (providerName === "sparior") {
    return new SpariorProfileProvider();
  }
  if (profileProvider === null) {
    profileProvider = new ApifyProvider();
  }

  return profileProvider;
}

export type InstagramProfileScrapeResult = {
  provider: string;
  runId: string;
  profiles: LeadProfile[];
  skipped: SkippedScrapeProfile[];
  usageTotalUsd?: number;
  computeUnits?: number;
};

export async function scrapeInstagramProfiles(
  usernames: string[],
  leadLimit?: number,
  options?: {
    campaignId?: string;
    userId?: string;
  },
): Promise<InstagramProfileScrapeResult> {
  const scraper = getScraperProvider();

  const effectiveLimit =
    leadLimit === undefined
      ? usernames.length
      : Math.min(leadLimit, usernames.length);

  const input: ScrapeInput = {
    campaignId: options?.campaignId,
    userId: options?.userId,
    usernames,
    // Controls how many profiles we keep/persist. The Actor itself has no
    // results-limit input, so this is enforced by the app and by `maxItems`.
    limit: effectiveLimit,
  };

  const job = await scraper.startJob(input);
  const runId = job.status.providerJobId ?? job.jobId;
  const { profiles, skipped, usageTotalUsd, computeUnits } = await scraper.getResults(runId);

  return {
    provider: job.provider,
    runId,
    profiles,
    skipped,
    usageTotalUsd,
    computeUnits,
  };
}
