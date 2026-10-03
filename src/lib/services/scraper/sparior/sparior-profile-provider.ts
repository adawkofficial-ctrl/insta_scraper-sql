import "server-only";

import { AppError } from "@/lib/errors";
import { getSpariorConfig } from "@/lib/env";
import type {
  LeadProfile,
  ScrapeInput,
  ScrapeJobResult,
  ScrapeJobStatus,
  SkippedScrapeProfile,
} from "@/lib/types";
import type {
  ProfileProvider,
  ProfileProviderContext,
} from "../profile-provider";
import type { ScraperProvider, ScrapeResults } from "../scraper-provider";
import { checkSpariorBudget } from "./sparior-budget";
import { SpariorClient } from "./sparior-client";
import { mapSpariorProfileToLeadProfile } from "./sparior-mappers";
import type { SpariorRawProfile } from "./sparior-types";

// In-memory cache for scrape jobs run through ScraperProvider interface
const inMemoryJobs = new Map<
  string,
  {
    status: ScrapeJobStatus;
    results: ScrapeResults;
  }
>();

export class SpariorProfileProvider
  implements ProfileProvider, ScraperProvider
{
  readonly name = "sparior";
  private readonly client: SpariorClient;

  constructor(client?: SpariorClient) {
    this.client = client ?? new SpariorClient();
  }

  async getProfile(
    username: string,
    context?: ProfileProviderContext,
  ): Promise<LeadProfile | null> {
    await checkSpariorBudget({
      userId: context?.userId,
    });

    const response = await this.client.getProfile(username, {
      campaignId: context?.campaignId,
      userId: context?.userId,
    });

    const raw = (response.data?.data ?? response.data) as SpariorRawProfile;
    const profile = mapSpariorProfileToLeadProfile(raw);
    return profile;
  }

  async getProfiles(
    usernames: string[],
    context?: ProfileProviderContext,
  ): Promise<{
    profiles: LeadProfile[];
    skipped: SkippedScrapeProfile[];
  }> {
    await checkSpariorBudget({
      userId: context?.userId,
    });

    const config = getSpariorConfig(false);
    const profiles: LeadProfile[] = [];
    const skipped: SkippedScrapeProfile[] = [];

    const effectiveLimit = Math.min(
      usernames.length,
      config.maxRequestsPerRun,
      config.maxProfilesPerRun,
    );

    for (let i = 0; i < effectiveLimit; i++) {
      const username = usernames[i];
      try {
        const response = await this.client.getProfile(username, {
          campaignId: context?.campaignId,
          userId: context?.userId,
        });

        const raw = (response.data?.data ?? response.data) as SpariorRawProfile;
        const profile = mapSpariorProfileToLeadProfile(raw);

        if (!profile) {
          skipped.push({
            username,
            reason: "malformed_profile_data",
          });
          continue;
        }

        if (profile.isPrivate) {
          skipped.push({
            username,
            reason: "private_profile",
          });
          continue;
        }

        profiles.push(profile);
      } catch (err: unknown) {
        if (
          err instanceof AppError &&
          err.code === "PROVIDER_QUOTA_EXHAUSTED"
        ) {
          skipped.push({
            username,
            reason: "quota_exhausted",
          });
          // Stop further requests once quota is exhausted
          break;
        }

        if (
          err instanceof AppError &&
          err.code === "PROVIDER_AUTH_FAILED"
        ) {
          throw err;
        }

        skipped.push({
          username,
          reason: err instanceof Error ? err.message : "scrape_failed",
        });
      }

      // Sequential delay between profile calls
      if (i < effectiveLimit - 1 && config.requestDelayMs > 0) {
        await new Promise((r) => setTimeout(r, config.requestDelayMs));
      }
    }

    return { profiles, skipped };
  }

  // ScraperProvider compatibility methods:
  async startJob(input: ScrapeInput): Promise<ScrapeJobResult> {
    const jobId = `sparior_job_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const { profiles, skipped } = await this.getProfiles(input.usernames, {
      campaignId: input.campaignId,
      userId: input.userId,
    });

    const status: ScrapeJobStatus = {
      jobId,
      state: "succeeded",
      providerJobId: jobId,
      progress: 100,
    };

    inMemoryJobs.set(jobId, {
      status,
      results: { profiles, skipped },
    });

    return {
      jobId,
      provider: this.name,
      status,
    };
  }

  async getJobStatus(jobId: string): Promise<ScrapeJobStatus> {
    const job = inMemoryJobs.get(jobId);
    if (!job) {
      return {
        jobId,
        state: "failed",
        error: "Job not found",
      };
    }
    return job.status;
  }

  async getResults(jobId: string): Promise<ScrapeResults> {
    const job = inMemoryJobs.get(jobId);
    if (!job) {
      return {
        profiles: [],
        skipped: [{ username: "unknown", reason: "Job not found" }],
      };
    }
    return job.results;
  }
}
