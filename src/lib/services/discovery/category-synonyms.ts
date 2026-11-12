/**
 * Category synonym mappings and verification for Instagram discovery.
 *
 * Instagram business profiles have pre-defined category labels (e.g. "Dentist & Dental Office",
 * "Medical & Health", "Software Company", "Product/service").
 *
 * This module provides the allowed synonym set for a target campaign category.
 */

export const CATEGORY_SYNONYMS: Record<string, string[]> = {
  dental: [
    "dental",
    "dentistry",
    "dentist",
    "dentist & dental office",
    "dental clinic",
    "cosmetic dentist",
    "medical & health",
    "health/beauty",
    "health & wellness website",
    "doctor",
    "orthodontist",
    "periodontist",
    "pediatric dentist",
    "endodontist",
    "prosthodontist",
    "oral surgeon",
    "dental service",
    "teeth whitening service",
    "emergency dental service",
    "dental implants provider",
    "dental hygienist",
    "dental radiology",
    "dental laboratory",
  ],
  fitness: [
    "fitness",
    "gym",
    "gym/physical fitness center",
    "fitness trainer",
    "personal trainer",
    "fitness boot camp",
    "sports & recreation",
    "health/beauty",
    "sports club",
    "yoga studio",
    "pilates studio",
    "crossfit",
  ],
  beauty: [
    "beauty",
    "beauty salon",
    "hair salon",
    "spa",
    "cosmetics & beauty supply",
    "skin care service",
    "aesthetician",
    "medical spa",
    "health/beauty",
    "nail salon",
    "barber shop",
  ],
  healthcare: [
    "healthcare",
    "medical & health",
    "doctor",
    "hospital",
    "medical center",
    "clinic",
    "health/beauty",
    "health & wellness website",
    "physical therapist",
  ],
  food: [
    "restaurant",
    "cafe",
    "coffee shop",
    "bakery",
    "food & beverage",
    "bar",
    "diner",
    "caterer",
    "food delivery service",
  ],
  realestate: [
    "real estate",
    "real estate agent",
    "real estate company",
    "property management",
    "commercial real estate agency",
  ],
  lifestyle: [
    "lifestyle",
    "lifestyle service",
    "magazine",
    "media",
    "media/news company",
    "gym",
    "fitness",
    "health/beauty",
    "clothing",
    "clothing (brand)",
    "fashion",
    "performance & event venue",
    "brand",
  ],
};

export function normalizeCategoryString(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Checks whether a candidate profile category matches the allowed set for a campaign.
 *
 * RULES:
 * 1. If profile category is null/empty/undefined, returns TRUE (do not auto-reject on category;
 *    defer to negative keywords + AI gate).
 * 2. If campaign category is null/empty/undefined, returns TRUE (no category constraint).
 * 3. Matching is case-insensitive and trimmed.
 * 4. Checks against the synonym list for the campaign category.
 * 5. Safe fallback: if campaign category has no entry in CATEGORY_SYNONYMS,
 *    use fuzzy contains-match against the campaign category itself.
 */
export function isCategoryAllowed(
  profileCategory: string | null | undefined,
  campaignCategory: string | null | undefined,
): boolean {
  if (!profileCategory || typeof profileCategory !== "string" || profileCategory.trim().length === 0) {
    return true;
  }
  if (!campaignCategory || typeof campaignCategory !== "string" || campaignCategory.trim().length === 0) {
    return true;
  }

  const normalizedProfile = normalizeCategoryString(profileCategory);
  const normalizedCampaign = normalizeCategoryString(campaignCategory);

  if (normalizedProfile.length === 0) return true;
  if (normalizedCampaign.length === 0) return true;

  // Exact match with campaign category
  if (normalizedProfile === normalizedCampaign) {
    return true;
  }

  // Lookup in synonym map (try exact normalized key, or key without spaces/special chars)
  const mapKey = normalizedCampaign.replace(/[^a-z0-9]/g, "");
  const synonyms = CATEGORY_SYNONYMS[normalizedCampaign] ?? CATEGORY_SYNONYMS[mapKey];

  if (synonyms && synonyms.length > 0) {
    for (const syn of synonyms) {
      const normSyn = normalizeCategoryString(syn);
      if (normalizedProfile === normSyn) {
        return true;
      }
      // Substring match: e.g. "Dentist & Dental Office" matches "dentist" or "dental clinic"
      if (normSyn.length >= 4 && (normalizedProfile.includes(normSyn) || normSyn.includes(normalizedProfile))) {
        return true;
      }
    }
    return false;
  }

  // Safe fallback when no entry in synonym map: fuzzy contains-match with campaign category
  return (
    normalizedProfile.includes(normalizedCampaign) ||
    normalizedCampaign.includes(normalizedProfile)
  );
}
