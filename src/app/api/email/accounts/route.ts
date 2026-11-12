import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import {
  createEmailSenderAccount,
  sanitizeEmailAccount,
} from "@/lib/services/email/email-account-service";
import { getPrismaClient } from "@/lib/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const accounts = await getPrismaClient().emailSenderAccount.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ accounts: accounts.map(sanitizeEmailAccount) });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }
    const input = body as Record<string, unknown>;
    if (
      typeof input.fromName !== "string" ||
      typeof input.fromAddress !== "string" ||
      typeof input.postalAddress !== "string" ||
      typeof input.smtpHost !== "string" ||
      typeof input.smtpPort !== "number" ||
      typeof input.smtpUser !== "string" ||
      typeof input.smtpPassword !== "string"
    ) {
      return apiError(400, "INVALID_INPUT", "Missing required email account fields.");
    }
    const account = await createEmailSenderAccount(user.id, {
      fromName: input.fromName,
      fromAddress: input.fromAddress,
      postalAddress: input.postalAddress,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpUser: input.smtpUser,
      smtpPassword: input.smtpPassword,
      secure: input.secure === undefined ? true : Boolean(input.secure),
      dailyCap: typeof input.dailyCap === "number" ? input.dailyCap : undefined,
      hourlyCap: typeof input.hourlyCap === "number" ? input.hourlyCap : undefined,
      dkimSelector: typeof input.dkimSelector === "string" ? input.dkimSelector : null,
      allowDnsOverride: Boolean(input.allowDnsOverride),
    });
    return NextResponse.json(account, { status: 201 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
