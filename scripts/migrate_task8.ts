import "dotenv/config";
import { Client } from "pg";

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  await client.connect();

  console.log("Connected to database. Applying Task 8 migration...");

  const queries = [
    // 1. CreateEnum CampaignExecutionPhase
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CampaignExecutionPhase') THEN
        CREATE TYPE "CampaignExecutionPhase" AS ENUM ('DISCOVERY', 'ENRICHMENT', 'READY', 'MESSAGING', 'FINALIZING');
      END IF;
    END $$;`,

    // 2. AlterEnum CampaignExecutionStatus
    `ALTER TYPE "CampaignExecutionStatus" ADD VALUE IF NOT EXISTS 'DRAFT';`,
    `ALTER TYPE "CampaignExecutionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';`,
    `ALTER TYPE "CampaignExecutionStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';`,

    // 3. AlterEnum CampaignStatus
    `ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'READY';`,
    `ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'PAUSED';`,
    `ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';`,
    `ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';`,

    // 4. AlterTable CampaignExecution
    `ALTER TABLE "CampaignExecution" ADD COLUMN IF NOT EXISTS "bulkMessageJobId" TEXT;`,
    `ALTER TABLE "CampaignExecution" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);`,
    `ALTER TABLE "CampaignExecution" ADD COLUMN IF NOT EXISTS "errorCode" TEXT;`,
    `ALTER TABLE "CampaignExecution" ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3);`,
    `ALTER TABLE "CampaignExecution" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);`,
    `ALTER TABLE "CampaignExecution" ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3);`,
    `ALTER TABLE "CampaignExecution" ADD COLUMN IF NOT EXISTS "phase" "CampaignExecutionPhase" NOT NULL DEFAULT 'READY';`,
    `ALTER TABLE "CampaignExecution" ADD COLUMN IF NOT EXISTS "scrapeJobId" TEXT;`,
    `ALTER TABLE "CampaignExecution" ADD COLUMN IF NOT EXISTS "userId" TEXT;`,
    `ALTER TABLE "CampaignExecution" ADD COLUMN IF NOT EXISTS "workerId" TEXT;`,
    `ALTER TABLE "CampaignExecution" ALTER COLUMN "status" SET DEFAULT 'READY';`,

    // 5. Create Indexes
    `CREATE INDEX IF NOT EXISTS "CampaignExecution_userId_idx" ON "CampaignExecution"("userId");`,
    `CREATE INDEX IF NOT EXISTS "CampaignExecution_phase_idx" ON "CampaignExecution"("phase");`,
    `CREATE INDEX IF NOT EXISTS "CampaignExecution_workerId_idx" ON "CampaignExecution"("workerId");`,
    `CREATE INDEX IF NOT EXISTS "CampaignExecution_leaseUntil_idx" ON "CampaignExecution"("leaseUntil");`,

    // 6. Foreign Keys
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CampaignExecution_userId_fkey') THEN
        ALTER TABLE "CampaignExecution" ADD CONSTRAINT "CampaignExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CampaignExecution_scrapeJobId_fkey') THEN
        ALTER TABLE "CampaignExecution" ADD CONSTRAINT "CampaignExecution_scrapeJobId_fkey" FOREIGN KEY ("scrapeJobId") REFERENCES "ScrapeJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CampaignExecution_bulkMessageJobId_fkey') THEN
        ALTER TABLE "CampaignExecution" ADD CONSTRAINT "CampaignExecution_bulkMessageJobId_fkey" FOREIGN KEY ("bulkMessageJobId") REFERENCES "BulkMessageJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$;`,
  ];

  for (const q of queries) {
    try {
      await client.query(q);
      console.log("Executed successfully:", q.split("\n")[0].trim().slice(0, 60));
    } catch (err) {
      console.error("Error executing query:", q, err);
      throw err;
    }
  }

  await client.end();
  console.log("✅ Task 8 migration applied successfully!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
