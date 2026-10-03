import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError } from "@/lib/errors";
import { removeDoNotContact } from "@/lib/services/compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ entryId: string }>;
};

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { entryId } = await context.params;

    const result = await removeDoNotContact({
      userId: user.id,
      entryId,
      actor: `user:${user.id}`,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
