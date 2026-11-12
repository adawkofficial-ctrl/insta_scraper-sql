import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";

export type JobSpendBreakdown = {
  mapsCostUsd: number;
  enrichmentCostUsd: number;
  geminiCostUsd: number;
  otherCostUsd?: number;
};

export type AllocatedLeadCost = {
  acquisitionCostUsd: number;
  breakdown: {
    mapsCostUsd: number;
    enrichmentCostUsd: number;
    geminiCostUsd: number;
    totalJobCostUsd: number;
    placesProcessed: number;
    survivingLeadsCount: number;
    wasteCostUsd: number;
    wasteRatePercent: number;
  };
};

/**
 * Calculates honest cost per saved lead by rolling all stage spend (including rejected places)
 * into surviving leads with zero leakage.
 *
 * Example:
 *   maps = $0.20 for 30 places
 *   enrichment = $0.10 for 10 handles
 *   gemini = $0.05 for 10 candidates
 *   total = $0.35
 *   survivingLeads = 5
 *   acquisitionCostUsd = $0.35 / 5 = $0.07 per lead.
 *   Sum of 5 leads * $0.07 = $0.35 (zero leakage).
 */
export function calculateLeadCostAllocation(input: {
  spend: JobSpendBreakdown;
  placesProcessed: number;
  survivingLeadsCount: number;
}): AllocatedLeadCost | null {
  const { spend, placesProcessed, survivingLeadsCount } = input;

  const mapsCost = Math.max(0, spend.mapsCostUsd || 0);
  const enrichmentCost = Math.max(0, spend.enrichmentCostUsd || 0);
  const geminiCost = Math.max(0, spend.geminiCostUsd || 0);
  const otherCost = Math.max(0, spend.otherCostUsd || 0);

  const totalJobCostUsd = Number(
    (mapsCost + enrichmentCost + geminiCost + otherCost).toFixed(6),
  );

  if (survivingLeadsCount <= 0) {
    return null;
  }

  // Cost per surviving lead (honest: includes the cost of rejected places)
  const acquisitionCostUsd = Number(
    (totalJobCostUsd / survivingLeadsCount).toFixed(4),
  );

  const mapsPerLead = Number((mapsCost / survivingLeadsCount).toFixed(4));
  const enrichmentPerLead = Number(
    (enrichmentCost / survivingLeadsCount).toFixed(4),
  );
  const geminiPerLead = Number((geminiCost / survivingLeadsCount).toFixed(4));

  const safePlaces = Math.max(1, placesProcessed, survivingLeadsCount);
  const wasteCount = Math.max(0, safePlaces - survivingLeadsCount);
  const wasteRatePercent = Number(
    ((wasteCount / safePlaces) * 100).toFixed(1),
  );
  const wasteCostUsd = Number(
    (totalJobCostUsd * (wasteCount / safePlaces)).toFixed(4),
  );

  return {
    acquisitionCostUsd,
    breakdown: {
      mapsCostUsd: mapsPerLead,
      enrichmentCostUsd: enrichmentPerLead,
      geminiCostUsd: geminiPerLead,
      totalJobCostUsd,
      placesProcessed: safePlaces,
      survivingLeadsCount,
      wasteCostUsd,
      wasteRatePercent,
    },
  };
}

export type RecordJobAttributionInput = {
  scrapeJobId: string;
  campaignId?: string;
  keyword?: string | null;
  city?: string | null;
  spend: JobSpendBreakdown;
  placesProcessed: number;
  survivingLeadIds: string[];
};

/**
 * Persists spend and breakdown to ScrapeJob, and allocates honest acquisitionCostUsd
 * to all surviving leads in the database.
 */
export async function recordJobAttribution(
  input: RecordJobAttributionInput,
): Promise<{
  totalJobCostUsd: number;
  acquisitionCostPerLead: number;
  allocatedLeadsCount: number;
}> {
  const prisma = getPrismaClient();
  const allocation = calculateLeadCostAllocation({
    spend: input.spend,
    placesProcessed: input.placesProcessed,
    survivingLeadsCount: input.survivingLeadIds.length,
  });

  const totalJobCostUsd = allocation?.breakdown.totalJobCostUsd ?? 0;
  const acquisitionCostPerLead = allocation?.acquisitionCostUsd ?? 0;

  // 1. Update ScrapeJob with total cost and breakdown
  await prisma.scrapeJob.update({
    where: { id: input.scrapeJobId },
    data: {
      costUsd: new Prisma.Decimal(totalJobCostUsd),
      costBreakdown: allocation?.breakdown ?? Prisma.DbNull,
    },
  });

  // 2. Allocate acquisition cost and attribution metadata to surviving leads
  if (input.survivingLeadIds.length > 0 && allocation) {
    await prisma.lead.updateMany({
      where: { id: { in: input.survivingLeadIds } },
      data: {
        scrapeJobId: input.scrapeJobId,
        discoveryKeyword: input.keyword ?? undefined,
        discoveryCity: input.city ?? undefined,
        acquisitionCostUsd: new Prisma.Decimal(acquisitionCostPerLead),
        acquisitionCostBreakdown: allocation.breakdown as unknown as Prisma.InputJsonValue,
      },
    });

    logger.info("[ATTRIBUTION] Allocated job spend to surviving leads", {
      scrapeJobId: input.scrapeJobId,
      totalJobCostUsd,
      acquisitionCostPerLead,
      survivingLeadsCount: input.survivingLeadIds.length,
    });
  }

  return {
    totalJobCostUsd,
    acquisitionCostPerLead,
    allocatedLeadsCount: input.survivingLeadIds.length,
  };
}
