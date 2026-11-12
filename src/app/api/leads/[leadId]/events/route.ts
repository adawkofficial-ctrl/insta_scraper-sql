import { NextResponse } from "next/server";
import { recordManualOutcomeEvent } from "@/lib/services/analytics";
import { handleRouteError, apiError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { MessageChannel } from "@/generated/prisma/enums";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ leadId: string }>;
};

const VALID_EVENT_TYPES = new Set([
  "MEETING_BOOKED",
  "WON",
  "POSITIVE_REPLY",
  "NEGATIVE_REPLY",
  "UNSUBSCRIBE_OR_DNC",
]);

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { leadId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const { eventType, notes, channel } =
      (body as {
        eventType?: string;
        notes?: string;
        channel?: string;
      }) || {};

    if (!eventType || !VALID_EVENT_TYPES.has(eventType)) {
      return apiError(
        400,
        "INVALID_EVENT_TYPE",
        `Invalid "eventType". Allowed: ${Array.from(VALID_EVENT_TYPES).join(", ")}.`,
      );
    }

    const mappedChannel =
      channel && Object.values(MessageChannel).includes(channel as MessageChannel)
        ? (channel as MessageChannel)
        : MessageChannel.INSTAGRAM;

    const result = await recordManualOutcomeEvent({
      leadId,
      eventType: eventType as
        | "MEETING_BOOKED"
        | "WON"
        | "POSITIVE_REPLY"
        | "NEGATIVE_REPLY"
        | "UNSUBSCRIBE_OR_DNC",
      channel: mappedChannel,
      notes: typeof notes === "string" ? notes.slice(0, 500) : undefined,
      actor: `user:${user.id}`,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
