import { PrismaPg } from "@prisma/adapter-pg";

import { getServerEnv } from "@/lib/env";
import { PrismaClient } from "@/generated/prisma/client";

type PrismaGlobal = typeof globalThis & {
  __instaScraperPrisma?: PrismaClient;
};

const globalForPrisma = globalThis as PrismaGlobal;

export function getPrismaClient(): PrismaClient {
  const cached = globalForPrisma.__instaScraperPrisma;
  if (cached !== undefined) {
    return cached;
  }

  const connectionString = getServerEnv("DATABASE_URL");
  if (connectionString === undefined) {
    throw new Error(
      "Missing required server environment variable: DATABASE_URL",
    );
  }

  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  const extended = client.$extends({
    query: {
      campaign: {
        async create({ args, query }) {
          const data = args.data as Record<string, unknown>;
          if (data && !data.companyProfileId && !data.companyProfile && typeof data.userId === "string") {
            let profile = await client.companyProfile.findFirst({
              where: { userId: data.userId },
              orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
              select: { id: true },
            });
            if (!profile) {
              profile = await client.companyProfile.create({
                data: {
                  userId: data.userId,
                  name: "Default Profile",
                  description: "Default Company Profile",
                  isDefault: true,
                },
                select: { id: true },
              });
            }
            data.companyProfileId = profile.id;
          }
          return query(args);
        },
      },
    },
  });

  // Reuse the client across module re-evaluations and hot reloads to avoid connection pool exhaustion
  globalForPrisma.__instaScraperPrisma = extended as unknown as PrismaClient;

  if (process.env.APIFY_DRY_RUN === "true" || process.env.APIFY_DRY_RUN === "1") {
    console.warn("[APIFY-DRY-RUN-WARNING] DRY RUN IS ACTIVE - fake data, no Apify cost. Live paid scraping is disabled.");
  }

  return extended as unknown as PrismaClient;
}

export type PrismaSyncCheckResult = {
  synced: boolean;
  error?: string;
};

/**
 * Cheap schema sync check to verify that the generated Prisma client columns match the database table schema.
 * Throws or returns synced=false if columns like isDryRun or campaignId are missing on either side.
 */
export async function checkPrismaClientDbSync(client?: PrismaClient): Promise<PrismaSyncCheckResult> {
  const prisma = client ?? getPrismaClient();
  try {
    // 1. Verify ScrapeJob has isDryRun and campaignId in client & DB
    await prisma.scrapeJob.findFirst({
      select: {
        id: true,
        campaignId: true,
        isDryRun: true,
      },
    });

    // 2. Verify Lead has isDryRun in client & DB
    await prisma.lead.findFirst({
      select: {
        id: true,
        isDryRun: true,
      },
    });

    return { synced: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[PRISMA-CLIENT-DB-MISMATCH]", errorMsg);
    return {
      synced: false,
      error: `Database/Client schema mismatch: ${errorMsg}. Please run "prisma generate" and "prisma migrate deploy".`,
    };
  }
}
