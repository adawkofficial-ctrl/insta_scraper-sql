import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { LeadStatus, ScrapeJobStatus, Prisma } from "@/generated/prisma/client";
import { scrapeLeadWebsite } from "../enrichment/website-lead-enricher";
import {
  saveLeadAsEnrichPending,
  saveContactOnlyLead,
  updateCandidateHandleResult,
} from "./candidate-persistence";
import { scrapeInstagramProfiles } from "../scraper/scraper-service";

export interface ResumeJobResult {
  jobId: string;
  campaignId: string;
  totalPendingCandidates: number;
  handlesDiscovered: number;
  leadsCreatedOrUpdated: number;
  leadsEnriched: number;
  finalJobStatus: ScrapeJobStatus;
  errors: string[];
}

/**
 * Resumes a discovery scrape job without making ANY Google Maps actor calls.
 * Processes only candidates still in DISCOVERED, HANDLE_FOUND, ENRICH_PENDING, or failed stages.
 * Fully idempotent: running repeatedly creates zero duplicate leads.
 */
export async function resumeScrapeJob(
  jobId: string,
  userId?: string,
  options?: { skipEnrichment?: boolean },
): Promise<ResumeJobResult> {
  const prisma = getPrismaClient();

  const job = await prisma.scrapeJob.findUnique({
    where: { id: jobId },
    include: { campaign: true },
  });

  if (!job || !job.campaignId) {
    throw new Error(`ScrapeJob "${jobId}" not found or has no associated campaign.`);
  }

  const campaignId = job.campaignId;

  // 1. Fetch pending candidates
  const pendingCandidates = await prisma.candidate.findMany({
    where: {
      campaignId,
      OR: [
        { status: "DISCOVERED" },
        { status: "HANDLE_FOUND" },
        { status: "ENRICH_PENDING" },
        { lastError: { not: null } },
      ],
    },
  });

  let handlesDiscovered = 0;
  let leadsCreatedOrUpdated = 0;
  let leadsEnriched = 0;
  const errors: string[] = [];

  // 2. Process DISCOVERED candidates: free handle waterfall
  for (const cand of pendingCandidates) {
    if (cand.status === "DISCOVERED" && cand.website) {
      try {
        const scraped = await scrapeLeadWebsite({
          website: cand.website,
          businessName: cand.name,
          countryCode: cand.countryCode ?? undefined,
        });
        const fields = {
          category: cand.category,
          address: cand.address,
          state: cand.state,
          countryCode: cand.countryCode,
          mapsUrl: cand.mapsUrl,
          rawPlaceData: (cand.rawPlaceData ?? null) as Record<string, unknown> | null,
          email: scraped.emails[0]?.value ?? null,
          socialLinks: scraped.socialLinks as Record<string, unknown>,
          websiteEmails: scraped.emails,
          websitePhones: scraped.phones,
          websiteDiagnostics: scraped.pages,
        };

        if (scraped.handle) {
          handlesDiscovered++;
          await saveLeadAsEnrichPending({
            campaignId,
            scrapeJobId: jobId,
            userId,
            placeId: cand.placeId,
            name: cand.name,
            handle: scraped.handle,
            website: cand.website,
            phone: cand.phone ?? scraped.phones[0]?.value ?? null,
            city: cand.city,
            rating: cand.rating,
            reviewsCount: cand.reviewsCount,
            handleSource: "homepage",
            handleConfidence: scraped.handleConfidence,
            isDryRun: job.isDryRun,
            fields,
          });
          cand.status = "ENRICH_PENDING";
          cand.handle = scraped.handle;
          leadsCreatedOrUpdated++;
        } else {
          const hasSocial = Object.values(scraped.socialLinks).some(Boolean);
          if (cand.phone || cand.website || hasSocial || scraped.emails.length > 0) {
            await saveContactOnlyLead({
              campaignId,
              scrapeJobId: jobId,
              userId,
              placeId: cand.placeId,
              name: cand.name,
              website: cand.website,
              phone: cand.phone ?? scraped.phones[0]?.value ?? null,
              email: scraped.emails[0]?.value ?? null,
              city: cand.city,
              rating: cand.rating,
              reviewsCount: cand.reviewsCount,
              socialLinks: scraped.socialLinks as Record<string, unknown>,
              isDryRun: job.isDryRun,
              fields,
            });
            cand.status = "LEAD_SAVED";
            leadsCreatedOrUpdated++;
          } else {
            await updateCandidateHandleResult(campaignId, cand.placeId, {
              status: "REJECTED:NO_CONTACT",
              handle: null,
              socialLinks: scraped.socialLinks as Record<string, unknown>,
            });
            cand.status = "REJECTED:NO_CONTACT";
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Handle waterfall failed for ${cand.name}: ${msg}`);
        await updateCandidateHandleResult(campaignId, cand.placeId, {
          status: "DISCOVERED",
          lastError: msg.slice(0, 200),
        });
      }
    } else if (cand.status === "DISCOVERED" && cand.phone) {
      try {
        await saveContactOnlyLead({
          campaignId,
          scrapeJobId: jobId,
          userId,
          placeId: cand.placeId,
          name: cand.name,
          phone: cand.phone,
          city: cand.city,
          rating: cand.rating,
          reviewsCount: cand.reviewsCount,
          isDryRun: job.isDryRun,
        });
        cand.status = "LEAD_SAVED";
        leadsCreatedOrUpdated++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to save phone-only lead ${cand.name}: ${msg}`);
      }
    } else if (cand.status === "DISCOVERED") {
      await updateCandidateHandleResult(campaignId, cand.placeId, {
        status: "REJECTED:NO_CONTACT",
        handle: null,
      });
      cand.status = "REJECTED:NO_CONTACT";
    }
  }

  // 3. Process ENRICH_PENDING candidates
  const enrichCandidates = pendingCandidates.filter(
    (c) => (c.status === "ENRICH_PENDING" || c.status === "HANDLE_FOUND") && Boolean(c.handle),
  );

  // On startup recovery we must not make paid profile calls. Persist the
  // already-discovered handle as an ENRICH_PENDING lead so work is not lost.
  if (options?.skipEnrichment) {
    for (const cand of enrichCandidates) {
      await saveLeadAsEnrichPending({
        campaignId,
        scrapeJobId: jobId,
        userId,
        placeId: cand.placeId,
        name: cand.name,
        handle: cand.handle!.replace(/^@/, "").trim().toLowerCase(),
        website: cand.website,
        phone: cand.phone,
        city: cand.city,
        rating: cand.rating,
        reviewsCount: cand.reviewsCount,
        handleSource: cand.handleSource ?? "resume",
        handleConfidence: cand.handleConfidence ?? "medium",
        isDryRun: job.isDryRun,
      });
      cand.status = "ENRICH_PENDING";
      leadsCreatedOrUpdated++;
    }
  } else if (enrichCandidates.length > 0) {
    const usernamesToEnrich = Array.from(new Set(enrichCandidates.map((c) => c.handle!.replace(/^@/, "").trim().toLowerCase())));
    try {
      const enrichment = await scrapeInstagramProfiles(
        usernamesToEnrich,
        usernamesToEnrich.length,
        {
          campaignId,
          userId,
        },
      );

      const enrichedMap = new Map(enrichment.profiles.map((p) => [(p.username || "").toLowerCase(), p]));

      for (const cand of enrichCandidates) {
        const norm = (cand.handle || "").replace(/^@/, "").toLowerCase();
        const profile = enrichedMap.get(norm);
        if (profile) {
          leadsEnriched++;
          await prisma.candidate.updateMany({
            where: { campaignId, placeId: cand.placeId },
            data: {
              status: "LEAD_SAVED",
              lastError: null,
            },
          });

          // Update Lead record
          await prisma.lead.updateMany({
            where: {
              campaignId,
              usernameNormalized: norm,
            },
            data: {
              status: LeadStatus.NEW,
              followersCount: profile.followersCount ?? profile.followers ?? null,
              followsCount: profile.followsCount ?? profile.following ?? null,
              postsCount: profile.postsCount ?? null,
              biography: profile.biography ?? null,
              verified: profile.verified ?? null,
              isBusinessAccount: profile.isBusinessAccount ?? profile.isBusiness ?? null,
              rawProfileData: profile as unknown as Prisma.InputJsonValue,
              scrapedAt: new Date(),
            },
          });
        }
      }
    } catch (enrichErr: unknown) {
      const msg = enrichErr instanceof Error ? enrichErr.message : String(enrichErr);
      errors.push(`Profile enrichment failed: ${msg}`);
      for (const cand of enrichCandidates) {
        await prisma.candidate.updateMany({
          where: { campaignId, placeId: cand.placeId },
          data: {
            status: "ENRICH_PENDING",
            lastError: msg.slice(0, 200),
          },
        });
      }
    }
  }

  // 4. Update Job Status
  const finalJobStatus = errors.length > 0
    ? ScrapeJobStatus.COMPLETED_WITH_WARNINGS
    : ScrapeJobStatus.COMPLETED;

  await prisma.scrapeJob.update({
    where: { id: jobId },
    data: {
      status: finalJobStatus,
      completedAt: new Date(),
      errorMessage: errors.length > 0 ? errors.join("; ").slice(0, 300) : null,
    },
  });

  return {
    jobId,
    campaignId,
    totalPendingCandidates: pendingCandidates.length,
    handlesDiscovered,
    leadsCreatedOrUpdated,
    leadsEnriched,
    finalJobStatus,
    errors,
  };
}

