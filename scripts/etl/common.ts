import crypto from "node:crypto";

export type Row = Record<string, unknown>;

export const TABLE_ORDER = [
  "User",
  "CompanyProfile",
  "Campaign",
  "ScrapeJob",
  "Candidate",
  "Lead",
  "LeadScoreFlag",
  "LeadSighting",
  "LeadStatusHistory",
  "LeadEvent",
  "DiscoveryCoverage",
  "DiscoveryPlaceOutcome",
  "InstagramSenderAccount",
  "EmailSenderAccount",
  "EmailCampaignSettings",
  "EmailSend",
  "EmailUnsubscribeToken",
  "MessageTemplate",
  "Conversation",
  "Message",
  "MessageAttempt",
  "CampaignExecution",
  "CampaignExecutionItem",
  "BulkMessageJob",
  "BulkMessageItem",
  "OutboundSendIdempotency",
  "DoNotContact",
  "UsageLog",
  "NotificationConfig",
  "NotificationLog",
  "MessageDraft",
  "DraftReview",
  "AiAnalysisJob",
  "FollowUpMessage",
  "LeadContactLedger",
  "LeadContactEvent",
  "SenderSettingsAudit",
  "UnipileWebhookEvent",
  "UnmatchedInboundMessage",
] as const;

export const JSON_COLUMNS: Record<string, Set<string>> = {
  Lead: new Set(["relatedProfiles", "latestPosts", "rawProfileData", "aiAnalysis", "scoreBreakdown", "acquisitionCostBreakdown", "previousUsernames"]),
  ScrapeJob: new Set(["usage", "costBreakdown"]),
  DiscoveryCoverage: new Set(["placeIds"]),
  Candidate: new Set(["socialLinks", "rawPlaceData"]),
  Message: new Set(["aiAnalysis"]),
  MessageTemplate: new Set(["variants"]),
  UsageLog: new Set(["metadata"]),
  CompanyProfile: new Set(["services", "preferredLength", "exampleMessages", "targetIndustries", "targetCountries", "forbiddenClaims"]),
  MessageDraft: new Set(["personalizationPointsUsed", "generationMeta", "qualityResult", "warningOverrides"]),
  DraftReview: new Set(["meta"]),
  AiAnalysisJob: new Set(["options"]),
  LeadEvent: new Set(["metadata"]),
  Campaign: new Set(["followUpDelayDays", "followUpTemplates", "customNegativeKeywords", "customPositiveKeywords"]),
  NotificationConfig: new Set(["eventTypes"]),
};

export type Exclusions = {
  users: Set<string>;
  campaigns: Set<string>;
  leads: Set<string>;
  jobs: Set<string>;
  senders: Set<string>;
  messages: Set<string>;
  drafts: Set<string>;
  executions: Set<string>;
  bulkJobs: Set<string>;
  emailSends: Set<string>;
  conversations: Set<string>;
  migratedUsers: Set<string>;
  migratedCampaigns: Set<string>;
  migratedLeads: Set<string>;
  migratedJobs: Set<string>;
  migratedSenders: Set<string>;
  migratedMessages: Set<string>;
  migratedDrafts: Set<string>;
  migratedExecutions: Set<string>;
  migratedBulkJobs: Set<string>;
  migratedEmailSends: Set<string>;
  migratedConversations: Set<string>;
};

