import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { checkEmailSenderDns } from "@/lib/services/email/email-account-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    let selector: string | null = null;
    try {
      const body = (await request.json()) as Record<string, unknown>;
      selector = typeof body.selector === "string" ? body.selector : null;
    } catch {
      selector = null;
    }
    const health = await checkEmailSenderDns(user.id, id, selector);
    return NextResponse.json(health);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
