import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  getAreaCooldownDays,
  getPlaceOutcomeCacheDays,
  rankKeywordSuggestions,
  type CoverageRow,
  type PlaceOutcomeRow,
} from "./google-maps-cost-optimizer";

export type RecordCoverageInput = {
  userId: string;
  campaignId?: string | null;
  keyword: string;
  area: string;
  placeIds: string[];
  newPlaces: number;
  acceptedLeads: number;
};

export async function getCoverageRows(
  userId: string,
  lookbackDays = 180,
): Promise<CoverageRow[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await getPrismaClient().discoveryCoverage.findMany({
    where: { userId, runDate: { gte: since } },
    orderBy: { runDate: "desc" },
    take: 500,
    select: {
      keyword: true,
      area: true,
      runDate: true,
      placeIds: true,
      newPlaces: true,
      acceptedLeads: true,
    },
  });
  return rows.map((row) => ({
    keyword: row.keyword,
    area: row.area,
    runDate: row.runDate,
    placeIds: Array.isArray(row.placeIds)
      ? row.placeIds.filter((v): v is string => typeof v === "string")
      : [],
    newPlaces: row.newPlaces,
    acceptedLeads: row.acceptedLeads,
  }));
}

export async function isAreaInCooldown(
  userId: string,
  keyword: string,
  area: string,
): Promise<boolean> {
  const { isAreaCoolingDown } = await import("./google-maps-cost-optimizer");
  const rows = await getCoverageRows(userId, getAreaCooldownDays() + 1);
  return isAreaCoolingDown(rows, keyword, area, getAreaCooldownDays());
}

export async function recordCoverage(input: RecordCoverageInput): Promise<void> {
  await getPrismaClient().discoveryCoverage.create({
    data: {
      userId: input.userId,
      campaignId: input.campaignId ?? null,
      keyword: input.keyword,
      area: input.area,
      placeIds: input.placeIds,
      newPlaces: input.newPlaces,
      acceptedLeads: input.acceptedLeads,
    },
  });
}

export async function getKnownPlaceOutcomes(
  userId: string,
  placeIds: string[],
): Promise<Map<string, PlaceOutcomeRow>> {
  if (placeIds.length === 0) return new Map();
  const since = new Date(Date.now() - getPlaceOutcomeCacheDays() * 24 * 60 * 60 * 1000);
  const rows = await getPrismaClient().discoveryPlaceOutcome.findMany({
    where: { userId, placeId: { in: placeIds }, updatedAt: { gte: since } },
    select: {
      placeId: true,
      outcome: true,
      reason: true,
      updatedAt: true,
    },
  });
  return new Map(
    rows.map((row) => [
      row.placeId,
      {
        placeId: row.placeId,
        outcome: row.outcome,
        reason: row.reason,
        updatedAt: row.updatedAt,
      },
    ]),
  );
}

export async function recordPlaceOutcomes(
  userId: string,
  outcomes: Array<{
    placeId: string;
    outcome: "accepted" | "rejected" | "no_contact";
    reason?: string | null;
    keyword?: string | null;
    area?: string | null;
  }>,
): Promise<void> {
  const prisma = getPrismaClient();
  const unique = new Map(outcomes.map((o) => [o.placeId, o]));
  await Promise.all(
    Array.from(unique.values()).map((outcome) =>
      prisma.discoveryPlaceOutcome.upsert({
        where: { userId_placeId: { userId, placeId: outcome.placeId } },
        create: {
          userId,
          placeId: outcome.placeId,
          outcome: outcome.outcome,
          reason: outcome.reason ?? null,
          keyword: outcome.keyword ?? null,
          area: outcome.area ?? null,
        },
        update: {
          outcome: outcome.outcome,
          reason: outcome.reason ?? null,
          keyword: outcome.keyword ?? null,
          area: outcome.area ?? null,
        },
      }),
    ),
  );
}

/**
 * Rolling actual per-place cost from the last N non-dry Google Maps runs.
 * Falls back to null so the caller can use constants.
 */
export async function getRollingMapsCostPerPlace(
  userId: string,
  limit = 5,
): Promise<{ costPerPlaceUsd: number | null; samples: number }> {
  const jobs = await getPrismaClient().scrapeJob.findMany({
    where: {
      isDryRun: false,
      discoveryActor: { contains: "crawler-google-places" },
      candidatesDiscovered: { gt: 0 },
      costUsd: { not: null },
      campaign: { userId },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { costUsd: true, candidatesDiscovered: true },
  });
  const perPlace = jobs
    .map((job) => {
      const cost = job.costUsd ? Number(job.costUsd) : 0;
      const places = job.candidatesDiscovered ?? 0;
      return places > 0 && cost > 0 ? cost / places : null;
    })
    .filter((v): v is number => v !== null);
  if (perPlace.length === 0) return { costPerPlaceUsd: null, samples: 0 };
  const avg = perPlace.reduce((a, b) => a + b, 0) / perPlace.length;
  return { costPerPlaceUsd: Number(avg.toFixed(5)), samples: perPlace.length };
}

export async function getKeywordYieldSuggestions(
  userId: string,
  limit = 3,
): Promise<Array<{ keyword: string; places: number; igReady: number; yield: number }>> {
  const rows = await getCoverageRows(userId, 180);
  const byKeyword = new Map<string, { places: number; igReady: number }>();
  for (const row of rows) {
    const key = row.keyword.toLowerCase();
    const entry = byKeyword.get(key) ?? { places: 0, igReady: 0 };
    entry.places += row.newPlaces ?? 0;
    entry.igReady += row.acceptedLeads ?? 0;
    byKeyword.set(key, entry);
  }
  return rankKeywordSuggestions(
    Array.from(byKeyword.entries()).map(([keyword, stats]) => ({
      keyword,
      places: stats.places,
      igReady: stats.igReady,
    })),
    limit,
  );
}