export function buildExclusions(source: Record<string, Row[]>): Exclusions {
  const users = new Set(
    (source.User ?? [])
      .filter((u) => String(u.email ?? "").toLowerCase().endsWith("@example.com"))
      .map((u) => String(u.id)),
  );
  const campaigns = new Set(
    (source.Campaign ?? [])
      .filter((c) => {
        const name = String(c.name ?? "").toLowerCase();
        return users.has(String(c.userId)) || /test|campaign a|sample/.test(name);
      })
      .map((c) => String(c.id)),
  );
  const jobs = new Set(
    (source.ScrapeJob ?? [])
      .filter((j) => campaigns.has(String(j.campaignId)) || j.isDryRun === true)
      .map((j) => String(j.id)),
  );
  const leads = new Set(
    (source.Lead ?? [])
      .filter((l) => {
        const sourceName = String(l.source ?? "").toLowerCase();
        const username = String(l.username ?? "").toLowerCase();
        const website = String(l.website ?? "").toLowerCase();
        const phone = String(l.phone ?? "");
        return (
          campaigns.has(String(l.campaignId)) ||
          l.isDryRun === true ||
          sourceName === "sample" ||
          sourceName === "dry_run" ||
          username.startsWith("sample_") ||
          website.includes("example.com") ||
          phone.includes("55501") ||
          phone.includes("555-01")
        );
      })
      .map((l) => String(l.id)),
  );
  const senders = new Set(
    [...(source.InstagramSenderAccount ?? []), ...(source.EmailSenderAccount ?? [])]
      .filter((s) => users.has(String(s.userId)))
      .map((s) => String(s.id)),
  );
  const conversations = new Set(
    (source.Conversation ?? [])
      .filter((c) => leads.has(String(c.leadId)))
      .map((c) => String(c.id)),
  );
  const messages = new Set(
    (source.Message ?? [])
      .filter(
        (m) =>
          campaigns.has(String(m.campaignId)) ||
          leads.has(String(m.leadId)) ||
          senders.has(String(m.senderAccountId)) ||
          conversations.has(String(m.conversationId)),
      )
      .map((m) => String(m.id)),
  );
  const drafts = new Set(
    (source.MessageDraft ?? [])
      .filter((d) => campaigns.has(String(d.campaignId)) || leads.has(String(d.leadId)))
      .map((d) => String(d.id)),
  );
  const executions = new Set(
    (source.CampaignExecution ?? [])
      .filter((e) => campaigns.has(String(e.campaignId)) || leads.has(String(e.leadId)))
      .map((e) => String(e.id)),
  );
  const bulkJobs = new Set(
    (source.BulkMessageJob ?? [])
      .filter((j) => campaigns.has(String(j.campaignId)))
      .map((j) => String(j.id)),
  );
  const emailSends = new Set(
    (source.EmailSend ?? [])
      .filter(
        (e) =>
          campaigns.has(String(e.campaignId)) ||
          leads.has(String(e.leadId)) ||
          senders.has(String(e.senderAccountId)),
      )
      .map((e) => String(e.id)),
  );
  const migrated = (table: string, excluded: Set<string>) =>
    new Set((source[table] ?? []).map((r) => String(r.id)).filter((id) => !excluded.has(id)));
  return {
    users, campaigns, leads, jobs, senders, messages, drafts, executions, bulkJobs, emailSends, conversations,
    migratedUsers: migrated("User", users),
    migratedCampaigns: migrated("Campaign", campaigns),
    migratedLeads: migrated("Lead", leads),
    migratedJobs: migrated("ScrapeJob", jobs),
    migratedSenders: migrated("InstagramSenderAccount", senders),
    migratedMessages: migrated("Message", messages),
    migratedDrafts: migrated("MessageDraft", drafts),
    migratedExecutions: migrated("CampaignExecution", executions),
    migratedBulkJobs: migrated("BulkMessageJob", bulkJobs),
    migratedEmailSends: migrated("EmailSend", emailSends),
    migratedConversations: migrated("Conversation", conversations),
  };
}

function refExcluded(value: unknown, allowed: Set<string>): boolean {
  if (value === null || value === undefined || value === "") return false;
  return !allowed.has(String(value));
}

