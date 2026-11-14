import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import { enrichLeadsFromWebsites } from "@/lib/services/enrichment/website-lead-enricher";
import { enrichLeadsOnDemand } from "@/lib/services/scraper/profile-enrichment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Scrape websites for all leads": free website enrichment for every lead in
 * the campaign that has a website, including leads that already have a handle,
 * email, or social link. No Apify/Gemini/Unipile calls during scraping.
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

    // "Scrape websites for all leads" must scan every lead that has a website,
    // including leads that already have IG/email/socials. It is an explicit
    // action, so it bypasses the 7-day cooldown.
    const result = await enrichLeadsFromWebsites({
      campaignId,
      scanAll: true,
      force: true,
      concurrency: 15,
    });

    // Fetch Instagram profiles for newly found handles (max 20 per click, the
    // existing enrichment safety cap) and evaluate the enrichment criteria.
    const newlyFoundHandleLeadIds = result.results
      .filter((row) => row.newHandle && row.handle)
      .map((row) => row.id)
      .slice(0, 20);
    let profilesEnriched = 0;
    let belowCriteria = 0;
    const criteriaFailures: Array<{ id: string; handle: string | null; reasons: string[] }> = [];
    if (newlyFoundHandleLeadIds.length > 0) {
      try {
        const enriched = await enrichLeadsOnDemand({
          leadIds: newlyFoundHandleLeadIds,
          userId: user.id,
        });
        profilesEnriched = enriched.enrichedCount;
        for (const row of enriched.leads) {
          if (row.criteriaPassed === false && row.criteriaReasons?.length) {
            belowCriteria++;
            criteriaFailures.push({
              id: row.id,
              handle: row.username || null,
              reasons: row.criteriaReasons,
            });
          }
        }
      } catch {
        // Website results are already saved; profile enrichment is best-effort.
      }
    }

    return NextResponse.json({
      success: true,
      totalChecked: result.totalEligible,
      found: result.results.filter((r) => r.outcome === "found").length,
      notFound: result.notFound,
      cooldownSkipped: result.cooldownSkipped,
      handlesFound: result.handlesFound,
      emailsFound: result.emailsFound,
      socialsFound: result.socialsFound,
      profilesEnriched,
      belowCriteria,
      criteriaFailures,
      results: result.results,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
