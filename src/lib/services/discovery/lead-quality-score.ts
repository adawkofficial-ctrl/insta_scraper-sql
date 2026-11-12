/**
 * Pure lead quality scoring system (0-100) with transparent breakdown,
 * weighted category scoring, re-normalization for missing fields/no-IG leads,
 * and standard flags.
 */

export type LeadQualityTier = "A" | "B" | "C" | "D";

export type LeadScoreWeights = {
  businessHealth: number;       // default 30
  independence: number;         // default 15
  instagramActivity: number;    // default 25
  audienceFit: number;          // default 15
  contactability: number;       // default 15
};

export const DEFAULT_SCORE_WEIGHTS: LeadScoreWeights = {
  businessHealth: 30,
  independence: 15,
  instagramActivity: 25,
  audienceFit: 15,
  contactability: 15,
};

export type LeadScoreInput = {
  // Business Health
  rating?: number | null;
  reviewCount?: number | null;
  website?: string | null;
  phone?: string | null;
  isClaimed?: boolean | null; // true = claimed, false = unclaimed, null/undefined = unknown

  // Independence / Decision Maker
  isChain?: boolean | null;
  chainReason?: string | null;
  locationCount?: number | null; // 1 = single location, 2-3 = small group, >=4 = chain

  // Instagram Activity
  hasInstagram?: boolean;
  lastPostAt?: string | Date | null;
  postsCount?: number | null;

  // Audience Fit
  followers?: number | null;
  isBusinessAccount?: boolean | null;
  isPrivate?: boolean | null;
  recentLikesAvg?: number | null;
  recentCommentsAvg?: number | null;
  /** Recorded only; no filtering thresholds are applied yet. */
  engagementRate?: number | null;

  // Contactability
  email?: string | null;
  availableChannels?: string[] | null;
  hasWhatsApp?: boolean | null;
  handleConfidence?: "high" | "medium" | "low" | string | null;
  handleSource?: string | null;

  // Outreach channel context & mismatch flags
  outreachChannel?: "INSTAGRAM" | "EMAIL" | "PHONE" | "MULTI" | string | null;
  isInstagramCampaign?: boolean;
  websiteMismatch?: boolean | null;

  // Reference date for tests (defaults to new Date())
  now?: Date;
};

export type ScoreCategoryName =
  | "businessHealth"
  | "independence"
  | "instagramActivity"
  | "audienceFit"
  | "contactability";

export type ScoreCategoryBreakdown = {
  category: ScoreCategoryName;
  displayName: string;
  weight: number;         // effective normalized weight in total score
  rawScore: number;       // 0 to 1 score within category
  points: number;         // rawScore * weight
  maxPoints: number;      // weight
  skipped: boolean;       // whether category was omitted (e.g. no-IG)
  reasons: string[];
};

export type LeadScoreResult = {
  score: number;          // 0 to 100 integer
  tier: LeadQualityTier;  // "A" (>=75), "B" (55-74), "C" (35-54), "D" (<35)
  breakdown: ScoreCategoryBreakdown[];
  reasons: string[];
  flags: string[];
  isChain: boolean;
};

export type LeadScoreThresholds = {
  tierA: number; // default 75
  tierB: number; // default 55
  tierC: number; // default 35
};

export const DEFAULT_SCORE_THRESHOLDS: LeadScoreThresholds = {
  tierA: 75,
  tierB: 55,
  tierC: 35,
};

/**
 * Validates that weights sum to 100 within a tiny floating point tolerance.
 */