export function isExcluded(table: string, row: Row, ex: Exclusions): boolean {
  switch (table) {
    case "User": return ex.users.has(String(row.id));
    case "CompanyProfile": return ex.users.has(String(row.userId));
    case "Campaign": return ex.campaigns.has(String(row.id));
    case "ScrapeJob": return ex.jobs.has(String(row.id));
    case "Candidate": return ex.campaigns.has(String(row.campaignId)) || ex.jobs.has(String(row.scrapeJobId));
    case "Lead": return ex.leads.has(String(row.id));
    case "LeadScoreFlag": return ex.leads.has(String(row.leadId));
    case "LeadSighting": return ex.leads.has(String(row.leadId)) || ex.campaigns.has(String(row.campaignId)) || ex.jobs.has(String(row.scrapeJobId));
    case "LeadStatusHistory": return ex.leads.has(String(row.leadId));
    case "LeadEvent": return ex.leads.has(String(row.leadId)) || ex.campaigns.has(String(row.campaignId));
    case "DiscoveryCoverage": return ex.users.has(String(row.userId));
    case "DiscoveryPlaceOutcome": return ex.users.has(String(row.userId)) || ex.jobs.has(String(row.scrapeJobId));
    case "InstagramSenderAccount":
    case "EmailSenderAccount": return ex.senders.has(String(row.id)) || ex.users.has(String(row.userId));
    case "EmailCampaignSettings": return ex.campaigns.has(String(row.campaignId));
    case "EmailSend": return ex.emailSends.has(String(row.id));
    case "EmailUnsubscribeToken": return ex.leads.has(String(row.leadId));
    case "MessageTemplate": return ex.campaigns.has(String(row.campaignId));
    case "Conversation": return ex.conversations.has(String(row.id)) || ex.leads.has(String(row.leadId));
    case "Message": return ex.messages.has(String(row.id));
    case "MessageAttempt": return ex.messages.has(String(row.messageId));
    case "LeadContactLedger":
    case "LeadContactEvent":
      return ex.campaigns.has(String(row.campaignId)) || ex.leads.has(String(row.leadId)) || ex.senders.has(String(row.senderAccountId));
    case "SenderSettingsAudit": return ex.users.has(String(row.userId)) || ex.senders.has(String(row.senderAccountId));
    case "CampaignExecution": return ex.executions.has(String(row.id)) || ex.campaigns.has(String(row.campaignId));
    case "CampaignExecutionItem": return ex.executions.has(String(row.executionId)) || ex.leads.has(String(row.leadId));
    case "BulkMessageJob": return ex.bulkJobs.has(String(row.id)) || ex.campaigns.has(String(row.campaignId));
    case "BulkMessageItem": return ex.bulkJobs.has(String(row.jobId)) || ex.leads.has(String(row.leadId));
    case "OutboundSendIdempotency": return ex.campaigns.has(String(row.campaignId)) || ex.leads.has(String(row.leadId)) || ex.senders.has(String(row.senderAccountId));
    case "DoNotContact": return ex.users.has(String(row.userId));
    case "UsageLog": return ex.users.has(String(row.userId)) || ex.campaigns.has(String(row.campaignId));
    case "NotificationConfig":
    case "NotificationLog": return ex.users.has(String(row.userId));
    case "MessageDraft": return ex.drafts.has(String(row.id)) || ex.campaigns.has(String(row.campaignId)) || ex.leads.has(String(row.leadId));
    case "DraftReview": return ex.drafts.has(String(row.draftId));
    case "AiAnalysisJob": return ex.users.has(String(row.userId)) || ex.campaigns.has(String(row.campaignId));
    case "FollowUpMessage": return ex.campaigns.has(String(row.campaignId)) || ex.leads.has(String(row.leadId));
    default: return false;
  }
}

const PARENT_REFS: Record<string, Array<[string, keyof Exclusions]>> = {
  CompanyProfile: [["userId", "migratedUsers"]],
  Campaign: [["userId", "migratedUsers"]],
  ScrapeJob: [["campaignId", "migratedCampaigns"]],
  Candidate: [["campaignId", "migratedCampaigns"], ["scrapeJobId", "migratedJobs"]],
  Lead: [["campaignId", "migratedCampaigns"], ["userId", "migratedUsers"]],
  LeadScoreFlag: [["leadId", "migratedLeads"]],
  LeadSighting: [["leadId", "migratedLeads"], ["campaignId", "migratedCampaigns"], ["scrapeJobId", "migratedJobs"]],
  LeadStatusHistory: [["leadId", "migratedLeads"]],
  LeadEvent: [["leadId", "migratedLeads"], ["campaignId", "migratedCampaigns"]],
  DiscoveryCoverage: [["userId", "migratedUsers"]],
  DiscoveryPlaceOutcome: [["userId", "migratedUsers"], ["scrapeJobId", "migratedJobs"]],
  InstagramSenderAccount: [["userId", "migratedUsers"]],
  EmailSenderAccount: [["userId", "migratedUsers"]],
  EmailCampaignSettings: [["campaignId", "migratedCampaigns"]],
  EmailSend: [["campaignId", "migratedCampaigns"], ["leadId", "migratedLeads"], ["senderAccountId", "migratedSenders"]],
  EmailUnsubscribeToken: [["leadId", "migratedLeads"]],
  MessageTemplate: [["campaignId", "migratedCampaigns"]],
  Conversation: [["leadId", "migratedLeads"]],
  Message: [["campaignId", "migratedCampaigns"], ["leadId", "migratedLeads"], ["conversationId", "migratedConversations"], ["senderAccountId", "migratedSenders"]],
  MessageAttempt: [["messageId", "migratedMessages"]],
  CampaignExecution: [["campaignId", "migratedCampaigns"]],
  CampaignExecutionItem: [["executionId", "migratedExecutions"], ["leadId", "migratedLeads"]],
  BulkMessageJob: [["campaignId", "migratedCampaigns"]],
  BulkMessageItem: [["jobId", "migratedBulkJobs"], ["leadId", "migratedLeads"]],
  OutboundSendIdempotency: [["campaignId", "migratedCampaigns"], ["leadId", "migratedLeads"], ["senderAccountId", "migratedSenders"]],
  LeadContactLedger: [["campaignId", "migratedCampaigns"], ["leadId", "migratedLeads"], ["senderAccountId", "migratedSenders"]],
  LeadContactEvent: [["campaignId", "migratedCampaigns"], ["leadId", "migratedLeads"], ["senderAccountId", "migratedSenders"]],
  SenderSettingsAudit: [["userId", "migratedUsers"], ["senderAccountId", "migratedSenders"]],
  DoNotContact: [["userId", "migratedUsers"]],
  UsageLog: [["userId", "migratedUsers"], ["campaignId", "migratedCampaigns"]],
  NotificationConfig: [["userId", "migratedUsers"]],
  NotificationLog: [["userId", "migratedUsers"]],
  MessageDraft: [["campaignId", "migratedCampaigns"], ["leadId", "migratedLeads"]],
  DraftReview: [["draftId", "migratedDrafts"]],
  AiAnalysisJob: [["userId", "migratedUsers"], ["campaignId", "migratedCampaigns"]],
  FollowUpMessage: [["campaignId", "migratedCampaigns"], ["leadId", "migratedLeads"]],
};

