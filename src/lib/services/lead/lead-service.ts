import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { LeadStatus } from "@/generated/prisma/enums";
import { getPrismaClient } from "@/lib/db/prisma";
import { BadRequestError, NotFoundError } from "@/lib/errors";

export type ListLeadsOptions = {
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
  verified?: boolean;
  isVerified?: boolean;
  isBusinessAccount?: boolean;
  isBusiness?: boolean;
  status?: string;
};

export type PaginatedLeadsResult = {
  items: unknown[];
  leads: unknown[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};

const MAX_LEAD_FIELD_LENGTH = 5000;

export async function listCampaignLeads(
  campaignId: string,
  rawParams: URLSearchParams | Record<string, string | undefined>,
  userId?: string,
): Promise<PaginatedLeadsResult> {
  const prisma = getPrismaClient();

  // Verify campaign exists and belongs to user if specified
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: { id: true },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", "Campaign not found");
  }

  const getParam = (key: string): string | undefined => {
    if (rawParams instanceof URLSearchParams) {
      return rawParams.get(key) ?? undefined;
    }
    return rawParams[key];
  };

  // Parse and validate pagination
  const rawPage = getParam("page");
  let page = 1;
  if (rawPage !== undefined) {
    const trimmed = rawPage.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new BadRequestError(
        "INVALID_PAGE",
        '"page" must be a positive integer.',
      );
    }
    page = Number.parseInt(trimmed, 10);
    if (page < 1) {
      throw new BadRequestError(
        "INVALID_PAGE",
        '"page" must be a positive integer.',
      );
    }
  }

  const rawLimit = getParam("limit");
  let limit = 25;
  if (rawLimit !== undefined) {
    const trimmed = rawLimit.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new BadRequestError(
        "INVALID_LIMIT",
        '"limit" must be an integer between 1 and 100.',
      );
    }
    limit = Number.parseInt(trimmed, 10);
    if (limit < 1 || limit > 100) {
      throw new BadRequestError(
        "INVALID_LIMIT",
        '"limit" must be an integer between 1 and 100.',
      );
    }
  }

  // Build filters using clean composable AND array
  const conditions: Prisma.LeadWhereInput[] = [{ campaignId }];

  const rawSearch = getParam("search");
  if (rawSearch !== undefined) {
    const search = rawSearch.trim();
    if (search.length > 0) {
      conditions.push({
        OR: [
          { username: { contains: search } },
          { fullName: { contains: search } },
          { biography: { contains: search } },
        ],
      });
    }
  }

  const rawCategory = getParam("category");
  if (rawCategory !== undefined) {
    const category = rawCategory.trim();
    if (category.length > 0) {
      conditions.push({
        OR: [
          { category: { contains: category } },
          { businessCategoryName: { contains: category } },
        ],
      });
    }
  }

  const rawVerified = getParam("verified") ?? getParam("isVerified");
  if (rawVerified !== undefined) {
    const val = rawVerified.toLowerCase().trim();
    if (val === "true") {
      conditions.push({
        OR: [{ verified: true }, { isVerified: true }],
      });
    } else if (val === "false") {
      conditions.push({
        AND: [
          { OR: [{ verified: false }, { verified: null }] },
          { OR: [{ isVerified: false }, { isVerified: null }] },
        ],
      });
    } else {
      throw new BadRequestError(
        "INVALID_FILTER",
        '"verified" must be "true" or "false".',
      );
    }
  }

  const rawBusiness =
    getParam("isBusinessAccount") ??
    getParam("business") ??
    getParam("isBusiness");
  if (rawBusiness !== undefined) {
    const val = rawBusiness.toLowerCase().trim();
    if (val === "true") {
      conditions.push({
        OR: [{ isBusinessAccount: true }, { isBusiness: true }],
      });
    } else if (val === "false") {
      conditions.push({
        AND: [
          { OR: [{ isBusinessAccount: false }, { isBusinessAccount: null }] },
          { OR: [{ isBusiness: false }, { isBusiness: null }] },
        ],
      });
    } else {
      throw new BadRequestError(
        "INVALID_FILTER",
        '"isBusinessAccount" must be "true" or "false".',
      );
    }
  }

  const rawStatus = getParam("status");
  if (rawStatus !== undefined) {
    const trimmedStatus = rawStatus.trim().toUpperCase();
    if (trimmedStatus && trimmedStatus !== "ALL") {
      if (trimmedStatus === "NEW") {
        conditions.push({ status: LeadStatus.NEW });
      } else if (trimmedStatus === "CONTACTED") {
        conditions.push({ status: LeadStatus.CONTACTED });
      } else if (trimmedStatus === "SENDING" || trimmedStatus === "QUEUED") {
        conditions.push({ status: LeadStatus.QUEUED });
      } else if (trimmedStatus === "FAILED") {
        conditions.push({ messages: { some: { status: "FAILED" } } });
      } else if (Object.values(LeadStatus).includes(trimmedStatus as LeadStatus)) {
        conditions.push({ status: trimmedStatus as LeadStatus });
      } else {
        throw new BadRequestError(
          "INVALID_STATUS_FILTER",
          `Invalid status filter: "${rawStatus}". Allowed values: NEW, CONTACTED, SENDING, FAILED, ${Object.values(LeadStatus).join(", ")}.`,
        );
      }
    }
  }

  // Step 4: hide duplicate-linked leads when requested (UI toggle).
  if ((getParam("excludeDuplicates") ?? "").toLowerCase() === "true") {
    conditions.push({ duplicateOfLeadId: null });
  }

  // Part E: Filter by available contact channel ("has email", "has phone", "Instagram only")
  const rawChannel = getParam("channel") ?? getParam("availableChannel");
  if (rawChannel !== undefined) {
    const trimmedChannel = rawChannel.trim().toLowerCase();
    if (trimmedChannel && trimmedChannel !== "all") {
      if (trimmedChannel === "has_instagram" || trimmedChannel === "with_instagram") {
        conditions.push({ hasInstagram: true });
      } else if (trimmedChannel === "no_instagram" || trimmedChannel === "without_instagram") {
        conditions.push({ hasInstagram: false });
      } else if (trimmedChannel === "has_email" || trimmedChannel === "email") {
        conditions.push({
          OR: [
            { hasEmail: true },
            { email: { not: null } },
            { emailNormalized: { not: null } },
          ],
        });
      } else if (trimmedChannel === "has_phone" || trimmedChannel === "phone") {
        conditions.push({
          OR: [
            { hasPhone: true },
            { phone: { not: null } },
            { phoneNormalized: { not: null } },
          ],
        });
      } else if (trimmedChannel === "has_website" || trimmedChannel === "website") {
        conditions.push({
          OR: [
            { hasWebsite: true },
            { website: { not: null } },
            { websiteDomain: { not: null } },
          ],
        });
      } else if (
        trimmedChannel === "has_ig_website_or_email" ||
        trimmedChannel === "has_contact" ||
        trimmedChannel === "contactable"
      ) {
        // Contactable = has an Instagram handle, a website, or an email.
        conditions.push({
          OR: [
            { hasInstagram: true },
            { hasWebsite: true },
            { hasEmail: true },
            { website: { not: null } },
            { websiteDomain: { not: null } },
            { email: { not: null } },
            { emailNormalized: { not: null } },
          ],
        });
      } else if (trimmedChannel === "has_social" || trimmedChannel === "has_other_social" || trimmedChannel === "social") {
        conditions.push({
          OR: [
            { hasOtherSocial: true },
            { socialLink: { not: null } },
          ],
        });
      } else if (trimmedChannel === "instagram_only" || trimmedChannel === "instagram") {
        conditions.push({
          AND: [
            { hasInstagram: true },
            { OR: [{ hasEmail: false }, { email: null }, { email: "" }] },
            { OR: [{ hasPhone: false }, { phone: null }, { phone: "" }] },
          ],
        });
      } else {
        throw new BadRequestError(
          "INVALID_CHANNEL_FILTER",
          `Invalid channel filter: "${rawChannel}". Allowed values: has_instagram, no_instagram, has_email, has_phone, has_website, has_social, has_ig_website_or_email, instagram_only, all.`,
        );
      }
    }
  }

  // Filter by enrichment status ("enriched" or "not_enriched")
  const rawEnrichment = getParam("enrichmentStatus");
  if (rawEnrichment !== undefined) {
    const trimmedEnrichment = rawEnrichment.trim().toLowerCase();
    if (trimmedEnrichment && trimmedEnrichment !== "all") {
      if (trimmedEnrichment === "enriched") {
        conditions.push({
          OR: [
            { biography: { not: null } },
            { followersCount: { not: null } },
            {
              rawProfileData: {
                path: "$.enrichmentStatus",
                equals: "ENRICHED",
              },
            },
          ],
        });
      } else if (trimmedEnrichment === "not_enriched") {
        conditions.push({
          OR: [
            { rawProfileData: { path: "$.enrichmentStatus", equals: "NOT_ENRICHED" } },
            {
              AND: [
                { followersCount: null },
                { followers: null },
              ],
            },
          ],
        });
      }
    }
  }

  // Quality Tier filter ("A", "B", "C", "D" or comma-separated "A,B")
  const rawTier = getParam("tier") ?? getParam("qualityTier");
  if (rawTier !== undefined) {
    const tiers = rawTier
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter((t) => ["A", "B", "C", "D"].includes(t));
    if (tiers.length > 0) {
      conditions.push({ qualityTier: { in: tiers } });
    }
  }

  // Quality Flags filter (e.g. "LOW_REVIEWS", "POSSIBLE_CHAIN", etc.)
  const rawFlags = getParam("flags") ?? getParam("scoreFlags") ?? getParam("flag");
  if (rawFlags !== undefined) {
    const flags = rawFlags
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    if (flags.length > 0) {
      conditions.push({ scoreFlags: { some: { flag: { in: flags } } } });
    }
  }

  // Chain filter
  const rawChain = getParam("isChain");
  if (rawChain !== undefined) {
    const val = rawChain.trim().toLowerCase();
    if (val === "true" || val === "false") {
      conditions.push({ isChain: val === "true" });
    }
  }

  const where: Prisma.LeadWhereInput = {
    AND: conditions,
  };

  const skip = (page - 1) * limit;

  // Sorting
  const sortBy = getParam("sort") ?? getParam("sortBy");
  const sortOrder =
    (getParam("order") ?? getParam("sortOrder") ?? "desc").toLowerCase() === "asc"
      ? "asc"
      : "desc";

  let orderBy: Prisma.LeadOrderByWithRelationInput[] = [
    { createdAt: "desc" },
    { id: "desc" },
  ];
  if (sortBy === "qualityScore" || sortBy === "score") {
    orderBy = [{ qualityScore: sortOrder }, { createdAt: "desc" }, { id: "desc" }];
  } else if (sortBy === "rating") {
    orderBy = [{ rating: sortOrder }, { createdAt: "desc" }];
  } else if (sortBy === "reviewCount") {
    orderBy = [{ reviewCount: sortOrder }, { createdAt: "desc" }];
  }

  const [total, items] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy,
      skip,
      take: limit,
    }),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  const mappedItems = items.map((lead) => ({
    ...lead,
    status: lead.status === LeadStatus.QUEUED ? "SENDING" : lead.status,
    leadStatus: lead.status,
  }));

  return {
    items: mappedItems,
    leads: mappedItems,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  };
}

