import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/services/auth";
import { getSenderAccount } from "@/lib/services/senders";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ senderAccountId: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { senderAccountId } = await params;
    const sender = await getSenderAccount(senderAccountId, user.id);
    const prisma = getPrismaClient();

    const [leads, attemptCounts, messageCount] = await Promise.all([
      prisma.lead.findMany({
        where: { userId: user.id, assignedSenderAccountId: senderAccountId },
        orderBy: [{ lastContactedAt: "desc" }, { firstContactedAt: "desc" }],
        take: 50,
        select: {
          id: true,
          username: true,
          fullName: true,
          firstContactedAt: true,
          lastContactedAt: true,
          outreachCount: true,
          status: true,
        },
      }),
      prisma.leadContactEvent.groupBy({
        by: ["status"],
        where: { userId: user.id, senderAccountId },
        _count: { _all: true },
      }),
      prisma.message.count({ where: { senderAccountId } }),
    ]);

    return NextResponse.json({
      sender,
      totalMessages: messageCount,
      statusCounts: Object.fromEntries(
        attemptCounts.map((row) => [row.status, row._count._all]),
      ),
      leads: leads.map((lead) => ({
        ...lead,
        username: lead.username ? `@${lead.username}` : null,
      })),
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
