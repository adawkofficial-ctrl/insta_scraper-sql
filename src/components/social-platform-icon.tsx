import { detectSocialPlatform, SOCIAL_PLATFORM_LABELS } from "@/lib/constants/social-platforms";

export function SocialPlatformIcon({
  platform,
  className = "h-4 w-4",
}: {
  platform: string;
  className?: string;
}) {
  const norm = platform.toLowerCase();
  switch (norm) {
    case "instagram":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
          <circle cx="12" cy="12" r="4.25" />
          <circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "youtube":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
        </svg>
      );
    case "facebook":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
        </svg>
      );
    case "tiktok":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.24 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
        </svg>
      );
    case "twitter":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      );
    case "whatsapp":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M17.472 14.382c-.301-.15-1.782-.879-2.058-.979-.276-.1-.477-.15-.678.15-.2.301-.778.979-.953 1.18-.175.2-.351.226-.652.075-.301-.15-1.272-.469-2.423-1.496-.896-.799-1.501-1.786-1.677-2.087-.175-.301-.019-.464.132-.614.136-.135.301-.351.452-.527.15-.175.2-.301.301-.502.1-.2.05-.376-.025-.526-.075-.15-.678-1.635-.929-2.241-.244-.59-.492-.51-.678-.519l-.578-.01c-.2 0-.527.075-.803.376s-1.054 1.03-1.054 2.512c0 1.482 1.079 2.912 1.23 3.113.15.2 2.124 3.243 5.145 4.547.719.31 1.28.496 1.718.635.722.23 1.38.197 1.899.12.579-.087 1.782-.728 2.033-1.431.251-.703.251-1.305.176-1.431-.075-.126-.276-.201-.577-.351zM12.04 2c-5.523 0-10 4.477-10 10 0 1.764.46 3.485 1.334 5.004L2 22l5.126-1.344A9.957 9.957 0 0 0 12.04 22c5.523 0 10-4.477 10-10s-4.477-10-10-10z" />
        </svg>
      );
    case "linkedin":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
        </svg>
      );
    case "linktree":
    case "linkinbio":
    case "beacons":
    case "biolink":
    case "lnkbio":
    case "campsite":
    case "taplink":
    case "soloto":
    case "hoobe":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      );
    default:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      );
  }
}

export function getLeadLinkClassification(lead: {
  website?: string | null;
  externalUrl?: string | null;
  socialLink?: string | null;
  socialPlatform?: string | null;
}) {
  let socialLink: string | null = lead.socialLink ?? null;
  let socialPlatform: string | null = lead.socialPlatform ?? null;
  let website: string | null = lead.website ?? null;

  // If social link not explicitly stored yet (e.g. older lead), inspect externalUrl
  if (!socialLink && lead.externalUrl) {
    const detected = detectSocialPlatform(lead.externalUrl);
    if (detected) {
      socialLink = detected.url;
      socialPlatform = detected.platform;
    } else if (!website) {
      website = lead.externalUrl;
    }
  }

  // If website was mistakenly stored as a social link
  if (website) {
    const detected = detectSocialPlatform(website);
    if (detected) {
      if (!socialLink) {
        socialLink = detected.url;
        socialPlatform = detected.platform;
      }
      website = null;
    }
  }

  const socialLabel = socialPlatform
    ? (SOCIAL_PLATFORM_LABELS[socialPlatform] ?? socialPlatform)
    : "Social Link";

  return {
    website,
    hasWebsite: !!website && website.trim().length > 0,
    socialLink,
    socialPlatform,
    socialLabel,
    hasSocialLink: !!socialLink && socialLink.trim().length > 0,
  };
}
