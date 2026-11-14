import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import {
  enrichLeadHandleWaterfall,
  enrichLeadsOnDemand,
} from "@/lib/services/scraper/profile-enrichment-service";

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

    // If the website yielded an Instagram account, fetch its profile stats and
    // evaluate the enrichment criteria immediately so the lead list can show
    // "below criteria" (followers/posts) instead of leaving it as unknown.
    let criteriaPassed: boolean | undefined;
    let criteriaReasons: string[] | undefined;
    let message = result.message;
    if (result.handle) {
      try {
        const enriched = await enrichLeadsOnDemand({
          leadIds: [lead.id],
          userId: user.id,
        });
        const row = enriched.leads.find((item) => item.id === lead.id);
        criteriaPassed = row?.criteriaPassed;
        criteriaReasons = row?.criteriaReasons;
        if (criteriaPassed === false && criteriaReasons?.length) {
          message = `${message} Profile found but below enrichment criteria: ${criteriaReasons.join("; ")}.`;
        }
      } catch {
        // The handle is still saved even if the paid profile fetch fails.
      }
    }

    return NextResponse.json({
      success: true,
      ...result,
      message,
      criteriaPassed,
      criteriaReasons,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

