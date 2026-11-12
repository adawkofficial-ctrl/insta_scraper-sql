import "server-only";

import { type ActorRun } from "apify-client";

import type {
  LeadProfile,
  ScrapeInput,
  ScrapeJobResult,
  ScrapeJobState,
  ScrapeJobStatus,
  SkippedScrapeProfile,
} from "@/lib/types";

import { ProviderError, toProviderError } from "../provider-error";
import { getApifyClient } from "./apify-client";
import { runActorSafely, type SafeActorRunResult } from "./apify-cost-guard";
import {
  getIgEnrichmentActorMode,
  getActiveEnrichmentActorId,
  buildInstagramProfileUrls,
  normalizeInstagramProfileItem,
} from "./instagram-profile";
import type { ScrapeResults, ScraperProvider } from "./scraper-provider";
import type { ProfileProvider } from "./profile-provider";
import { classifyApifyProviderError } from "./apify-error-classifier";
import { assertEnrichmentActorEnabled } from "./provider-switch";

function log(message: string): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  console.log(message);
}

// In-memory cache for runs executed via runActorSafely
const cachedSafeRuns = new Map<string, SafeActorRunResult<unknown>>();

export class ApifyProvider implements ScraperProvider, ProfileProvider {
  readonly name = "apify";

  async startJob(input: ScrapeInput): Promise<ScrapeJobResult> {
    const usernames = input.usernames;
    if (usernames.length === 0) {
      throw new ProviderError(
        this.name,
        "startJob",
        "At least one username is required to start a scrape.",
        { code: "invalid_input" },
      );
    }

    const actorMode = getIgEnrichmentActorMode();
    const actorId = getActiveEnrichmentActorId();
    assertEnrichmentActorEnabled(actorId);

    const requestedLimit =
      input.limit === undefined
        ? usernames.length
        : Math.min(input.limit, usernames.length);

    log(
      `[SCRAPE] actorMode=${actorMode} actor=${actorId} profiles=${usernames.join(", ")} maxItems=${requestedLimit}`,
    );

    let actorInput: Record<string, unknown>;
    if (actorMode === "instagram_scraper_details") {
      const directUrls = buildInstagramProfileUrls(usernames);
      actorInput = {
        directUrls,
        resultsType: "details",
        resultsLimit: directUrls.length,
      };
    } else {
      actorInput = {
        usernames,
        includeAboutSection: false,
      };
    }

    const safeResult = await runActorSafely(
      actorId,
      actorInput,
      {
        maxItems: requestedLimit,
        campaignId: input.campaignId,
        userId: input.userId,
        operationName:
          actorMode === "instagram_scraper_details"
            ? "profile_enrichment_details"
            : "profile_enrichment",
      },
    );

    const run = safeResult.run;
    cachedSafeRuns.set(run.id, safeResult);

    log(`[SCRAPE] run completed id=${run.id} isDryRun=${safeResult.isDryRun}`);

    return {
      jobId: run.id,
      provider: this.name,
      status: {
        jobId: run.id,
        state: "succeeded",
        providerJobId: run.id,
        progress: null,
        error: null,
      },
    };
  }

  async getJobStatus(jobId: string): Promise<ScrapeJobStatus> {
    const cached = cachedSafeRuns.get(jobId);
    if (cached) {
      return {
        jobId,
        state: "succeeded",
        providerJobId: cached.run.id,
        progress: null,
        error: null,
      };
    }

    const client = getApifyClient();

    let run: ActorRun | undefined;
    try {
      run = await client.run(jobId).get();
    } catch (error) {
      throw toProviderError(
        this.name,
        "getJobStatus",
        error,
        classifyApifyProviderError(error) ?? "actor_status_failed",
      );
    }

    if (run === undefined) {
      throw new ProviderError(
        this.name,
        "getJobStatus",
        `Apify run "${jobId}" was not found.`,
        { code: "run_not_found" },
      );
    }

    return {
      jobId,
      state: mapRunStatus(run.status),
      providerJobId: run.id,
      progress: null,
      error: run.statusMessage ?? null,
    };
  }

  async getResults(jobId: string): Promise<ScrapeResults> {
    const cached = cachedSafeRuns.get(jobId);
    let items: unknown[];
    let usageTotalUsd: number | undefined;
    let computeUnits: number | undefined;
    let isTimedOut: boolean | undefined;
    let isWasted: boolean | undefined;

    if (cached) {
      items = cached.items;
      usageTotalUsd = cached.usageTotalUsd;
      computeUnits = cached.computeUnits;
      isTimedOut = cached.isTimedOut;
      isWasted = cached.isWasted;
    } else {
      const client = getApifyClient();
      try {
        const { items: datasetItems } = await client
          .run(jobId)
          .dataset()
          .listItems();
        items = datasetItems;
      } catch (error) {
        throw toProviderError(
          this.name,
          "getResults",
          error,
          classifyApifyProviderError(error) ?? "dataset_failed",
        );
      }

      try {
        const run = await client.run(jobId).get();
        usageTotalUsd = (run as unknown as { usageTotalUsd?: number })?.usageTotalUsd;
        computeUnits = run?.stats?.computeUnits;
      } catch {
        // Non-fatal if run details fail to load
      }
    }

    const scrapedAt = new Date().toISOString();
    const profiles: LeadProfile[] = [];
    const skipped: SkippedScrapeProfile[] = [];

    for (const item of items) {
      const normalized = normalizeInstagramProfileItem(item, scrapedAt);
      if (normalized) {
        profiles.push(normalized);
      } else {
        const username =
          typeof (item as { username?: unknown })?.username === "string"
            ? (item as { username: string }).username
            : "unknown";
        skipped.push({
          username,
          reason: "normalization_failed",
        });
      }
    }

    return { profiles, skipped, usageTotalUsd, computeUnits, isTimedOut, isWasted };
  }

  /**
   * ProfileProvider implementation: scrape one or more profiles in a single run.
   * Kept in terms of the existing startJob/getResults flow so behavior is
   * identical to the ScraperProvider path.
   */
  async getProfiles(
    usernames: string[],
  ): Promise<{ profiles: LeadProfile[]; skipped: SkippedScrapeProfile[] }> {
    if (usernames.length === 0) {
      return { profiles: [], skipped: [] };
    }
    const job = await this.startJob({ usernames });
    return this.getResults(job.jobId);
  }

  async getProfile(username: string): Promise<LeadProfile | null> {
    const normalized = username.replace(/^@/, "").trim().toLowerCase();
    const { profiles } = await this.getProfiles([username]);
    return (
      profiles.find(
        (profile) => profile.username?.replace(/^@/, "").trim().toLowerCase() === normalized,
      ) ??
      profiles[0] ??
      null
    );
  }
}

function mapRunStatus(status: ActorRun["status"]): ScrapeJobState {
  switch (status) {
    case "READY":
      return "pending";
    case "RUNNING":
    case "ABORTING":
      return "running";
    case "SUCCEEDED":
      return "succeeded";
    default:
      return "failed";
  }
}
