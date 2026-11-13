import { getPrismaClient } from "@/lib/db/prisma";
import { NotFoundError } from "@/lib/errors";

export interface ExportLeadsOptions {
  campaignId: string;
  userId?: string;
  leadIds?: string[];
}

export interface CsvExportResult {
  filename: string;
  csvContent: string;
  totalLeads: number;
}

function escapeCsvValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return val.toString();
  if (val instanceof Date) return val.toISOString();
  const str = String(val);
  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function exportCampaignLeads(
  options: ExportLeadsOptions,
): Promise<CsvExportResult> {
  const { campaignId, userId, leadIds } = options;
  const prisma = getPrismaClient();

  // Verify campaign exists and belongs to user if specified
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: { id: true, name: true },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${campaignId}" was not found.`,
    );
  }

  // Fetch leads for this campaign (excluding DO_NOT_CONTACT suppressed leads)
  const where: Record<string, unknown> = {
    campaignId,
    status: { not: "DO_NOT_CONTACT" },
  };
  if (leadIds && leadIds.length > 0) {
    where.id = { in: leadIds };
  }

  const leads = await prisma.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      username: true,
      instagramUsername: true,
      fullName: true,
      email: true,
      emailConfidence: true,
      emailRole: true,
      phone: true,
      website: true,
      externalUrl: true,
      profileUrl: true,
      followersCount: true,
      followers: true,
      followsCount: true,
      following: true,
      postsCount: true,
      verified: true,
      isVerified: true,
      isBusinessAccount: true,
      isBusiness: true,
      businessCategoryName: true,
      category: true,
      location: true,
      city: true,
      rating: true,
      reviewCount: true,
      gmapsPlaceId: true,
      socialLink: true,
      socialPlatform: true,
      availableChannels: true,
      rawProfileData: true,
      status: true,
      leadScore: true,
      leadQuality: true,
      contactSource: true,
      biography: true,
      source: true,
      createdAt: true,
    },
  });

  const headers = [
    "ID",
    "Business Name",
    "Instagram",
    "Email",
    "Phone",
    "Website",
    "Facebook",
    "TikTok",
    "YouTube",
    "LinkedIn",
    "X",
    "WhatsApp",
    "Other Social",
    "Category",
    "Address",
    "City",
    "Rating",
    "Reviews",
    "Maps URL",
    "Status",
    "Source Notes",
    "Followers",
    "Created At",
  ];

  const lines: string[] = [headers.join(",")];

  for (const lead of leads) {
    const username = lead.username || lead.instagramUsername || "";
    const followers = lead.followersCount ?? lead.followers ?? "";
    const category = lead.businessCategoryName || lead.category || "";
    const website = lead.website || lead.externalUrl || "";

    const raw = (lead.rawProfileData as Record<string, unknown> | null) || {};
    const socialLinks = (raw.socialLinks as Record<string, string> | undefined) || {};

    let facebook = socialLinks.facebook || "";
    let tiktok = socialLinks.tiktok || "";
    let youtube = socialLinks.youtube || "";
    let linkedin = socialLinks.linkedin || "";
    let x = socialLinks.twitter || socialLinks.x || "";
    let whatsapp = socialLinks.whatsapp || "";
    let otherSocial = "";

    if (lead.socialLink && lead.socialPlatform) {
      const plat = lead.socialPlatform.toLowerCase();
      if (plat === "facebook" && !facebook) facebook = lead.socialLink;
      else if (plat === "tiktok" && !tiktok) tiktok = lead.socialLink;
      else if (plat === "youtube" && !youtube) youtube = lead.socialLink;
      else if (plat === "linkedin" && !linkedin) linkedin = lead.socialLink;
      else if ((plat === "twitter" || plat === "x") && !x) x = lead.socialLink;
      else if (plat === "whatsapp" && !whatsapp) whatsapp = lead.socialLink;
      else if (!otherSocial) otherSocial = lead.socialLink;
    }

    const address = (raw.address as string) || (raw.street as string) || lead.location || "";
    const city = lead.city || (raw.city as string) || lead.location || "";
    const mapsUrl = (raw.mapsUrl as string) || (raw.url as string) || (lead.gmapsPlaceId ? `https://www.google.com/maps/place/?q=place_id:${lead.gmapsPlaceId}` : "");
    const sourceNotes = [lead.contactSource, lead.source, lead.availableChannels?.join(";")].filter(Boolean).join(" | ");

    const row = [
      escapeCsvValue(lead.id),
      escapeCsvValue(lead.fullName || ""),
      escapeCsvValue(username ? `@${username}` : ""),
      escapeCsvValue(lead.email || ""),
      escapeCsvValue(lead.phone || ""),
      escapeCsvValue(website),
      escapeCsvValue(facebook),
      escapeCsvValue(tiktok),
      escapeCsvValue(youtube),
      escapeCsvValue(linkedin),
      escapeCsvValue(x),
      escapeCsvValue(whatsapp),
      escapeCsvValue(otherSocial),
      escapeCsvValue(category),
      escapeCsvValue(address),
      escapeCsvValue(city),
      escapeCsvValue(lead.rating ?? ""),
      escapeCsvValue(lead.reviewCount ?? ""),
      escapeCsvValue(mapsUrl),
      escapeCsvValue(lead.status || ""),
      escapeCsvValue(sourceNotes),
      escapeCsvValue(followers),
      escapeCsvValue(lead.createdAt ? lead.createdAt.toISOString() : ""),
    ];

    lines.push(row.join(","));
  }

  // Prepend UTF-8 BOM for Microsoft Excel compatibility
  const BOM = "\uFEFF";
  const csvContent = BOM + lines.join("\r\n");

  const sanitizedCampaignName = (campaign.name || "campaign")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  const filename = `${sanitizedCampaignName || "campaign"}-leads.csv`;

  return {
    filename,
    csvContent,
    totalLeads: leads.length,
  };
}
