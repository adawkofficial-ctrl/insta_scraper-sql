import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import {
  renderTemplate,
  validateTemplateVariables,
} from "../template/template-renderer";
import { getAIProvider } from "./default-ai-provider";

export type MessagePreviewRequest = {
  leadId: string;
  templateId: string;
  campaignContext?: string;
};

export type MessagePreviewResponse = {
  text: string;
};

export type AIPreviewResponse = {
  text: string;
  provider: string;
  generated: true;
};

export async function previewTemplateMessage(
  input: unknown,
  userId?: string,
): Promise<MessagePreviewResponse> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError(
      "INVALID_BODY",
      "Request body must be a JSON object.",
    );
  }

  const record = input as Record<string, unknown>;

  if (!record.leadId || typeof record.leadId !== "string") {
    throw new BadRequestError("MISSING_LEAD_ID", '"leadId" is required.');
  }
  const leadId = record.leadId.trim();

  if (!record.templateId || typeof record.templateId !== "string") {
    throw new BadRequestError(
      "MISSING_TEMPLATE_ID",
      '"templateId" is required.',
    );
  }
  const templateId = record.templateId.trim();

  const campaignContext =
    typeof record.campaignContext === "string"
      ? record.campaignContext.trim()
      : undefined;

  const prisma = getPrismaClient();
  const senderName = await resolveSenderName(prisma, userId, record.senderName);

  // 1. Load lead, verifying campaign belongs to userId if provided
  const lead = await prisma.lead.findFirst({
    where: {
      id: leadId,
      ...(userId ? { campaign: { userId } } : {}),
    },
    include: { campaign: { select: { id: true, name: true, userId: true } } },
  });

  if (!lead) {
    throw new NotFoundError(
      "LEAD_NOT_FOUND",
      `Lead with ID "${leadId}" was not found.`,
    );
  }

  // 2. Load template, verifying campaign belongs to userId if provided
  const template = await prisma.messageTemplate.findFirst({
    where: {
      id: templateId,
      ...(userId ? { campaign: { userId } } : {}),
    },
  });

  if (!template) {
    throw new NotFoundError(
      "TEMPLATE_NOT_FOUND",
      `Template with ID "${templateId}" was not found.`,
    );
  }

  // 3. Campaign mismatch validation
  if (template.campaignId && template.campaignId !== lead.campaignId) {
    throw new BadRequestError(
      "CAMPAIGN_MISMATCH",
      "Template belongs to a different campaign than the lead.",
    );
  }

  // 4. An empty template body cannot produce a message.
  if (template.body.trim().length === 0) {
    throw new BadRequestError(
      "EMPTY_TEMPLATE",
      "The selected message template has an empty body.",
    );
  }

  const variableCheck = validateTemplateVariables(template.body);
  if (!variableCheck.valid) {
    throw new BadRequestError(
      "UNSUPPORTED_VARIABLES",
      `Unsupported template variable(s): ${variableCheck.unsupported
        .map((variable) => `{{${variable}}}`)
        .join(", ")}.`,
    );
  }

  // 5. Render basic template variables (missing values use safe fallbacks)
  const contextName = campaignContext || lead.campaign?.name || "";
  const rendered = renderTemplate(
    template.body,
    {
      username: lead.username ?? "",
      fullName: lead.fullName,
      biography: lead.biography,
      category: lead.category,
    },
    contextName,
    senderName,
  );

  return {
    text: rendered,
  };
}

async function resolveSenderName(
  prisma: ReturnType<typeof getPrismaClient>,
  userId: string | undefined,
  override: unknown,
): Promise<string | null> {
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim().slice(0, 100);
  }

  if (!userId) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });

  return user?.name ?? null;
}

export async function previewAIMessage(
  input: unknown,
  userId?: string,
): Promise<AIPreviewResponse> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError(
      "INVALID_BODY",
      "Request body must be a JSON object.",
    );
  }

  const record = input as Record<string, unknown>;

  if (!record.leadId || typeof record.leadId !== "string") {
    throw new BadRequestError("MISSING_LEAD_ID", '"leadId" is required.');
  }
  const leadId = record.leadId.trim();

  if (!record.templateId || typeof record.templateId !== "string") {
    throw new BadRequestError(
      "MISSING_TEMPLATE_ID",
      '"templateId" is required.',
    );
  }
  const templateId = record.templateId.trim();

  const campaignContext =
    typeof record.campaignContext === "string"
      ? record.campaignContext.trim()
      : undefined;

  const prisma = getPrismaClient();
  const senderName = await resolveSenderName(prisma, userId, record.senderName);

  // 1. Validate & load lead, verifying campaign belongs to userId if provided
  const lead = await prisma.lead.findFirst({
    where: {
      id: leadId,
      ...(userId ? { campaign: { userId } } : {}),
    },
    include: { campaign: { select: { id: true, name: true, userId: true } } },
  });

  if (!lead) {
    throw new NotFoundError(
      "LEAD_NOT_FOUND",
      `Lead with ID "${leadId}" was not found.`,
    );
  }

  // 2. Validate & load template, verifying campaign belongs to userId if provided
  const template = await prisma.messageTemplate.findFirst({
    where: {
      id: templateId,
      ...(userId ? { campaign: { userId } } : {}),
    },
  });

  if (!template) {
    throw new NotFoundError(
      "TEMPLATE_NOT_FOUND",
      `Template with ID "${templateId}" was not found.`,
    );
  }

  // 3. Campaign mismatch check
  if (template.campaignId && template.campaignId !== lead.campaignId) {
    throw new BadRequestError(
      "CAMPAIGN_MISMATCH",
      "Template belongs to a different campaign than the lead.",
    );
  }

  // 4. An empty template body cannot produce a message.
  if (template.body.trim().length === 0) {
    throw new BadRequestError(
      "EMPTY_TEMPLATE",
      "The selected message template has an empty body.",
    );
  }

  const aiVariableCheck = validateTemplateVariables(template.body);
  if (!aiVariableCheck.valid) {
    throw new BadRequestError(
      "UNSUPPORTED_VARIABLES",
      `Unsupported template variable(s): ${aiVariableCheck.unsupported
        .map((variable) => `{{${variable}}}`)
        .join(", ")}.`,
    );
  }

  // 5. Render available variables to form the baseline template
  const contextName = campaignContext || lead.campaign?.name || "";
  const renderedBase = renderTemplate(
    template.body,
    {
      username: lead.username ?? "",
      fullName: lead.fullName,
      biography: lead.biography,
      category: lead.category,
    },
    contextName,
    senderName,
  );

  // 5. Send only necessary context to the AI provider
  const aiProvider = getAIProvider();
  const aiResult = await aiProvider.generatePersonalizedMessage({
    lead: {
      username: lead.username ?? "",
      fullName: lead.fullName,
      biography: lead.biography,
      category: lead.category,
      followers: lead.followers,
      isBusiness: lead.isBusiness,
    },
    template: renderedBase,
    campaignContext: contextName,
  });

  if (!aiResult.text || aiResult.text.trim().length === 0) {
    throw new BadRequestError(
      "EMPTY_GENERATED_MESSAGE",
      "Generated message is empty.",
    );
  }

  if (aiResult.text.length > 2000) {
    throw new BadRequestError(
      "EXCESSIVE_MESSAGE_LENGTH",
      "Generated message exceeds 2000 characters.",
    );
  }

  return {
    text: aiResult.text,
    provider: aiResult.provider || aiProvider.name,
    generated: true,
  };
}
