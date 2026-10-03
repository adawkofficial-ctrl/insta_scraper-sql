export type CampaignStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "archived";

export type Campaign = {
  id: string;
  name: string;
  description?: string | null;
  status: CampaignStatus;
  niche?: string | null;
  intent?: string | null;
  location?: string | null;
  category?: string | null;
  leadLimit?: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ScrapeInput = {
  campaignId?: string;
  userId?: string;
  usernames: string[];
  limit?: number;
  options?: Record<string, unknown>;
};

export type ScrapeJobState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

export type ScrapeJobStatus = {
  jobId: string;
  state: ScrapeJobState;
  providerJobId?: string | null;
  progress?: number | null;
  error?: string | null;
};

export type ScrapeJobResult = {
  jobId: string;
  provider: string;
  status: ScrapeJobStatus;
};

export type LeadProfileSource = "apify" | "sparior";

export type SkippedScrapeProfile = {
  username: string;
  reason: string;
};

export type LeadRelatedProfile = {
  username: string;
  fullName: string | null;
  profilePictureUrl: string | null;
  isVerified: boolean | null;
  isPrivate: boolean | null;
};

export type LeadLatestPost = {
  id: string | null;
  shortCode: string | null;
  url: string | null;
  type: string | null;
  caption: string | null;
  likesCount: number | null;
  commentsCount: number | null;
  displayUrl: string | null;
  timestamp: string | null;
};

export type LeadProfile = {
  username: string;
  profileUrl: string;
  instagramId: string | null;
  instagramUserId?: string | null;
  fullName: string | null;
  biography: string | null;
  bio?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  websiteDomain?: string | null;
  followers: number | null;
  following: number | null;
  followersCount?: number | null;
  followsCount?: number | null;
  postsCount: number | null;
  profilePictureUrl: string | null;
  profilePicUrl?: string | null;
  profilePicUrlHD?: string | null;
  isVerified: boolean | null;
  verified?: boolean | null;
  isBusiness: boolean | null;
  isBusinessAccount?: boolean | null;
  isPrivate?: boolean | null;
  category: string | null;
  businessCategoryName?: string | null;
  externalUrl: string | null;
  location: string | null;
  phoneNormalized?: string | null;
  socialLink?: string | null;
  socialPlatform?: string | null;
  contactSource?: string | null;
  availableChannels?: string[] | null;
  relatedProfiles: LeadRelatedProfile[] | null;
  latestPosts: LeadLatestPost[] | null;
  rawProfileData?: Record<string, unknown> | null;
  raw?: Record<string, unknown> | null;
  source: LeadProfileSource;
  scrapedAt: string;
};

export type MessageStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed";

export type SendMessageInput = {
  leadId?: string;
  campaignId?: string;
  recipient: string;
  body: string;
};

export type SendMessageResult = {
  messageId: string;
  status: MessageStatus;
  sentAt?: string | null;
};

export type LeadQualification = {
  lead: string;
  qualified: boolean;
  score?: number;
  reasons?: string[];
};

export type GenerateMessageInput = {
  campaignId?: string;
  lead: LeadProfile;
  instructions?: string;
};

export type PersonalizeMessageInput = GenerateMessageInput & {
  template: string;
};

export type GeneratedMessage = {
  body: string;
  metadata?: Record<string, unknown>;
};
