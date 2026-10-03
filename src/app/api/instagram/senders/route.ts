import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { createSenderAccount, listSenderAccounts } from "@/lib/services/senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const senders = await listSenderAccounts(user.id);
    return NextResponse.json({ senders });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const sender = await createSenderAccount(body, user.id);
    return NextResponse.json({ sender }, { status: 201 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
