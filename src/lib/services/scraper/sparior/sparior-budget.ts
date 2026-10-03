import "server-only";

import { AppError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import { UsageProvider, LeadStatus } from "@/generated/prisma/client";
import { getSpariorConfig } from "@/lib/env";

export type SpariorUsageSummary = {
  requests: number;
  profiles: number;
  newLeads: number;
  qualifiedLeads: number;
  latestQuotaRemaining: number | null;
  profilesPerRequest: number;
  newLeadsPerRequest: number;
  qualifiedPerRequest: number;
  estimatedCostPerQualifiedLead: number;
  costPerRequest: number;
  monthlyLimit: number;
  monthlyPriceUsd: number;
  periodStart: string;
  periodEnd: string;
};

export async function checkSpariorBudget(options?: {
  userId?: string | null;
  overrideBudget?: boolean;
}): Promise<void> {
  const config = getSpariorConfig(false);
  const prisma = getPrismaClient();

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // 1. Check latest known quotaRemaining from headers
  const quotaFilter: {
    provider: UsageProvider;
    quotaRemaining: { not: null };
    userId?: string;
  } = {
    provider: UsageProvider.SPARIOR,
    quotaRemaining: { not: null },
  };
  if (options?.userId) {
    quotaFilter.userId = options.userId;
  }

  const latestWithQuota = await prisma.usageLog.findFirst({
    where: quotaFilter,
    orderBy: { createdAt: "desc" },
    select: { quotaRemaining: true },
  });

  const reserveThreshold = config.quotaReserve;
  if (
    latestWithQuota?.quotaRemaining !== null &&
    latestWithQuota?.quotaRemaining !== undefined &&
    latestWithQuota.quotaRemaining <= reserveThreshold
  ) {
    if (!options?.overrideBudget) {
      throw new AppError(
        429,
        "PROVIDER_QUOTA_EXHAUSTED",
        `Sparior quota remaining (${latestWithQuota.quotaRemaining}) is at or below the reserve limit (${reserveThreshold}).`,
      );
    }
  }

  // 2. Check local monthly usage against soft limit
  const monthlyFilter: {
    provider: UsageProvider;
    createdAt: { gte: Date };
    userId?: string;
  } = {
    provider: UsageProvider.SPARIOR,
    createdAt: { gte: startOfMonth },
  };
  if (options?.userId) {
    monthlyFilter.userId = options.userId;
  }

  const monthlyUsage = await prisma.usageLog.aggregate({
    where: monthlyFilter,
    _sum: { requestCount: true },
  });

  const used = monthlyUsage._sum.requestCount ?? 0;
  const softLimitRequests = Math.floor(
    config.monthlyRequestLimit * (config.monthlySoftLimitPercent / 100),
  );

  console.log(
    `[sparior-budget] Quota check: Guard 1 (header reserve: remaining=${latestWithQuota?.quotaRemaining ?? "none"}, reserveLimit=${reserveThreshold}) | Guard 2 (local monthly soft limit: used=${used}/${config.monthlyRequestLimit} [${used >= softLimitRequests ? "EXCEEDED" : "OK"}], softLimit=${softLimitRequests} [${config.monthlySoftLimitPercent}% limit], userId=${options?.userId ?? "none"})`,
  );

  if (used >= softLimitRequests && !options?.overrideBudget) {
    throw new AppError(
      429,
      "PROVIDER_QUOTA_EXHAUSTED",
      `Sparior monthly soft limit reached: ${used} / ${config.monthlyRequestLimit} requests (${config.monthlySoftLimitPercent}% limit). Pass overrideBudget to proceed.`,
    );
  }
}

export async function getSpariorUsageSummary(options?: {
  userId?: string | null;
  from?: Date | string;
  to?: Date | string;
}): Promise<SpariorUsageSummary> {
  const config = getSpariorConfig(false);
  const prisma = getPrismaClient();

  const now = new Date();
  const fromDate = options?.from
    ? new Date(options.from)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const toDate = options?.to ? new Date(options.to) : now;

  const usageFilter: {
    provider: UsageProvider;
    createdAt: { gte: Date; lte: Date };
    userId?: string;
  } = {
    provider: UsageProvider.SPARIOR,
    createdAt: { gte: fromDate, lte: toDate },
  };
  if (options?.userId) {
    usageFilter.userId = options.userId;
  }

  const [usageAgg, latestWithQuota] = await Promise.all([
    prisma.usageLog.aggregate({
      where: usageFilter,
      _sum: {
        requestCount: true,
        itemsReturned: true,
      },
    }),
    prisma.usageLog.findFirst({
      where: {
        provider: UsageProvider.SPARIOR,
        quotaRemaining: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { quotaRemaining: true },
    }),
  ]);

  const requests = usageAgg._sum.requestCount ?? 0;
  const profiles = usageAgg._sum.itemsReturned ?? 0;

  // Query new leads created with source = "sparior" in this period
  const leadFilter: {
    source: string;
    createdAt: { gte: Date; lte: Date };
    campaign?: { userId: string };
  } = {
    source: "sparior",
    createdAt: { gte: fromDate, lte: toDate },
  };
  if (options?.userId) {
    leadFilter.campaign = { userId: options.userId };
  }

  const [newLeads, qualifiedLeads] = await Promise.all([
    prisma.lead.count({ where: leadFilter }),
    prisma.lead.count({
      where: {
        ...leadFilter,
        status: { not: LeadStatus.DO_NOT_CONTACT },
      },
    }),
  ]);

  const costPerRequest =
    config.monthlyRequestLimit > 0
      ? config.monthlyPriceUsd / config.monthlyRequestLimit
      : 0;

  const profilesPerRequest = requests > 0 ? profiles / requests : 0;
  const newLeadsPerRequest = requests > 0 ? newLeads / requests : 0;
  const qualifiedPerRequest = requests > 0 ? qualifiedLeads / requests : 0;

  const totalCostForRequests = requests * costPerRequest;
  const estimatedCostPerQualifiedLead =
    qualifiedLeads > 0 ? totalCostForRequests / qualifiedLeads : 0;

  return {
    requests,
    profiles,
    newLeads,
    qualifiedLeads,
    latestQuotaRemaining: latestWithQuota?.quotaRemaining ?? null,
    profilesPerRequest: Math.round(profilesPerRequest * 100) / 100,
    newLeadsPerRequest: Math.round(newLeadsPerRequest * 100) / 100,
    qualifiedPerRequest: Math.round(qualifiedPerRequest * 100) / 100,
    estimatedCostPerQualifiedLead:
      Math.round(estimatedCostPerQualifiedLead * 1000) / 1000,
    costPerRequest: Math.round(costPerRequest * 10000) / 10000,
    monthlyLimit: config.monthlyRequestLimit,
    monthlyPriceUsd: config.monthlyPriceUsd,
    periodStart: fromDate.toISOString(),
    periodEnd: toDate.toISOString(),
  };
}