export function shouldExclude(table: string, row: Row, ex: Exclusions): boolean {
  if (isExcluded(table, row, ex)) return true;
  for (const [field, setKey] of PARENT_REFS[table] ?? []) {
    const value = row[field];
    if (value === null || value === undefined || value === "") continue;
    if (!(ex[setKey] as Set<string>).has(String(value))) return true;
  }
  return false;
}

export function isTestLikeLead(row: Row): boolean {
  const username = String(row.username ?? "").toLowerCase();
  return (
    /@example\.com$/i.test(String(row.email ?? "")) ||
    username.startsWith("sample_") ||
    String(row.source ?? "").toLowerCase() === "sample" ||
    String(row.website ?? "").toLowerCase().includes("example.com") ||
    /555[-]?01/.test(String(row.phone ?? ""))
  );
}

export function computeGuardKeys(row: Row): { activeInstagramGuard: string | null; activeUsernameGuard: string | null; activeEmailGuard: string | null } {
  const guarded = !row.duplicateOfLeadId;
  return {
    activeInstagramGuard: guarded && row.instagramUserId ? String(row.instagramUserId) : null,
    activeUsernameGuard: guarded && row.usernameNormalized ? String(row.usernameNormalized) : null,
    activeEmailGuard: guarded && row.emailNormalized ? String(row.emailNormalized) : null,
  };
}

export function channelFlags(row: Row): { hasInstagram: boolean; hasEmail: boolean; hasPhone: boolean; hasWebsite: boolean; hasOtherSocial: boolean } {
  const channels = Array.isArray(row.availableChannels) ? row.availableChannels.map((c) => String(c).toUpperCase()) : [];
  const set = new Set(channels);
  return {
    hasInstagram: set.has("INSTAGRAM"),
    hasEmail: set.has("EMAIL"),
    hasPhone: set.has("PHONE"),
    hasWebsite: set.has("WEBSITE"),
    hasOtherSocial: ["SOCIAL", "WHATSAPP", "FACEBOOK", "TIKTOK", "LINKEDIN", "YOUTUBE", "TWITTER", "X", "PINTEREST", "YELP", "GOOGLE_BUSINESS"].some((c) => set.has(c)),
  };
}

export function formatMysqlDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("T", " ").replace("Z", "");
}

export function scoreFlagId(leadId: string, flag: string): string {
  return "lsf_" + crypto.createHash("sha1").update(`${leadId}:${flag}`).digest("hex").slice(0, 24);
}

export function md5Ids(ids: string[]): string {
  return crypto.createHash("md5").update([...ids].sort().join(",")).digest("hex");
}

export function mysqlConnectionConfig(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number.parseInt(u.port, 10) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    timezone: "+00:00",
    dateStrings: true,
    multipleStatements: false,
  };
}

export function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}
