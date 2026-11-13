import type { LeadLatestPost, LeadProfile } from "@/lib/types";
import type { PerQuerySearchStat } from "./instagram-all-in-one-query";
import type { MappedPlaceSignal } from "./instagram-all-in-one-mapper";

export type DiscoveredProfile = {
  username?: string | null;
  instagramUsername?: string | null;
  profileUrl?: string | null;
  fullName?: string | null;
  biography?: string | null;
  category?: string | null;
  businessCategoryName?: string | null;
  location?: string | null;
  followers?: number | null;
  followersCount?: number | null;
  followsCount?: number | null;
  postsCount?: number | null;
  lastPostAt?: string | null;
  recentLikesAvg?: number | null;
  recentCommentsAvg?: number | null;
  engagementRate?: number | null;
  isBusinessAccount?: boolean | null;
  verified?: boolean | null;
  isPrivate?: boolean | null;
  locationVerification?: "verified" | "unverified" | "wrong_location" | string | null;
  externalUrl?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  handleSource?: "maps" | "homepage" | "contact_page" | "linkhub" | string | null;
  handleConfidence?: "high" | "medium" | "low" | string | null;
  availableChannels?: string[] | null;
  businessAddress?: { city_name?: string; street_address?: string; zip_code?: string } | null;
  latestPosts?: Array<{ caption?: string | null; locationName?: string | null }> | LeadLatestPost[] | null;
  gmapsCategory?: string | null;
  gmapsCategories?: string[] | null;
  gmapsCity?: string | null;
  gmapsAddress?: string | null;
  gmapsCountry?: string | null;
  gmapsRating?: number | null;
  gmapsReviews?: number | null;
  gmapsPlaceId?: string | null;
  socialLinks?: {
    facebook?: string | null;
    tiktok?: string | null;
    linkedin?: string | null;
    youtube?: string | null;
    whatsapp?: string | null;
  } | null;
  city?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  sourceProvider?: "google_maps" | "instagram_search" | "instagram_places" | "instagram_scraper" | string;
  isClaimed?: boolean | null;
  permanentlyClosed?: boolean | null;
  temporarilyClosed?: boolean | null;
  isChain?: boolean | null;
  isGroup?: boolean | null;
  groupKey?: string | null;
  flags?: string[] | null;
  nameWebsiteMismatch?: boolean | null;
  locationConfidence?: "high" | "medium" | "low" | string | null;
  fieldSources?: Record<string, string> | null;
  gmapsUrl?: string | null;
  url?: string | null;
};

export type DiscoveredCandidate = DiscoveredProfile;

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
  scrapeJobId?: string | null;
  userId?: string | null;
  isDryRun?: boolean;
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
  notice?: string | null;
  gmapsPlacesFound?: number;
  gmapsWithWebsite?: number;
  gmapsWithInstagram?: number;
  noInstagramCount?: number;
  leadsWithIg?: number;
  leadsNoIgButContactable?: number;
  placesDroppedNoContact?: number;
  placesReturned?: number;
  placesWithInstagram?: number;
  itemsReturnedRaw?: number;
  itemsParsedAsPlaces?: number;
  withInstagramUsername?: number;
  candidatesKept?: number;
  outOfAreaCount?: number;
  duplicatesSkipped?: number;
  placesByCity?: Record<string, number>;
  perQueryStats?: PerQuerySearchStat[];
  placeSignals?: MappedPlaceSignal[];
  searchResultsConsumed?: number;
  detailsResultsConsumed?: number;
  estimatedCostUsd?: number;
  locationRejectedCount?: number;
  actualCostUsd?: number;
  chargedEvents?: Array<{ runId: string; chargedUsd: number; events: unknown }>;
  coverageSkipped?: number;
  outcomeCacheSkipped?: number;
  placeOverlapRatio?: number;
  areaYield?: Record<string, number>;
  keywordYield?: Record<string, number>;
  newPlaces?: number;
  sourceProvider?: "google_maps" | "instagram_search" | "instagram_places" | "instagram_scraper" | "hybrid";
  error?: string;
  errorsCount?: number;
  isTimedOut?: boolean;
  isWasted?: boolean;
};

export interface DiscoveryProvider {
  readonly name: string;

  discover(input: DiscoveryInput): Promise<DiscoveryResult>;
}
