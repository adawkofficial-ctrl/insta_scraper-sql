export {
  canonicalProfileUrl,
  isSharedPlatform,
  normalizeEmail,
  normalizeUsername,
  normalizeWebsite,
  usernameFromProfileUrl,
  type NormalizedWebsite,
} from "./identity";

export { SHARED_PLATFORM_DOMAINS, MAILBOX_PROVIDER_DOMAINS } from "./dedup-constants";

export {
  applyClassifiedProfiles,
  classifyProfiles,
  clearPossibleDuplicateFlag,
  emptyDedupStats,
  findPreviouslyContactedLeadIds,
  normalizeProfile,
  wasPreviouslyContacted,
  type ApplyClassifiedInput,
  type ApplyClassifiedResult,
  type DedupClassification,
  type DedupKey,
  type DedupProfileInput,
  type DedupStats,
  type NormalizedProfile,
} from "./dedup-service";