export async function getLeadById(
  leadId: string,
  userId?: string,
): Promise<unknown> {
  const prisma = getPrismaClient();

  const lead = await prisma.lead.findFirst({
    where: {
      id: leadId,
      ...(userId ? { campaign: { userId } } : {}),
    },
    include: {
      campaign: {
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
        },
      },
      // Step 4 dedup provenance for the lead drawer.
      duplicateOf: { select: { id: true, username: true } },
      possibleDuplicateOf: { select: { id: true, username: true } },
      _count: { select: { sightings: true } },
      followUpMessages: {
        orderBy: { step: "asc" },
        select: {
          id: true,
          step: true,
          status: true,
          templateText: true,
          renderedBody: true,
          dueAt: true,
          sentAt: true,
          retryAt: true,
          cancelReason: true,
          errorCode: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!lead) {
    throw new NotFoundError("LEAD_NOT_FOUND", "Lead not found");
  }

  return {
    ...lead,
    status: lead.status === LeadStatus.QUEUED ? "SENDING" : lead.status,
    leadStatus: lead.status,
  };
}

export async function updateLead(
  leadId: string,
  input: unknown,
  userId?: string,
): Promise<unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }

  // Ensure lead exists and belongs to user
  await getLeadById(leadId, userId);

  const record = input as Record<string, unknown>;
  const allowedKeys = new Set(["fullName", "category", "biography", "externalUrl"]);

  const unexpectedKeys = Object.keys(record).filter((k) => !allowedKeys.has(k));
  if (unexpectedKeys.length > 0) {
    throw new BadRequestError(
      "UNALLOWED_FIELDS",
      `Cannot update fields: ${unexpectedKeys.join(", ")}. Allowed fields are: fullName, category, biography, externalUrl.`,
    );
  }

  const data: {
    fullName?: string | null;
    category?: string | null;
    biography?: string | null;
    externalUrl?: string | null;
  } = {};

  const processField = (key: keyof typeof data) => {
    if (record[key] !== undefined) {
      const val = record[key];
      if (val === null) {
        data[key] = null;
      } else if (typeof val === "string") {
        const trimmed = val.trim();
        if (trimmed.length > MAX_LEAD_FIELD_LENGTH) {
          throw new BadRequestError(
            "FIELD_TOO_LONG",
            `"${key}" exceeds maximum length of ${MAX_LEAD_FIELD_LENGTH} characters.`,
          );
        }
        data[key] = trimmed.length > 0 ? trimmed : null;
      } else {
        throw new BadRequestError(
          "INVALID_FIELD_TYPE",
          `"${key}" must be a string or null.`,
        );
      }
    }
  };

  processField("fullName");
  processField("category");
  processField("biography");
  processField("externalUrl");

  if (Object.keys(data).length === 0) {
    throw new BadRequestError("NO_UPDATES", "No valid update fields were provided.");
  }

  const prisma = getPrismaClient();
  const updated = await prisma.lead.update({
    where: { id: leadId },
    data,
    include: {
      campaign: {
        select: {
          id: true,
          name: true,
          status: true,
        },
      },
    },
  });

  return {
    ...updated,
    status: updated.status === LeadStatus.QUEUED ? "SENDING" : updated.status,
    leadStatus: updated.status,
  };
}

export async function deleteLead(
  leadId: string,
  userId?: string,
): Promise<{
  id: string;
  deleted: true;
}> {
  // Ensure lead exists and belongs to user
  await getLeadById(leadId, userId);

  const prisma = getPrismaClient();
  await prisma.lead.delete({
    where: { id: leadId },
  });

  return {
    id: leadId,
    deleted: true,
  };
}

export async function deleteLeads(
  leadIds: string[],
  userId?: string,
): Promise<{
  deletedCount: number;
  deletedIds: string[];
}> {
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return { deletedCount: 0, deletedIds: [] };
  }

  const prisma = getPrismaClient();

  // Find all leads that match and belong to user (if userId provided)
  const whereClause: Parameters<typeof prisma.lead.findMany>[0] = {
    where: {
      id: { in: leadIds },
      ...(userId ? { campaign: { userId } } : {}),
    },
    select: { id: true },
  };

  const matches = await prisma.lead.findMany(whereClause);
  const idsToDelete = matches.map((m) => m.id);

  if (idsToDelete.length === 0) {
    return { deletedCount: 0, deletedIds: [] };
  }

  const result = await prisma.lead.deleteMany({
    where: { id: { in: idsToDelete } },
  });

  return {
    deletedCount: result.count,
    deletedIds: idsToDelete,
  };
}

export async function deleteDryRunLeads(
  campaignId: string,
  userId?: string,
): Promise<{ deletedCount: number }> {
  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: { id: true },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", "Campaign not found");
  }

  const result = await prisma.lead.deleteMany({
    where: {
      campaignId,
      OR: [
        { source: "dry_run" },
        { source: "sample" },
        { username: { startsWith: "sample_" } },
      ],
    },
  });

  return { deletedCount: result.count };
}

