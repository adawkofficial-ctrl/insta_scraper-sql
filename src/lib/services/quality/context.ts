import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { DncChannel } from "@/generated/prisma/enums";
import { getPrismaClient } from "@/lib/db/prisma";
import { NotFoundError } from "@/lib/errors";
import {
  resolveCompanyProfileForCampaign,
  toCompanyProfileDto,
  type CompanyProfileDto,
} from "@/lib/services/company-profile";
import { checkLeadSuppression } from "@/lib/services/compliance";
import { wasPreviouslyContacted } from "@/lib/services/dedup";
import {
  EXACT_DUPLICATE_WINDOW_DAYS,
  NEAR_DUPLICATE_COMPARISON_LIMIT,
  REPEATED_OPENER_COMPARISON_LIMIT,
} from "./rules";
import { firstNWords, normalizeForExactDuplicate } from "./similarity";
import type { QualityCompany, QualityContext, QualityHistory } from "./types";

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function extractPersonalizationPoints(aiAnalysis: unknown): string[] {
  if (!aiAnalysis || typeof aiAnalysis !== "object") return [];
  return asStringArray((aiAnalysis as Record<string, unknown>).personalizationPoints);
}

function hasPostContext(latestPosts: unknown): boolean {
  if (Array.isArray(latestPosts)) return latestPosts.length > 0;
  return Boolean(latestPosts);
}

