import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError, NotFoundError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import {
  addDoNotContact,
  DncChannel,
  DncIdentifierType,
  DncSource,
  type AddDncEntryInput,
} from "@/lib/services/compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ leadId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { leadId } = await context.params;

    let body: { reason?: string; channel?: string } = {};
    try {
      const parsed = await request.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed;
      }
    } catch {
      // Body is optional for simple one-click DNC
    }

    let channel: DncChannel = DncChannel.ALL;
    if (body.channel) {
      if (!Object.values(DncChannel).includes(body.channel as DncChannel)) {
        return apiError(
          400,
          "INVALID_CHANNEL",
          `Invalid channel. Allowed: ${Object.values(DncChannel).join(", ")}.`,
        );
      }
      channel = body.channel as DncChannel;
    }

    const prisma = getPrismaClient();
    const lead = await prisma.lead.findFirst({
      where: {
        id: leadId,
        campaign: { userId: user.id },
      },
      select: {
        id: true,
        username: true,
        instagramUserId: true,
        email: true,
        emailNormalized: true,
      },
    });

    if (!lead) {
      throw new NotFoundError("LEAD_NOT_FOUND", "Lead not found.");
    }

    const entries: AddDncEntryInput[] = [];

    if (lead.username) {
      entries.push({
        identifierType: DncIdentifierType.USERNAME,
        value: lead.username,
        channel,
        reason: body.reason,
      });
    }

    if (lead.instagramUserId) {
      entries.push({
        identifierType: DncIdentifierType.INSTAGRAM_ID,
        value: lead.instagramUserId,
        channel,
        reason: body.reason,
      });
    }

    const email = lead.emailNormalized || lead.email;
    if (email) {
      entries.push({
        identifierType: DncIdentifierType.EMAIL,
        value: email,
        channel,
        reason: body.reason,
      });
    }

    const result = await addDoNotContact({
      userId: user.id,
      entries,
      source: DncSource.MANUAL,
      reason: body.reason,
      actor: `user:${user.id}`,
    });

    return NextResponse.json(
      {
        success: true,
        leadId: lead.id,
        entriesAdded: result.created,
        leadsUpdated: result.leadsUpdated,
        pendingCancelled: result.pendingCancelled,
      },
      { status: 200 },
    );
  } catch (error) {
    return handleRouteError(request, error);
  }
}
