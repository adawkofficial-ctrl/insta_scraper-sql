export type TemplateLeadContext = {
  username: string;
  fullName?: string | null;
  biography?: string | null;
  category?: string | null;
  businessCategory?: string | null;
  businessCategoryName?: string | null;
  followersCount?: number | null;
  followers?: number | null;
  followingCount?: number | null;
  following?: number | null;
  postsCount?: number | null;
  externalUrl?: string | null;
  profileUrl?: string | null;
};

export type TemplateVariableDefinition = {
  /** Canonical variable name, without braces. */
  name: string;
  label: string;
  description: string;
  /** Example value used for the client-side sample preview. */
  sample: string;
};

/**
 * Single source of truth for the variables a template may use. Shared by
 * validation, rendering, the preview endpoint and the UI variable picker.
 */
export const TEMPLATE_VARIABLE_DEFINITIONS: TemplateVariableDefinition[] = [
  { name: "username", label: "Username", description: "Instagram handle", sample: "natgeo" },
  { name: "fullName", label: "Full Name", description: "Lead's full name", sample: "National Geographic" },
  { name: "firstName", label: "First Name", description: "First name (falls back to username)", sample: "National" },
  { name: "biography", label: "Biography", description: "Instagram bio text", sample: "Exploring the world since 1888" },
  { name: "followersCount", label: "Followers", description: "Follower count", sample: "280000000" },
  { name: "followingCount", label: "Following", description: "Following count", sample: "150" },
  { name: "postsCount", label: "Posts", description: "Number of posts", sample: "30000" },
  { name: "businessCategory", label: "Business Category", description: "Business/category", sample: "Media" },
  { name: "externalUrl", label: "Website", description: "External website", sample: "https://www.natgeo.com" },
  { name: "profileUrl", label: "Profile URL", description: "Instagram profile link", sample: "https://www.instagram.com/natgeo/" },
  { name: "campaignName", label: "Campaign Name", description: "Current campaign name", sample: "Outreach" },
  { name: "campaignDescription", label: "Campaign Description", description: "Services or description of the campaign", sample: "Custom dental marketing and patient acquisition" },
  { name: "services", label: "Services", description: "Services offered in this campaign", sample: "Custom dental marketing and patient acquisition" },
  { name: "senderName", label: "Sender Name", description: "Your account display name", sample: "Alex" },
];

// Backwards-compatible aliases still accepted in existing templates.
export const TEMPLATE_VARIABLE_ALIASES: Record<string, string> = {
  bio: "biography",
  category: "businessCategory",
  followers: "followersCount",
  following: "followingCount",
  services: "campaignDescription",
  description: "campaignDescription",
};

export const SUPPORTED_TEMPLATE_VARIABLES = [
  ...TEMPLATE_VARIABLE_DEFINITIONS.map((definition) => definition.name),
  ...Object.keys(TEMPLATE_VARIABLE_ALIASES),
] as const;

export const SUPPORTED_VARIABLES_SET = new Set(
  SUPPORTED_TEMPLATE_VARIABLES.map((variable) => variable.toLowerCase()),
);

const VARIABLE_PATTERN = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

/** Returns the distinct variable names used in a template body. */
export function extractTemplateVariables(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    found.add(match[1].toLowerCase());
  }
  return Array.from(found);
}

/** Validates that every variable used belongs to the supported list. */
export function validateTemplateVariables(text: string): {
  valid: boolean;
  unsupported: string[];
} {
  const unsupported = extractTemplateVariables(text).filter(
    (variable) => !SUPPORTED_VARIABLES_SET.has(variable),
  );

  return { valid: unsupported.length === 0, unsupported };
}

/**
 * Deterministic first-name resolver:
 * first token of fullName -> username -> fallback.
 */
export function resolveFirstName(
  fullName?: string | null,
  username?: string | null,
  fallback = "there",
): string {
  if (fullName && fullName.trim().length > 0) {
    const cleaned = fullName.trim().split(/[\s|•\-,]+/)[0];
    if (cleaned && cleaned.length > 0) {
      return cleaned;
    }
  }
  if (username && username.trim().length > 0) {
    return username.trim();
  }
  return fallback;
}

