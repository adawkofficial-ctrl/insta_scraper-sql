/**
 * Campaign lead-limit bounds.
 *
 * Campaign.leadLimit has no product cap: campaigns may target any positive
 * number of leads. The upper bound only prevents overflowing the underlying
 * 32-bit PostgreSQL integer.
 *
 * Campaign-scoped discovery uses the same high bound. The separate
 * `MAX_MAX_LEADS` constant in src/lib/api/scraper.ts still caps the specific
 * profile-import batch, which is not a campaign lead limit.
 */
export const MIN_CAMPAIGN_LEAD_LIMIT = 1;
export const MAX_CAMPAIGN_LEAD_LIMIT = 2_147_483_647;
