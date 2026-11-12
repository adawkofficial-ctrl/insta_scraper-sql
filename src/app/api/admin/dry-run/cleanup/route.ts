import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/services/auth";
import { getDryRunCounts, deleteDryRunData } from "@/lib/services/lead/dry-run-cleanup";
import { handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);

    const counts = await getDryRunCounts();
    return NextResponse.json({
      success: true,
      counts,
      backupReminder: "Make sure you have a database backup (e.g. pg_dump) before proceeding.",
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);

    let body: unknown = undefined;
    try {
      body = await request.json();
    } catch {
      // empty body
    }

    const confirm = (body as { confirm?: boolean } | undefined)?.confirm;
    if (!confirm) {
      const counts = await getDryRunCounts();
      return NextResponse.json(
        {
          error: "CONFIRMATION_REQUIRED",
          message: "You must pass { confirm: true } to execute dry-run data deletion.",
          counts,
          backupReminder: "Make sure you have a database backup (e.g. pg_dump) before proceeding.",
        },
        { status: 400 },
      );
    }

    const result = await deleteDryRunData();
    return NextResponse.json({
      success: true,
      result,
      message: `Deleted ${result.deletedLeads} dry-run leads and ${result.deletedScrapeJobs} dry-run scrape jobs.`,
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

