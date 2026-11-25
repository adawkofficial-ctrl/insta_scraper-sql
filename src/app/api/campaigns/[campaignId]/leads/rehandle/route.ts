import { requireAuth } from "@/lib/services/auth";
import { handleRouteError, apiError } from "@/lib/errors";
import { getPrismaClient } from "@/lib/db/prisma";
import { enrichLeadsFromWebsites } from "@/lib/services/enrichment/website-lead-enricher";
import { enrichLeadsOnDemand } from "@/lib/services/scraper/profile-enrichment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Scrape websites for all leads": free website enrichment for every lead in
 * the campaign that has a website, including leads that already have a handle,
 * email, or social link. No Apify/Gemini/Unipile calls during website scraping.
 *
 * Streams NDJSON so the UI can show live progress:
 *   {"type":"progress", phase:"scrape", total, processed, ...counters}
 *   {"type":"phase", phase:"profiles", total, processed, message}
 *   {"type":"result", ...summary}
 *   {"type":"error", error:{message}}
 */
export async function POST(
  request: Request,
  props: { params: Promise<{ campaignId: string }> },
): Promise<Response> {
  try {
    const user = await requireAuth(request);
    const { campaignId } = await props.params;

    if (!campaignId) {
      return apiError(400, "MISSING_CAMPAIGN_ID", "campaignId is required.");
    }

    const prisma = getPrismaClient();
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, userId: true },
    });

    if (!campaign || campaign.userId !== user.id) {
      return apiError(404, "CAMPAIGN_NOT_FOUND", "Campaign not found or unauthorized.");
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (event: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            closed = true;
          }
        };

        try {
          send({ type: "start", campaignId, startedAt: new Date().toISOString() });

          // "Scrape websites for all leads" must scan every lead that has a
          // website, including leads that already have IG/email/socials. It is
          // an explicit action, so it bypasses the 7-day cooldown.
          const result = await enrichLeadsFromWebsites({
            campaignId,
            scanAll: true,
            force: true,
            concurrency: 15,
            onProgress: (progress) => send({ type: "progress", ...progress }),
          });

          // Fetch Instagram profiles for newly found handles (max 20 per click,
          // the existing enrichment safety cap) and evaluate the criteria.
          const newlyFoundHandleLeadIds = result.results
            .filter((row) => row.newHandle && row.handle)
            .map((row) => row.id)
            .slice(0, 20);
          let profilesEnriched = 0;
          let belowCriteria = 0;
          const criteriaFailures: Array<{ id: string; handle: string | null; reasons: string[] }> = [];
          if (newlyFoundHandleLeadIds.length > 0) {
            send({
              type: "phase",
              phase: "profiles",
              total: newlyFoundHandleLeadIds.length,
              processed: 0,
              message: `Website scrape done. Enriching ${newlyFoundHandleLeadIds.length} new Instagram profile(s) via Apify...`,
            });
            try {
              const enriched = await enrichLeadsOnDemand({
                leadIds: newlyFoundHandleLeadIds,
                userId: user.id,
              });
              profilesEnriched = enriched.enrichedCount;
              for (const row of enriched.leads) {
                if (row.criteriaPassed === false && row.criteriaReasons?.length) {
                  belowCriteria++;
                  criteriaFailures.push({
                    id: row.id,
                    handle: row.username || null,
                    reasons: row.criteriaReasons,
                  });
                }
              }
              send({
                type: "phase",
                phase: "profiles",
                total: newlyFoundHandleLeadIds.length,
                processed: profilesEnriched,
                message: `Enriched ${profilesEnriched} of ${newlyFoundHandleLeadIds.length} new profile(s).`,
              });
            } catch {
              // Website results are already saved; profile enrichment is best-effort.
              send({
                type: "phase",
                phase: "profiles",
                total: newlyFoundHandleLeadIds.length,
                processed: 0,
                message: "Profile enrichment failed; website results were saved.",
              });
            }
          }

          send({
            type: "result",
            success: true,
            totalChecked: result.totalEligible,
            processed: result.processed,
            found: result.results.filter((r) => r.outcome === "found").length,
            notFound: result.notFound,
            cooldownSkipped: result.cooldownSkipped,
            handlesFound: result.handlesFound,
            emailsFound: result.emailsFound,
            socialsFound: result.socialsFound,
            profilesEnriched,
            belowCriteria,
            criteriaFailures,
            results: result.results,
          });
        } catch (error) {
          send({
            type: "error",
            error: {
              message: error instanceof Error ? error.message : "Website scrape failed.",
            },
          });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
