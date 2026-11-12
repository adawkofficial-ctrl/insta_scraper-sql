import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import {
  buildComplianceFooter,
  buildEmailGreeting,
  buildListUnsubscribeHeaders,
  buildUnsubscribeUrl,
  generateUnsubscribeToken,
  lintEmailContent,
  renderEmailTemplate,
} from "@/lib/services/email/email-compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await params;
    const url = new URL(request.url);
    const leadId = url.searchParams.get("leadId");

    const prisma = getPrismaClient();
    const resolvedLead = leadId
      ? await prisma.lead.findFirst({
          where: { id: leadId, campaignId },
          select: { id: true },
        })
      : await prisma.lead.findFirst({
          where: { campaignId, email: { not: null } },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
    if (!resolvedLead) return apiError(404, "NOT_FOUND", "No lead with an email in this campaign.");
    const [campaign, settings, lead, account] = await Promise.all([
      prisma.campaign.findFirst({
        where: { id: campaignId, userId: user.id },
        select: { id: true },
      }),
      prisma.emailCampaignSettings.findUnique({ where: { campaignId } }),
      prisma.lead.findFirst({
        where: { id: resolvedLead.id, campaignId },
        select: { fullName: true, username: true, city: true, email: true },
      }),
      prisma.emailSenderAccount.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    if (!campaign) return apiError(404, "NOT_FOUND", "Campaign not found.");
    if (!lead) return apiError(404, "NOT_FOUND", "Lead not found.");
    if (!settings) return apiError(404, "NOT_FOUND", "Email settings not configured.");
    if (!account) return apiError(404, "NOT_FOUND", "No email sender account configured.");

    const context = {
      businessName: lead.fullName ?? lead.username ?? null,
      city: lead.city ?? null,
      firstName: null,
    };
    const subject = renderEmailTemplate(settings.subjectTemplate, context);
    const body = renderEmailTemplate(settings.bodyTemplate, context);
    const greeting = buildEmailGreeting(context.businessName);
    const unsubscribeUrl = buildUnsubscribeUrl(generateUnsubscribeToken());
    const footer = buildComplianceFooter({
      senderName: account.fromName,
      companyName: process.env.EMAIL_COMPANY_NAME?.trim() || "Insta Scraper",
      postalAddress: account.postalAddress,
      unsubscribeUrl,
    });
    const finalBody = `${body.text.trim().startsWith(greeting) ? body.text : `${greeting}\n\n${body.text}`}\n${footer}\n`;
    const problems = lintEmailContent(subject.text, finalBody);
    const unresolved = Array.from(new Set([...subject.unresolved, ...body.unresolved]));

    return NextResponse.json({
      subject: subject.text,
      body: finalBody,
      unresolved,
      spamProblems: problems,
      needsEdit: unresolved.length > 0 || problems.length > 0,
      headers: buildListUnsubscribeHeaders({
        mailto: account.fromAddress,
        unsubscribeUrl,
      }),
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
