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

  return extended as unknown as PrismaClient;
}
