import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, BadRequestError } from "@/lib/errors";
import { previewCsvLeads } from "@/lib/services/lead";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

export async function POST(
  request: Request,
  _context: RouteContext,
): Promise<Response> {
  try {
    await requireAuth(request);

    let csvText = "";
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file || typeof file === "string") {
        throw new BadRequestError("MISSING_FILE", 'A valid CSV "file" is required in form-data.');
      }

      const fileObj = file as File;
      csvText = await fileObj.text();
    } else {
      const body = await request.json();
      if (!body || typeof body !== "object") {
        throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object or multipart/form-data.");
      }
      csvText = body.csvText || body.csv || "";
    }

    if (!csvText || !csvText.trim()) {
      throw new BadRequestError("EMPTY_CSV", "CSV content cannot be empty.");
    }

    const preview = await previewCsvLeads(csvText);
    return NextResponse.json(preview);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
