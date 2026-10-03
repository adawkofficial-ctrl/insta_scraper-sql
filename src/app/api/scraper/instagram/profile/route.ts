import { NextResponse } from "next/server";

import {
  parseCampaignScrapeRequest,
  runCampaignScrape,
} from "@/lib/services/campaign";
import { handleRouteError, apiError } from "@/lib/errors";
import { validateScraperConfig } from "@/lib/env";

import { requireAuth } from "@/lib/services/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const input = parseCampaignScrapeRequest(body);
    validateScraperConfig();
    const result = await runCampaignScrape(input, user.id);

    return NextResponse.json({
      success: true,
      data: result.profiles,
      meta: {
        campaignId: result.campaignId,
        scrapeJobId: result.scrapeJobId,
        provider: result.provider,
        status: result.status,
        inputCount: result.inputCount,
        processedCount: result.processedCount,
        notice: result.notice,
      },
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
