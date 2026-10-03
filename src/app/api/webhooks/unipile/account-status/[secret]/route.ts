import { NextResponse } from "next/server";
import {
  verifyWebhookSecret,
  handleAccountStatusWebhook,
} from "@/lib/services/unipile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ secret: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { secret } = await context.params;

  if (!verifyWebhookSecret(secret)) {
    return new Response("Not Found", { status: 404 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // If body is empty or non-JSON, still acknowledge gracefully
    body = {};
  }

  try {
    const eventIdHeader =
      request.headers.get("x-unipile-event-id") ||
      request.headers.get("unipile-delivery-id");

    const result = await handleAccountStatusWebhook(body, eventIdHeader);
    return NextResponse.json(result.body, { status: result.status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("ACCOUNT STATUS ROUTE ERROR:", err);
    return NextResponse.json(
      { error: message, stack },
      { status: 500 }
    );
  }
}
