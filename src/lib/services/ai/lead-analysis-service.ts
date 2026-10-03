import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { AiStatus, LeadStatus } from "@/generated/prisma/enums";
import { CompanyProfileIncompleteError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { transitionLeadStatus } from "../lead/lead-status-service";
import {
  getCompanyProfileCompleteness,
  resolveCompanyProfileForCampaign,
  toCompanyProfileDto,
} from "../company-profile";
import { generateStructured, GeminiApiError } from "./gemini";
import {
  ANALYSIS_PROMPT_VERSION,
  ANALYSIS_RESPONSE_SCHEMA,
  buildAnalysisPrompt,
  buildLeadContext,
  validateLeadAnalysis,
  type LeadAnalysis,
} from "./prompts";
import {
  notifyHighValueLead,
  notifySystemError,
} from "../notifications/notification-triggers";
import { getNotificationHighScoreThreshold } from "@/lib/env";

export type AnalyzeLeadResult =
  | { status: "DONE"; analysis: LeadAnalysis }
  | { status: "SKIPPED"; skipReason: string }
  | { status: "FAILED"; errorCode: string };

/**
 * Analyzes one lead. The CompanyProfile completeness gate runs BEFORE any
 * Gemini call or UsageLog write.
 */
export async function analyzeLead(input: {
  userId: string;
  leadId: string;
  force?: boolean;
}): Promise<AnalyzeLeadResult> {
  const prisma = getPrismaClient();
  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, campaign: { userId: input.userId } },
    include: { campaign: true },
  });
  if (!lead) {
    throw new NotFoundError("LEAD_NOT_FOUND", `Lead "${input.leadId}" was not found.`);
  }

  // ---- Company profile completeness gate (no Gemini, no UsageLog before this) ----
  const profileRecord = await resolveCompanyProfileForCampaign(lead.campaignId, input.userId);
  const completeness = getCompanyProfileCompleteness(profileRecord);
  if (!completeness.complete) {
    throw new CompanyProfileIncompleteError(completeness.missingFields, completeness.warnings);
  }

  // ---- Deterministic skips (also before any Gemini call) ----
  if (lead.status === LeadStatus.DO_NOT_CONTACT) {
    return skip(prisma, lead.id, "do_not_contact");
  }
  if (lead.duplicateOfLeadId) {
    return skip(prisma, lead.id, "duplicate_lead");
  }
  const hasUsableData = Boolean(
    lead.biography || lead.businessCategoryName || lead.category || lead.fullName,
  );
  if (!hasUsableData) {
    return skip(prisma, lead.id, "no_usable_data");
  }
  if (
    !input.force &&
    lead.aiStatus === AiStatus.DONE &&
    lead.promptVersion === ANALYSIS_PROMPT_VERSION
  ) {
    return { status: "SKIPPED", skipReason: "already_analyzed" };
  }

  const priorStatus = lead.status;
  if (lead.campaign.aiQualificationEnabled && priorStatus === LeadStatus.NEW) {
    await transitionLeadStatus({
      leadId: lead.id,
      to: LeadStatus.QUALIFYING,
      reason: "ai_analysis_started",
      actor: `user:${input.userId}`,
    });
  }

  try {
    const company = toCompanyProfileDto(profileRecord!);
    const context = buildLeadContext(lead, lead.campaign, {
      ...company,
      messageLanguage: lead.campaign.messageLanguage ?? company.messageLanguage,
    });
    const prompt = buildAnalysisPrompt(context);

    const result = await generateStructured({
      systemInstruction: prompt.systemInstruction,
      userText: prompt.userText,
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      validate: validateLeadAnalysis,
      operation: "lead_analysis",
      promptVersion: ANALYSIS_PROMPT_VERSION,
      userId: input.userId,
      campaignId: lead.campaignId,
    });
    const analysis = result.data;

    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        aiAnalysis: analysis as unknown as Prisma.InputJsonValue,
        leadScore: analysis.leadScore,
        leadQuality: analysis.leadQuality,
        aiStatus: AiStatus.DONE,
        aiAnalyzedAt: new Date(),
        promptVersion: ANALYSIS_PROMPT_VERSION,
        aiFailedReason: null,
      },
    });

    const threshold = getNotificationHighScoreThreshold();
    const wasBelow = lead.leadScore === null || lead.leadScore < threshold;
    if (wasBelow && analysis.leadScore >= threshold) {
      await notifyHighValueLead({
        leadId: lead.id,
        userId: input.userId,
        username: lead.username,
        score: analysis.leadScore,
        quality: analysis.leadQuality,
        campaignName: lead.campaign.name,
      }).catch(() => undefined);
    }

    if (lead.campaign.aiQualificationEnabled) {
      const meetsScore = analysis.leadScore >= lead.campaign.minLeadScore;
      const lowConfidenceNeedsMore =
        analysis.confidence === "low" && analysis.leadScore >= lead.campaign.minLeadScore + 10;
      const qualifies =
        analysis.isTargetMatch &&
        meetsScore &&
        (analysis.confidence !== "low" || lowConfidenceNeedsMore);
      if (qualifies) {
        await transitionLeadStatus({
          leadId: lead.id,
          to: LeadStatus.QUALIFIED,
          reason: "ai_qualified",
          actor: `user:${input.userId}`,
        });
      } else if (priorStatus !== LeadStatus.NEW) {
        await transitionLeadStatus({
          leadId: lead.id,
          to: LeadStatus.NEW,
          reason: "ai_not_qualified",
          actor: `user:${input.userId}`,
        });
      }
    }

    return { status: "DONE", analysis };
  } catch (error) {
    const code = error instanceof GeminiApiError ? error.code : "AI_UNAVAILABLE";
    await prisma.lead.update({
      where: { id: lead.id },
      data: { aiStatus: AiStatus.FAILED, aiFailedReason: code },
    });
    // Restore the pre-analysis status so the lead can be retried.
    if (lead.campaign.aiQualificationEnabled && priorStatus === LeadStatus.NEW) {
      await transitionLeadStatus({
        leadId: lead.id,
        to: LeadStatus.NEW,
        reason: "ai_analysis_failed",
        actor: `user:${input.userId}`,
      }).catch(() => undefined);
    }

    if (code === "AI_AUTH_FAILED" || code === "AI_QUOTA_EXHAUSTED") {
      await notifySystemError({
        userId: input.userId,
        provider: "Gemini",
        errorType: code === "AI_AUTH_FAILED" ? "AUTH_FAILED" : "QUOTA_EXHAUSTED",
        details: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }

    logger.warn("[AI] lead analysis failed", { leadId: lead.id, code });
    return { status: "FAILED", errorCode: code };
  }
}

async function skip(
  prisma: ReturnType<typeof getPrismaClient>,
  leadId: string,
  reason: string,
): Promise<AnalyzeLeadResult> {
  await prisma.lead.update({
    where: { id: leadId },
    data: { aiStatus: AiStatus.SKIPPED, aiFailedReason: reason },
  });
  return { status: "SKIPPED", skipReason: reason };
}

/** Bounded, sequential batch used by the job runner (per-lead errors never stop it). */
export async function analyzeLeadsBatch(input: {
  userId: string;
  leadIds: string[];
  force?: boolean;
  shouldStop?: () => Promise<boolean> | boolean;
  onProgress?: (result: AnalyzeLeadResult) => void;
}): Promise<{ succeeded: number; failed: number; skipped: number }> {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const leadId of input.leadIds) {
    if (input.shouldStop && (await input.shouldStop())) break;
    try {
      const result = await analyzeLead({ userId: input.userId, leadId, force: input.force });
      if (result.status === "DONE") succeeded += 1;
      else if (result.status === "SKIPPED") skipped += 1;
      else failed += 1;
      input.onProgress?.(result);
    } catch (error) {
      // A CompanyProfileIncompleteError aborts the whole batch; other errors are per-lead.
      if (error instanceof CompanyProfileIncompleteError) throw error;
      failed += 1;
      logger.warn("[AI] analyze lead batch item failed", {
        leadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { succeeded, failed, skipped };
}
