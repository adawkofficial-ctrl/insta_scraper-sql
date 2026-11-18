/**
 * Production start: resume unfinished discovery jobs from the DB (no new paid
 * actor runs), then start Next.js. `next start` honors PORT.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { recoverUnfinishedScrapeJobs } from "../src/lib/services/discovery/startup-recovery";

async function main() {
  try {
    try { execSync("npx prisma migrate deploy --config prisma7.config.ts", { stdio: "inherit", env: process.env }); } catch (err) { console.warn("[MIGRATE] prisma migrate deploy failed:", err instanceof Error ? err.message : String(err)); }
    const result = await recoverUnfinishedScrapeJobs();
    if (result.scanned > 0) {
      console.log(
        `[STARTUP-RECOVERY] scanned=${result.scanned} resumed=${result.resumed} failed=${result.failed} jobIds=${result.jobIds.join(",")}`,
      );
    }
  } catch (err) {
    console.warn(
      "[STARTUP-RECOVERY] failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  const port = process.env.PORT || "3000";
  const child = spawn("npx", ["next", "start", "-p", port], {
    shell: true,
    stdio: "inherit",
    env: process.env,
  });
  const stop = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error("start failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
