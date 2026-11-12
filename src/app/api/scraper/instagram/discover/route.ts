import { requireAuth } from "@/lib/services/auth";
import { getCampaignById } from "@/lib/services/campaign";
import { parseDiscoveryRequest, prepareDiscoveryRun, type PreparedDiscoveryRun } from "@/lib/services/discovery";
import { handleRouteError } from "@/lib/errors";
import { validateScraperConfig } from "@/lib/env";
import { getMonthlyApifyBudgetRemaining } from "@/lib/services/scraper/apify-cost-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

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

  // Pre-initialize ScrapeJob tracking BEFORE streaming or returning 200.
  // If ScrapeJob creation fails (e.g. schema mismatch / DB error), FAIL LOUD with 500.
  // Discovery must NEVER run untracked.
  let preparedRun: PreparedDiscoveryRun;
  try {
    preparedRun = await prepareDiscoveryRun(input, user.id);
  } catch (error) {
    console.error("[DISCOVERY-JOB-INIT-ERROR] ScrapeJob creation or initialization failed:", error);
    if (error && typeof error === "object" && ("statusCode" in error || "code" in error)) {
      return handleRouteError(request, error);
    }
    return Response.json(
      {
        error: {
          code: "SCRAPE_JOB_CREATE_FAILED",
          message: "Failed to initialize scrape job tracking. Discovery aborted.",
        },
      },
      { status: 500 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let isClosed = false;
      const send = (payload: unknown): void => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          isClosed = true;
        }
      };

      const heartbeat = setInterval(() => {
        send({ type: "ping" });
      }, 10000);

      void (async () => {
        try {
          if (preparedRun.kind === "LIMIT_REACHED") {
            send({
              type: "result",
              success: true,
              data: preparedRun.result.profiles,
              meta: {
                campaignId: preparedRun.result.campaignId,
                scrapeJobId: preparedRun.result.scrapeJobId,
                discoveryActor: preparedRun.result.discoveryActor,
                enrichmentActor: preparedRun.result.enrichmentActor,
                requestedLimit: preparedRun.result.requestedLimit,
                existingLeads: preparedRun.result.existingLeads,
                candidatesDiscovered: 0,
                candidatesEnriched: 0,
                existingSkipped: 0,
                skipped: 0,
                persisted: 0,
                remainingCapacity: 0,
                notice: preparedRun.result.notice,
                skipCounts: preparedRun.result.skipCounts,
                apifyCostUsd: 0,
                remainingBudgetUsd: await getMonthlyApifyBudgetRemaining(),
              },
            });
            return;
          }

          const result = await preparedRun.execute((event) => {
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
              apifyCostUsd: result.apifyCostUsd,
              usageSummary: result.usageSummary,
              remainingBudgetUsd: await getMonthlyApifyBudgetRemaining(),
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
          clearInterval(heartbeat);
          if (!isClosed) {
            isClosed = true;
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
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
