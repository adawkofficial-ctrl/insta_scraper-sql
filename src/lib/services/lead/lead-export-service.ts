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

  // Fetch leads for this campaign
  const where: Record<string, unknown> = { campaignId };
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
    "Username",
    "Full Name",
    "Email",
    "Email Confidence",
    "Email Role",
    "Phone",
    "Website",
    "Profile URL",
    "Followers",
    "Following",
    "Posts Count",
    "Verified",
    "Business Account",
    "Category",
    "Location",
    "Status",
    "Lead Score",
    "Lead Quality",
    "Contact Source",
    "Biography",
    "Source",
    "Created At",
  ];

  const lines: string[] = [headers.join(",")];

  for (const lead of leads) {
    const username = lead.username || lead.instagramUsername || "";
    const emailConfidenceStr =
      lead.emailConfidence !== null && lead.emailConfidence !== undefined
        ? `${Math.round(lead.emailConfidence * 100)}%`
        : "";
    const followers = lead.followersCount ?? lead.followers ?? "";
    const following = lead.followsCount ?? lead.following ?? "";
    const verified = lead.verified ?? lead.isVerified ?? false;
    const isBusiness = lead.isBusinessAccount ?? lead.isBusiness ?? false;
    const category = lead.businessCategoryName || lead.category || "";
    const website = lead.website || lead.externalUrl || "";
    const profileUrl =
      lead.profileUrl || (username ? `https://instagram.com/${username}` : "");

    const row = [
      escapeCsvValue(lead.id),
      escapeCsvValue(username),
      escapeCsvValue(lead.fullName || ""),
      escapeCsvValue(lead.email || ""),
      escapeCsvValue(emailConfidenceStr),
      escapeCsvValue(lead.emailRole || ""),
      escapeCsvValue(lead.phone || ""),
      escapeCsvValue(website),
      escapeCsvValue(profileUrl),
      escapeCsvValue(followers),
      escapeCsvValue(following),
      escapeCsvValue(lead.postsCount ?? ""),
      escapeCsvValue(verified),
      escapeCsvValue(isBusiness),
      escapeCsvValue(category),
      escapeCsvValue(lead.location || ""),
      escapeCsvValue(lead.status || ""),
      escapeCsvValue(lead.leadScore ?? ""),
      escapeCsvValue(lead.leadQuality || ""),
      escapeCsvValue(lead.contactSource || ""),
      escapeCsvValue(lead.biography || ""),
      escapeCsvValue(lead.source || ""),
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