/**
 * Own-property lookup only. Prevents prototype-chain leakage such as
 * {{constructor}} / {{__proto__}} resolving to JavaScript internals.
 */
function lookupVariable(
  map: Record<string, string>,
  key: string,
): string | null {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

export type CampaignContextData =
  | string
  | {
      name?: string | null;
      description?: string | null;
      intent?: string | null;
      category?: string | null;
    }
  | null;

function buildVariableMap(
  lead: TemplateLeadContext,
  campaignContext?: CampaignContextData,
  senderName?: string | null,
): Record<string, string> {
  const firstName = resolveFirstName(lead.fullName, lead.username);
  const fullName = lead.fullName?.trim() || lead.username || "";
  const username = lead.username || "";
  const category =
    lead.businessCategory?.trim() ||
    lead.businessCategoryName?.trim() ||
    lead.category?.trim() ||
    "";
  const biography = lead.biography?.trim() || "";
  const followers =
    lead.followersCount !== undefined && lead.followersCount !== null
      ? String(lead.followersCount)
      : lead.followers !== undefined && lead.followers !== null
        ? String(lead.followers)
        : "";
  const following =
    lead.followingCount !== undefined && lead.followingCount !== null
      ? String(lead.followingCount)
      : lead.following !== undefined && lead.following !== null
        ? String(lead.following)
        : "";
  const posts =
    lead.postsCount !== undefined && lead.postsCount !== null
      ? String(lead.postsCount)
      : "";
  const externalUrl = lead.externalUrl?.trim() || "";
  const profileUrl =
    lead.profileUrl?.trim() ||
    (username ? `https://www.instagram.com/${username}/` : "");

  let campaignName = "";
  let campaignDescription = "";
  if (typeof campaignContext === "string") {
    campaignName = campaignContext.trim();
  } else if (campaignContext && typeof campaignContext === "object") {
    campaignName = campaignContext.name?.trim() || "";
    campaignDescription =
      campaignContext.description?.trim() || campaignContext.intent?.trim() || "";
  }

  const sender = senderName?.trim() || "";

  return {
    username,
    fullname: fullName,
    firstname: firstName,
    biography,
    followerscount: followers,
    followingcount: following,
    postscount: posts,
    businesscategory: category,
    externalurl: externalUrl,
    profileurl: profileUrl,
    campaignname: campaignName,
    campaigndescription: campaignDescription,
    services: campaignDescription,
    description: campaignDescription,
    sendername: sender,
    // aliases
    bio: biography,
    category,
    followers,
    following,
  };
}

export type RenderedTemplate = {
  text: string;
  usedVariables: string[];
  /** Variables present in the template that resolved to an empty value. */
  missingVariables: string[];
};

/**
 * Centralized, deterministic renderer. Plain string replacement only —
 * no eval, no expressions, no arbitrary database access.
 */
export function renderTemplateDetailed(
  templateBody: string,
  lead: TemplateLeadContext,
  campaignContext?: CampaignContextData,
  senderName?: string | null,
): RenderedTemplate {
  if (!templateBody) {
    return { text: "", usedVariables: [], missingVariables: [] };
  }

  const variableMap = buildVariableMap(lead, campaignContext, senderName);
  const usedVariables = extractTemplateVariables(templateBody);
  const missingVariables = usedVariables.filter((variable) => {
    const value = lookupVariable(variableMap, variable);
    return value === null || value.length === 0;
  });

  const text = templateBody
    .replace(VARIABLE_PATTERN, (_match, key: string) => {
      // Own-property lookup only; unsupported/dangerous keys become empty.
      return lookupVariable(variableMap, key.toLowerCase()) ?? "";
    })
    .replace(/[ \t]+/g, " ")
    .trim();

  return { text, usedVariables, missingVariables };
}

/** Backwards-compatible string-only renderer. */
export function renderTemplate(
  templateBody: string,
  lead: TemplateLeadContext,
  campaignContext?: CampaignContextData,
  senderName?: string | null,
): string {
  return renderTemplateDetailed(templateBody, lead, campaignContext, senderName)
    .text;
}
