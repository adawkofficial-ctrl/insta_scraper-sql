import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors";

import {
  MAX_PREVIEW_LEADS,
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
} from "./template-constants";
import {
  SUPPORTED_TEMPLATE_VARIABLES,
  renderTemplateDetailed,
  validateTemplateVariables,
} from "./template-renderer";

export type MessageTemplateSummary = {
  id: string;
  campaignId: string | null;
  name: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TemplateLeadPreview = {
  lead: {
    id: string;
    username: string;
    fullName: string | null;
    profileUrl: string;
    profilePictureUrl: string | null;
    isVerified: boolean | null;
    isBusiness: boolean | null;
    category: string | null;
    followers: number | null;
    following: number | null;
    postsCount: number | null;
    externalUrl: string | null;
  };
  text: string;
  missingVariables: string[];
};

export type TemplatePreviewResult = {
  template: { id: string; name: string; body: string };
  campaign: { id: string; name: string };
  /** Draft preview only — nothing is ever dispatched by this endpoint. */
  sent: false;
  previews: TemplateLeadPreview[];
};

const TEMPLATE_SELECT = {
  id: true,
  campaignId: true,
  name: true,
  body: true,
  createdAt: true,
  updatedAt: true,
} as const;

function assertValidBodyVariables(body: string): void {
  const { valid, unsupported } = validateTemplateVariables(body);
  if (!valid) {
    throw new BadRequestError(
      "UNSUPPORTED_VARIABLES",
      `Unsupported template variable(s): ${unsupported
        .map((variable) => `{{${variable}}}`)
        .join(", ")}. Supported variables: ${SUPPORTED_TEMPLATE_VARIABLES.join(
        ", ",
      )}.`,
    );
  }
}

function assertMutableTemplate(template: MessageTemplateSummary): void {
  if (template.campaignId === null) {
    throw new ForbiddenError(
      "GLOBAL_TEMPLATE_READONLY",
      "Global templates are shared and cannot be modified.",
    );
  }
}

export async function createCampaignTemplate(
  campaignId: string,
  input: unknown,
  userId?: string,
): Promise<MessageTemplateSummary> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }

  const record = input as Record<string, unknown>;

  if (!record.name || typeof record.name !== "string") {
    throw new BadRequestError("MISSING_NAME", '"name" is required.');
  }
  const name = record.name.trim();
  if (name.length === 0) {
    throw new BadRequestError("EMPTY_NAME", '"name" cannot be empty.');
  }
  if (name.length > MAX_TEMPLATE_NAME_LENGTH) {
    throw new BadRequestError(
      "NAME_TOO_LONG",
      `"name" cannot exceed ${MAX_TEMPLATE_NAME_LENGTH} characters.`,
    );
  }

  if (!record.body || typeof record.body !== "string") {
    throw new BadRequestError("MISSING_BODY", '"body" is required.');
  }
  const body = record.body.trim();
  if (body.length === 0) {
    throw new BadRequestError("EMPTY_BODY", '"body" cannot be empty.');
  }
  if (body.length > MAX_TEMPLATE_BODY_LENGTH) {
    throw new BadRequestError(
      "BODY_TOO_LONG",
      `"body" cannot exceed ${MAX_TEMPLATE_BODY_LENGTH} characters.`,
    );
  }

  assertValidBodyVariables(body);

  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: { id: true },
  });

  if (!campaign) {
    throw new NotFoundError(
      "CAMPAIGN_NOT_FOUND",
      `Campaign with ID "${campaignId}" was not found.`,
    );
  }

  return prisma.messageTemplate.create({
    data: { campaignId, name, body },
    select: TEMPLATE_SELECT,
  });
}

export async function listCampaignTemplates(
  campaignId: string,
  userId?: string,
): Promise<MessageTemplateSummary[]> {
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

  return prisma.messageTemplate.findMany({
    where: {
      OR: [{ campaignId }, { campaignId: null }],
    },
    orderBy: { createdAt: "desc" },
    select: TEMPLATE_SELECT,
  });
}

export async function getTemplateById(
  templateId: string,
  userId?: string,
): Promise<MessageTemplateSummary> {
  const prisma = getPrismaClient();

  const template = await prisma.messageTemplate.findFirst({
    where: {
      id: templateId,
      ...(userId
        ? {
            OR: [{ campaignId: null }, { campaign: { userId } }],
          }
        : {}),
    },
    select: TEMPLATE_SELECT,
  });

  if (!template) {
    throw new NotFoundError("TEMPLATE_NOT_FOUND", "Message template not found");
  }

  return template;
}

