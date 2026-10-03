import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import {
  listDoNotContact,
  addDoNotContact,
  DncChannel,
  DncIdentifierType,
  DncSource,
  type AddDncEntryInput,
} from "@/lib/services/compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const url = new URL(request.url);

    const rawChannel = url.searchParams.get("channel");
    const search = url.searchParams.get("search") || undefined;
    const page = Number.parseInt(url.searchParams.get("page") || "1", 10);
    const pageSize = Number.parseInt(url.searchParams.get("pageSize") || "50", 10);

    let channel: DncChannel | undefined;
    if (rawChannel && Object.values(DncChannel).includes(rawChannel as DncChannel)) {
      channel = rawChannel as DncChannel;
    }

    const result = await listDoNotContact({
      userId: user.id,
      channel,
      search,
      page: Number.isNaN(page) ? 1 : page,
      pageSize: Number.isNaN(pageSize) ? 50 : pageSize,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuth(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiError(400, "INVALID_BODY", "Request body must be a JSON object.");
    }

    const { entries: rawEntries, source: rawSource } = body as {
      entries?: unknown;
      source?: unknown;
    };

    if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
      return apiError(400, "MISSING_ENTRIES", '"entries" must be a non-empty array.');
    }

    if (rawEntries.length > 1000) {
      return apiError(400, "LIMIT_EXCEEDED", "Maximum 1000 entries allowed per request.");
    }

    let source: DncSource = DncSource.MANUAL;
    if (rawSource === "IMPORT") {
      source = DncSource.IMPORT;
    } else if (rawSource && rawSource !== "MANUAL") {
      return apiError(400, "INVALID_SOURCE", 'Source must be "MANUAL" or "IMPORT".');
    }

    const validatedEntries: AddDncEntryInput[] = [];

    for (let i = 0; i < rawEntries.length; i++) {
      const item = rawEntries[i];
      if (!item || typeof item !== "object") {
        return apiError(400, "INVALID_ENTRY", `Entry at index ${i} must be an object.`);
      }

      const { identifierType, value, channel, reason } = item as Record<string, unknown>;

      if (!identifierType || !Object.values(DncIdentifierType).includes(identifierType as DncIdentifierType)) {
        return apiError(
          400,
          "INVALID_IDENTIFIER_TYPE",
          `Entry at index ${i} has invalid identifierType. Allowed: ${Object.values(DncIdentifierType).join(", ")}.`,
        );
      }

      if (!value || typeof value !== "string" || !value.trim()) {
        return apiError(400, "INVALID_VALUE", `Entry at index ${i} must have a non-empty string "value".`);
      }

      let dncChannel: DncChannel = DncChannel.ALL;
      if (channel) {
        if (!Object.values(DncChannel).includes(channel as DncChannel)) {
          return apiError(
            400,
            "INVALID_CHANNEL",
            `Entry at index ${i} has invalid channel. Allowed: ${Object.values(DncChannel).join(", ")}.`,
          );
        }
        dncChannel = channel as DncChannel;
      }

      validatedEntries.push({
        identifierType: identifierType as DncIdentifierType,
        value: value.trim(),
        channel: dncChannel,
        reason: typeof reason === "string" ? reason.trim() : undefined,
      });
    }

    const result = await addDoNotContact({
      userId: user.id,
      entries: validatedEntries,
      source,
      actor: `user:${user.id}`,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
