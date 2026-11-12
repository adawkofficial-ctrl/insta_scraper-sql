import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { verifyEmailSenderAccount } from "@/lib/services/email/email-account-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    const result = await verifyEmailSenderAccount(user.id, id);
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