function buildQualityCompany(dto: CompanyProfileDto | null, fallbackLanguage: string): QualityCompany {
  const services = (dto?.services ?? []).map((entry) => entry.name).filter(Boolean);
  const rawText = [
    dto?.name,
    dto?.description,
    ...services,
    ...(dto?.targetIndustries ?? []),
    ...(dto?.targetCountries ?? []),
    dto?.idealCustomerProfile,
    dto?.brandTone,
    dto?.pricingPolicy,
    dto?.ctaStyle,
    JSON.stringify(dto?.exampleMessages ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  return {
    name: dto?.name ?? "",
    description: dto?.description ?? "",
    services,
    forbiddenClaims: dto?.forbiddenClaims ?? [],
    preferredLength: dto?.preferredLength ?? null,
    pricingPolicy: dto?.pricingPolicy ?? null,
    brandTone: dto?.brandTone ?? null,
    messageLanguage: dto?.messageLanguage ?? fallbackLanguage,
    rawText,
  };
}

async function loadHistory(input: {
  userId: string;
  campaignId: string;
  excludeDraftId: string;
  client: Prisma.TransactionClient | ReturnType<typeof getPrismaClient>;
}): Promise<QualityHistory> {
  const since = new Date(Date.now() - EXACT_DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [outboundMessages, otherDrafts, campaignMessages, campaignDrafts] = await Promise.all([
    input.client.message.findMany({
      where: {
        campaign: { userId: input.userId },
        direction: "OUTBOUND",
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take: NEAR_DUPLICATE_COMPARISON_LIMIT,
      select: { messageText: true },
    }),
    input.client.messageDraft.findMany({
      where: {
        userId: input.userId,
        id: { not: input.excludeDraftId },
        status: { not: "SUPERSEDED" },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take: NEAR_DUPLICATE_COMPARISON_LIMIT,
      select: { body: true },
    }),
    input.client.message.findMany({
      where: { campaignId: input.campaignId, direction: "OUTBOUND" },
      orderBy: { createdAt: "desc" },
      take: REPEATED_OPENER_COMPARISON_LIMIT,
      select: { messageText: true },
    }),
    input.client.messageDraft.findMany({
      where: { campaignId: input.campaignId, status: { not: "SUPERSEDED" } },
      orderBy: { createdAt: "desc" },
      take: REPEATED_OPENER_COMPARISON_LIMIT,
      select: { body: true },
    }),
  ]);

  const exact = new Set<string>();
  for (const message of outboundMessages) {
    const normalized = normalizeForExactDuplicate(message.messageText);
    if (normalized.length > 0) exact.add(normalized);
  }
  for (const draft of otherDrafts) {
    const normalized = normalizeForExactDuplicate(draft.body);
    if (normalized.length > 0) exact.add(normalized);
  }

  const openers = new Set<string>();
  for (const message of campaignMessages) {
    const opener = firstNWords(message.messageText, 6);
    if (opener.length > 0) openers.add(opener);
  }
  for (const draft of campaignDrafts) {
    const opener = firstNWords(draft.body, 6);
    if (opener.length > 0) openers.add(opener);
  }

  return {
    exactDuplicateBodies: Array.from(exact),
    recentOutboundTexts: outboundMessages.map((message) => message.messageText),
    recentCampaignOpeners: Array.from(openers),
  };
}

/**
 * Loads everything a quality check needs in a bounded number of queries:
 * draft + lead + campaign, company profile, live suppression state, previous
 * contact state, and a bounded slice of message/draft history.
 */
export async function loadQualityContext(input: {
  draftId: string;
  tx?: Prisma.TransactionClient;
}): Promise<{ ctx: QualityContext; draftStatus: string }> {
  const client = input.tx ?? getPrismaClient();
  const draft = await client.messageDraft.findUnique({
    where: { id: input.draftId },
    include: { lead: { include: { campaign: true } } },
  });
  if (!draft) {
    throw new NotFoundError("DRAFT_NOT_FOUND", `Draft "${input.draftId}" was not found.`);
  }
  const lead = draft.lead;
  const campaign = lead.campaign;

  const profileRecord = await resolveCompanyProfileForCampaign(campaign.id, draft.userId);
  const company = buildQualityCompany(
    profileRecord ? toCompanyProfileDto(profileRecord) : null,
    campaign.messageLanguage ?? "en",
  );

  const [suppression, previouslyContacted, history] = await Promise.all([
    checkLeadSuppression({
      userId: draft.userId,
      lead: { id: lead.id, status: lead.status, username: lead.username, instagramUserId: lead.instagramUserId, email: lead.email, emailNormalized: lead.emailNormalized, website: lead.website, websiteDomain: lead.websiteDomain },
      channel: DncChannel.INSTAGRAM,
      tx: input.tx,
    }),
    wasPreviouslyContacted(lead.id, input.tx),
    loadHistory({
      userId: draft.userId,
      campaignId: campaign.id,
      excludeDraftId: draft.id,
      client,
    }),
  ]);

  const finalBody = draft.editedBody ?? draft.body;

  const ctx: QualityContext = {
    draft: {
      id: draft.id,
      body: finalBody,
      generatedBody: draft.body,
      promptVersion: draft.promptVersion,
      personalizationPointsUsed: asStringArray(draft.personalizationPointsUsed),
      kind: draft.kind,
    },
    lead: {
      id: lead.id,
      campaignId: campaign.id,
      username: lead.username,
      fullName: lead.fullName,
      biography: lead.biography,
      businessCategoryName: lead.businessCategoryName,
      category: lead.category,
      location: lead.location,
      aiStatus: lead.aiStatus,
      status: lead.status,
      duplicateOfLeadId: lead.duplicateOfLeadId,
      leadScore: lead.leadScore,
      targetNiche: campaign.targetNiche,
      personalizationPoints: extractPersonalizationPoints(lead.aiAnalysis),
      hasPostContext: hasPostContext(lead.latestPosts),
    },
    campaign: {
      id: campaign.id,
      aiQualificationEnabled: campaign.aiQualificationEnabled,
      messageLanguage: campaign.messageLanguage,
    },
    company,
    suppression: {
      suppressed: suppression.suppressed,
      matchedIdentifierTypes: suppression.matches.map((match) => match.identifierType),
    },
    previouslyContacted,
    history,
  };

  return { ctx, draftStatus: draft.status };
}
