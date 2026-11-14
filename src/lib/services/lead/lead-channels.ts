/**
 * Canonical lead channel flags and score-flag helpers.
 * availableChannels is no longer stored as a list: the five booleans are the
 * source of truth, so every write path must go through these helpers.
 */

export type LeadChannelFlags = {
  hasInstagram: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  hasOtherSocial: boolean;
};

export function leadChannelFlagsFromChannels(
  channels: readonly string[] | null | undefined,
): LeadChannelFlags {
  const normalized = new Set(
    (channels ?? []).map((channel) => channel.trim().toUpperCase()).filter(Boolean),
  );
  return {
    hasInstagram: normalized.has("INSTAGRAM"),
    hasEmail: normalized.has("EMAIL"),
    hasPhone: normalized.has("PHONE"),
    hasWebsite: normalized.has("WEBSITE"),
    hasOtherSocial:
      normalized.has("SOCIAL") ||
      normalized.has("WHATSAPP") ||
      normalized.has("FACEBOOK") ||
      normalized.has("TIKTOK") ||
      normalized.has("LINKEDIN") ||
      normalized.has("YOUTUBE") ||
      normalized.has("TWITTER") ||
      normalized.has("X") ||
      normalized.has("PINTEREST") ||
      normalized.has("YELP") ||
      normalized.has("GOOGLE_BUSINESS"),
  };
}

export function leadChannelsFromFlags(flags: LeadChannelFlags): string[] {
  const channels: string[] = [];
  if (flags.hasInstagram) channels.push("INSTAGRAM");
  if (flags.hasEmail) channels.push("EMAIL");
  if (flags.hasPhone) channels.push("PHONE");
  if (flags.hasWebsite) channels.push("WEBSITE");
  if (flags.hasOtherSocial) channels.push("SOCIAL");
  return channels;
}

export function withLeadChannelFlags(
  channels: readonly string[] | null | undefined,
): LeadChannelFlags {
  return leadChannelFlagsFromChannels(channels);
}

export type LeadScoreFlagRow = { flag: string };

export function scoreFlagsFromRows(rows: readonly LeadScoreFlagRow[] | null | undefined): string[] {
  return Array.from(new Set((rows ?? []).map((row) => row.flag).filter(Boolean)));
}

export function scoreFlagCreate(flags: readonly string[]) {
  return {
    create: Array.from(new Set(flags.filter(Boolean))).map((flag) => ({ flag })),
  };
}

export function scoreFlagReplace(flags: readonly string[]) {
  return {
    deleteMany: {},
    create: Array.from(new Set(flags.filter(Boolean))).map((flag) => ({ flag })),
  };
}
