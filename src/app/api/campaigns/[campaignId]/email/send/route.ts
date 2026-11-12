import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import { sendEmailForLead } from "@/lib/services/email/email-send-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await params;
    const prisma = getPrismaClient();
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.id },
      select: { id: true },
    });
    if (!campaign) return apiError(404, "NOT_FOUND", "Campaign not found.");

    const { isOutboundSendingEnabled } = await import("@/lib/services/messaging/send-gate");
    if (!isOutboundSendingEnabled()) {
      return apiError(403, "OUTBOUND_DISABLED", "OUTBOUND_SENDING_ENABLED is false.");
    }

    const accounts = await prisma.emailSenderAccount.findMany({
      where: { userId: user.id, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const senderAccountId = accounts[0]?.id;
    if (!senderAccountId) {
      return apiError(400, "NO_EMAIL_ACCOUNT", "No active email sender account.");
    }

    const leads = await prisma.lead.findMany({
      where: {
        campaignId,
        email: { not: null },
        emailInvalid: false,
        emailOptOutAt: null,
        OR: [{ username: null }, { availableChannels: { has: "EMAIL" } }],
      },
      orderBy: { createdAt: "asc" },
      take: 10,
      select: { id: true },
    });

    const results = [];
    for (const lead of leads) {
      const outcome = await sendEmailForLead({
        leadId: lead.id,
        campaignId,
        senderAccountId,
      });
      results.push({ leadId: lead.id, ...outcome });
      if (outcome.status === "UNKNOWN") break;
    }

    return NextResponse.json({
      processed: results.length,
      sent: results.filter((r) => r.status === "SENT").length,
      unknown: results.filter((r) => r.status === "UNKNOWN").length,
      failed: results.filter((r) => r.status === "FAILED").length,
      suppressed: results.filter((r) => r.status === "SUPPRESSED").length,
      needsEdit: results.filter((r) => r.status === "NEEDS_EDIT").length,
      results,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
