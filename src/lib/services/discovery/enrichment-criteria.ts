import type { LeadProfile } from "@/lib/types";
import { isCategoryAllowed } from "./category-synonyms";
import { findMatchedNegativeKeyword } from "./negative-keywords";
import { extractContactFromBio } from "../contact/contact-parser";
import type { RelevanceCampaignContext } from "./lead-relevance";

export type RuleMode = "hard" | "soft";

export interface EnrichmentCriteria {
  /** Minimum required followers (default: 100). Rejects below this if hard mode. */
  minFollowers?: number | null;
  /** Maximum allowed followers (default: 500000, null = no maximum). Rejects above this if hard mode. */
  maxFollowers?: number | null;
  /** Minimum required posts (default: 3). Soft flag "low_activity" unless strict mode or mode="hard". */
  minPosts?: number | null;
  /** When true, converts soft rules (like minPosts) into hard rejection rules. */
  strictMode?: boolean;
  /** Exclude private accounts (default: true). Hard reject if private. */
  excludePrivate?: boolean;
  /**
   * Allowed categories. Derived from campaign Category via category-synonyms if null.
   * If candidate has null/empty category, it is NOT rejected and deferred to AI.
   */
  allowedCategories?: string[] | null;
  /** Require at least one contact signal (website, email, phone). Default: false (soft flag "no_contact_signal"). */
  requireContactSignal?: boolean;
  /** Optional list of keywords where candidate bio must contain at least one. */
  bioIncludeAny?: string[] | null;
  /** Negative keywords to reject candidate bios. Uses DEFAULT_NEGATIVE_KEYWORDS if not specified. */
  bioExclude?: string[] | null;
  /** Reject profiles whose last post is older than this many days. Default: null (no rule). */
  maxDaysSinceLastPost?: number | null;
  /** Per-rule mode override ("hard" for rejection, "soft" for flagging only). */
  ruleModes?: {
    minFollowers?: RuleMode;
    maxFollowers?: RuleMode;
    minPosts?: RuleMode;
    excludePrivate?: RuleMode;
    allowedCategories?: RuleMode;
    requireContactSignal?: RuleMode;
    bioIncludeAny?: RuleMode;
    bioExclude?: RuleMode;
    maxDaysSinceLastPost?: RuleMode;
  };
  [key: string]: unknown;
}

export const DEFAULT_ENRICHMENT_CRITERIA: Readonly<EnrichmentCriteria> = {
  minFollowers: 100,
  maxFollowers: 500000,
  minPosts: 3,
  strictMode: false,
  excludePrivate: true,
  allowedCategories: null,
  requireContactSignal: false,
  bioIncludeAny: null,
  bioExclude: null,
  maxDaysSinceLastPost: null,
  ruleModes: {
    minFollowers: "hard",
    maxFollowers: "hard",
    minPosts: "soft",
    excludePrivate: "hard",
    allowedCategories: "hard",
    requireContactSignal: "soft",
    bioIncludeAny: "hard",
    bioExclude: "hard",
  },
};

export interface EnrichmentRuleResult {
  rule: "minFollowers" | "maxFollowers" | "private" | "category" | "minPosts-strict" | "minPosts" | "requireContactSignal" | "bioIncludeAny" | "bioExclude" | string;
  value: unknown;
  required: unknown;
  message?: string;
}

export interface EnrichmentCriteriaEvaluationResult {
  passed: boolean;
  reasons: EnrichmentRuleResult[];
  flags: EnrichmentRuleResult[];
}

/**
 * Evaluates an enriched Instagram lead profile against the configured enrichment criteria.
 * Returns { passed, reasons, flags } with the actual values.
 *
 * Rules:
 * - minFollowers: rejected if followers < minFollowers (default 100)
 * - maxFollowers: rejected if maxFollowers != null and followers > maxFollowers (default 500,000)
 * - excludePrivate: rejected if isPrivate == true (default true)
 * - allowedCategories: derived from campaign Category via category-synonyms.
 *   Null/empty profile category is NOT rejected (deferred to AI).
 * - minPosts: flagged as "low_activity" (soft) unless strict mode (or ruleMode="hard"), which rejects as "minPosts-strict"
 * - requireContactSignal: flagged as "no_contact_signal" (soft) if no website, email, or phone
 * - bioExclude: rejected if bio contains negative keywords
 * - bioIncludeAny: rejected if specified and bio contains none of them
 */
