import { NextResponse } from "next/server";
import {
  getUnsubscribeTokenPreview,
  processEmailUnsubscribe,
} from "@/lib/services/email/email-unsubscribe-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}

function getIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (rateLimited(getIp(request))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const preview = await getUnsubscribeTokenPreview(token);
  return NextResponse.json(preview, { status: preview.valid ? 200 : 404 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (rateLimited(getIp(request))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const result = await processEmailUnsubscribe(token);
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
