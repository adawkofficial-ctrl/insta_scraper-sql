import "server-only";

import { AppError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import { CampaignStatus } from "@/generated/prisma/client";
import { getSpariorConfig } from "@/lib/env";
import type {
  DiscoveredProfile,
  DiscoveryInput,
  DiscoveryProvider,
  DiscoveryResult,
} from "@/lib/services/discovery/discovery-provider";
import type { LeadProfile } from "@/lib/types";
import { buildPerKeywordSearchQueries } from "@/lib/services/discovery/discovery-query";
import { checkSpariorBudget } from "./sparior-budget";
import { SpariorClient } from "./sparior-client";
import { mapSpariorSearchItem } from "./sparior-mappers";
import type { SpariorRawSearchItem, SpariorSearchResponse } from "./sparior-types";

export type SpariorDiscoveryFunnel = {
  requestsUsed: number;
  profilesReturned: number;
  malformedSkipped: number;
  privateSkipped: number;
  stopReason: "completed" | "max_requests" | "max_profiles" | "quota" | "error" | "cancelled";
};

export class SpariorDiscoveryProvider implements DiscoveryProvider {
  readonly name = "sparior";
  private readonly client: SpariorClient;

  constructor(client?: SpariorClient) {
    this.client = client ?? new SpariorClient();
  }

  async discover(input: DiscoveryInput): Promise<DiscoveryResult> {
    const config = getSpariorConfig(false);

    // Budget guard check
    await checkSpariorBudget({
      userId: input.userId,
    });

    const maxRequests = config.maxRequestsPerRun;
    const maxPages = config.maxPagesPerRun;
    const targetLimit = input.limit || 50;
    const maxProfiles = Math.min(targetLimit, config.maxProfilesPerRun);

    const candidates: DiscoveredProfile[] = [];
    const profiles: LeadProfile[] = [];
    const seenUsernames = new Set<string>();

    let requestsUsed = 0;
    let profilesReturnedTotal = 0;
    let malformedSkipped = 0;
    let privateSkipped = 0;
    let stopReason: SpariorDiscoveryFunnel["stopReason"] = "completed";

    const prisma = getPrismaClient();

    // Determine per-keyword queries
    const queries =
      input.queries && input.queries.length > 0
        ? input.queries
        : buildPerKeywordSearchQueries({
            query: input.query,
            category: input.category,
            location: input.location,
          });

    const effectiveQueries = queries.length > 0 ? queries : [input.query];

    // Determine keyword rotation starting index based on previous ScrapeJob
    let startIndex = 0;
    if (input.campaignId && effectiveQueries.length > 1) {
      try {
        const lastJob = await prisma.scrapeJob.findFirst({
          where: { campaignId: input.campaignId, provider: "sparior" },
          orderBy: { createdAt: "desc" },
          select: { usage: true },
        });
        const lastUsage = lastJob?.usage as Record<string, unknown> | null;
        if (typeof lastUsage?.nextKeywordIndex === "number") {
          startIndex = lastUsage.nextKeywordIndex % effectiveQueries.length;
        }
      } catch {
        // Soft fallback to startIndex = 0
      }
    }

    const orderedQueries = [
      ...effectiveQueries.slice(startIndex),
      ...effectiveQueries.slice(0, startIndex),
    ];

    const keywordStats: Array<{
      query: string;
      candidatesCount: number;
      rawCount: number;
    }> = [];

    const executedQueries: string[] = [];
    const skippedQueries: string[] = [];

    for (let qIdx = 0; qIdx < orderedQueries.length; qIdx++) {
      const currentQuery = orderedQueries[qIdx];

      // Check per-run request budget cap before starting search for this keyword
      if (requestsUsed >= maxRequests) {
        stopReason = "max_requests";
        skippedQueries.push(...orderedQueries.slice(qIdx));
        console.log(
          `[DISCOVERY] Budget reached (${requestsUsed}/${maxRequests} requests). Skipped queries for this run: ${skippedQueries.join(", ")}`,
        );
        break;
      }

      if (candidates.length >= maxProfiles) {
        stopReason = "max_profiles";
        skippedQueries.push(...orderedQueries.slice(qIdx));
        break;
      }

      // Check cancellation between keywords if campaignId provided
      if (input.campaignId) {
        const campaign = await prisma.campaign.findUnique({
          where: { id: input.campaignId },
          select: { status: true },
        });
        if (
          campaign &&
          (campaign.status === CampaignStatus.PAUSED ||
            campaign.status === CampaignStatus.CANCELLED)
        ) {
          stopReason = "cancelled";
          break;
        }
      }

      executedQueries.push(currentQuery);
      let keywordCandidatesCount = 0;
      let keywordRawCount = 0;

      let cursor: string | null = input.cursor ?? null;
      let page = input.page ?? 1;

      while (
        requestsUsed < maxRequests &&
        page <= maxPages &&
        candidates.length < maxProfiles
      ) {
        let searchResult;
        try {
          searchResult = await this.client.search(currentQuery, {
            cursor,
            page,
            limit: maxProfiles - candidates.length,
            campaignId: input.campaignId,
            userId: input.userId,
            pageIndex: page,
          });
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === "PROVIDER_QUOTA_EXHAUSTED") {
            stopReason = "quota";
            if (candidates.length > 0) {
              break;
            }
            throw err;
          }

          if (err instanceof AppError && err.code === "PROVIDER_AUTH_FAILED") {
            throw err;
          }

          if (candidates.length > 0) {
            stopReason = "error";
            break;
          }
          throw err;
        }

        requestsUsed++;

        const resp = searchResult.data as SpariorSearchResponse;
        let rawItems: SpariorRawSearchItem[] = [];

        if (Array.isArray(resp)) {
          rawItems = resp;
        } else if (Array.isArray(resp?.body)) {
          rawItems = resp.body;
        } else if (resp?.data) {
          if (Array.isArray(resp.data)) {
            rawItems = resp.data;
          } else if (typeof resp.data === "object") {
            const d = resp.data;
            if (Array.isArray(d.items)) rawItems = d.items;
            else if (Array.isArray(d.users)) rawItems = d.users;
            else if (Array.isArray(d.results)) rawItems = d.results;
          }
        }

        profilesReturnedTotal += rawItems.length;
        keywordRawCount += rawItems.length;

        for (const rawItem of rawItems) {
          const mapped = mapSpariorSearchItem(rawItem);
          if (mapped.isMalformed) {
            malformedSkipped++;
            continue;
          }
          if (mapped.isPrivate) {
            privateSkipped++;
            continue;
          }

          if (mapped.candidate && !seenUsernames.has(mapped.candidate.username)) {
            seenUsernames.add(mapped.candidate.username);
            candidates.push(mapped.candidate);
            keywordCandidatesCount++;
            if (mapped.profile) {
              profiles.push(mapped.profile);
            }
          }

          if (candidates.length >= maxProfiles) {
            stopReason = "max_profiles";
            break;
          }
        }

        // Check next page / cursor
        let nextCursor: string | null = null;
        let hasMore = false;

        if (resp && typeof resp === "object") {
          if (
            !Array.isArray(resp) &&
            resp.data &&
            typeof resp.data === "object" &&
            !Array.isArray(resp.data)
          ) {
            nextCursor = resp.data.next_cursor ?? resp.data.cursor ?? null;
            hasMore =
              resp.data.has_more ??
              resp.data.more_available ??
              (nextCursor !== null && nextCursor !== "");
          } else {
            nextCursor = resp.next_cursor ?? resp.cursor ?? null;
            hasMore = resp.has_more ?? (nextCursor !== null && nextCursor !== "");
          }
        }

        cursor = nextCursor;

        if (!hasMore || !cursor || rawItems.length === 0) {
          break;
        }

        if (requestsUsed >= maxRequests) {
          stopReason = "max_requests";
          break;
        }

        page++;

        // Sequential delay between page requests
        if (config.requestDelayMs > 0) {
          await new Promise((r) => setTimeout(r, config.requestDelayMs));
        }
      }

      keywordStats.push({
        query: currentQuery,
        candidatesCount: keywordCandidatesCount,
        rawCount: keywordRawCount,
      });

      console.log(
        `[DISCOVERY] actor=sparior-search search="${currentQuery}" candidates=${keywordCandidatesCount} raw=${keywordRawCount}`,
      );

      if (
        stopReason !== "completed" ||
        candidates.length >= maxProfiles
      ) {
        break;
      }

      // Sequential delay between keyword searches
      if (config.requestDelayMs > 0 && qIdx < orderedQueries.length - 1) {
        await new Promise((r) => setTimeout(r, config.requestDelayMs));
      }
    }

    const nextKeywordIndex =
      effectiveQueries.length > 0
        ? (startIndex + executedQueries.length) % effectiveQueries.length
        : 0;

    const runId = `sparior_search_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    void profilesReturnedTotal;
    void malformedSkipped;
    void privateSkipped;

    return {
      candidates,
      profiles: profiles.length > 0 ? profiles : undefined,
      runId,
      datasetId: null,
      actor: "sparior-search",
      nextCursor: null,
      hasMore: false,
      keywordStats,
      executedQueries,
      skippedQueries,
      nextKeywordIndex,
      requestsUsed,
      stopReason,
    };
  }
}
