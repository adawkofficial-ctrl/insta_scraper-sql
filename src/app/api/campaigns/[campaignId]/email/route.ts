import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function assertCampaignOwner(userId: string, campaignId: string): Promise<boolean> {
  const campaign = await getPrismaClient().campaign.findFirst({
    where: { id: campaignId, userId },
    select: { id: true },
  });
  return Boolean(campaign);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await params;
    if (!(await assertCampaignOwner(user.id, campaignId))) {
      return apiError(404, "NOT_FOUND", "Campaign not found.");
    }
    const prisma = getPrismaClient();
    const [settings, sends] = await Promise.all([
      prisma.emailCampaignSettings.findUnique({ where: { campaignId } }),
      prisma.emailSend.findMany({
        where: { campaignId },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          lead: { select: { fullName: true, email: true, username: true } },
        },
      }),
    ]);
    const counts = sends.reduce<Record<string, number>>((acc, send) => {
      acc[send.status] = (acc[send.status] ?? 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({
      settings,
      counts,
      queue: sends.map((send) => ({
        id: send.id,
        leadId: send.leadId,
        status: send.status,
        recipient: send.recipient,
        subject: send.subject,
        createdAt: send.createdAt,
        sentAt: send.sentAt,
        errorCode: send.errorCode,
        lead: send.lead,
      })),
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await params;
    if (!(await assertCampaignOwner(user.id, campaignId))) {
      return apiError(404, "NOT_FOUND", "Campaign not found.");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }
    const input = body as Record<string, unknown>;
    if (
      typeof input.subjectTemplate !== "string" ||
      typeof input.bodyTemplate !== "string"
    ) {
      return apiError(400, "INVALID_INPUT", "subjectTemplate and bodyTemplate are required.");
    }
    const settings = await getPrismaClient().emailCampaignSettings.upsert({
      where: { campaignId },
      create: {
        campaignId,
        subjectTemplate: input.subjectTemplate,
        bodyTemplate: input.bodyTemplate,
        enabled: Boolean(input.enabled),
      },
      update: {
        subjectTemplate: input.subjectTemplate,
        bodyTemplate: input.bodyTemplate,
        enabled: Boolean(input.enabled),
        templateVersion: { increment: 1 },
      },
    });
    return NextResponse.json(settings);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
