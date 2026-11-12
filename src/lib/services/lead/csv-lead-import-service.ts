import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { LeadStatus, Prisma } from "@/generated/prisma/client";
import { NotFoundError, BadRequestError } from "@/lib/errors";
import { parseLeadCsv, type CsvParseResult } from "./csv-lead-parser";

export type CsvImportOptions = {
  skipExisting?: boolean; // If true, don't update existing leads, just skip
  defaultStatus?: LeadStatus; // Defaults to NEW
};

export type CsvImportResult = {
  success: boolean;
  campaignId: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createdCount: number;
  updatedCount: number;
  skippedDuplicates: number;
  errors: Array<{ row: number; reason: string; snippet: string }>;
  sampleLeads: Array<{ id: string; username: string | null; fullName: string | null; status: string }>;
};

/**
 * Extracts domain name from a website URL.
 */
function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const raw = url.startsWith("http") ? url : `https://${url}`;
    const parsed = new URL(raw);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Previews CSV leads without modifying the database.
 */
export async function previewCsvLeads(csvText: string): Promise<CsvParseResult> {
  if (!csvText || typeof csvText !== "string" || !csvText.trim()) {
    throw new BadRequestError("EMPTY_CSV", "Uploaded CSV content is empty.");
  }
  return parseLeadCsv(csvText, 1000);
}

/**
 * Imports leads from CSV into a target campaign.
 */
export async function importLeadsFromCsv(
  campaignId: string,
  userId: string,
  csvText: string,
  options?: CsvImportOptions,
): Promise<CsvImportResult> {
  const prisma = getPrismaClient();

  // 1. Verify campaign ownership
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: { id: true, userId: true, leadLimit: true },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${campaignId}" was not found.`,
    );
  }

  // 2. Parse CSV
  const parseResult = parseLeadCsv(csvText, 2000);
  if (parseResult.leads.length === 0) {
    return {
      success: true,
      campaignId,
      totalRows: parseResult.totalRows,
      validRows: 0,
      invalidRows: parseResult.invalidCount,
      createdCount: 0,
      updatedCount: 0,
      skippedDuplicates: 0,
      errors: parseResult.errors,
      sampleLeads: [],
    };
  }

  const defaultStatus = options?.defaultStatus || LeadStatus.NEW;

  // 3. Check existing leads in this campaign
  const candidateUsernames = parseResult.leads.map((l) => l.username);
  const existingLeads = await prisma.lead.findMany({
    where: {
      campaignId: campaign.id,
      username: { in: candidateUsernames },
    },
    select: {
      id: true,
      username: true,
      email: true,
      phone: true,
      website: true,
      fullName: true,
    },
  });

  const existingMap = new Map(
    existingLeads
      .filter((l): l is typeof l & { username: string } => typeof l.username === "string" && l.username.length > 0)
      .map((l) => [l.username.toLowerCase(), l]),
  );

  let createdCount = 0;
  let updatedCount = 0;
  let skippedDuplicates = 0;
  const sampleLeads: Array<{ id: string; username: string | null; fullName: string | null; status: string }> = [];

  // Check lead limit if configured
  const currentLeadCount = await prisma.lead.count({ where: { campaignId: campaign.id } });
  const remainingAllowance =
    campaign.leadLimit != null ? Math.max(0, campaign.leadLimit - currentLeadCount) : Infinity;

  // 4. Batch create or update leads in database transaction
  await prisma.$transaction(async (tx) => {
    for (const item of parseResult.leads) {
      const existing = existingMap.get(item.username);

      const availableChannels: string[] = ["instagram"];
      if (item.email) availableChannels.push("email");
      if (item.phone) availableChannels.push("phone");

      const websiteDomain = extractDomain(item.website);

      if (existing) {
        if (options?.skipExisting) {
          skippedDuplicates++;
          continue;
        }

        // Update existing lead with any new contact data provided in CSV
        const updateData: Prisma.LeadUpdateInput = {};
        let hasChanges = false;

        if (item.fullName && !existing.fullName) {
          updateData.fullName = item.fullName;
          hasChanges = true;
        }
        if (item.email && !existing.email) {
          updateData.email = item.email;
          updateData.emailNormalized = item.email.toLowerCase();
          hasChanges = true;
        }
        if (item.phone && !existing.phone) {
          updateData.phone = item.phone;
          updateData.phoneNormalized = item.phone.replace(/\D/g, "");
          hasChanges = true;
        }
        if (item.website && !existing.website) {
          updateData.website = item.website;
          updateData.websiteDomain = websiteDomain;
          hasChanges = true;
        }
        if (item.category) {
          updateData.category = item.category;
          updateData.businessCategoryName = item.category;
          hasChanges = true;
        }
        if (item.followersCount != null) {
          updateData.followers = item.followersCount;
          updateData.followersCount = item.followersCount;
          hasChanges = true;
        }

        if (hasChanges) {
          await tx.lead.update({
            where: { id: existing.id },
            data: updateData,
          });
          updatedCount++;
        } else {
          skippedDuplicates++;
        }

        if (sampleLeads.length < 5) {
          sampleLeads.push({
            id: existing.id,
            username: item.username,
            fullName: item.fullName,
            status: "UPDATED",
          });
        }
      } else {
        // Enforce campaign lead limit if reached
        if (createdCount >= remainingAllowance) {
          break;
        }

        const newLead = await tx.lead.create({
          data: {
            campaignId: campaign.id,
            userId: campaign.userId,
            username: item.username,
            usernameNormalized: item.username,
            profileUrl: item.profileUrl,
            fullName: item.fullName,
            biography: item.biography,
            email: item.email,
            emailNormalized: item.email ? item.email.toLowerCase() : null,
            phone: item.phone,
            phoneNormalized: item.phone ? item.phone.replace(/\D/g, "") : null,
            website: item.website,
            websiteDomain,
            category: item.category,
            businessCategoryName: item.category,
            followers: item.followersCount,
            followersCount: item.followersCount,
            following: item.followingCount,
            followsCount: item.followingCount,
            postsCount: item.postsCount,
            isVerified: item.isVerified,
            verified: item.isVerified,
            isBusiness: item.isBusinessAccount,
            isBusinessAccount: item.isBusinessAccount,
            location: item.location,
            source: "csv_upload",
            status: defaultStatus,
            availableChannels,
            contactSource: item.email || item.phone ? "csv" : null,
          },
        });

        // Record initial status history
        await tx.leadStatusHistory.create({
          data: {
            leadId: newLead.id,
            fromStatus: null,
            toStatus: defaultStatus,
            reason: "csv_import",
            actor: userId ? `user:${userId}` : "csv_importer",
          },
        });

        // Record sighting provenance
        await tx.leadSighting.create({
          data: {
            leadId: newLead.id,
            campaignId: campaign.id,
            source: "csv_upload",
            matchedBy: "csv_row",
          },
        });

        createdCount++;

        if (sampleLeads.length < 5) {
          sampleLeads.push({
            id: newLead.id,
            username: newLead.username,
            fullName: newLead.fullName,
            status: "CREATED",
          });
        }
      }
    }
  });

  return {
    success: true,
    campaignId,
    totalRows: parseResult.totalRows,
    validRows: parseResult.validCount,
    invalidRows: parseResult.invalidCount,
    createdCount,
    updatedCount,
    skippedDuplicates,
    errors: parseResult.errors,
    sampleLeads,
  };
}
