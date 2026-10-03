import { NextResponse } from "next/server";
import { getCampaignAnalytics } from "@/lib/services/analytics";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, NotFoundError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;

    const prisma = getPrismaClient();
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.id },
      select: { id: true, name: true, status: true },
    });

    if (!campaign) {
      throw new NotFoundError(
        "CAMPAIGN_NOT_FOUND",
        `Campaign with ID "${campaignId}" was not found.`,
      );
    }

    const analytics = await getCampaignAnalytics(campaignId, user.id);

    const url = new URL(request.url);
    const format = url.searchParams.get("format")?.toLowerCase() || "csv";

    // Fetch message history for export
    const messages = await prisma.message.findMany({
      where: { campaignId },
      include: { lead: { select: { username: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    if (format === "json") {
      return new NextResponse(
        JSON.stringify(
          {
            ...analytics,
            messages: messages.map((m) => ({
              id: m.id,
              username: m.lead.username,
              status: m.status,
              errorCode: m.errorCode,
              createdAt: m.createdAt,
            })),
          },
          null,
          2,
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="campaign-${campaignId}-analytics.json"`,
          },
        },
      );
    }

    // CSV format
    const lines: string[] = [];
    lines.push("--- CAMPAIGN ANALYTICS SUMMARY ---");
    lines.push(`Campaign ID,${campaign.id}`);
    lines.push(`Campaign Name,"${campaign.name.replace(/"/g, '""')}"`);
    lines.push(`Status,${analytics.campaign.status}`);
    lines.push(`Total Leads,${analytics.leads.total}`);
    lines.push(`Verified Leads,${analytics.leads.verified}`);
    lines.push(`Business Leads,${analytics.leads.business}`);
    lines.push(`Messages Sent,${analytics.summary.messagesSent}`);
    lines.push(`Messages Failed,${analytics.summary.messagesFailed}`);
    lines.push(`Messages Unknown,${analytics.summary.messagesUnknown}`);
    lines.push(`Messages Remaining,${analytics.summary.messagesRemaining}`);
    lines.push(`Execution Status,${analytics.summary.executionStatus}`);
    lines.push(`Overall Progress,${analytics.execution.overallProgress}%`);
    lines.push("");

    // Section 2: Outreach Items
    lines.push("--- MESSAGE DISPATCH LOG ---");
    lines.push("Lead Username,Outreach Channel,Status,Error Code,Created At");

    for (const m of messages) {
      lines.push(
        `"${m.lead.username}",Direct Message,${m.status},${m.errorCode || "NONE"},"${m.createdAt.toISOString()}"`,
      );
    }

    const csvContent = lines.join("\r\n");
    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="campaign-${campaignId}-analytics.csv"`,
      },
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
