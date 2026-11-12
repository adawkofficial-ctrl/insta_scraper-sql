import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, BadRequestError } from "@/lib/errors";
import { importLeadsFromCsv } from "@/lib/services/lead";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await context.params;

    let csvText = "";
    let options: { skipExisting?: boolean } | undefined;

    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file || typeof file === "string") {
        throw new BadRequestError("MISSING_FILE", 'A valid CSV "file" is required in form-data.');
      }

      const fileObj = file as File;
      csvText = await fileObj.text();

      const skipExistingStr = formData.get("skipExisting");
      if (skipExistingStr === "true") {
        options = { skipExisting: true };
      }
    } else {
      const body = await request.json();
      if (!body || typeof body !== "object") {
        throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object or multipart/form-data.");
      }

      csvText = body.csvText || body.csv || "";
      if (body.options && typeof body.options === "object") {
        options = body.options;
      }
    }

    if (!csvText || !csvText.trim()) {
      throw new BadRequestError("EMPTY_CSV", "CSV content cannot be empty.");
    }

    const result = await importLeadsFromCsv(campaignId, user.id, csvText, options);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
