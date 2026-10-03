import type { LeadProfile } from "@/lib/types";

export type DiscoveredProfile = {
  username: string;
  profileUrl: string;
};

export type DiscoveryInput = {
  /** Keyword(s) sent to the discovery provider (already sanitized). */
  query: string;
  /** Explicit per-keyword queries if prepared in advance. */
  queries?: string[];
  /** Number of candidate results to request from the discovery provider. */
  limit: number;
  location?: string | null;
  category?: string | null;
  cursor?: string | null;
  page?: number | null;
  campaignId?: string | null;
  userId?: string | null;
};

export type KeywordSearchStat = {
  query: string;
  candidatesCount: number;
  rawCount: number;
};

export type DiscoveryResult = {
  candidates: DiscoveredProfile[];
  profiles?: LeadProfile[];
  runId: string;
  datasetId: string | null;
  actor: string;
  usageTotalUsd?: number;
  computeUnits?: number;
  nextCursor?: string | null;
  hasMore?: boolean;
  keywordStats?: KeywordSearchStat[];
  executedQueries?: string[];
  skippedQueries?: string[];
  nextKeywordIndex?: number;
  requestsUsed?: number;
  stopReason?: string;
};

export interface DiscoveryProvider {
  readonly name: string;

  discover(input: DiscoveryInput): Promise<DiscoveryResult>;
}
