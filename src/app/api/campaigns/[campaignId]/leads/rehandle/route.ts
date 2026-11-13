import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import { enrichLeadsFromWebsites } from "@/lib/services/enrichment/website-lead-enricher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Scrape websites for all leads": free website enrichment for leads missing a
 * handle, email, or social link. No Apify/Gemini/Unipile calls. At most once
 * per 7 days per lead (pass ?force=1 to bypass).
 */
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

    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";
    const result = await enrichLeadsFromWebsites({
      campaignId,
      force,
      concurrency: 15,
    });

    return NextResponse.json({
      success: true,
      totalChecked: result.totalEligible,
      found: result.results.filter((r) => r.outcome === "found").length,
      notFound: result.notFound,
      cooldownSkipped: result.cooldownSkipped,
      handlesFound: result.handlesFound,
      emailsFound: result.emailsFound,
      socialsFound: result.socialsFound,
      results: result.results,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
