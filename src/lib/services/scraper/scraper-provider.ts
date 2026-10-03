import type {
  LeadProfile,
  ScrapeInput,
  ScrapeJobResult,
  ScrapeJobStatus,
  SkippedScrapeProfile,
} from "@/lib/types";

export type ScrapeResults = {
  profiles: LeadProfile[];
  skipped: SkippedScrapeProfile[];
  usageTotalUsd?: number;
  computeUnits?: number;
};

export interface ScraperProvider {
  readonly name: string;

  startJob(input: ScrapeInput): Promise<ScrapeJobResult>;

  getJobStatus(jobId: string): Promise<ScrapeJobStatus>;

  getResults(jobId: string): Promise<ScrapeResults>;
}
