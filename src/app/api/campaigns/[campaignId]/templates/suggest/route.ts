import { NextResponse } from "next/server";
import { generateCampaignTemplateSuggestions } from "@/lib/services/template";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";

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
    const url = new URL(request.url);
    const intent = url.searchParams.get("intent") ?? undefined;

    const data = await generateCampaignTemplateSuggestions(
      campaignId,
      user.id,
      intent,
    );
    return NextResponse.json(data);
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;

    let customIntent: string | undefined;
    try {
      const body = (await request.json()) as { intent?: string };
      if (typeof body?.intent === "string" && body.intent.trim().length > 0) {
        customIntent = body.intent.trim();
      }
    } catch {
      // Body is optional
    }

    const data = await generateCampaignTemplateSuggestions(
      campaignId,
      user.id,
      customIntent,
    );
    return NextResponse.json(data);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
