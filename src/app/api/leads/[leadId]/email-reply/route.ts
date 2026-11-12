import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ leadId: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { leadId } = await params;
    const prisma = getPrismaClient();
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, campaign: { userId: user.id } },
      select: { id: true, emailNormalized: true },
    });
    if (!lead) return apiError(404, "NOT_FOUND", "Lead not found.");

    const now = new Date();
    const domain = lead.emailNormalized?.split("@")[1]?.toLowerCase() ?? null;
    await prisma.$transaction([
      prisma.lead.update({
        where: { id: lead.id },
        data: { status: "REPLIED", emailOptOutAt: now, emailInvalid: true },
      }),
      ...(lead.emailNormalized
        ? [
            prisma.doNotContact.upsert({
              where: {
                userId_channel_identifierType_identifierNormalized: {
                  userId: user.id,
                  channel: "EMAIL",
                  identifierType: "EMAIL",
                  identifierNormalized: lead.emailNormalized,
                },
              },
              create: {
                userId: user.id,
                channel: "EMAIL",
                identifierType: "EMAIL",
                identifierNormalized: lead.emailNormalized,
                reason: "Reply STOP (manual)",
                source: "REPLY_OPT_OUT",
              },
              update: { reason: "Reply STOP (manual)" },
            }),
          ]
        : []),
      ...(domain
        ? [
            prisma.doNotContact.upsert({
              where: {
                userId_channel_identifierType_identifierNormalized: {
                  userId: user.id,
                  channel: "EMAIL",
                  identifierType: "DOMAIN",
                  identifierNormalized: domain,
                },
              },
              create: {
                userId: user.id,
                channel: "EMAIL",
                identifierType: "DOMAIN",
                identifierNormalized: domain,
                reason: "Reply STOP (manual)",
                source: "REPLY_OPT_OUT",
              },
              update: { reason: "Reply STOP (manual)" },
            }),
          ]
        : []),
    ]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
