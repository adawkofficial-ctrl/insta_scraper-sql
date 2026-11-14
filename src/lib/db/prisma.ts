import { PrismaMariaDb } from "@prisma/adapter-mariadb";

import { getServerEnv } from "@/lib/env";
import { PrismaClient } from "@/generated/prisma/client";

type PrismaGlobal = typeof globalThis & {
  __instaScraperPrisma?: PrismaClient;
};

const globalForPrisma = globalThis as PrismaGlobal;

const DEFAULT_CONNECTION_LIMIT = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDatabaseUrl(): string {
  // Local MySQL development/test override for the mysql-port branch. Production
  // Hostinger deployments use DATABASE_URL directly.
  const connectionString =
    process.env.DATABASE_URL_MYSQL_LOCAL || getServerEnv("DATABASE_URL");
  if (!connectionString) {
    throw new Error(
      "Missing required environment variable: DATABASE_URL (or DATABASE_URL_MYSQL_LOCAL)",
    );
  }
  return connectionString;
}

/**
 * Build the MariaDB/MySQL driver-adapter pool configuration from the URL.
 * Hostinger has a low max_connections limit, so the default pool is small and
 * every timeout is bounded.
 */
function buildMariaDbPoolConfig(connectionString: string) {
  if (!/^(mysql|mariadb):\/\//i.test(connectionString)) {
    throw new Error(
      "mysql-port requires a mysql:// or mariadb:// DATABASE_URL. Refusing to start with a non-MySQL URL.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL is not a valid MySQL URL.");
  }

  const database = parsed.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error("DATABASE_URL must include a database name.");
  }

  const connectionLimit = readPositiveInt(
    process.env.DATABASE_CONNECTION_LIMIT ??
      parsed.searchParams.get("connection_limit") ??
      undefined,
    DEFAULT_CONNECTION_LIMIT,
  );

  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    connectionLimit,
    connectTimeout: readPositiveInt(
      process.env.DATABASE_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    acquireTimeout: readPositiveInt(
      process.env.DATABASE_ACQUIRE_TIMEOUT_MS,
      DEFAULT_ACQUIRE_TIMEOUT_MS,
    ),
    idleTimeout: readPositiveInt(
      process.env.DATABASE_IDLE_TIMEOUT_MS,
      DEFAULT_IDLE_TIMEOUT_MS,
    ),
    charset: "utf8mb4",
    // Prisma/MySQL DATETIME has no timezone; keep the driver in UTC.
    timezone: "Z",
    multipleStatements: false,
  };
}

function applyCampaignExtension(client: PrismaClient): PrismaClient {
  return client.$extends({
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
  }) as unknown as PrismaClient;
}

/**
 * Create a fresh MySQL-backed Prisma client. Scripts should use this instead
 * of constructing PrismaPg/PrismaClient themselves.
 */
export function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    adapter: new PrismaMariaDb(buildMariaDbPoolConfig(getDatabaseUrl())),
  });
  return applyCampaignExtension(client);
}

export function getPrismaClient(): PrismaClient {
  const cached = globalForPrisma.__instaScraperPrisma;
  if (cached !== undefined) {
    return cached;
  }

  const extended = createPrismaClient();

  // Reuse the client across module re-evaluations and hot reloads to avoid connection pool exhaustion
  globalForPrisma.__instaScraperPrisma = extended;

  if (process.env.APIFY_DRY_RUN === "true" || process.env.APIFY_DRY_RUN === "1") {
    console.warn("[APIFY-DRY-RUN-WARNING] DRY RUN IS ACTIVE - fake data, no Apify cost. Live paid scraping is disabled.");
  }

  return extended;
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