export function validateWeights(weights: Partial<LeadScoreWeights>): LeadScoreWeights {
  const merged: LeadScoreWeights = {
    businessHealth: weights.businessHealth ?? DEFAULT_SCORE_WEIGHTS.businessHealth,
    independence: weights.independence ?? DEFAULT_SCORE_WEIGHTS.independence,
    instagramActivity: weights.instagramActivity ?? DEFAULT_SCORE_WEIGHTS.instagramActivity,
    audienceFit: weights.audienceFit ?? DEFAULT_SCORE_WEIGHTS.audienceFit,
    contactability: weights.contactability ?? DEFAULT_SCORE_WEIGHTS.contactability,
  };

  const sum =
    merged.businessHealth +
    merged.independence +
    merged.instagramActivity +
    merged.audienceFit +
    merged.contactability;

  if (Math.abs(sum - 100) > 0.01) {
    throw new Error(
      `Invalid weights: sum is ${sum.toFixed(2)}, but weights must sum to exactly 100.`,
    );
  }

  for (const [k, v] of Object.entries(merged)) {
    if (v < 0) {
      throw new Error(`Invalid weight for category "${k}": must be non-negative, got ${v}.`);
    }
  }

  return merged;
}

/**
 * Pure, deterministic function to compute a lead's 0-100 quality score, tier, breakdown, and flags.
 */