export function evaluateEnrichmentCriteria(
  profile: LeadProfile,
  criteriaInput?: EnrichmentCriteria | null,
  campaignContext?: RelevanceCampaignContext,
): EnrichmentCriteriaEvaluationResult {
  const criteria: EnrichmentCriteria = {
    ...DEFAULT_ENRICHMENT_CRITERIA,
    ...criteriaInput,
    ruleModes: {
      ...DEFAULT_ENRICHMENT_CRITERIA.ruleModes,
      ...criteriaInput?.ruleModes,
    },
  };

  const isStrict = Boolean(criteria.strictMode);
  const reasons: EnrichmentRuleResult[] = [];
  const flags: EnrichmentRuleResult[] = [];

  const rawFollowers =
    typeof profile.followersCount === "number"
      ? profile.followersCount
      : typeof profile.followers === "number"
        ? profile.followers
        : 0;

  // 1. Minimum Followers
  if (criteria.minFollowers !== null && criteria.minFollowers !== undefined) {
    if (rawFollowers < criteria.minFollowers) {
      const mode = criteria.ruleModes?.minFollowers ?? "hard";
      const item: EnrichmentRuleResult = {
        rule: "minFollowers",
        value: rawFollowers,
        required: criteria.minFollowers,
        message: `Follower count ${rawFollowers} is below minimum requirement of ${criteria.minFollowers}`,
      };
      if (mode === "hard") {
        reasons.push(item);
      } else {
        flags.push(item);
      }
    }
  }

  // 2. Maximum Followers
  if (criteria.maxFollowers !== null && criteria.maxFollowers !== undefined) {
    if (rawFollowers > criteria.maxFollowers) {
      const mode = criteria.ruleModes?.maxFollowers ?? "hard";
      const item: EnrichmentRuleResult = {
        rule: "maxFollowers",
        value: rawFollowers,
        required: criteria.maxFollowers,
        message: `Follower count ${rawFollowers} exceeds maximum limit of ${criteria.maxFollowers}`,
      };
      if (mode === "hard") {
        reasons.push(item);
      } else {
        flags.push(item);
      }
    }
  }

  // 3. Exclude Private
  const isPrivate = Boolean(
    profile.isPrivate ??
      (profile.rawProfileData as { isPrivate?: boolean } | undefined)?.isPrivate,
  );
  if (criteria.excludePrivate) {
    if (isPrivate) {
      const mode = criteria.ruleModes?.excludePrivate ?? "hard";
      const item: EnrichmentRuleResult = {
        rule: "private",
        value: true,
        required: false,
        message: "Private profiles cannot be qualified for outreach",
      };
      if (mode === "hard") {
        reasons.push(item);
      } else {
        flags.push(item);
      }
    }
  }

  // 4. Allowed Categories
  // Null or empty profile category is NOT rejected; deferred to AI.
  const profileCategory =
    profile.businessCategoryName ||
    profile.category ||
    (profile.rawProfileData as { businessCategoryName?: string; category?: string } | undefined)
      ?.businessCategoryName ||
    (profile.rawProfileData as { category?: string } | undefined)?.category ||
    null;

  if (profileCategory && profileCategory.trim().length > 0) {
    let categoryAllowed = true;
    if (Array.isArray(criteria.allowedCategories) && criteria.allowedCategories.length > 0) {
      const normProfile = profileCategory.trim().toLowerCase();
      categoryAllowed = criteria.allowedCategories.some((allowed) => {
        const normAllowed = allowed.trim().toLowerCase();
        return (
          normProfile === normAllowed ||
          normProfile.includes(normAllowed) ||
          normAllowed.includes(normProfile)
        );
      });
    } else if (campaignContext?.category) {
      categoryAllowed = isCategoryAllowed(profileCategory, campaignContext.category);
    }

    if (!categoryAllowed) {
      const mode = criteria.ruleModes?.allowedCategories ?? "hard";
      const item: EnrichmentRuleResult = {
        rule: "category",
        value: profileCategory,
        required: criteria.allowedCategories ?? campaignContext?.category ?? "matching category",
        message: `Profile category "${profileCategory}" does not match target category`,
      };
      if (mode === "hard") {
        reasons.push(item);
      } else {
        flags.push(item);
      }
    }
  }

  // 5. Minimum Posts
  const rawPosts =
    typeof profile.postsCount === "number"
      ? profile.postsCount
      : typeof (profile.rawProfileData as { postsCount?: number } | undefined)?.postsCount ===
          "number"
        ? (profile.rawProfileData as { postsCount?: number }).postsCount!
        : 0;

  if (criteria.minPosts !== null && criteria.minPosts !== undefined) {
    if (rawPosts < criteria.minPosts) {
      const isHard = isStrict || criteria.ruleModes?.minPosts === "hard";
      if (isHard) {
        reasons.push({
          rule: "minPosts-strict",
          value: rawPosts,
          required: criteria.minPosts,
          message: `Post count ${rawPosts} is below minimum requirement of ${criteria.minPosts} in strict mode`,
        });
      } else {
        flags.push({
          rule: "minPosts",
          value: rawPosts,
          required: criteria.minPosts,
          message: "low_activity",
        });
      }
    }
  }

  // 6. Contact Signal Signal Detection
  const bio = profile.biography ?? (profile.rawProfileData as { biography?: string } | undefined)?.biography ?? "";
  const extUrl = profile.externalUrl ?? profile.website ?? (profile.rawProfileData as { externalUrl?: string } | undefined)?.externalUrl ?? "";
  const parsedContact = extractContactFromBio(bio, extUrl);
  const hasContact = Boolean(
    profile.email ||
      profile.phone ||
      profile.website ||
      profile.externalUrl ||
      parsedContact.email ||
      parsedContact.phone ||
      parsedContact.website,
  );

  if (!hasContact) {
    const isHard = criteria.requireContactSignal && (isStrict || criteria.ruleModes?.requireContactSignal === "hard");
    const item: EnrichmentRuleResult = {
      rule: "requireContactSignal",
      value: "none",
      required: "website|email|phone",
      message: "no_contact_signal",
    };
    if (isHard) {
      reasons.push(item);
    } else {
      flags.push(item);
    }
  }

  // 7. Bio Negative Keywords (bioExclude)
  const excludeKeywords = criteria.bioExclude ?? null;
  const allowedTerms = [
    ...(campaignContext?.intent ? campaignContext.intent.split(/[\s,]+/) : []),
    ...(campaignContext?.category ? campaignContext.category.split(/[\s,]+/) : []),
  ];
  const matched = findMatchedNegativeKeyword(
    [bio, profile.fullName ?? ""],
    excludeKeywords,
    allowedTerms,
  );
  if (matched) {
      const mode = criteria.ruleModes?.bioExclude ?? "hard";
      const item: EnrichmentRuleResult = {
        rule: "bioExclude",
        value: matched,
        required: "clean bio",
        message: `Bio matched negative keyword: "${matched}"`,
      };
      if (mode === "hard") {
        reasons.push(item);
      } else {
        flags.push(item);
      }
    }

  // 8. Last post recency
  if (criteria.maxDaysSinceLastPost !== null && criteria.maxDaysSinceLastPost !== undefined) {
    const lastPostRaw =
      profile.lastPostAt ??
      (profile.rawProfileData as { lastPostAt?: string | null } | undefined)?.lastPostAt ??
      null;
    if (lastPostRaw) {
      const lastPostMs = new Date(lastPostRaw).getTime();
      if (!Number.isNaN(lastPostMs)) {
        const days = Math.floor((Date.now() - lastPostMs) / (24 * 60 * 60 * 1000));
        if (days > criteria.maxDaysSinceLastPost) {
          const mode = criteria.ruleModes?.maxDaysSinceLastPost ?? "hard";
          const item: EnrichmentRuleResult = {
            rule: "maxDaysSinceLastPost",
            value: days,
            required: criteria.maxDaysSinceLastPost,
            message: `Last post was ${days} days ago (max ${criteria.maxDaysSinceLastPost})`,
          };
          if (mode === "hard") {
            reasons.push(item);
          } else {
            flags.push(item);
          }
        }
      }
    }
  }

  // 9. Bio Include Any
  if (Array.isArray(criteria.bioIncludeAny) && criteria.bioIncludeAny.length > 0) {
    const normBio = bio.toLowerCase();
    const hasAny = criteria.bioIncludeAny.some((kw) => normBio.includes(kw.trim().toLowerCase()));
    if (!hasAny) {
      const mode = criteria.ruleModes?.bioIncludeAny ?? "hard";
      const item: EnrichmentRuleResult = {
        rule: "bioIncludeAny",
        value: bio,
        required: criteria.bioIncludeAny,
        message: "Bio did not contain any of the required keywords",
      };
      if (mode === "hard") {
        reasons.push(item);
      } else {
        flags.push(item);
      }
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
    flags,
  };
}
