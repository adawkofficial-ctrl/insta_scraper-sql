import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { resumeSenderAccount } from "@/lib/services/senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ senderAccountId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { senderAccountId } = await context.params;
    const sender = await resumeSenderAccount(senderAccountId, user.id);
    return NextResponse.json({ sender });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
