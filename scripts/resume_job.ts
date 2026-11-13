/**
 * Resume Job CLI
 * Usage: npm run resume:job -- <jobId>
 * Resumes a discovery scrape job using stored Candidates data without buying any new Google Maps runs.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { resumeScrapeJob } from "../src/lib/services/discovery/resume-service";

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: npm run resume:job -- <jobId>");
    process.exit(1);
  }

  console.log(`[RESUME] Resuming scrape job: ${jobId}...`);
  try {
    const result = await resumeScrapeJob(jobId);
    console.log("------------------------------------------");
    console.log(`Job ID:                   ${result.jobId}`);
    console.log(`Campaign ID:              ${result.campaignId}`);
    console.log(`Pending Candidates:       ${result.totalPendingCandidates}`);
    console.log(`Handles Discovered:       ${result.handlesDiscovered}`);
    console.log(`Leads Created / Updated:  ${result.leadsCreatedOrUpdated}`);
    console.log(`Leads Enriched:           ${result.leadsEnriched}`);
    console.log(`Final Job Status:         ${result.finalJobStatus}`);
    if (result.errors.length > 0) {
      console.log(`Errors encountered:       ${result.errors.length}`);
      result.errors.forEach((e) => console.log(`  - ${e}`));
    }
    console.log("------------------------------------------");
    console.log("Resume completed successfully.");
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[RESUME] Failed to resume job: ${msg}`);
    process.exit(1);
  }
}

main();

