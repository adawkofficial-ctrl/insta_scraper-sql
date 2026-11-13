/**
 * Import Apify Dataset or CSV Fixture
 * Usage: npm run import:apify-dataset -- <runId|datasetId|csvPath> --campaign <campaignId>
 * Loads already-paid data into Candidates, deduped by placeId, and processes leads without starting any actor.
 */

import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./preload_server_only.cjs");

import { getPrismaClient } from "../src/lib/db/prisma";
import { persistDiscoveredPlace } from "../src/lib/services/discovery/candidate-persistence";
import { resumeScrapeJob } from "../src/lib/services/discovery/resume-service";
import { getApifyClient } from "../src/lib/services/scraper/apify-client";
import { ScrapeJobStatus } from "@/generated/prisma/client";

function parseCsv(content: string): Array<Record<string, string>> {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '"') {
      if (inQuotes && content[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && content[i + 1] === '\n') {
        i++;
      }
      lines.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }

  if (lines.length < 2) return [];

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let field = "";
    let inside = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inside && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inside = !inside;
        }
      } else if (char === ',' && !inside) {
        fields.push(field.trim());
        field = "";
      } else {
        field += char;
      }
    }
    fields.push(field.trim());
    return fields;
  };

  const headers = parseLine(lines[0]);
  const records: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseLine(lines[i]);
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = values[idx] ?? "";
    });
    records.push(record);
  }

  return records;
}

export async function importDataset(source: string, campaignId: string) {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
  });

  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found.`);
  }

  let rawItems: Array<Record<string, unknown>> = [];
  let runId = "imported";
  let datasetId = "imported";

  const resolvedPath = path.isAbsolute(source) ? source : path.resolve(process.cwd(), source);

  if (fs.existsSync(resolvedPath)) {
    const ext = path.extname(resolvedPath).toLowerCase();
    const fileContent = fs.readFileSync(resolvedPath, "utf-8");
    if (ext === ".csv") {
      rawItems = parseCsv(fileContent);
    } else {
      rawItems = JSON.parse(fileContent);
    }
    runId = `csv:${path.basename(source)}`;
    datasetId = `csv:${path.basename(source)}`;
    console.log(`[IMPORT] Loaded ${rawItems.length} items from file: ${source}`);
  } else {
    // Treat as Apify dataset or run ID
    console.log(`[IMPORT] Fetching dataset items from Apify for source: ${source}...`);
    const apify = getApifyClient();
    try {
      const ds = apify.dataset(source);
      const res = await ds.listItems({ limit: 1000 });
      rawItems = res.items as Array<Record<string, unknown>>;
      datasetId = source;
    } catch {
      // Try as run
      const run = apify.run(source);
      const runData = await run.get();
      if (runData?.defaultDatasetId) {
        runId = runData.id;
        datasetId = runData.defaultDatasetId;
        const ds = apify.dataset(datasetId);
        const res = await ds.listItems({ limit: 1000 });
        rawItems = res.items as Array<Record<string, unknown>>;
      } else {
        throw new Error(`Unable to fetch dataset from Apify for ID: ${source}`);
      }
    }
    console.log(`[IMPORT] Loaded ${rawItems.length} items from Apify dataset.`);
  }

  if (rawItems.length === 0) {
    console.log("[IMPORT] No items to import.");
    return;
  }

  // Create or find an import ScrapeJob
  const job = await prisma.scrapeJob.create({
    data: {
      campaignId,
      provider: "dataset_import",
      status: ScrapeJobStatus.COMPLETED,
      inputCount: rawItems.length,
      processedCount: rawItems.length,
      isDryRun: false,
    },
  });

  let importedCandidates = 0;
  const seenPlaceIds = new Set<string>();

  for (const item of rawItems) {
    const placeId =
      (item.placeId as string) ||
      (item.query_place_id as string) ||
      (typeof item.url === "string" && /query_place_id=([^&]+)/.exec(item.url)?.[1]) ||
      (typeof item.url === "string" && /place_id:([^&]+)/.exec(item.url)?.[1]) ||
      (item.id as string) ||
      `custom_${String(item.title || item.name || Math.random()).toLowerCase().replace(/[^a-z0-9]/g, "_")}`;

    if (seenPlaceIds.has(placeId)) {
      continue;
    }
    seenPlaceIds.add(placeId);

    const title = (item.title as string) || (item.name as string) || "Unknown";
    const category = (item.categoryName as string) || (item.category as string) || null;
    const address = (item.street as string) || (item.address as string) || null;
    const city = (item.city as string) || null;
    const state = (item.state as string) || null;
    const countryCode = (item.countryCode as string) || null;
    const phone = (item.phone as string) || null;
    const website = (item.website as string) || null;
    const rating = item.totalScore !== undefined ? Number(item.totalScore) : (item.rating !== undefined ? Number(item.rating) : null);
    const reviewsCount = item.reviewsCount !== undefined ? Number(item.reviewsCount) : (item.reviewCount !== undefined ? Number(item.reviewCount) : null);
    const mapsUrl = (item.url as string) || (item.mapsUrl as string) || null;

    await persistDiscoveredPlace(
      campaignId,
      job.id,
      {
        placeId,
        name: title,
        category,
        address,
        city,
        state,
        countryCode,
        phone,
        website,
        rating: Number.isFinite(rating) ? rating : null,
        reviewsCount: Number.isFinite(reviewsCount) ? reviewsCount : null,
        mapsUrl,
        rawPlaceData: item,
      },
      {
        runId,
        datasetId,
        costUsd: 0,
      },
    );
    importedCandidates++;
  }

  console.log(`[IMPORT] Successfully imported ${importedCandidates} candidates into campaign "${campaignId}".`);

  // Now run resume to process the candidates without any actor calls
  console.log(`[IMPORT] Processing candidates through handle discovery (zero actor calls)...`);
  const resumeRes = await resumeScrapeJob(job.id, campaign.userId, { skipEnrichment: true });

  // Fetch candidate statuses to display the decision table
  const candidates = await prisma.candidate.findMany({
    where: { campaignId, scrapeJobId: job.id },
  });

  console.log("\n======================== IMPORT DECISION TABLE ========================");
  console.log(
    "Title".padEnd(35) +
    "Status".padEnd(20) +
    "Handle".padEnd(25) +
    "Reason / Details"
  );
  console.log("-".repeat(95));

  for (const c of candidates) {
    console.log(
      (c.name.slice(0, 33)).padEnd(35) +
      c.status.padEnd(20) +
      (c.handle || "-").padEnd(25) +
      (c.rejectionReason || c.lastError || "OK")
    );
  }
  console.log("=======================================================================\n");
  console.log(`Import summary: Total Candidates: ${importedCandidates}, Handles Discovered: ${resumeRes.handlesDiscovered}, Leads Saved: ${resumeRes.leadsCreatedOrUpdated}`);
}

async function main() {
  const args = process.argv.slice(2);
  const source = args[0];
  let campaignId = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--campaign" && args[i + 1]) {
      campaignId = args[i + 1];
    }
  }

  if (!source || !campaignId) {
    console.error("Usage: npm run import:apify-dataset -- <runId|datasetId|csvPath> --campaign <id>");
    process.exit(1);
  }

  try {
    await importDataset(source, campaignId);
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[IMPORT] Error: ${msg}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
