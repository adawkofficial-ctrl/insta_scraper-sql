import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { NotFoundError } from "@/lib/errors";
import { normalizeInstagramHandle } from "./google-maps-discovery-provider";
import { scrapeInstagramProfiles } from "../scraper";
import { persistCampaignLeads } from "../campaign";
import {
  type EnrichmentCriteria,
  DEFAULT_ENRICHMENT_CRITERIA,
  evaluateEnrichmentCriteria,
} from "./enrichment-criteria";
import { evaluateProfileRelevanceWithAI } from "./ai-relevance";
import type { LeadProfile } from "@/lib/types";

export type ImportHandlesInput = {
  campaignId: string;
  userId: string;
  rawInput: string | string[];
  maxLeads?: number;
  criteria?: EnrichmentCriteria;
};

export type ImportHandlesResult = {
  success: boolean;
  totalInput: number;
  normalizedCount: number;
  duplicatesSkipped: number;
  cachedCount: number;
  enrichedCount: number;
  criteriaRejected: number;
  aiRejected: number;
  persisted: number;
  leads: LeadProfile[];
  notice: string;
};

export const MAX_IMPORT_ROWS = 200;
const CACHE_TTL_DAYS = 30;

/**
 * Parses and extracts normalized Instagram handles from CSV or textarea input.
 * Handles:
 * - Comma-separated CSV rows
 * - Plain usernames ("@handle", "handle")
 * - Full Instagram profile URLs ("https://www.instagram.com/handle/")
 * - Rejects non-profile URLs and invalid usernames.
 */
