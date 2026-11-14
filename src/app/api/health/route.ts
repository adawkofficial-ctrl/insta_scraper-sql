import { NextResponse } from "next/server";
import { getPrismaClient } from "@/lib/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let dbStatus = "connected";
  let databaseName: string | null = null;
  try {
    const prisma = getPrismaClient();
    // Lightweight database ping plus the connected database name (non-secret).
    const rows = await prisma.$queryRaw<Array<{ name: string }>>`SELECT DATABASE() AS name`;
    databaseName = rows[0]?.name ?? null;
  } catch {
    dbStatus = "disconnected";
  }

  const isHealthy = dbStatus === "connected";

  return NextResponse.json(
    {
      status: isHealthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        databaseName,
      },
    },
    {
      status: isHealthy ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}
