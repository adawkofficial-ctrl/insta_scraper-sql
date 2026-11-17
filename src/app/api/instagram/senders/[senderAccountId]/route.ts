import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import {
  getSenderAccount,
  deleteSenderAccount,
  updateSenderSettings,
  pauseSenderAccount,
  resumeSenderAccount,
} from "@/lib/services/senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ senderAccountId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { senderAccountId } = await context.params;
    const sender = await getSenderAccount(senderAccountId, user.id);
    return NextResponse.json({ sender });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { senderAccountId } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === "pause") {
      const sender = await pauseSenderAccount(senderAccountId, user.id);
      return NextResponse.json({ sender });
    }

    if (body.action === "resume") {
      const sender = await resumeSenderAccount(senderAccountId, user.id);
      return NextResponse.json({ sender });
    }

    const sender = await updateSenderSettings(
      senderAccountId,
      user.id,
      {
        messagesPerDay:
          typeof body.messagesPerDay === "number"
            ? body.messagesPerDay
            : typeof body.dailyCap === "number"
              ? body.dailyCap
              : undefined,
        minutesBetweenMessages:
          typeof body.minutesBetweenMessages === "number"
            ? body.minutesBetweenMessages
            : typeof body.customMinGapSeconds === "number"
              ? Math.round(body.customMinGapSeconds / 60)
              : undefined,
        jitterMinutes: typeof body.jitterMinutes === "number" ? body.jitterMinutes : undefined,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
        workingHoursStart:
          typeof body.workingHoursStart === "number" ? body.workingHoursStart : undefined,
        workingHoursEnd:
          typeof body.workingHoursEnd === "number" ? body.workingHoursEnd : undefined,
        warmUpEnabled:
          typeof body.warmupEnabled === "boolean"
            ? body.warmupEnabled
            : typeof body.warmUpEnabled === "boolean"
              ? body.warmUpEnabled
              : undefined,
      },
      user.id,
    );
    return NextResponse.json({ sender });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { senderAccountId } = await context.params;
    const result = await deleteSenderAccount(senderAccountId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