export async function updateTemplate(
  templateId: string,
  input: unknown,
  userId?: string,
): Promise<MessageTemplateSummary> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }

  const existing = await getTemplateById(templateId, userId);
  assertMutableTemplate(existing);

  const record = input as Record<string, unknown>;
  const allowedKeys = new Set(["name", "body"]);
  const unexpected = Object.keys(record).filter((k) => !allowedKeys.has(k));

  if (unexpected.length > 0) {
    throw new BadRequestError(
      "UNALLOWED_FIELDS",
      `Cannot update fields: ${unexpected.join(", ")}. Allowed fields: name, body.`,
    );
  }

  const data: { name?: string; body?: string } = {};

  if (record.name !== undefined) {
    if (typeof record.name !== "string" || !record.name.trim()) {
      throw new BadRequestError("INVALID_NAME", '"name" must be a non-empty string.');
    }
    const name = record.name.trim();
    if (name.length > MAX_TEMPLATE_NAME_LENGTH) {
      throw new BadRequestError(
        "NAME_TOO_LONG",
        `Maximum name length is ${MAX_TEMPLATE_NAME_LENGTH}.`,
      );
    }
    data.name = name;
  }

  if (record.body !== undefined) {
    if (typeof record.body !== "string" || !record.body.trim()) {
      throw new BadRequestError("INVALID_BODY", '"body" must be a non-empty string.');
    }
    const body = record.body.trim();
    if (body.length > MAX_TEMPLATE_BODY_LENGTH) {
      throw new BadRequestError(
        "BODY_TOO_LONG",
        `Maximum body length is ${MAX_TEMPLATE_BODY_LENGTH}.`,
      );
    }
    assertValidBodyVariables(body);
    data.body = body;
  }

  if (Object.keys(data).length === 0) {
    throw new BadRequestError("NO_UPDATES", "No valid update fields provided.");
  }

  const prisma = getPrismaClient();
  return prisma.messageTemplate.update({
    where: { id: templateId },
    data,
    select: TEMPLATE_SELECT,
  });
}

export async function deleteTemplate(
  templateId: string,
  userId?: string,
): Promise<{ id: string; deleted: true }> {
  const existing = await getTemplateById(templateId, userId);
  assertMutableTemplate(existing);

  const prisma = getPrismaClient();
  await prisma.messageTemplate.delete({ where: { id: templateId } });

  return { id: templateId, deleted: true };
}

/**
 * Renders a template against real campaign leads. Draft/preview ONLY — no
 * message is created or dispatched. Leads are fetched in a single query.
 */
export async function previewTemplateForLeads(
  templateId: string,
  input: unknown,
  userId?: string,
): Promise<TemplatePreviewResult> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }

  const record = input as Record<string, unknown>;

  if (typeof record.campaignId !== "string" || record.campaignId.trim().length === 0) {
    throw new BadRequestError("MISSING_CAMPAIGN_ID", '"campaignId" is required.');
  }
  const campaignId = record.campaignId.trim();

  if (!Array.isArray(record.leadIds) || record.leadIds.length === 0) {
    throw new BadRequestError("MISSING_LEAD_IDS", '"leadIds" must be a non-empty array.');
  }
  if (record.leadIds.length > MAX_PREVIEW_LEADS) {
    throw new BadRequestError(
      "TOO_MANY_LEADS",
      `Preview supports at most ${MAX_PREVIEW_LEADS} leads per request.`,
    );
  }

  const leadIds: string[] = [];
  for (const value of record.leadIds) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestError("INVALID_LEAD_IDS", '"leadIds" must contain non-empty strings.');
    }
    if (!leadIds.includes(value.trim())) {
      leadIds.push(value.trim());
    }
  }

  const template = await getTemplateById(templateId, userId);
  assertValidBodyVariables(template.body);

  const prisma = getPrismaClient();

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      ...(userId ? { userId } : {}),
    },
    select: { id: true, name: true },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", `Campaign with ID "${campaignId}" was not found.`);
  }

  if (template.campaignId !== null && template.campaignId !== campaign.id) {
    throw new BadRequestError(
      "CAMPAIGN_MISMATCH",
      "Template belongs to a different campaign than the requested campaign.",
    );
  }

  // Single query for all requested leads (no per-variable / per-lead queries).
  const leads = await prisma.lead.findMany({
    where: { id: { in: leadIds }, campaignId: campaign.id },
    select: {
      id: true,
      username: true,
      fullName: true,
      biography: true,
      category: true,
      followers: true,
      following: true,
      postsCount: true,
      externalUrl: true,
      profileUrl: true,
      profilePictureUrl: true,
      isVerified: true,
      isBusiness: true,
    },
  });

  if (leads.length !== leadIds.length) {
    throw new BadRequestError(
      "INVALID_LEAD_IDS",
      "One or more selected leads do not belong to this campaign.",
    );
  }

  const senderName =
    userId === undefined
      ? null
      : (
          await prisma.user.findUnique({
            where: { id: userId },
            select: { name: true },
          })
        )?.name ?? null;

  const byId = new Map(leads.map((lead) => [lead.id, lead]));

  const previews: TemplateLeadPreview[] = leadIds.map((leadId) => {
    const lead = byId.get(leadId)!;
    const rendered = renderTemplateDetailed(
      template.body,
      {
        username: lead.username,
        fullName: lead.fullName,
        biography: lead.biography,
        category: lead.category,
        followersCount: lead.followers,
        followingCount: lead.following,
        postsCount: lead.postsCount,
        externalUrl: lead.externalUrl,
        profileUrl: lead.profileUrl,
      },
      campaign.name,
      senderName,
    );

    return {
      lead: {
        id: lead.id,
        username: lead.username,
        fullName: lead.fullName,
        profileUrl: lead.profileUrl,
        profilePictureUrl: lead.profilePictureUrl,
        isVerified: lead.isVerified,
        isBusiness: lead.isBusiness,
        category: lead.category,
        followers: lead.followers,
        following: lead.following,
        postsCount: lead.postsCount,
        externalUrl: lead.externalUrl,
      },
      text: rendered.text,
      missingVariables: rendered.missingVariables,
    };
  });

  return {
    template: { id: template.id, name: template.name, body: template.body },
    campaign: { id: campaign.id, name: campaign.name },
    sent: false,
    previews,
  };
}

