import type { LeadProfile, SkippedScrapeProfile } from "@/lib/types";

export type ProfileProviderContext = {
  campaignId?: string | null;
  userId?: string | null;
};

export interface ProfileProvider {
  readonly name: string;
  getProfile(username: string, context?: ProfileProviderContext): Promise<LeadProfile | null>;
  getProfiles(
    usernames: string[],
    context?: ProfileProviderContext,
  ): Promise<{
    profiles: LeadProfile[];
    skipped: SkippedScrapeProfile[];
  }>;
}
