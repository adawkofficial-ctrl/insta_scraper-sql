import { requireAuth } from "@/lib/services/auth";
import { getCampaignById } from "@/lib/services/campaign";
import { parseDiscoveryRequest, runDiscovery } from "@/lib/services/discovery";
import { handleRouteError } from "@/lib/errors";
import { validateScraperConfig } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/scraper/instagram/discover
 *
 * Streams newline-delimited JSON progress events while running:
 *   campaign intent -> discovery Actor -> candidate usernames
 *                    -> existing profile scraper (enrichment) -> persistence
 *
 * Events:
 *   { type: "progress", stage, message, candidatesDiscovered?, candidatesEnriched?, persisted? }
 *   { type: "result",   success: true, data: LeadProfile[], meta: {...} }
 *   { type: "error",    success: false, error: { code, message } }
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  let user;
  try {
    user = await requireAuth(request);
  } catch (error) {
    return handleRouteError(request, error);
  }

  let input;
  try {
    input = parseDiscoveryRequest(body);
    // Ownership check before streaming so IDOR attempts get a clean 404.
    await getCampaignById(input.campaignId, user.id);
    validateScraperConfig();
  } catch (error) {
    return handleRouteError(request, error);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      void (async () => {
        try {
          const result = await runDiscovery(input, user.id, (event) => {
            send({ type: "progress", ...event });
          });

          send({
            type: "result",
            success: true,
            data: result.profiles,
            meta: {
              campaignId: result.campaignId,
              scrapeJobId: result.scrapeJobId,
              discoveryActor: result.discoveryActor,
              enrichmentActor: result.enrichmentActor,
              requestedLimit: result.requestedLimit,
              existingLeads: result.existingLeads,
              candidatesDiscovered: result.candidatesDiscovered,
              candidatesEnriched: result.candidatesEnriched,
              existingSkipped: result.existingSkipped,
              skipped: result.skipped,
              persisted: result.persisted,
              remainingCapacity: result.remainingCapacity,
              notice: result.notice,
              skipCounts: result.skipCounts,
            },
          });
        } catch (error) {
          const response = handleRouteError(request, error);
          let payload: unknown = {
            code: "INTERNAL_ERROR",
            message: "The discovery request failed unexpectedly.",
          };
          try {
            const parsed = (await response.json()) as { error?: unknown };
            if (parsed.error !== undefined) {
              payload = parsed.error;
            }
          } catch {
            // keep the fallback payload
          }
          send({ type: "error", success: false, error: payload });
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
