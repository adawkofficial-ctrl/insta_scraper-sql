import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import { enrichLeadHandleWaterfall } from "@/lib/services/scraper/profile-enrichment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  props: { params: Promise<{ campaignId: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await props.params;

    if (!campaignId) {
      return apiError(400, "MISSING_CAMPAIGN_ID", "campaignId is required.");
    }

    const prisma = getPrismaClient();
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, userId: true },
    });

    if (!campaign || campaign.userId !== user.id) {
      return apiError(404, "CAMPAIGN_NOT_FOUND", "Campaign not found or unauthorized.");
    }

    const eligibleLeads = await prisma.lead.findMany({
      where: {
        campaignId,
        website: { not: null },
        OR: [
          { username: null },
          { username: "" },
        ],
      },
      select: {
        id: true,
        fullName: true,
        website: true,
        username: true,
        lastHandleEnrichmentAt: true,
        rating: true,
        reviewCount: true,
        isClaimed: true,
        isChain: true,
        email: true,
        phone: true,
        availableChannels: true,
        scoreFlags: true,
      },
    });

    let foundCount = 0;
    let notFoundCount = 0;
    let cooldownCount = 0;
    const results: Array<{ id: string; name: string | null; outcome: string; handle: string | null }> = [];

    for (const lead of eligibleLeads) {
      if (!lead.website || !lead.website.trim()) continue;

      const res = await enrichLeadHandleWaterfall(lead, prisma);
      if (res.outcome === "found") {
        foundCount++;
      } else if (res.outcome === "cooldown") {
        cooldownCount++;
      } else {
        notFoundCount++;
      }
      results.push({
        id: lead.id,
        name: lead.fullName,
        outcome: res.outcome,
        handle: res.handle,
      });
    }

    return NextResponse.json({
      success: true,
      totalChecked: eligibleLeads.length,
      found: foundCount,
      notFound: notFoundCount,
      cooldownSkipped: cooldownCount,
      results,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

