import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import { enrichLeadHandleWaterfall } from "@/lib/services/scraper/profile-enrichment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  props: { params: Promise<{ leadId: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { leadId } = await props.params;

    if (!leadId) {
      return apiError(400, "MISSING_LEAD_ID", "leadId is required.");
    }

    const prisma = getPrismaClient();
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        campaign: { select: { userId: true } },
      },
    });

    if (!lead || (lead.userId !== user.id && lead.campaign?.userId !== user.id)) {
      return apiError(404, "LEAD_NOT_FOUND", "Lead not found or unauthorized.");
    }

    const result = await enrichLeadHandleWaterfall(lead, prisma, { force: true });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

