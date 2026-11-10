/**
 * Pipeline types for modular discovery stages.
 */

import type {
  DiscoveryProvider,
  DiscoveryResult,
  DiscoveryInput,
  DiscoveredCandidate,
} from "../discovery-provider";
import type {
  MapsRelevanceCandidate,
  AiRelevanceOptions,
} from "../ai-relevance";
import type { RelevanceCampaignContext } from "../lead-relevance";
export type { DiscoveredCandidate } from "../discovery-provider";
export type { DiscoverySkipCounts } from "../lead-relevance";
export type { LeadProfile } from "@/lib/types";
import type { LeadProfile } from "@/lib/types";
import type { EnrichmentCriteria } from "../enrichment-criteria";

export interface RejectionDetail {
  id: string;
  reason: string;
  detail?: string;
  gate?: string;
  matchedTerm?: string;
}

export interface StageResult<T> {
  survivors: T[];
  rejected: RejectionDetail[];
  spendUsd: number;
  counters: Record<string, number>;
  durationMs: number;
}

export interface PipelineStageContext {
  campaign: {
    id: string;
    userId: string;
    intent?: string | null;
    location?: string | null;
    category?: string | null;
    minRating?: number | null;
    minReviews?: number | null;
    excludeChains?: boolean | null;
    companyProfile?: {
      description?: string | null;
      targetIndustries?: string[] | null;
    } | null;
  };
  jobId: string;
  userId?: string;
  requestedLimit: number;
  existingLeadCount: number;
  remainingCapacity: number;
  criteria: EnrichmentCriteria;
  caches: {
    seenCandidates: Set<string>;
    existingUsernames: Set<string>;
    existingPlaceIds: Set<string>;
    existingDomains: Set<string>;
    existingPhones: Set<string>;
  };
}

export interface StageFunnelReport {
  jobId: string;
  plannedQueries: number;
  placesFound: number;
  afterFreeRules: number;
  afterChains: number;
  afterMapsGate: number;
  handlesDiscovered: number;
  multiChannelFound: number;
  profilesEnriched: number;
  afterCriteria: number;
  afterFinalGate: number;
  persisted: number;
  totalSpendUsd: number;
  rejectionsByStage: Record<string, Record<string, number>>;
  durationMs: number;
  [key: string]: unknown;
}

export interface PlannedSearch {
  searchTerm: string;
  searchQueries: string[];
  effectiveQueries: string[];
  currentKeywordIndex: number;
  countryCode: string;
  maxRounds: number;
  roundCandidateTarget: number;
}

export type StageDiscoveryResult = Partial<DiscoveryResult> & {
  candidates: DiscoveredCandidate[];
};

export type MapsGeminiResult = {
  relevant: boolean;
  reason?: string;
  score?: number;
  accountType?: string;
  analytics?: Record<string, unknown> | null;
};

export type FinalGeminiResult = {
  relevant: boolean;
  reason?: string;
  score?: number;
  accountType?: string;
  analytics?: Record<string, unknown> | null;
};

export interface DiscoveryDependencies {
  discoveryProvider?: DiscoveryProvider | {
    discover: (params: DiscoveryInput) => Promise<StageDiscoveryResult>;
  };
  profileProvider?: {
    getProfiles?: (usernames: string[]) => Promise<LeadProfile[]>;
  };
  evalMapsGemini?: (
    candidate: MapsRelevanceCandidate,
    campaign: RelevanceCampaignContext,
    options?: AiRelevanceOptions,
  ) => Promise<MapsGeminiResult>;
  evalFinalGemini?: (
    profile: LeadProfile,
    campaign: RelevanceCampaignContext,
    options?: AiRelevanceOptions,
  ) => Promise<FinalGeminiResult>;
  now?: () => number;
}
