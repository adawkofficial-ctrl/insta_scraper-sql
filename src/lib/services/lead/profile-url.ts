import { canonicalProfileUrl, normalizeUsername } from "@/lib/services/dedup/identity";

export type InstagramProfileSource = {
  profileUrl?: string | null;
  username?: string | null;
};

/**
 * Resolves the Instagram profile URL used to address a lead.
 *
 * Leads discovered from a business website often get a handle but no stored
 * profile URL. A handle is sufficient to address the profile, so derive the
 * canonical URL from it instead of dropping the lead:
 *   1. An absolute http(s) profile URL is used as-is.
 *   2. Otherwise the handle is taken from `profileUrl` (bare handle / URL) or
 *      `username` and expanded to `https://www.instagram.com/<handle>/`.
 */
export function resolveLeadProfileUrl(lead: InstagramProfileSource | null | undefined): string | null {
  if (!lead) return null;
  const raw = lead.profileUrl?.trim() ?? "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const handle = normalizeUsername(raw) ?? normalizeUsername(lead.username ?? null);
  return handle ? canonicalProfileUrl(handle) : null;
}