export function computeLeadScore(
  input: LeadScoreInput,
  customWeights?: Partial<LeadScoreWeights>,
  customThresholds?: Partial<LeadScoreThresholds>,
): LeadScoreResult {
  const weights = validateWeights(customWeights ?? {});
  const thresholds: LeadScoreThresholds = {
    tierA: customThresholds?.tierA ?? DEFAULT_SCORE_THRESHOLDS.tierA,
    tierB: customThresholds?.tierB ?? DEFAULT_SCORE_THRESHOLDS.tierB,
    tierC: customThresholds?.tierC ?? DEFAULT_SCORE_THRESHOLDS.tierC,
  };

  const flags: string[] = [];
  const reasons: string[] = [];
  const now = input.now ?? new Date();

  // Determine Instagram presence
  const hasInstagram =
    input.hasInstagram !== undefined
      ? input.hasInstagram
      : Boolean(input.lastPostAt || input.followers !== undefined || input.postsCount !== undefined);

  if (!hasInstagram) {
    flags.push("IG_UNKNOWN");
  }

  if (input.websiteMismatch === true) {
    flags.push("NAME_WEBSITE_MISMATCH");
  }

  // Instagram-only discovery never receives Maps business-health fields. Mark
  // the absence explicitly so tier comparisons with Maps-based leads are not
  // silently treated as equivalent.
  if (
    (input.rating === null || input.rating === undefined) &&
    (input.reviewCount === null || input.reviewCount === undefined) &&
    (input.isClaimed === null || input.isClaimed === undefined)
  ) {
    flags.push("UNKNOWN_MAPS_DATA");
  }

  // -------------------------------------------------------------
  // 1. BUSINESS HEALTH (default weight: 30)
  // Sub-items: rating (25%), reviewCount (25%), website (20%), phone (15%), isClaimed (15%)
  // -------------------------------------------------------------
  let bhKnownWeight = 0;
  let bhEarnedPoints = 0;
  const bhReasons: string[] = [];

  // Rating (sub-weight 25)
  if (input.rating === null || input.rating === undefined) {
    flags.push("UNKNOWN_RATING");
  } else {
    bhKnownWeight += 25;
    const r = input.rating;
    if (r >= 4.5) {
      bhEarnedPoints += 25;
      bhReasons.push(`Exceptional Maps rating (${r.toFixed(1)}/5)`);
    } else if (r >= 4.0) {
      bhEarnedPoints += 25 * 0.85;
      bhReasons.push(`Strong Maps rating (${r.toFixed(1)}/5)`);
    } else if (r >= 3.5) {
      bhEarnedPoints += 25 * 0.50;
      bhReasons.push(`Average Maps rating (${r.toFixed(1)}/5)`);
    } else {
      bhEarnedPoints += 25 * 0.10;
      flags.push("LOW_RATING");
      bhReasons.push(`Low Maps rating (${r.toFixed(1)}/5)`);
    }
  }

  // Review Count (sub-weight 25)
  if (input.reviewCount === null || input.reviewCount === undefined) {
    flags.push("UNKNOWN_REVIEWS");
  } else {
    bhKnownWeight += 25;
    const rc = input.reviewCount;
    if (rc >= 100) {
      bhEarnedPoints += 25;
      bhReasons.push(`High review volume (${rc} reviews)`);
    } else if (rc >= 50) {
      bhEarnedPoints += 25 * 0.85;
      bhReasons.push(`Established review volume (${rc} reviews)`);
    } else if (rc >= 20) {
      bhEarnedPoints += 25 * 0.70;
      bhReasons.push(`Moderate review volume (${rc} reviews)`);
    } else if (rc >= 5) {
      bhEarnedPoints += 25 * 0.40;
      bhReasons.push(`Few reviews (${rc} reviews)`);
    } else {
      bhEarnedPoints += 25 * 0.10;
      flags.push("LOW_REVIEWS");
      bhReasons.push(`Very low reviews (${rc} reviews)`);
    }
  }

  // Website (sub-weight 20)
  bhKnownWeight += 20;
  if (input.website && input.website.trim().length > 0) {
    bhEarnedPoints += 20;
    bhReasons.push("Verified website present");
  } else {
    flags.push("NO_WEBSITE");
    bhReasons.push("Missing website");
  }

  // Phone (sub-weight 15)
  bhKnownWeight += 15;
  if (input.phone && input.phone.trim().length > 0) {
    bhEarnedPoints += 15;
    bhReasons.push("Direct phone number present");
  } else {
    flags.push("NO_PHONE");
    bhReasons.push("Missing phone number");
  }

  // Claimed status (sub-weight 15)
  if (input.isClaimed === null || input.isClaimed === undefined) {
    flags.push("UNKNOWN_CLAIMED");
  } else {
    bhKnownWeight += 15;
    if (input.isClaimed) {
      bhEarnedPoints += 15;
      bhReasons.push("Verified claimed Google Maps listing");
    } else {
      bhEarnedPoints += 15 * 0.20;
      flags.push("UNCLAIMED_LISTING");
      bhReasons.push("Unclaimed Google Maps listing");
    }
  }

  const rawBusinessHealth =
    bhKnownWeight > 0 ? Math.min(1, Math.max(0, bhEarnedPoints / bhKnownWeight)) : 0;

  // -------------------------------------------------------------
  // 2. INDEPENDENCE / DECISION-MAKER REACHABLE (default weight: 15)
  // Single location = 1.0, small group (2-3) = 0.5, chain = 0
  // -------------------------------------------------------------
  let rawIndependence = 1.0;
  const indReasons: string[] = [];
  const isChain = Boolean(input.isChain);

  if (isChain) {
    rawIndependence = 0.0;
    flags.push("POSSIBLE_CHAIN");
    indReasons.push(`Identified as corporate chain/franchise${input.chainReason ? ` (${input.chainReason})` : ""}`);
  } else if (input.locationCount && input.locationCount > 1 && input.locationCount <= 3) {
    rawIndependence = 0.5;
    flags.push("SMALL_GROUP");
    indReasons.push(`Small group practice with ${input.locationCount} locations`);
  } else {
    rawIndependence = 1.0;
    indReasons.push("Independent single-location business");
  }

  // -------------------------------------------------------------
  // 3. INSTAGRAM ACTIVITY (default weight: 25)
  // Skipped and re-normalized for no-IG leads!
  // Sub-items: lastPostAt (70%), postsCount (30%)
  // -------------------------------------------------------------
  let rawInstagramActivity = 0;
  let igActivityKnownWeight = 0;
  let igActivityEarnedPoints = 0;
  const igReasons: string[] = [];

  if (hasInstagram) {
    // Recency of last post (sub-weight 70)
    if (input.lastPostAt) {
      igActivityKnownWeight += 70;
      const postDate = typeof input.lastPostAt === "string" ? new Date(input.lastPostAt) : input.lastPostAt;
      const diffMs = now.getTime() - postDate.getTime();
      const diffDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

      if (diffDays <= 30) {
        igActivityEarnedPoints += 70;
        igReasons.push(`Active Instagram account (posted ${diffDays}d ago)`);
      } else if (diffDays <= 60) {
        igActivityEarnedPoints += 70 * 0.80;
        igReasons.push(`Recently active (posted ${diffDays}d ago)`);
      } else if (diffDays <= 120) {
        igActivityEarnedPoints += 70 * 0.40;
        igReasons.push(`Moderate posting activity (posted ${diffDays}d ago)`);
      } else {
        igActivityEarnedPoints += 0;
        flags.push("STALE_INSTAGRAM");
        igReasons.push(`Stale Instagram account (last post ${diffDays}d ago)`);
      }
    } else {
      flags.push("UNKNOWN_LAST_POST_DATE");
    }

    // Posts count (sub-weight 30)
    if (input.postsCount === null || input.postsCount === undefined) {
      flags.push("UNKNOWN_POSTS_COUNT");
    } else {
      igActivityKnownWeight += 30;
      const pc = input.postsCount;
      if (pc >= 30) {
        igActivityEarnedPoints += 30;
        igReasons.push(`Active content feed (${pc} total posts)`);
      } else if (pc >= 10) {
        igActivityEarnedPoints += 30 * 0.80;
        igReasons.push(`Established profile (${pc} posts)`);
      } else if (pc >= 3) {
        igActivityEarnedPoints += 30 * 0.50;
        igReasons.push(`Low post count (${pc} posts)`);
      } else {
        igActivityEarnedPoints += 30 * 0.15;
        if (!flags.includes("STALE_INSTAGRAM")) {
          flags.push("STALE_INSTAGRAM");
        }
        igReasons.push(`Inactive profile (${pc} posts)`);
      }
    }

    rawInstagramActivity =
      igActivityKnownWeight > 0 ? Math.min(1, Math.max(0, igActivityEarnedPoints / igActivityKnownWeight)) : 0.5;
  }

  // -------------------------------------------------------------
  // 4. AUDIENCE FIT (default weight: 15)
  // Local business follower band (300 - 20,000), engagement hint
  // Skipped and re-normalized for no-IG leads!
  // -------------------------------------------------------------
  let rawAudienceFit = 0;
  let audKnownWeight = 0;
  let audEarnedPoints = 0;
  const audReasons: string[] = [];

  if (hasInstagram) {
    if (input.isPrivate === true) {
      flags.push("PRIVATE_ACCOUNT");
      audKnownWeight += 100;
      audEarnedPoints += 0;
      audReasons.push("Private Instagram account");
    } else {
      // Follower count band (sub-weight 70)
      if (input.followers === null || input.followers === undefined) {
        flags.push("UNKNOWN_FOLLOWERS");
      } else {
        audKnownWeight += 70;
        const f = input.followers;
        if (f >= 500 && f <= 15000) {
          audEarnedPoints += 70;
          audReasons.push(`Ideal local audience band (${f.toLocaleString()} followers)`);
        } else if (f >= 300 && f <= 25000) {
          audEarnedPoints += 70 * 0.85;
          audReasons.push(`Good audience size (${f.toLocaleString()} followers)`);
        } else if (f >= 100 && f < 300) {
          audEarnedPoints += 70 * 0.50;
          audReasons.push(`Small audience (${f} followers)`);
        } else if (f > 25000 && f <= 75000) {
          audEarnedPoints += 70 * 0.60;
          audReasons.push(`Large audience (${f.toLocaleString()} followers)`);
        } else if (f < 100) {
          audEarnedPoints += 70 * 0.10;
          flags.push("FEW_FOLLOWERS");
          audReasons.push(`Very few followers (${f} followers)`);
        } else {
          // > 75k
          audEarnedPoints += 70 * 0.20;
          flags.push("CELEBRITY_OR_AGGREGATOR");
          audReasons.push(`Atypically large follower count for local clinic (${f.toLocaleString()} followers)`);
        }
      }

      // Business account indicator (sub-weight 30)
      audKnownWeight += 30;
      if (input.isBusinessAccount === true) {
        audEarnedPoints += 30;
        audReasons.push("Registered Instagram business profile");
      } else if (input.isBusinessAccount === false) {
        audEarnedPoints += 30 * 0.60;
        audReasons.push("Personal / creator profile mode");
      } else {
        audEarnedPoints += 30 * 0.70;
      }
    }

    rawAudienceFit =
      audKnownWeight > 0 ? Math.min(1, Math.max(0, audEarnedPoints / audKnownWeight)) : 0.5;
  }

  // -------------------------------------------------------------
  // 5. CONTACTABILITY (default weight: 15)
  // Public email (+0.4), phone/WhatsApp (+0.3), business IG (+0.2), multi-channel (+0.1)
  // -------------------------------------------------------------
  let rawContactability = 0;
  const contReasons: string[] = [];
  const channels = new Set(
    (input.availableChannels ?? []).map((c) => c.toUpperCase()),
  );
  if (input.email) channels.add("EMAIL");
  if (input.phone) channels.add("PHONE");
  if (input.hasWhatsApp) channels.add("WHATSAPP");
  if (hasInstagram) channels.add("INSTAGRAM");

  if (input.email && input.email.includes("@")) {
    rawContactability += 0.40;
    contReasons.push("Direct public email available");
  }

  if (input.phone || input.hasWhatsApp || channels.has("PHONE") || channels.has("WHATSAPP")) {
    rawContactability += 0.30;
    contReasons.push("Phone / WhatsApp channel accessible");
  }

  if (hasInstagram) {
    rawContactability += 0.20;
    contReasons.push("Instagram direct profile");
  }

  if (channels.size >= 2) {
    rawContactability += 0.10;
    contReasons.push(`Multi-channel reachability (${Array.from(channels).join(", ")})`);
  }

  if (input.handleConfidence === "low") {
    flags.push("LOW_CONFIDENCE_HANDLE");
    contReasons.push("Low-confidence Instagram handle association");
  }

  if (rawContactability === 0) {
    flags.push("NO_CONTACT_CHANNELS");
    contReasons.push("No verified contact channels discovered");
  }

  const hasOffInstagramContact =
    Boolean(input.email && input.email.includes("@")) ||
    Boolean(input.phone) ||
    Boolean(input.website && input.website.trim().length > 0) ||
    channels.has("EMAIL") ||
    channels.has("PHONE") ||
    channels.has("WHATSAPP") ||
    channels.has("WEBSITE");

  if (!hasOffInstagramContact) {
    flags.push("NO_CONTACT_CHANNEL");
    contReasons.push("Instagram is the only reachable channel (email/phone/website missing)");
  }

  if (
    (input.recentLikesAvg !== null && input.recentLikesAvg !== undefined) ||
    (input.recentCommentsAvg !== null && input.recentCommentsAvg !== undefined) ||
    (input.engagementRate !== null && input.engagementRate !== undefined)
  ) {
    audReasons.push(
      `Engagement recorded (likes avg ${input.recentLikesAvg ?? "unknown"}, comments avg ${
        input.recentCommentsAvg ?? "unknown"
      }, rate ${input.engagementRate !== null && input.engagementRate !== undefined ? input.engagementRate.toFixed(4) : "unknown"})`,
    );
  }

  rawContactability = Math.min(1, Math.max(0, rawContactability));

  // -------------------------------------------------------------
  // RE-NORMALIZATION
  // If a category is skipped (e.g. no-IG leads skip IG activity and audience fit),
  // re-normalize remaining category weights so they sum to 100.
  // -------------------------------------------------------------
  type CategoryEval = {
    name: ScoreCategoryName;
    displayName: string;
    rawScore: number;
    baseWeight: number;
    skipped: boolean;
    reasons: string[];
  };

  const categories: CategoryEval[] = [
    {
      name: "businessHealth",
      displayName: "Business Health",
      rawScore: rawBusinessHealth,
      baseWeight: weights.businessHealth,
      skipped: bhKnownWeight === 0,
      reasons: bhReasons,
    },
    {
      name: "independence",
      displayName: "Independence",
      rawScore: rawIndependence,
      baseWeight: weights.independence,
      skipped: false,
      reasons: indReasons,
    },
    {
      name: "instagramActivity",
      displayName: "Instagram Activity",
      rawScore: rawInstagramActivity,
      baseWeight: weights.instagramActivity,
      skipped: !hasInstagram,
      reasons: hasInstagram ? igReasons : ["Omitted: Candidate has no Instagram handle (re-normalized)"],
    },
    {
      name: "audienceFit",
      displayName: "Audience Fit",
      rawScore: rawAudienceFit,
      baseWeight: weights.audienceFit,
      skipped: !hasInstagram,
      reasons: hasInstagram ? audReasons : ["Omitted: Candidate has no Instagram handle (re-normalized)"],
    },
    {
      name: "contactability",
      displayName: "Contactability",
      rawScore: rawContactability,
      baseWeight: weights.contactability,
      skipped: false,
      reasons: contReasons,
    },
  ];

  // Active categories sum
  const activeBaseWeightSum = categories
    .filter((c) => !c.skipped)
    .reduce((sum, c) => sum + c.baseWeight, 0);

  const breakdown: ScoreCategoryBreakdown[] = [];
  let calculatedScore = 0;

  for (const cat of categories) {
    if (cat.skipped || activeBaseWeightSum === 0) {
      breakdown.push({
        category: cat.name,
        displayName: cat.displayName,
        weight: 0,
        rawScore: 0,
        points: 0,
        maxPoints: 0,
        skipped: true,
        reasons: cat.reasons,
      });
      continue;
    }

    const effectiveWeight = (cat.baseWeight / activeBaseWeightSum) * 100;
    const points = cat.rawScore * effectiveWeight;
    calculatedScore += points;

    breakdown.push({
      category: cat.name,
      displayName: cat.displayName,
      weight: Math.round(effectiveWeight * 10) / 10,
      rawScore: Math.round(cat.rawScore * 100) / 100,
      points: Math.round(points * 10) / 10,
      maxPoints: Math.round(effectiveWeight * 10) / 10,
      skipped: false,
      reasons: cat.reasons,
    });
  }

  // Bound score 0..100
  const finalScore = Math.min(100, Math.max(0, Math.round(calculatedScore)));

  // Tier determination
  let tier: LeadQualityTier = "D";
  if (finalScore >= thresholds.tierA) {
    tier = "A";
  } else if (finalScore >= thresholds.tierB) {
    tier = "B";
  } else if (finalScore >= thresholds.tierC) {
    tier = "C";
  } else {
    tier = "D";
  }

  // Cap tier at B for no-handle leads when campaign uses Instagram DM
  const isInstagramChannel =
    input.outreachChannel === undefined ||
    input.outreachChannel === "INSTAGRAM" ||
    input.isInstagramCampaign !== false;

  if (!hasInstagram && isInstagramChannel && tier === "A") {
    tier = "B";
    reasons.push("Tier capped at B: Instagram handle unknown for Instagram DM campaign");
  }

  if (!hasOffInstagramContact && (tier === "A" || tier === "B")) {
    tier = "C";
    reasons.push("Tier capped at C: no email/phone/website contact channel (NO_CONTACT_CHANNEL)");
  }

  // Synthesize top-level human-readable reasons
  for (const b of breakdown) {
    if (!b.skipped && b.reasons.length > 0) {
      reasons.push(`${b.displayName}: ${b.reasons.join(", ")}`);
    }
  }

  return {
    score: finalScore,
    tier,
    breakdown,
    reasons,
    flags: Array.from(new Set(flags)),
    isChain,
  };
}
