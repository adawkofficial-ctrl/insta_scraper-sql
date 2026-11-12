import "dotenv/config";
import * as readline from "node:readline";
import { getDryRunCounts, deleteDryRunData } from "../src/lib/services/lead/dry-run-cleanup";

async function promptConfirmation(promptText: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "y" || trimmed === "yes" || trimmed === "confirm");
    });
  });
}

async function main() {
  console.log("=================================================");
  console.log("         DRY-RUN / MOCK DATA CLEANUP TOOL        ");
  console.log("=================================================\n");

  const counts = await getDryRunCounts();

  console.log("DISCOVERED DRY-RUN DATA:");
  console.log(`  - Dry-Run Leads (isDryRun = true)      : ${counts.dryLeads}`);
  console.log(`  - Dry-Run Scrape Jobs (isDryRun = true): ${counts.dryScrapeJobs}`);
  console.log(`  - Associated Sightings                : ${counts.drySightings}`);
  console.log("");
  console.log("Real rows (isDryRun = false) will NEVER be modified or deleted.\n");
  console.log("-------------------------------------------------");
  console.log("REMINDER: Make sure you have a database backup (e.g. pg_dump) before proceeding.");
  console.log("-------------------------------------------------\n");

  if (counts.dryLeads === 0 && counts.dryScrapeJobs === 0) {
    console.log("✅ No dry-run data found to clean. Database is already clean!");
    process.exit(0);
  }

  const isForce = process.argv.includes("--force") || process.argv.includes("-y");
  if (!isForce) {
    const confirmed = await promptConfirmation(
      "Type 'yes' or 'confirm' to permanently delete these dry-run records: ",
    );
    if (!confirmed) {
      console.log("\n❌ Cleanup cancelled by user. No records were modified.");
      process.exit(0);
    }
  }

  console.log("\nExecuting dry-run data cleanup...");
  const result = await deleteDryRunData();

  console.log("\n=================================================");
  console.log(" CLEANUP COMPLETED SUCCESSFULLY");
  console.log("=================================================");
  console.log(`  - Deleted Leads       : ${result.deletedLeads}`);
  console.log(`  - Deleted Scrape Jobs : ${result.deletedScrapeJobs}`);
  console.log(`  - Deleted Sightings   : ${result.deletedSightings}`);
  console.log("=================================================\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});

