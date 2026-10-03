import { NextResponse } from "next/server";

import { getPrismaClient } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ leadId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { leadId } = await context.params;
    const prisma = getPrismaClient();

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, campaign: { userId: user.id } },
      select: { id: true },
    });
    if (!lead) {
      throw new NotFoundError("LEAD_NOT_FOUND", `Lead "${leadId}" was not found.`);
    }

    const drafts = await prisma.messageDraft.findMany({
      where: { leadId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        body: true,
        status: true,
        promptVersion: true,
        model: true,
        wordCount: true,
        personalizationPointsUsed: true,
        generationMeta: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ drafts });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
