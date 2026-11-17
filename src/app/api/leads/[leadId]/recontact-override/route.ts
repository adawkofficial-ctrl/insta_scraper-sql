import { NextResponse } from "next/server";

import { getPrismaClient } from "@/lib/db/prisma";
import { apiError, handleRouteError, NotFoundError } from "@/lib/errors";
import { requireAuth } from "@/lib/services/auth";
import { normalizeContactHandle } from "@/lib/services/messaging/contact-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ leadId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuth(request);
    if (user.role !== "ADMIN") {
      return apiError(403, "FORBIDDEN", "Only an administrator can override the re-contact policy.");
    }
    const { leadId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 10) {
      return apiError(400, "REASON_REQUIRED", "A typed reason of at least 10 characters is required.");
    }

    const prisma = getPrismaClient();
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, campaign: { userId: user.id } },
      select: { id: true, username: true, campaignId: true, userId: true },
    });
    if (!lead) throw new NotFoundError("LEAD_NOT_FOUND", "Lead was not found.");

    const handleNormalized = normalizeContactHandle(lead.username);
    const ledger = await prisma.leadContactLedger.findFirst({
      where: { userId: user.id, handleNormalized, step: "1", channel: "INSTAGRAM" },
      orderBy: { reservedAt: "desc" },
    });
    if (!ledger) {
      return apiError(400, "NO_RESERVATION", "No prior first-contact reservation exists for this handle.");
    }

    const since = new Date(Date.now() - 30 * 86400000);
    const recentOverride = await prisma.leadContactEvent.count({
      where: { ledgerId: ledger.id, status: "OVERRIDE", createdAt: { gte: since } },
    });
    if (recentOverride > 0) {
      return apiError(
        409,
        "OVERRIDE_LIMIT",
        "This handle already has a manual re-contact override in the last 30 days.",
      );
    }

    const metadata = (ledger.metadata ?? {}) as Record<string, unknown>;
    await prisma.$transaction([
      prisma.leadContactLedger.update({
        where: { id: ledger.id },
        data: {
          metadata: {
            ...metadata,
            overrideAt: new Date().toISOString(),
            overrideReason: reason,
            overrideBy: user.id,
          },
        },
      }),
      prisma.leadContactEvent.create({
        data: {
          ledgerId: ledger.id,
          userId: user.id,
          leadId,
          campaignId: lead.campaignId,
          senderAccountId: ledger.senderAccountId,
          senderUsernameSnapshot: ledger.senderUsernameSnapshot,
          step: "1",
          channel: "INSTAGRAM",
          status: "OVERRIDE",
          reason: reason.slice(0, 64),
        },
      }),
    ]);

    return NextResponse.json({ ok: true, ledgerId: ledger.id, reason });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

