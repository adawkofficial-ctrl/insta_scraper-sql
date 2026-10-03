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
import { getServerEnv } from "@/lib/env";
import { getApifyClient } from "./apify-client";
import {
  INSTAGRAM_PROFILE_ACTOR_ID,
  extractActorError,
  normalizeInstagramProfileItem,
} from "./instagram-profile";
import type { ScrapeResults, ScraperProvider } from "./scraper-provider";
import type { ProfileProvider } from "./profile-provider";
import { classifyApifyProviderError } from "./apify-error-classifier";

const RUN_WAIT_SECS = 180;
const RUN_TIMEOUT_SECS = 300;

function log(message: string): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  console.log(message);
}

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

    const client = getApifyClient();
    // Actor id is configurable for production without code changes.
    const actorId =
      getServerEnv("APIFY_PROFILE_ACTOR_ID") ?? INSTAGRAM_PROFILE_ACTOR_ID;

    const requestedLimit =
      input.limit === undefined
        ? usernames.length
        : Math.min(input.limit, usernames.length);

    log(
      `[SCRAPE] actor=${actorId} profiles=${usernames.join(", ")} maxItems=${requestedLimit}`,
    );

    let run: ActorRun;
    try {
      run = await client.actor(actorId).call(
        { usernames },
        {
          waitSecs: RUN_WAIT_SECS,
          timeout: RUN_TIMEOUT_SECS,
          maxItems: requestedLimit,
          log: null,
        },
      );
    } catch (error) {
      throw toProviderError(
        this.name,
        "startJob",
        error,
        classifyApifyProviderError(error) ?? "actor_start_failed",
      );
    }

    log(
      `[SCRAPE] run started id=${run.id} status=${run.status} dataset=${run.defaultDatasetId ?? "none"}`,
    );

    if (run.status === "READY" || run.status === "RUNNING") {
      try {
        await client.run(run.id).abort();
      } catch {
        // The run may have finished between polling and the abort attempt.
      }

      throw new ProviderError(
        this.name,
        "startJob",
        `Apify run ${run.id} did not finish within ${RUN_WAIT_SECS}s (status ${run.status}).`,
        { code: "run_timeout" },
      );
    }

    if (run.status !== "SUCCEEDED") {
      throw new ProviderError(
        this.name,
        "startJob",
        `Apify run ${run.id} finished with status ${run.status}${
          run.statusMessage === undefined ? "" : `: ${run.statusMessage}`
        }.`,
        { code: "actor_failed" },
      );
    }

    log("[SCRAPE] run completed");

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
    const client = getApifyClient();

    let items: unknown[];
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

    log(`[SCRAPE] dataset fetched runId=${jobId} items=${items.length}`);

    const scrapedAt = new Date().toISOString();
    const profiles: LeadProfile[] = [];
    const skipped: SkippedScrapeProfile[] = [];
    let malformed = 0;

    for (const item of items) {
      // The Actor reports unfetchable profiles as error items; do not persist them.
      const actorError = extractActorError(item);
      if (actorError !== null) {
        skipped.push(actorError);
        continue;
      }

      const profile = normalizeInstagramProfileItem(item, scrapedAt);
      if (profile === null) {
        malformed += 1;
        continue;
      }

      profiles.push(profile);
    }

    if (skipped.length > 0) {
      log(
        `[SCRAPE] skipped actor error items=${skipped.length} reasons=${skipped
          .map((entry) => `${entry.username}=${entry.reason}`)
          .join(", ")}`,
      );
    }
    if (malformed > 0) {
      log(`[SCRAPE] skipped malformed profile items=${malformed}`);
    }
    let usageTotalUsd: number | undefined;
    let computeUnits: number | undefined;
    try {
      const run = await client.run(jobId).get();
      usageTotalUsd = (run as unknown as { usageTotalUsd?: number })?.usageTotalUsd;
      computeUnits = run?.stats?.computeUnits;
    } catch {
      // Non-fatal if run details fail to load
    }

    return { profiles, skipped, usageTotalUsd, computeUnits };
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
        (profile) => profile.username.replace(/^@/, "").trim().toLowerCase() === normalized,
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
