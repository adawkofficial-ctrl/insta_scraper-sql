import { NextResponse } from "next/server";
import { getPrismaClient } from "@/lib/db/prisma";
import { handleRouteError, NotFoundError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import {
  classifyReply,
  applyIntentToLeadStatus,
  generateReplyDraft,
  REPLY_WORTHY_INTENTS,
} from "@/lib/services/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ messageId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { messageId } = await context.params;

    const prisma = getPrismaClient();
    const message = await prisma.message.findFirst({
      where: {
        id: messageId,
        campaign: { userId: user.id },
      },
      select: { id: true, leadId: true },
    });

    if (!message) {
      throw new NotFoundError("MESSAGE_NOT_FOUND", `Message "${messageId}" was not found.`);
    }

    const classification = await classifyReply({
      leadId: message.leadId,
      messageId: message.id,
    });

    let draftResult = null;
    let statusResult = null;

    if (classification.ok && classification.intent) {
      statusResult = await applyIntentToLeadStatus({
        leadId: message.leadId,
        intent: classification.intent,
        interestLevel: classification.interestLevel,
        actor: `user:${user.id}`,
      });

      if (REPLY_WORTHY_INTENTS.has(classification.intent)) {
        draftResult = await generateReplyDraft({
          leadId: message.leadId,
          messageId: message.id,
        });
      }
    }

    return NextResponse.json({
      ok: classification.ok,
      classification,
      leadStatus: statusResult,
      draft: draftResult,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
