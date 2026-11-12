import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { updateEmailSenderAccount } from "@/lib/services/email/email-account-service";
import { getPrismaClient } from "@/lib/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }
    const input = body as Record<string, unknown>;
    const account = await updateEmailSenderAccount(user.id, id, {
      fromName: typeof input.fromName === "string" ? input.fromName : undefined,
      fromAddress: typeof input.fromAddress === "string" ? input.fromAddress : undefined,
      postalAddress: typeof input.postalAddress === "string" ? input.postalAddress : undefined,
      smtpHost: typeof input.smtpHost === "string" ? input.smtpHost : undefined,
      smtpPort: typeof input.smtpPort === "number" ? input.smtpPort : undefined,
      smtpUser: typeof input.smtpUser === "string" ? input.smtpUser : undefined,
      smtpPassword: typeof input.smtpPassword === "string" ? input.smtpPassword : undefined,
      secure: input.secure === undefined ? undefined : Boolean(input.secure),
      dailyCap: typeof input.dailyCap === "number" ? input.dailyCap : undefined,
      hourlyCap: typeof input.hourlyCap === "number" ? input.hourlyCap : undefined,
      dkimSelector: typeof input.dkimSelector === "string" ? input.dkimSelector : undefined,
      allowDnsOverride: input.allowDnsOverride === undefined ? undefined : Boolean(input.allowDnsOverride),
      status: typeof input.status === "string" ? input.status : undefined,
    });
    return NextResponse.json(account);
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    const deleted = await getPrismaClient().emailSenderAccount.deleteMany({
      where: { id, userId: user.id },
    });
    if (deleted.count === 0) return apiError(404, "NOT_FOUND", "Email account not found.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
