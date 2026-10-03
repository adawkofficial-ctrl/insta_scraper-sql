import { ApiClientError, apiFetch } from "./client";
import type { ScrapeJobItem } from "./campaigns";
export type { ScrapeJobItem };

export type ScrapeResultMeta = {
  campaignId: string;
  scrapeJobId: string;
  provider: string;
  status: string;
  inputCount: number;
  processedCount: number;
  notice: string | null;
};

export type ScrapeProfilesResponse = {
  success: boolean;
  data: unknown[];
  meta: ScrapeResultMeta;
};

export const DEFAULT_MAX_LEADS = 10;
export const MIN_MAX_LEADS = 1;
export const MAX_MAX_LEADS = 100;
// Mirrors the server-side batch cap in the scraper service.
export const MAX_PROFILE_BATCH = 100;

export async function scrapeProfiles(
  campaignId: string,
  profiles: string[],
  maxLeads: number = DEFAULT_MAX_LEADS,
): Promise<ScrapeProfilesResponse> {
  return apiFetch<ScrapeProfilesResponse>("/api/scraper/instagram/profile", {
    method: "POST",
    body: JSON.stringify({
      campaignId,
      profiles,
      maxLeads,
    }),
  });
}

// ---------------------------------------------------------------------------
// Campaign-intent discovery (streaming NDJSON progress)
// ---------------------------------------------------------------------------

export type DiscoveryStage =
  | "discover"
  | "discovered"
  | "enrich"
  | "persist"
  | "done";

export type DiscoverySkipReason =
  | "IRRELEVANT_CATEGORY"
  | "IRRELEVANT_INTENT"
  | "IRRELEVANT_LOCATION"
  | "IRRELEVANT_LOCATION_NATIONAL_SCALE"
  | "INSUFFICIENT_RELEVANCE_DATA"
  | "DUPLICATE"
  | "CAMPAIGN_CAPACITY_REACHED"
  | "CANDIDATE_BOUND_REACHED"
  | "ACTOR_ERROR"
  | "ENRICHMENT_FAILED";

export type DiscoverySkipCounts = Partial<Record<DiscoverySkipReason, number>>;

export type DiscoveryProgress = {
  stage: DiscoveryStage;
  message: string;
  candidatesDiscovered?: number;
  candidatesEnriched?: number;
  persisted?: number;
  skipped?: number;
  remainingCapacity?: number;
  existingLeads?: number;
  skipCounts?: DiscoverySkipCounts;
};

export type DiscoveryMeta = {
  campaignId: string;
  scrapeJobId: string;
  discoveryActor: string;
  enrichmentActor: string;
  requestedLimit: number;
  existingLeads?: number;
  candidatesDiscovered: number;
  candidatesEnriched: number;
  existingSkipped: number;
  skipped: number;
  persisted: number;
  remainingCapacity?: number;
  notice: string | null;
  skipCounts?: DiscoverySkipCounts;
};

export type DiscoverLeadsResponse = {
  success: true;
  data: unknown[];
  meta: DiscoveryMeta;
};

export type DiscoverLeadsInput = {
  query: string;
  location?: string | null;
  category?: string | null;
  maxLeads: number;
};

export async function discoverLeads(
  campaignId: string,
  input: DiscoverLeadsInput,
  onProgress?: (event: DiscoveryProgress) => void,
): Promise<DiscoverLeadsResponse> {
  const payload = {
    campaignId,
    query: input.query,
    location: input.location,
    category: input.category,
    maxLeads: input.maxLeads,
  };


  const response = await fetch("/api/scraper/instagram/discover", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let error: { code?: string; message?: string } | null = null;
    try {
      const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
      error = parsed.error ?? null;
    } catch {
      error = null;
    }
    throw new ApiClientError(
      response.status,
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? response.statusText ?? "Discovery request failed.",
    );
  }

  if (!response.body) {
    throw new ApiClientError(500, "DISCOVERY_FAILED", "Discovery response had no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: DiscoverLeadsResponse | null = null;

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    if (event.type === "progress") {
      onProgress?.(event as unknown as DiscoveryProgress);
    } else if (event.type === "result") {
      result = event as unknown as DiscoverLeadsResponse;
    } else if (event.type === "error") {
      const errorPayload = (event.error ?? {}) as { code?: string; message?: string };
      throw new ApiClientError(
        400,
        errorPayload.code ?? "DISCOVERY_FAILED",
        errorPayload.message ?? "Discovery failed.",
      );
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      processLine(line);
    }
  }

  if (buffer.trim().length > 0) {
    processLine(buffer);
  }

  if (result === null) {
    throw new ApiClientError(500, "DISCOVERY_FAILED", "Discovery finished without a result.");
  }

  return result;
}

export async function getCampaignScrapeJobs(
  campaignId: string,
): Promise<ScrapeJobItem[]> {
  return apiFetch<ScrapeJobItem[]>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/scrape-jobs`,
  );
}

export async function getScrapeJob(
  jobId: string,
): Promise<ScrapeJobItem & { campaign?: { id: string; name: string; status: string } }> {
  return apiFetch<
    ScrapeJobItem & { campaign?: { id: string; name: string; status: string } }
  >(`/api/scrape-jobs/${encodeURIComponent(jobId)}`);
}