export function parseImportHandles(rawInput: string | string[]): string[] {
  let rawLines: string[] = [];
  if (Array.isArray(rawInput)) {
    rawLines = rawInput.map((l) => (typeof l === "string" ? l.trim() : "")).filter(Boolean);
  } else if (typeof rawInput === "string") {
    rawLines = rawInput
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  const limitedLines = rawLines.slice(0, MAX_IMPORT_ROWS);
  const normalizedSet = new Set<string>();

  if (limitedLines.length === 0) return [];

  // Detect if line 0 is a CSV header
  let startIndex = 0;
  let targetColIndex = -1;
  const firstLine = limitedLines[0].trim();
  if (firstLine.includes(",")) {
    const headers = firstLine.split(",").map((h) => h.trim().toLowerCase());
    const headerMatch = headers.findIndex(
      (h) =>
        h.includes("username") ||
        h.includes("handle") ||
        h.includes("instagram") ||
        h.includes("profile"),
    );
    if (headerMatch !== -1) {
      targetColIndex = headerMatch;
      startIndex = 1;
    }
  }

  for (let i = startIndex; i < limitedLines.length; i++) {
    const line = limitedLines[i].trim();
    if (!line) continue;

    if (line.includes(",")) {
      const parts = line.split(",").map((p) => p.trim());
      if (targetColIndex >= 0 && targetColIndex < parts.length) {
        const handle = normalizeInstagramHandle(parts[targetColIndex]);
        if (handle) {
          normalizedSet.add(handle.toLowerCase());
        }
      } else {
        // Find column with instagram url or @
        let found = false;
        for (const part of parts) {
          if (part.includes("instagram.com") || part.startsWith("@")) {
            const handle = normalizeInstagramHandle(part);
            if (handle) {
              normalizedSet.add(handle.toLowerCase());
              found = true;
              break;
            }
          }
        }
        if (!found && parts.length > 0) {
          const handle = normalizeInstagramHandle(parts[0]);
          if (handle) {
            normalizedSet.add(handle.toLowerCase());
          }
        }
      }
    } else {
      const handle = normalizeInstagramHandle(line);
      if (handle) {
        normalizedSet.add(handle.toLowerCase());
      }
    }
  }

  return Array.from(normalizedSet);
}

/**
 * Phase 8: Import Instagram handles / URLs into a campaign.
 * Normalizes handles, deduplicates against campaign and user leads,
 * checks 30-day cache, enriches survivors via runActorSafely,
 * evaluates enrichment criteria, and verifies via AI relevance gate.
 */
export async function importHandlesToCampaign(
  input: ImportHandlesInput,
): Promise<ImportHandlesResult> {
  const prisma = getPrismaClient();

  // 1. Verify campaign ownership
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: input.campaignId,
      ...(input.userId ? { userId: input.userId } : {}),
    },
    include: { companyProfile: true },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${input.campaignId}" was not found.`,
    );
  }

  // 2. Normalize and dedup input handles
  const allHandles = parseImportHandles(input.rawInput);
  if (allHandles.length === 0) {
    return {
      success: true,
      totalInput: 0,
      normalizedCount: 0,
      duplicatesSkipped: 0,
      cachedCount: 0,
      enrichedCount: 0,
      criteriaRejected: 0,
      aiRejected: 0,
      persisted: 0,
      leads: [],
      notice: "No valid Instagram handles found in input.",
    };
  }

  // 3. Deduplicate against existing campaign & user leads
  const existingLeads = await prisma.lead.findMany({
    where: {
      OR: [
        { campaignId: campaign.id },
        { userId: campaign.userId },
        { campaign: { userId: campaign.userId } },
      ],
      usernameNormalized: { in: allHandles },
    },
    select: { usernameNormalized: true },
  });

  const existingSet = new Set(
    existingLeads
      .map((l) => l.usernameNormalized?.toLowerCase())
      .filter((u): u is string => Boolean(u)),
  );
  const survivingHandles = allHandles.filter((h) => !existingSet.has(h));
  const duplicatesSkipped = allHandles.length - survivingHandles.length;

  if (survivingHandles.length === 0) {
    const notice = `All ${allHandles.length} handles are already in your campaign or account.`;
    return {
      success: true,
      totalInput: allHandles.length,
      normalizedCount: allHandles.length,
      duplicatesSkipped,
      cachedCount: 0,
      enrichedCount: 0,
      criteriaRejected: 0,
      aiRejected: 0,
      persisted: 0,
      leads: [],
      notice,
    };
  }

  // 4. Check 30-day cache on Lead.rawProfileData
  const thirtyDaysAgo = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const cachedDbLeads = await prisma.lead.findMany({
    where: {
      usernameNormalized: { in: survivingHandles },
      rawProfileData: { not: Prisma.DbNull },
      updatedAt: { gte: thirtyDaysAgo },
    },
    select: { usernameNormalized: true, rawProfileData: true },
  });

  const cachedMap = new Map<string, LeadProfile>();
  for (const row of cachedDbLeads) {
    if (
      row.usernameNormalized &&
      row.rawProfileData &&
      typeof row.rawProfileData === "object"
    ) {
      cachedMap.set(
        row.usernameNormalized.toLowerCase(),
        row.rawProfileData as unknown as LeadProfile,
      );
    }
  }

  const uncachedHandles = survivingHandles.filter((h) => !cachedMap.has(h));
  const currentLeadCount = await prisma.lead.count({
    where: { campaignId: campaign.id },
  });
  const maxLimit = input.maxLeads ?? campaign.leadLimit ?? 50;
  const remainingCapacity = Math.max(0, maxLimit - currentLeadCount);
  const batchCap = Math.min(Math.max(1, remainingCapacity * 2), 20);
  const handlesToEnrich = uncachedHandles.slice(0, batchCap);

  // 5. Enrich uncached handles via Apify Profile Scraper
  let freshlyEnrichedProfiles: LeadProfile[] = [];
  if (handlesToEnrich.length > 0) {
    const { profiles } = await scrapeInstagramProfiles(
      handlesToEnrich,
      handlesToEnrich.length,
    );
    freshlyEnrichedProfiles = profiles;
  }

  // Combine cached + enriched profiles
  const allProfilesToGate: LeadProfile[] = [];
  for (const h of survivingHandles) {
    if (cachedMap.has(h)) {
      allProfilesToGate.push(cachedMap.get(h)!);
    } else {
      const found = freshlyEnrichedProfiles.find(
        (p) => p.username?.toLowerCase() === h,
      );
      if (found) allProfilesToGate.push(found);
    }
  }

  // 6. Enrichment Criteria Gate
  const effectiveCriteria = input.criteria ?? DEFAULT_ENRICHMENT_CRITERIA;
  const criteriaPassed: LeadProfile[] = [];
  let criteriaRejectedCount = 0;

  for (const profile of allProfilesToGate) {
    const critResult = evaluateEnrichmentCriteria(profile, effectiveCriteria);
    if (critResult.passed) {
      criteriaPassed.push(profile);
    } else {
      criteriaRejectedCount++;
    }
  }

  // 7. AI Analytics Gate
  const qualifiedProfiles: LeadProfile[] = [];
  let aiRejectedCount = 0;

  for (const profile of criteriaPassed) {
    try {
      const aiResult = await evaluateProfileRelevanceWithAI(
        profile,
        {
          intent: campaign.intent ?? "",
          category: campaign.category ?? "",
          location: campaign.location ?? "",
        },
        campaign.companyProfile ?? null,
      );

      if (aiResult.relevant && aiResult.score >= 70) {
        qualifiedProfiles.push({
          ...profile,
          leadScore: aiResult.score,
          aiScore: aiResult.score,
          aiAnalysis: aiResult.analytics as unknown as Record<string, unknown>,
        });
      } else {
        aiRejectedCount++;
      }
    } catch {
      aiRejectedCount++;
    }
  }

  // 8. Persist Qualified Leads
  const persistResult = await persistCampaignLeads(
    campaign.id,
    qualifiedProfiles,
    maxLimit,
    { source: "import", userId: campaign.userId },
  );

  const notice = `Import Funnel: Handles ${allHandles.length} -> Dedup ${survivingHandles.length} -> Enriched ${handlesToEnrich.length} (Cached: ${cachedMap.size}) -> Criteria Passed ${criteriaPassed.length} -> AI Accepted ${qualifiedProfiles.length} -> Saved ${persistResult.persisted}`;

  return {
    success: true,
    totalInput: allHandles.length,
    normalizedCount: allHandles.length,
    duplicatesSkipped,
    cachedCount: cachedMap.size,
    enrichedCount: handlesToEnrich.length,
    criteriaRejected: criteriaRejectedCount,
    aiRejected: aiRejectedCount,
    persisted: persistResult.persisted,
    leads: qualifiedProfiles.slice(0, persistResult.persisted),
    notice,
  };
}