export type TemplateSuggestion = {
  id: string;
  name: string;
  angle: "curiosity" | "value_offer" | "collaboration" | "direct_inquiry";
  label: string;
  body: string;
  description: string;
};

export async function generateCampaignTemplateSuggestions(
  campaignId: string,
  userId: string,
  customIntent?: string,
): Promise<{
  campaignName: string;
  intent: string;
  suggestions: TemplateSuggestion[];
}> {
  const prisma = getPrismaClient();
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
    select: {
      id: true,
      name: true,
      intent: true,
      category: true,
      targetNiche: true,
      description: true,
    },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  }

  const effectiveIntent =
    typeof customIntent === "string" && customIntent.trim().length > 0
      ? customIntent.trim()
      : campaign.intent?.trim() || campaign.description?.trim() || campaign.name;

  const niche = campaign.targetNiche?.trim() || campaign.category?.trim() || "";

  // Dynamic high-converting templates built specifically to convince the lead to reply
  const suggestions: TemplateSuggestion[] = [
    {
      id: "curiosity_hook",
      name: "Curiosity Question (Highest Reply Rate)",
      angle: "curiosity",
      label: "Quick Question",
      description:
        "Low-friction, conversational opener asking a relevant industry question. Takes 5 seconds to reply.",
      body: niche
        ? `Hey {{firstName}}, loved what you're doing in the {{businessCategory}} space! Quick question regarding {{campaignName}} — are you currently taking on new projects this month?`
        : `Hey {{firstName}}, saw your work on Instagram! Quick question regarding {{campaignName}} — are you currently taking on new projects or clients?`,
    },
    {
      id: "value_offer",
      name: "Value-First / Free Resource",
      angle: "value_offer",
      label: "Value-First",
      description:
        "Offers a helpful breakdown or asset with zero pitch pressure, asking for permission to send.",
      body: `Hi {{firstName}}, noticed your focus in {{businessCategory}}. We recently put together a quick 30-sec breakdown on ${effectiveIntent} tailored for creators in your niche. Mind if I drop the key takeaways here?`,
    },
    {
      id: "collaboration",
      name: "Peer Collaboration & Partnership",
      angle: "collaboration",
      label: "Collaboration",
      description:
        "Frames outreach as a mutually beneficial partnership opportunity rather than a sales pitch.",
      body: `Hey {{firstName}}, your work in {{businessCategory}} caught our eye. We're actively connecting with select profiles in your space for {{campaignName}}. Would you be open to exploring a quick collaboration?`,
    },
    {
      id: "direct_inquiry",
      name: "Direct Problem-Solving Hook",
      angle: "direct_inquiry",
      label: "Problem-Solving",
      description:
        "Addresses a common bottleneck conversationally and offers a quick peek at the solution.",
      body: `Hey {{firstName}}, working with others in {{businessCategory}} on {{campaignName}}, we noticed a lot of people struggle with inconsistent results. Open to seeing a quick 30-second example of how we solved it?`,
    },
  ];

  return {
    campaignName: campaign.name,
    intent: effectiveIntent,
    suggestions,
  };
}
